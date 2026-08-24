import fs from "fs";
import path from "path";
import { logInfo, logWarn, logSuccess, logError, findExecutable, isBinaryInstalled } from "./logger.js";
import { deepMergeObjects } from "./opencode.js";

// ─── Supported MCP targets ────────────────────────────────────────────────────

const SUPPORTED_MCP_TARGETS = new Set(["opencode", "claude"]);

// ─── MCP configuration builders ──────────────────────────────────────────────

/**
 * Build the OpenCode MCP entry for Graphify.
 * @param {string} graphPath - relative path to graph.json (e.g. "graphify-out/graph.json")
 * @returns {object} MCP config object
 */
export function resolveGraphifyLauncher(detectFn = isBinaryInstalled) {
  // This resolves an executable only. Runtime/import health is checked by the
  // graphify coordinator before it records query_status=success.
  for (const launcher of ["graphify-mcp", "python", "python3"]) {
    if (detectFn(launcher)) return launcher;
  }
  return "python";
}

/**
 * Resolve the Python interpreter behind graphify-mcp when possible. This is
 * needed to test the package environment selected by pipx/uv, not an
 * unrelated system Python merely because it is available on PATH.
 */
export function resolveGraphifyPython(detectFn = isBinaryInstalled) {
  const launcher = resolveGraphifyLauncher(detectFn);
  if (launcher === "graphify-mcp") {
    const executable = findExecutable("graphify-mcp");
    if (executable) {
      try {
        const firstLine = fs.readFileSync(executable, "utf8").split(/\r?\n/, 1)[0];
        if (firstLine.startsWith("#!")) {
          const shebang = firstLine.slice(2).trim().split(/\s+/);
          if (shebang[0].endsWith("/env") && shebang[1]) return shebang[1];
          if (shebang[0]) return shebang[0];
        }
        const bundledPython = path.join(path.dirname(executable), process.platform === "win32" ? "python.exe" : "python");
        if (fs.existsSync(bundledPython)) return bundledPython;
      } catch {
        // Fall through to the regular Python executable checks.
      }
    }
  }
  if (detectFn("python")) return "python";
  if (detectFn("python3")) return "python3";
  return null;
}

export function buildOpencodeMcpEntry(graphPath, opts = {}) {
  const launcher = resolveGraphifyLauncher(opts.detectFn);
  return {
    type: "local",
    command: launcher === "graphify-mcp"
      ? [launcher, graphPath]
      : [launcher, "-m", "graphify.serve", graphPath],
    enabled: true,
  };
}

/**
 * Build the Claude .mcp.json entry for Graphify.
 * @param {string} graphPath - relative path to graph.json
 * @returns {object} MCP config object
 */
export function buildClaudeMcpEntry(graphPath, opts = {}) {
  const launcher = resolveGraphifyLauncher(opts.detectFn);
  return {
    command: launcher,
    args: launcher === "graphify-mcp" ? [graphPath] : ["-m", "graphify.serve", graphPath],
  };
}

// ─── MCP merger for OpenCode ─────────────────────────────────────────────────

/**
 * Merge Graphify MCP entry into an OpenCode config file.
 * Idempotent: replaces existing `graphify` entry, preserves others.
 *
 * @param {string} configPath - path to opencode.json
 * @param {string} graphPath  - relative path to graph.json
 * @returns {{ success: boolean, warning: string|null }}
 */
export function mergeGraphifyOpencodeMcp(configPath, graphPath, opts = {}) {
  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8").trim();
      if (content) {
        try { config = JSON.parse(content); } catch { config = {}; }
      }
    }

    if (!config.mcp) config.mcp = {};
    config.mcp.graphify = buildOpencodeMcpEntry(graphPath, opts);

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return { success: true, warning: null };
  } catch (err) {
    return {
      success: false,
      warning: `Graphify MCP (opencode): no se pudo escribir ${configPath} (${err.message}).`,
    };
  }
}

// ─── MCP merger for Claude ───────────────────────────────────────────────────

/**
 * Merge Graphify MCP entry into a Claude .mcp.json file.
 * Idempotent: replaces existing `graphify` entry, preserves others.
 *
 * @param {string} mcpJsonPath - path to .mcp.json
 * @param {string} graphPath   - relative path to graph.json
 * @returns {{ success: boolean, warning: string|null }}
 */
export function mergeGraphifyClaudeMcp(mcpJsonPath, graphPath, opts = {}) {
  try {
    let config = {};
    if (fs.existsSync(mcpJsonPath)) {
      const content = fs.readFileSync(mcpJsonPath, "utf8").trim();
      if (content) {
        try { config = JSON.parse(content); } catch { config = {}; }
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.graphify = buildClaudeMcpEntry(graphPath, opts);

    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf8");
    return { success: true, warning: null };
  } catch (err) {
    return {
      success: false,
      warning: `Graphify MCP (claude): no se pudo escribir ${mcpJsonPath} (${err.message}).`,
    };
  }
}

// ─── MCP orchestration ───────────────────────────────────────────────────────

/**
 * Configure MCP for selected CLI targets.
 * Only `opencode` and `claude` are supported; others produce a non-blocking warning.
 *
 * @param {object} params
 * @param {string} params.projectDir
 * @param {string[]} params.selectedClis
 * @param {string} params.graphPath - relative path to graph.json
 * @param {string} [params.ideDir]  - IDE directory name (e.g. ".opencode", ".claude")
 * @returns {{ status: string, warning: string|null, details: object[] }}
 */
export function configureMcpForTargets({ projectDir, selectedClis, graphPath, detectFn }) {
  const warnings = [];
  const details = [];

  for (const cli of selectedClis) {
    if (!SUPPORTED_MCP_TARGETS.has(cli)) {
      const w = `Graphify MCP: target "${cli}" no soportado para MCP; se omite configuración.`;
      warnings.push(w);
      details.push({ target: cli, status: "unsupported", warning: w });
      continue;
    }

    if (cli === "opencode") {
      const configPath = path.join(projectDir, ".opencode", "opencode.json");
      const result = mergeGraphifyOpencodeMcp(configPath, graphPath, { detectFn });
      details.push({ target: cli, status: result.success ? "success" : "failed", ...result });
      if (result.warning) warnings.push(result.warning);
    }

    if (cli === "claude") {
      const mcpJsonPath = path.join(projectDir, ".mcp.json");
      const result = mergeGraphifyClaudeMcp(mcpJsonPath, graphPath, { detectFn });
      details.push({ target: cli, status: result.success ? "success" : "failed", ...result });
      if (result.warning) warnings.push(result.warning);
    }
  }

  const allUnsupported = details.length > 0 && details.every((d) => d.status === "unsupported");
  const allSuccess = details.every((d) => d.status === "success" || d.status === "unsupported");
  return {
    status: details.length === 0 || allUnsupported ? "unsupported" : allSuccess ? "success" : "failed",
    warning: warnings.length > 0 ? warnings[warnings.length - 1] : null,
    details,
  };
}
