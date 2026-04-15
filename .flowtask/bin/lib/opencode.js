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
        ideConfig[section] = adjusted;
      } else if (section === "plugin") {
        const existing = Array.isArray(ideConfig[section]) ? ideConfig[section] : [];
        const incoming = Array.isArray(adjusted) ? adjusted : [];
        ideConfig[section] = [...existing, ...incoming];
      } else {
        ideConfig[section] = deepMergeObjects(ideConfig[section], adjusted);
      }
    }

    if (!ideConfig.$schema) ideConfig.$schema = "https://opencode.ai/config.json";

    fs.writeFileSync(ideConfigPath, JSON.stringify(ideConfig, null, 2), "utf8");
    logSuccess("Configuration merged successfully.");
  } catch (err) {
    logError(`Failed to merge config: ${err.message}`);
  }
}
