import fs from "fs";
import path from "path";

export const WORKTREE_MANAGER_MCP_SERVER = "worktree_manager";
export const WORKTREE_MANAGER_MCP_MODULE = "worktree_manager.mcp_transport";
export const DEFAULT_PYTHON_BIN = "python3";

const SECTION_BY_FORMAT = Object.freeze({ opencode: "mcp", claude: "mcpServers" });
const PYTHON_BIN_PATTERN = /^python3(?:\.\d+)*$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Canonical server entry for one destination configuration format. */
export function buildWorktreeManagerMcpEntry(format, managerDir, pythonBin = DEFAULT_PYTHON_BIN) {
  if (format === "opencode") {
    return {
      type: "local",
      command: [pythonBin, "-m", WORKTREE_MANAGER_MCP_MODULE],
      environment: { PYTHONPATH: managerDir },
      enabled: true,
    };
  }
  if (format === "claude") {
    return {
      type: "stdio",
      command: pythonBin,
      args: ["-m", WORKTREE_MANAGER_MCP_MODULE],
      env: { PYTHONPATH: managerDir },
    };
  }
  throw new Error(`unsupported MCP configuration format: ${format}`);
}

/**
 * Whether an existing entry has the shape FlowTask writes, so its managed
 * PYTHONPATH may be refreshed. Any other shape belongs to the user.
 */
export function isFlowTaskWorktreeManagerEntry(entry, format) {
  if (!isPlainObject(entry)) return false;
  if (format === "opencode") {
    return entry.type === "local"
      && Array.isArray(entry.command)
      && entry.command.length === 3
      && typeof entry.command[0] === "string"
      && PYTHON_BIN_PATTERN.test(entry.command[0])
      && entry.command[1] === "-m"
      && entry.command[2] === WORKTREE_MANAGER_MCP_MODULE
      && isPlainObject(entry.environment)
      && entry.enabled === true;
  }
  if (format === "claude") {
    return entry.type === "stdio"
      && typeof entry.command === "string"
      && PYTHON_BIN_PATTERN.test(entry.command)
      && Array.isArray(entry.args)
      && entry.args.length === 2
      && entry.args[0] === "-m"
      && entry.args[1] === WORKTREE_MANAGER_MCP_MODULE
      && isPlainObject(entry.env);
  }
  return false;
}

function managerDirectoryCause(managerDir) {
  if (typeof managerDir !== "string" || !path.isAbsolute(managerDir)) {
    return "the managed Worktree Manager directory is not an absolute path";
  }
  if (!fs.existsSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"))) {
    return `the MCP entrypoint is missing from ${managerDir}`;
  }
  return null;
}

/** Write with a temporary file, rename, re-read and deep comparison. */
function writeJsonVerified(configPath, value) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const tempPath = `${configPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, configPath);
    const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!sameJson(verified, value)) throw new Error("destination verification failed");
  } catch (error) {
    try {
      if (original) fs.writeFileSync(configPath, original);
      else fs.rmSync(configPath, { force: true });
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original error; the recovery is best-effort.
    }
    throw error;
  }
}

/**
 * Register the Worktree Manager MCP server in one project configuration.
 *
 * Returns one of: `registered`, `unchanged`, `preserved` (a foreign entry or an
 * unreadable document stays untouched), `unavailable` (the manager has no MCP
 * entrypoint) or `failed` (the write could not be verified).
 */
export function registerWorktreeManagerMcp({
  configPath,
  format,
  managerDir,
  pythonBin = DEFAULT_PYTHON_BIN,
}) {
  const sectionKey = SECTION_BY_FORMAT[format];
  if (!sectionKey) {
    return { status: "failed", cause: `unsupported MCP configuration format: ${format}` };
  }
  if (typeof configPath !== "string" || !configPath) {
    return { status: "failed", cause: "the configuration path is missing" };
  }
  const managerCause = managerDirectoryCause(managerDir);
  if (managerCause) return { status: "unavailable", cause: managerCause };

  let config = {};
  if (fs.existsSync(configPath)) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (error) {
      return { status: "preserved", cause: `the existing configuration is unreadable: ${error.message}` };
    }
    if (raw.trim()) {
      try {
        config = JSON.parse(raw);
      } catch (error) {
        return { status: "preserved", cause: `the existing configuration is not valid JSON: ${error.message}` };
      }
    }
    if (!isPlainObject(config)) {
      return { status: "preserved", cause: "the existing configuration is not a JSON object" };
    }
  }

  const section = config[sectionKey];
  if (section !== undefined && !isPlainObject(section)) {
    return { status: "preserved", cause: `the existing ${sectionKey} section is not a JSON object` };
  }
  const current = section?.[WORKTREE_MANAGER_MCP_SERVER];
  if (current !== undefined && !isFlowTaskWorktreeManagerEntry(current, format)) {
    return { status: "preserved", cause: `the existing ${WORKTREE_MANAGER_MCP_SERVER} entry belongs to the user` };
  }

  const entry = buildWorktreeManagerMcpEntry(format, managerDir, pythonBin);
  if (current !== undefined && sameJson(current, entry)) {
    return { status: "unchanged", configPath, entry };
  }

  const next = {
    ...config,
    [sectionKey]: { ...(section ?? {}), [WORKTREE_MANAGER_MCP_SERVER]: entry },
  };
  try {
    writeJsonVerified(configPath, next);
  } catch (error) {
    return { status: "failed", cause: error.message };
  }
  return { status: "registered", configPath, entry };
}
