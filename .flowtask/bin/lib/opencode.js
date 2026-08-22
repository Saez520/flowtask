import fs from "fs";
import path from "path";
import { logInfo, logWarn, logSuccess, logError, fileExists } from "./logger.js";

/**
 * Deep merge two plain objects; source values take precedence.
 */
export function deepMergeObjects(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv === undefined) continue;
    if (
      typeof sv === "object" && sv !== null && !Array.isArray(sv) &&
      typeof tv === "object" && tv !== null && !Array.isArray(tv)
    ) {
      result[key] = deepMergeObjects(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

/**
 * Locate the FlowTask opencode.json config (checks several fallback paths).
 */
export function findOpencodeConfig(flowtaskDir) {
  const candidates = [
    path.join(flowtaskDir, "opencode.json"),
    path.join(flowtaskDir, "config", "opencode.json"),
    path.join(flowtaskDir, "..", "opencode.json"),
    path.join(flowtaskDir, "..", ".opencode", "opencode.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      logInfo(`Found FlowTask config at: ${p}`);
      return p;
    }
  }
  logWarn("Could not find FlowTask opencode.json configuration file");
  return null;
}

/**
 * Rewrite {file:.flowtask/…} references to {file:flowtask/…} (relative to ideDir).
 */
function adjustConfigPaths(config, targetSubDir) {
  const normalizedTarget = targetSubDir.replace(/\\/g, "/");

  const adjustString = (str) => {
    if (typeof str !== "string") return str;
    if (str.includes(normalizedTarget)) return str;
    return str.replace(/\{file:\.flowtask\//g, "{file:flowtask/");
  };

  const adjustValue = (value) => {
    if (typeof value === "string") return adjustString(value);
    if (Array.isArray(value)) return value.map(adjustValue);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, adjustValue(v)]));
    }
    return value;
  };

  return adjustValue(config);
}

/**
 * Extract plugin name from a path (e.g., ".opencode/plugins/flowtask-classifier/index.js" → "flowtask-classifier")
 */
function extractPluginName(pluginPath) {
  if (typeof pluginPath !== "string") return null;
  const normalized = pluginPath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/|\\)plugins\/([^\/\\]+)/);
  return match ? match[1] : null;
}

function isFlowTaskPluginEntry(entry) {
  const entryPath = typeof entry === "string" ? entry : entry?.path;
  if (typeof entryPath !== "string") return false;
  const normalized = entryPath.replace(/\\/g, "/");
  const name = extractPluginName(entryPath);
  return Boolean(name?.includes("flowtask-") || normalized.includes("flowtask-"));
}

function mergeMissingObjects(target, source) {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined || Object.prototype.hasOwnProperty.call(result, key)) {
      if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) &&
          result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
        result[key] = mergeMissingObjects(result[key], sourceValue);
      }
      continue;
    }
    result[key] = sourceValue;
  }
  return result;
}

function normalizePluginEntries(existing, incoming) {
  const result = [];
  const indexes = new Map();
  const incomingByName = new Map();
  for (const entry of incoming) {
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    const name = extractPluginName(entryPath);
    if (name && !incomingByName.has(name)) incomingByName.set(name, entry);
  }

  for (const entry of existing) {
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    const name = extractPluginName(entryPath);
    if (isFlowTaskPluginEntry(entry)) {
      if (name && indexes.has(name)) continue;
      if (name) indexes.set(name, result.length);
    }
    result.push(entry);
  }

  for (const entry of incoming) {
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    const name = extractPluginName(entryPath);
    if (name && indexes.has(name)) {
      result[indexes.get(name)] = entry;
    } else {
      if (name) indexes.set(name, result.length);
      result.push(entry);
    }
  }

  // Incoming entries are canonical, but only one entry per FlowTask plugin is kept.
  for (const [name, entry] of incomingByName) {
    const index = indexes.get(name);
    if (index !== undefined) result[index] = entry;
  }
  return result;
}

/**
 * Register a plugin entry in tui.json or opencode.json (generic).
 * Supports both string paths and object entries with path property.
 * Identifies existing entries by plugin name (not just exact path match) to handle path corrections.
 */
export function registerPluginArrayEntry(configPath, entry, schema = "https://opencode.ai/tui.json") {
  try {
    let config;
    if (fileExists(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf8").trim();
        config = content ? JSON.parse(content) : {};
      } catch {
        logError(`${configPath} es inválido o ilegible. Corrígelo y reintenta con flowtask update.`);
        return false;
      }
    } else {
      config = {};
    }

    if (!config) config = {};

    // Ensure base structure
    if (!config.$schema) config.$schema = schema;

    // Initialize plugin array if needed
    let plugins = Array.isArray(config.plugin) ? config.plugin : [];

    // Extract plugin name from new entry
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    const newPluginName = extractPluginName(entryPath);

    // Find existing entry by plugin name OR exact path match
    let existingIndex = -1;
    if (newPluginName) {
      existingIndex = plugins.findIndex(p => {
        const pPath = typeof p === "string" ? p : p?.path;
        const pPluginName = extractPluginName(pPath);
        return pPluginName === newPluginName;
      });
    }

    // Fallback: find by exact path if plugin name extraction failed
    if (existingIndex < 0) {
      existingIndex = plugins.findIndex(p => {
        return (typeof p === "string" && p === entryPath) ||
               (p && p.path === entryPath);
      });
    }

    if (existingIndex >= 0) {
      logInfo(`Replacing existing plugin entry for ${newPluginName || entryPath}`);
      plugins[existingIndex] = entry;
    } else {
      plugins.push(entry);
    }
    config.plugin = normalizePluginEntries(plugins, []);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = fileExists(configPath) ? fs.readFileSync(configPath) : null;
    const tempPath = `${configPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf8");
      fs.renameSync(tempPath, configPath);
      const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (JSON.stringify(verified) !== JSON.stringify(config)) throw new Error("la verificación del destino falló");
    } catch (err) {
      try {
        if (original) fs.writeFileSync(configPath, original);
        else fs.rmSync(configPath, { force: true });
        fs.rmSync(tempPath, { force: true });
      } catch { /* preserve the original error */ }
      throw err;
    }
    logSuccess(`Plugin entry registered in ${path.basename(configPath)}`);
    return true;
  } catch (err) {
    logError(`Failed to register plugin entry en ${configPath}: ${err.message}. Verifica permisos/espacio y reintenta con flowtask update.`);
    return false;
  }
}

/**
 * Merge FlowTask agent/command/mcp/plugin sections into the IDE's opencode.json.
 */
export function mergeOpencodeConfig(ideConfigPath, flowtaskDir, ideDir) {
  const flowtaskOpencodePath = findOpencodeConfig(flowtaskDir);
  if (!flowtaskOpencodePath) return;

  logInfo(`Merging FlowTask configuration into ${ideConfigPath}...`);

  try {
    const ftConfig = JSON.parse(fs.readFileSync(flowtaskOpencodePath, "utf8"));
    let ideConfig = {};

    if (fs.existsSync(ideConfigPath)) {
      const content = fs.readFileSync(ideConfigPath, "utf8").trim();
      if (content) {
        try { ideConfig = JSON.parse(content); } catch { logWarn("Existing opencode.json is invalid, starting fresh."); }
      }
    }

    const targetSubDir = path.join(ideDir, "flowtask");

    for (const section of ["mcp", "agent", "command", "plugin"]) {
      if (!ftConfig[section]) continue;
      const adjusted = adjustConfigPaths(ftConfig[section], targetSubDir);
      if (!ideConfig[section]) {
        ideConfig[section] = section === "plugin"
          ? normalizePluginEntries([], Array.isArray(adjusted) ? adjusted : [])
          : adjusted;
      } else if (section === "plugin") {
        const existing = Array.isArray(ideConfig[section]) ? ideConfig[section] : [];
        const incoming = Array.isArray(adjusted) ? adjusted : [];
        ideConfig[section] = normalizePluginEntries(existing, incoming);
      } else {
        ideConfig[section] = mergeMissingObjects(ideConfig[section], adjusted);
      }
    }

    // The permission gate is the sole Runner enforcement. Remove the legacy
    // managed block from existing targets without touching Runner metadata.
    if (ideConfig.agent?.["flowtask-runner"]) {
      delete ideConfig.agent["flowtask-runner"].permission;
    }

    if (!ideConfig.$schema) ideConfig.$schema = "https://opencode.ai/config.json";

    fs.mkdirSync(path.dirname(ideConfigPath), { recursive: true });
    const original = fs.existsSync(ideConfigPath) ? fs.readFileSync(ideConfigPath) : null;
    const tempPath = `${ideConfigPath}.${process.pid}.tmp`;
    try {
      const content = JSON.stringify(ideConfig, null, 2);
      fs.writeFileSync(tempPath, content, "utf8");
      fs.renameSync(tempPath, ideConfigPath);
      const verified = JSON.parse(fs.readFileSync(ideConfigPath, "utf8"));
      if (JSON.stringify(verified) !== JSON.stringify(ideConfig)) throw new Error("la verificación del destino falló");
    } catch (writeError) {
      try {
        if (original) fs.writeFileSync(ideConfigPath, original);
        else fs.rmSync(ideConfigPath, { force: true });
        fs.rmSync(tempPath, { force: true });
      } catch { /* preserve the original error */ }
      throw writeError;
    }
    logSuccess("Configuration merged successfully.");
  } catch (err) {
    logError(`Failed to merge config: ${err.message}`);
  }
}
