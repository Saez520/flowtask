import fs from "fs";
import os from "os";
import path from "path";
import { logInfo, fileExists } from "./logger.js";
import { findOpencodeConfig, mergeAgentEntries, pluginEntryPath } from "./opencode.js";
import {
  readUserRuntimeManifest,
  resolveUserPayloadPaths,
  resolveUserRuntimePaths,
  writeFileAtomic,
} from "./user-runtime.js";

const FLOWTASK_AGENT_PREFIX = "flowtask-";
const FLOWTASK_PLUGINS = Object.freeze(["flowtask-permission-gate", "flowtask-context-checkpoint"]);
const DEFAULT_ENGRAM = Object.freeze({
  type: "local",
  command: Object.freeze(["engram", "mcp"]),
  enabled: true,
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const value = JSON.parse(raw);
  if (!isPlainObject(value)) throw new Error(`${filePath} is not a JSON object`);
  return value;
}

/** Resolve the user-level OpenCode configuration directory. */
export function resolveOpencodeUserPaths(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const configDir = options.configDir ?? (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "opencode")
    : process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(homeDir, ".config", "opencode"));
  return {
    configDir,
    configPath: path.join(configDir, "opencode.json"),
    jsoncPath: path.join(configDir, "opencode.jsonc"),
  };
}

/**
 * Read the user-level OpenCode configuration. Only JSON is managed: a JSONC
 * file, alone or next to the JSON file, fails closed without writing.
 */
export function readOpencodeGlobalConfig(options = {}) {
  const paths = resolveOpencodeUserPaths(options);
  const hasJson = fileExists(paths.configPath);
  const hasJsonc = fileExists(paths.jsoncPath);
  if (hasJsonc) {
    return {
      status: "jsonc_unmanaged",
      config: null,
      path: paths.configPath,
      jsoncPath: paths.jsoncPath,
      paths,
      reason: `unmanaged JSONC configuration at ${paths.jsoncPath}`,
    };
  }
  if (!hasJson) return { status: "absent", config: {}, path: paths.configPath, paths };

  try {
    return { status: "ok", config: readJsonObject(paths.configPath), path: paths.configPath, paths };
  } catch (error) {
    return { status: "invalid", config: null, path: paths.configPath, paths, reason: error.message };
  }
}

function stableEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Write the user-level OpenCode configuration atomically when it changed. */
export function writeOpencodeGlobalConfig(config, options = {}) {
  const paths = options.paths ?? resolveOpencodeUserPaths(options);
  if (!isPlainObject(config)) throw new Error("the OpenCode global configuration must be a JSON object");
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (fileExists(paths.configPath) && fs.readFileSync(paths.configPath, "utf8") === serialized) {
    return { ok: true, changed: false, path: paths.configPath, config };
  }
  fs.mkdirSync(paths.configDir, { recursive: true });
  writeFileAtomic(paths.configPath, serialized);
  const verified = readJsonObject(paths.configPath);
  if (!stableEqual(verified, config)) throw new Error(`verification of ${paths.configPath} failed`);
  return { ok: true, changed: true, path: paths.configPath, config };
}

function canonicalConfig(flowtaskDir) {
  const source = findOpencodeConfig(flowtaskDir);
  if (!source) throw new Error("the canonical OpenCode configuration was not found");
  return readJsonObject(source);
}

function payloadAgentPath(payloadPaths, agentName) {
  if (agentName === "flowtask-runner") return path.join(payloadPaths.payloadDir, "runner.md");
  return path.join(payloadPaths.agentsDir, `${agentName.slice(FLOWTASK_AGENT_PREFIX.length)}.md`);
}

function desiredAgents(canonical, payloadPaths) {
  const agents = {};
  for (const [name, entry] of Object.entries(canonical.agents ?? {})) {
    if (!name.startsWith(FLOWTASK_AGENT_PREFIX) || !isPlainObject(entry)) continue;
    const systemPath = payloadAgentPath(payloadPaths, name);
    if (!fileExists(systemPath)) {
      const error = new Error(`The canonical payload is missing the agent ${name} at ${systemPath}. Run: flowtask install`);
      error.code = "opencode_payload_agent_missing";
      throw error;
    }
    agents[name] = { ...entry, system: `{file:${systemPath}}` };
  }
  return agents;
}

function flowTaskPluginEntry(runtimePaths, name, options) {
  return {
    package: path.join(runtimePaths.pluginsDir, name),
    options,
  };
}

function isOurPluginEntry(entry, runtimeRoot) {
  const entryPath = pluginEntryPath(entry);
  if (typeof entryPath !== "string") return false;
  const normalized = entryPath.replaceAll("\\", "/");
  const runtime = runtimeRoot.replaceAll("\\", "/");
  return normalized.startsWith(`${runtime}/plugins/`) || normalized.includes("/flowtask/plugins/");
}

function isFlowTaskAgent(name) {
  return typeof name === "string" && name.startsWith(FLOWTASK_AGENT_PREFIX);
}

/**
 * Apply the FlowTask-owned surface to the user-level OpenCode configuration.
 *
 * Only FlowTask keys are added or replaced; the consumer keeps custom agents,
 * skills, plugins, commands and MCP servers. Stale FlowTask agents are removed.
 */
export function applyOpencodeGlobalSurface(config, {
  flowtaskDir,
  runtimeManifest,
  runtimeRoot,
  commandSource = null,
} = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const canonical = commandSource ?? canonicalConfig(flowtaskDir);
  const payloadPaths = resolveUserPayloadPaths(root, runtimeManifest, "canonical");
  const next = isPlainObject(config) ? { ...config } : {};
  if (!next.$schema) next.$schema = "https://opencode.ai/config.json";

  // Agents: FlowTask owns its own entries; user entries are untouched.
  const agents = { ...(isPlainObject(next.agents) ? next.agents : {}) };
  for (const name of Object.keys(agents)) {
    if (isFlowTaskAgent(name) && !(name in (canonical.agents ?? {}))) delete agents[name];
  }
  next.agents = mergeAgentEntries(agents, desiredAgents(canonical, payloadPaths));

  // Skills: one directory per active payload, stale payload directories removed.
  const skills = Array.isArray(next.skills) ? next.skills : [];
  const payloadSkills = payloadPaths.skillsDir;
  const filteredSkills = skills.filter((entry) => {
    if (typeof entry !== "string") return true;
    const normalized = entry.replaceAll("\\", "/");
    if (normalized === payloadSkills.replaceAll("\\", "/")) return false;
    return !normalized.includes("/versions/") || !normalized.endsWith("/skills");
  });
  next.skills = [...filteredSkills, payloadSkills];

  // Plugins: global packages with their options; stale FlowTask entries removed.
  const plugins = Array.isArray(next.plugins) ? next.plugins : [];
  const runtimePaths = resolveUserRuntimePaths({ runtimeRoot: root });
  const keptPlugins = plugins.filter((entry) => !isOurPluginEntry(entry, root));
  keptPlugins.push(
    flowTaskPluginEntry(runtimePaths, "flowtask-permission-gate", {
      configDir: runtimePaths.configDir,
      runtimeRoot: root,
    }),
    flowTaskPluginEntry(runtimePaths, "flowtask-context-checkpoint", { runtimeRoot: root }),
  );
  next.plugins = keptPlugins;
  if (Array.isArray(next.plugin)) {
    next.plugin = next.plugin.filter((entry) => !isOurPluginEntry(entry, root));
    if (next.plugin.length === 0) delete next.plugin;
  }

  // Commands: canonical FlowTask commands are added when absent.
  if (isPlainObject(canonical.commands)) {
    const commands = { ...(isPlainObject(next.commands) ? next.commands : {}) };
    for (const [name, value] of Object.entries(canonical.commands)) {
      if (!Object.prototype.hasOwnProperty.call(commands, name)) commands[name] = value;
    }
    next.commands = commands;
  }

  if (!Object.prototype.hasOwnProperty.call(next, "default_agent")) {
    next.default_agent = canonical.default_agent ?? "flowtask-runner";
  }

  let engramManaged = false;
  const mcp = { ...(isPlainObject(next.mcp) ? next.mcp : {}) };
  if (!Object.prototype.hasOwnProperty.call(mcp, "engram")) {
    mcp.engram = isPlainObject(canonical.mcp?.engram) ? canonical.mcp.engram : { ...DEFAULT_ENGRAM };
    engramManaged = true;
  }
  if (Object.keys(mcp).length > 0) next.mcp = mcp;

  return { config: next, engramManaged };
}

/**
 * Ensure the user-level OpenCode surface. The function reads, applies, compares
 * and writes only when the serialized configuration changed.
 */
export function ensureOpencodeGlobalSurface({ flowtaskDir, runtimeRoot = null, commandSource = null } = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const userPaths = resolveOpencodeUserPaths();
  const read = readOpencodeGlobalConfig({ configDir: userPaths.configDir });
  if (read.status === "jsonc_unmanaged" || read.status === "invalid") {
    return {
      ok: false,
      status: read.status,
      path: read.path,
      reason: read.reason,
      config: null,
      engramManaged: false,
    };
  }

  const runtimeManifest = readUserRuntimeManifest(root);
  const applied = applyOpencodeGlobalSurface(read.config, {
    flowtaskDir,
    runtimeManifest,
    runtimeRoot: root,
    commandSource,
  });
  const written = writeOpencodeGlobalConfig(applied.config, { paths: userPaths });
  if (written.changed) {
    logInfo(read.status === "absent"
      ? `OpenCode global configuration created at ${written.path}.`
      : `OpenCode global configuration updated at ${written.path}.`);
  }
  return {
    ok: true,
    status: written.changed ? (read.status === "absent" ? "created" : "updated") : "unchanged",
    path: written.path,
    config: applied.config,
    engramManaged: applied.engramManaged,
  };
}

/** Remove the FlowTask-owned surface and preserve everything else. */
export function removeOpencodeGlobalSurface({
  flowtaskDir,
  runtimeRoot = null,
  commandSource = null,
} = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const userPaths = resolveOpencodeUserPaths();
  const read = readOpencodeGlobalConfig({ configDir: userPaths.configDir });
  if (read.status === "absent") return { ok: true, status: "absent", path: read.path, removed: [] };
  if (read.status !== "ok") return { ok: false, status: read.status, path: read.path, reason: read.reason, removed: [] };

  const canonical = commandSource ?? (() => {
    try { return canonicalConfig(flowtaskDir); } catch { return {}; }
  })();
  const next = { ...read.config };
  const removed = [];

  if (isPlainObject(next.agents)) {
    const agents = { ...next.agents };
    for (const name of Object.keys(agents)) {
      if (isFlowTaskAgent(name)) {
        delete agents[name];
        removed.push(`agents.${name}`);
      }
    }
    if (Object.keys(agents).length > 0) next.agents = agents;
    else delete next.agents;
  }

  if (Array.isArray(next.skills)) {
    const skills = next.skills.filter((entry) => {
      if (typeof entry !== "string") return true;
      const normalized = entry.replaceAll("\\", "/");
      const ours = normalized.startsWith(`${root.replaceAll("\\", "/")}/versions/`) || normalized === root;
      if (ours) removed.push(`skills:${entry}`);
      return !ours;
    });
    if (skills.length > 0) next.skills = skills;
    else delete next.skills;
  }

  if (Array.isArray(next.plugins)) {
    const plugins = next.plugins.filter((entry) => {
      const ours = isOurPluginEntry(entry, root);
      if (ours) removed.push("plugins");
      return !ours;
    });
    if (plugins.length > 0) next.plugins = plugins;
    else delete next.plugins;
  }

  if (isPlainObject(next.commands) && isPlainObject(canonical.commands)) {
    const commands = { ...next.commands };
    for (const [name, value] of Object.entries(canonical.commands)) {
      if (stableEqual(commands[name], value)) {
        delete commands[name];
        removed.push(`commands.${name}`);
      }
    }
    if (Object.keys(commands).length > 0) next.commands = commands;
    else delete next.commands;
  }

  if (next.default_agent === "flowtask-runner") {
    delete next.default_agent;
    removed.push("default_agent");
  }

  const template = isPlainObject(canonical.mcp?.engram) ? canonical.mcp.engram : DEFAULT_ENGRAM;
  if (isPlainObject(next.mcp) && stableEqual(next.mcp.engram, template)) {
    const mcp = { ...next.mcp };
    delete mcp.engram;
    if (Object.keys(mcp).length > 0) next.mcp = mcp;
    else delete next.mcp;
    removed.push("mcp.engram");
  }

  const written = writeOpencodeGlobalConfig(next, { paths: userPaths });
  return { ok: true, status: written.changed ? "removed" : "unchanged", path: written.path, removed };
}

/** Ensure Engram is present in the user-level OpenCode MCP map. */
export function ensureOpencodeEngram({ flowtaskDir, runtimeRoot = null } = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const userPaths = resolveOpencodeUserPaths();
  const read = readOpencodeGlobalConfig({ configDir: userPaths.configDir });
  if (read.status !== "ok" && read.status !== "absent") {
    return { ok: false, status: read.status, reason: read.reason, managed: false };
  }
  const config = { ...read.config };
  const mcp = { ...(isPlainObject(config.mcp) ? config.mcp : {}) };
  if (Object.prototype.hasOwnProperty.call(mcp, "engram")) {
    return { ok: true, status: "present", managed: false, path: read.path };
  }
  let template = { ...DEFAULT_ENGRAM };
  try {
    const canonical = canonicalConfig(flowtaskDir);
    if (isPlainObject(canonical.mcp?.engram)) template = canonical.mcp.engram;
  } catch {
    // The default template is enough when the canonical source is unavailable.
  }
  mcp.engram = template;
  config.mcp = mcp;
  const written = writeOpencodeGlobalConfig(config, { paths: userPaths });
  logInfo(`Engram registered in the OpenCode user configuration at ${written.path}.`);
  return { ok: true, status: "added", managed: true, path: written.path };
}
