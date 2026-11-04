import fs from "fs";
import os from "os";
import path from "path";
import { COLORS } from "./logger.js";

const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "win32"]);
const FERRIS_SEARCH_KEY = "ferris-search";
const GLOBAL_SCHEMA = "https://opencode.ai/config.json";

function ferrisSearchEntry() {
  return {
    type: "local",
    command: ["ferris-search"],
    env: { DEFAULT_SEARCH_ENGINE: "bing" },
    enabled: true,
  };
}

function failure(paths, cause, action, binaryInstalled = false) {
  return {
    status: "failed",
    globalConfigPath: paths.globalConfigPath,
    binaryInstalled,
    cause,
    action,
  };
}

/**
 * The web search MCP is only available on the platforms that ship a binary.
 */
export function isFerrisSearchSupported(platform = process.platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

/**
 * Resolve the per-user binary and OpenCode configuration paths.
 */
export function resolveFerrisSearchPaths({
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  flowtaskDir,
} = {}) {
  if (!flowtaskDir) throw new Error("flowtaskDir is required to resolve ferris-search paths");
  const binaryName = platform === "win32"
    ? `ferris-search-windows-${arch}.exe`
    : `ferris-search-darwin-${arch}`;
  const globalConfigDir = path.join(homeDir, ".config", "opencode");
  return {
    sourceBinary: path.join(flowtaskDir, "bin", binaryName),
    destinationBinary: path.join(
      homeDir,
      ".opencode",
      "bin",
      platform === "win32" ? "ferris-search.exe" : "ferris-search",
    ),
    globalConfigDir,
    globalConfigPath: path.join(globalConfigDir, "opencode.json"),
  };
}

/**
 * True when the OpenCode configuration declares the web search MCP entry,
 * regardless of its enabled flag.
 */
export function hasFerrisSearch(config) {
  return Boolean(
    config &&
    typeof config === "object" &&
    config.mcp &&
    typeof config.mcp === "object" &&
    !Array.isArray(config.mcp) &&
    Object.prototype.hasOwnProperty.call(config.mcp, FERRIS_SEARCH_KEY),
  );
}

/**
 * Pure removal of the project-local web search entry. An empty mcp section is
 * removed as well so the target keeps no trace of the entry.
 */
export function withoutFerrisSearch(config) {
  if (!hasFerrisSearch(config)) return { config, removed: false };

  const next = { ...config };
  const mcp = { ...config.mcp };
  delete mcp[FERRIS_SEARCH_KEY];
  if (Object.keys(mcp).length === 0) delete next.mcp;
  else next.mcp = mcp;
  return { config: next, removed: true };
}

/**
 * Read the per-user OpenCode configuration without writing anything.
 */
export function readGlobalConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { exists: false, config: {}, invalid: false, error: null };
  }

  try {
    const content = fs.readFileSync(configPath, "utf8").trim();
    if (!content) return { exists: true, config: {}, invalid: false, error: null };

    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        exists: true,
        config: null,
        invalid: true,
        error: "the configuration is not a JSON object",
      };
    }
    return { exists: true, config: parsed, invalid: false, error: null };
  } catch (err) {
    return { exists: true, config: null, invalid: true, error: err.message };
  }
}

/**
 * Write JSON through a temporary file, rename, and read-back verification.
 * Any failure restores the original bytes and removes the temporary file.
 */
export function writeJsonAtomic(configPath, value) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const tempPath = `${configPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, configPath);
    const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (JSON.stringify(verified) !== JSON.stringify(value)) {
      throw new Error("destination verification failed");
    }
  } catch (err) {
    try {
      if (original) fs.writeFileSync(configPath, original);
      else fs.rmSync(configPath, { force: true });
      fs.rmSync(tempPath, { force: true });
    } catch { /* preserve the original error */ }
    throw err;
  }
}

/**
 * Copy the binary through a temporary file so a partial copy never replaces a
 * working executable.
 */
export function installBinary({ sourceBinary, destinationBinary }) {
  fs.mkdirSync(path.dirname(destinationBinary), { recursive: true });
  const tempPath = `${destinationBinary}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(sourceBinary, tempPath);
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, destinationBinary);
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original error */ }
    throw err;
  }
}

/**
 * Reconcile the web search MCP on the per-user OpenCode configuration.
 * The caller owns all user-facing reporting: this function never logs.
 */
export async function ensureGlobalFerrisSearch({
  flowtaskDir,
  readline,
  homeDir = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  isTTY = Boolean(process.stdin?.isTTY),
} = {}) {
  const paths = resolveFerrisSearchPaths({ homeDir, platform, arch, flowtaskDir });

  if (!isFerrisSearchSupported(platform)) {
    return {
      status: "unsupported",
      globalConfigPath: paths.globalConfigPath,
      binaryInstalled: false,
      cause: null,
      action: null,
    };
  }

  const initial = readGlobalConfig(paths.globalConfigPath);
  if (initial.invalid) {
    return failure(
      paths,
      `the global OpenCode configuration is not valid JSON (${initial.error})`,
      `fix or remove ${paths.globalConfigPath} and retry with flowtask update`,
    );
  }

  if (hasFerrisSearch(initial.config)) {
    if (fs.existsSync(paths.destinationBinary)) {
      return {
        status: "configured",
        globalConfigPath: paths.globalConfigPath,
        binaryInstalled: false,
        cause: null,
        action: null,
      };
    }
    if (!fs.existsSync(paths.sourceBinary)) {
      return failure(
        paths,
        `the ferris-search binary is missing from ${paths.destinationBinary} and ${paths.sourceBinary}`,
        "reinstall FlowTask and retry with flowtask update",
      );
    }
    try {
      installBinary({ sourceBinary: paths.sourceBinary, destinationBinary: paths.destinationBinary });
    } catch (err) {
      return failure(
        paths,
        `could not restore ${paths.destinationBinary}: ${err.message}`,
        "check permissions/space and retry with flowtask update",
      );
    }
    return {
      status: "configured",
      globalConfigPath: paths.globalConfigPath,
      binaryInstalled: true,
      cause: null,
      action: null,
    };
  }

  if (!isTTY || !readline || typeof readline.createInterface !== "function") {
    return {
      status: "skipped",
      globalConfigPath: paths.globalConfigPath,
      binaryInstalled: false,
      cause: null,
      action: null,
    };
  }

  if (!fs.existsSync(paths.sourceBinary)) {
    return failure(
      paths,
      `the ferris-search binary was not found at ${paths.sourceBinary}`,
      "reinstall FlowTask and retry with flowtask update",
    );
  }

  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `${COLORS.cyan}?${COLORS.reset} Install ferris-search MCP for web search in OpenCode (this user)? ${COLORS.dim}(Y/n):${COLORS.reset} `,
      (value) => {
        rl.close();
        resolve(String(value ?? "").trim().toLowerCase());
      },
    );
  });

  if (answer === "n" || answer === "no") {
    return {
      status: "declined",
      globalConfigPath: paths.globalConfigPath,
      binaryInstalled: false,
      cause: null,
      action: null,
    };
  }

  try {
    installBinary({ sourceBinary: paths.sourceBinary, destinationBinary: paths.destinationBinary });
  } catch (err) {
    return failure(
      paths,
      `could not install ${paths.destinationBinary}: ${err.message}`,
      "check permissions/space and retry with flowtask update",
    );
  }

  const current = readGlobalConfig(paths.globalConfigPath);
  if (current.invalid) {
    return failure(
      paths,
      `the global OpenCode configuration is not valid JSON (${current.error})`,
      `fix or remove ${paths.globalConfigPath} and retry with flowtask update`,
      true,
    );
  }

  const next = { ...current.config };
  const mcp = next.mcp && typeof next.mcp === "object" && !Array.isArray(next.mcp) ? next.mcp : {};
  next.mcp = { ...mcp, [FERRIS_SEARCH_KEY]: ferrisSearchEntry() };
  if (!next.$schema) next.$schema = GLOBAL_SCHEMA;

  try {
    writeJsonAtomic(paths.globalConfigPath, next);
  } catch (err) {
    return failure(
      paths,
      `could not write ${paths.globalConfigPath}: ${err.message}`,
      "check permissions/space and retry with flowtask update",
      true,
    );
  }

  return {
    status: "installed",
    globalConfigPath: paths.globalConfigPath,
    binaryInstalled: true,
    cause: null,
    action: null,
  };
}
