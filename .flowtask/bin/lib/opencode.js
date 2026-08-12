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
  const add = (entry, canonical = false) => {
    const entryPath = typeof entry === "string" ? entry : entry?.path;
    const name = extractPluginName(entryPath);
    if (!name || !indexes.has(name)) {
      if (name) indexes.set(name, result.length);
      result.push(entry);
      return;
    }
    if (canonical) result[indexes.get(name)] = entry;
  };
  for (const entry of existing) add(entry);
  for (const entry of incoming) add(entry, true);
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
        logWarn(`${configPath} is invalid, starting fresh.`);
        config = {};
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

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    logSuccess(`Plugin entry registered in ${path.basename(configPath)}`);
  } catch (err) {
    logError(`Failed to register plugin entry: ${err.message}`);
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

    if (!ideConfig.$schema) ideConfig.$schema = "https://opencode.ai/config.json";

    fs.mkdirSync(path.dirname(ideConfigPath), { recursive: true });
    fs.writeFileSync(ideConfigPath, JSON.stringify(ideConfig, null, 2), "utf8");
    logSuccess("Configuration merged successfully.");
  } catch (err) {
    logError(`Failed to merge config: ${err.message}`);
  }
}
