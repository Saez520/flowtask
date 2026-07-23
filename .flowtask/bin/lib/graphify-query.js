import fs from "fs";
import path from "path";
import { logInfo, logWarn, logSuccess, logError } from "./logger.js";
import { deepMergeObjects } from "./opencode.js";

// ─── Supported MCP targets ────────────────────────────────────────────────────

const SUPPORTED_MCP_TARGETS = new Set(["opencode", "claude"]);

// ─── MCP configuration builders ──────────────────────────────────────────────

/**
 * Build the OpenCode MCP entry for Graphify.
 * @param {string} graphPath - relative path to graph.json (e.g. "graphify-out/graph.json")
 * @returns {object} MCP config object
 */
export function buildOpencodeMcpEntry(graphPath) {
  return {
    type: "local",
    command: ["python", "-m", "graphify.serve", graphPath],
    enabled: true,
  };
}

/**
 * Build the Claude .mcp.json entry for Graphify.
 * @param {string} graphPath - relative path to graph.json
 * @returns {object} MCP config object
 */
export function buildClaudeMcpEntry(graphPath) {
  return {
    command: "python",
    args: ["-m", "graphify.serve", graphPath],
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
export function mergeGraphifyOpencodeMcp(configPath, graphPath) {
  try {
    let config = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf8").trim();
      if (content) {
        try { config = JSON.parse(content); } catch { config = {}; }
      }
    }

    if (!config.mcp) config.mcp = {};
    config.mcp.graphify = buildOpencodeMcpEntry(graphPath);

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
export function mergeGraphifyClaudeMcp(mcpJsonPath, graphPath) {
  try {
    let config = {};
    if (fs.existsSync(mcpJsonPath)) {
      const content = fs.readFileSync(mcpJsonPath, "utf8").trim();
      if (content) {
        try { config = JSON.parse(content); } catch { config = {}; }
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.graphify = buildClaudeMcpEntry(graphPath);

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
export function configureMcpForTargets({ projectDir, selectedClis, graphPath }) {
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
      const result = mergeGraphifyOpencodeMcp(configPath, graphPath);
      details.push({ target: cli, status: result.success ? "success" : "failed", ...result });
      if (result.warning) warnings.push(result.warning);
    }

    if (cli === "claude") {
      const mcpJsonPath = path.join(projectDir, ".mcp.json");
      const result = mergeGraphifyClaudeMcp(mcpJsonPath, graphPath);
      details.push({ target: cli, status: result.success ? "success" : "failed", ...result });
      if (result.warning) warnings.push(result.warning);
    }
  }

  const allSuccess = details.every((d) => d.status === "success" || d.status === "unsupported");
  return {
    status: allSuccess ? "success" : "failed",
    warning: warnings.length > 0 ? warnings[warnings.length - 1] : null,
    details,
  };
}
