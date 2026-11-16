import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { buildWindowsCommand } from "./worktree-manager-package.js";
import { logSuccess, logWarn } from "./logger.js";

export const CLAUDE_CODE_DESTINATION = "claude-code";
export const CLAUDE_PLUGIN_TIMEOUT_MS = 120000;

const RESTORE_SUBMODULE_ACTION =
  "restore the submodule with git submodule update --init .flowtask/plugins/agent-model-selector and retry with flowtask update";
const UPGRADE_CLAUDE_ACTION = "install Claude Code 2.1.309 or later and retry with flowtask update";
const RETRY_ACTION = "retry with flowtask update";
const MANUAL_INSTALL_ACTION = "run the plugin install manually and retry with flowtask update";

/** Read and parse a JSON file; every failure is reported as data, never thrown. */
function readJsonFile(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, cause: `cannot read ${filePath}: ${error.message}` };
  }
}

/** Resolve `candidate` under `root` and reject any path that leaves it. */
function resolveInside(root, candidate) {
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function unresolved(cause, action = RESTORE_SUBMODULE_ACTION) {
  return { ok: false, cause, action };
}

/**
 * Resolve the marketplace, the plugin entry and the version of a manifest mod.
 *
 * `entry.marketplaceRoot` is relative to `<flowtaskDir>/plugins`; the plugin
 * directory is the manifest entry path and must be the marketplace entry whose
 * `source` resolves to it. A version or an entrypoint missing means the
 * checkout is incomplete, so the caller restores the submodule instead of
 * installing a partial plugin.
 */
export function resolveModTarget(flowtaskDir, entry) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
    return unresolved("the plugin entry declares no path");
  }
  if (typeof entry.marketplaceRoot !== "string" || entry.marketplaceRoot.length === 0) {
    return unresolved(`the plugin entry ${entry.name} declares no marketplaceRoot`);
  }
  const pluginRoot = path.resolve(flowtaskDir, "plugins");
  const marketplaceRoot = resolveInside(pluginRoot, entry.marketplaceRoot);
  if (!marketplaceRoot) {
    return unresolved(`the marketplaceRoot ${entry.marketplaceRoot} escapes ${pluginRoot}`);
  }
  const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  const marketplace = readJsonFile(marketplacePath);
  if (!marketplace.ok) return unresolved(`the marketplace manifest is not readable: ${marketplace.cause}`);
  const marketplaceName = marketplace.value?.name;
  if (typeof marketplaceName !== "string" || marketplaceName.length === 0) {
    return unresolved(`the marketplace manifest at ${marketplacePath} declares no name`);
  }
  const declaredPlugins = Array.isArray(marketplace.value?.plugins) ? marketplace.value.plugins : [];
  const pluginDir = resolveInside(pluginRoot, entry.path);
  if (!pluginDir) {
    return unresolved(`the plugin path ${entry.path} escapes ${pluginRoot}`);
  }
  const declared = declaredPlugins.find((candidate) => {
    if (typeof candidate?.source !== "string") return false;
    return resolveInside(marketplaceRoot, candidate.source) === pluginDir;
  });
  if (!declared) {
    return unresolved(`the marketplace ${marketplaceName} has no entry pointing to ${entry.path}`);
  }
  const pluginManifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const pluginManifest = readJsonFile(pluginManifestPath);
  if (!pluginManifest.ok) return unresolved(`the plugin manifest is not readable: ${pluginManifest.cause}`);
  if (pluginManifest.value?.name !== declared.name) {
    return unresolved(
      `the plugin manifest at ${pluginManifestPath} declares ${pluginManifest.value?.name} instead of ${declared.name}`,
    );
  }
  const version = pluginManifest.value?.version;
  if (typeof version !== "string" || version.length === 0) {
    return unresolved(`the plugin manifest at ${pluginManifestPath} declares no version`);
  }
  const entrypoint = typeof entry.entrypoint === "string" ? resolveInside(pluginDir, entry.entrypoint) : null;
  if (!entrypoint || !fs.existsSync(entrypoint)) {
    return unresolved(`the plugin entrypoint ${entry.entrypoint} is missing under ${entry.path}`);
  }
  return {
    ok: true,
    marketplaceRoot,
    marketplaceName,
    pluginName: declared.name,
    ref: `${declared.name}@${marketplaceName}`,
    version,
  };
}

/**
 * Report whether the plugin manager already has this ref enabled.
 *
 * Unreadable or malformed settings return false so the caller installs, which
 * also adds the marketplace when it is missing.
 */
export function isPluginEnabled(settingsPath, ref) {
  const settings = readJsonFile(settingsPath);
  if (!settings.ok) return false;
  const enabled = settings.value?.enabledPlugins;
  if (!enabled || typeof enabled !== "object" || Array.isArray(enabled)) return false;
  return Object.hasOwn(enabled, ref);
}

/** Last non-empty line of a command's stderr, or its message when stderr is empty. */
function lastStderrLine(error) {
  const lines = String(error?.stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines[lines.length - 1];
  return String(error?.message ?? "the command failed").trim();
}

/**
 * Run the Claude Code plugin manager without a TTY.
 *
 * Returns the captured stdout on success and a cause on failure; the caller
 * decides whether the failure is actionable. Windows needs a single command
 * string because Node rejects an argument array together with `shell: true`.
 */
export function runClaudeCommand(args, { cwd } = {}) {
  const options = {
    cwd,
    encoding: "utf8",
    timeout: CLAUDE_PLUGIN_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  };
  try {
    const stdout = process.platform === "win32"
      ? execSync(buildWindowsCommand("claude", args), { ...options, shell: true })
      : execFileSync("claude", args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: String(stdout ?? "") };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, cause: "claude is not available on PATH" };
    if (error?.killed || error?.signal || error?.code === "ETIMEDOUT") {
      return { ok: false, cause: `claude exceeded ${CLAUDE_PLUGIN_TIMEOUT_MS} ms` };
    }
    return { ok: false, cause: lastStderrLine(error) };
  }
}

function actionForCommandFailure(cause) {
  if (/not available on PATH|not recognized as an internal/i.test(cause)) return UPGRADE_CLAUDE_ACTION;
  if (/exceeded \d+ ms/.test(cause)) return RETRY_ACTION;
  return MANUAL_INSTALL_ACTION;
}

function installArguments(target) {
  return [
    "plugin", "install", target.ref,
    "--marketplace", target.marketplaceRoot,
    "--scope", "user", "-y", "--json",
  ];
}

function updateArguments(target) {
  return [
    ["plugin", "marketplace", "add", target.marketplaceRoot, "--scope", "user"],
    ["plugin", "update", target.ref, "--scope", "user", "-y", "--json"],
  ];
}

function runInstall(runner, target) {
  const result = runner(installArguments(target), {});
  return result?.ok === true
    ? { ok: true, status: "installed" }
    : { ok: false, cause: result?.cause ?? "claude plugin install failed" };
}

function runUpdate(runner, target) {
  for (const args of updateArguments(target)) {
    const result = runner(args, {});
    if (result?.ok !== true) {
      return { ok: false, cause: result?.cause ?? `claude ${args.slice(0, 2).join(" ")} failed` };
    }
  }
  return { ok: true, status: "updated" };
}

/**
 * Install or update every Claude Code mod declared by the plugin manifest.
 *
 * The module never throws: each entry produces one result, failures are
 * reported with cause and next action, and the update continues. The ref is
 * updated when the plugin manager already has it enabled and installed
 * otherwise; when the chosen path fails, the other path is tried once.
 */
export function installClaudeModPlugins({ flowtaskDir, manifest, claudeUserDir, runner = runClaudeCommand }) {
  const results = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (entry?.kind !== "mod" || !Array.isArray(entry.destinations)) continue;
    if (!entry.destinations.includes(CLAUDE_CODE_DESTINATION)) continue;
    const startedAt = Date.now();
    const result = (fields) => ({ name: entry.name, ref: null, version: null, durationMs: Date.now() - startedAt, ...fields });
    const target = resolveModTarget(flowtaskDir, entry);
    if (!target.ok) {
      logWarn(`Claude Code plugin ${entry.name} was not installed: ${target.cause}. ${target.action}.`);
      results.push(result({ status: "failed", cause: target.cause, action: target.action }));
      continue;
    }
    const enabled = isPluginEnabled(path.join(claudeUserDir, "settings.json"), target.ref);
    const outcome = enabled ? runUpdate(runner, target) : runInstall(runner, target);
    const settled = outcome.ok ? outcome : (enabled ? runInstall(runner, target) : runUpdate(runner, target));
    if (settled.ok) {
      logSuccess(`Claude Code plugin ${target.ref} ${target.version} ${settled.status}.`);
      results.push(result({ ref: target.ref, version: target.version, status: settled.status, cause: null, action: null }));
      continue;
    }
    const action = actionForCommandFailure(outcome.cause);
    logWarn(`Claude Code plugin ${target.ref} was not installed: ${outcome.cause}. ${action}.`);
    results.push(result({ ref: target.ref, version: target.version, status: "failed", cause: outcome.cause, action }));
  }
  return results;
}

/** One readable line per result for the update dashboard. */
export function describeClaudeModResults(results) {
  return (Array.isArray(results) ? results : [])
    .map((result) => {
      const state = result?.status === "failed" ? "not installed" : result?.status;
      return [result?.ref ?? result?.name, result?.version, state].filter(Boolean).join(" · ");
    })
    .join(" · ");
}
