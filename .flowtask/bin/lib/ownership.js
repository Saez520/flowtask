import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copyDirectoryDelta, verifyDirectoryMirror } from "./copy.js";

export const CONTEXT_CHECKPOINT_NAME = "flowtask-context-checkpoint";
export const CONTEXT_CHECKPOINT_SHA = "a863ee144a088428b8078583f13bf48ce13d7631";
export function ownerMarkerFor(pluginName, { source = "submodule", sourceCommit = CONTEXT_CHECKPOINT_SHA } = {}) {
  return {
    schema: 1,
    managedBy: "flowtask",
    plugin: pluginName,
    source,
    sourceCommit,
    registration: "opencode-v2-package",
  };
}

export const OWNER_MARKER = ownerMarkerFor(CONTEXT_CHECKPOINT_NAME);

export const OWNERSHIP = Object.freeze({
  ABSENT: "ABSENT",
  MANAGED_V1: "MANAGED_V1",
  MANAGED_V2: "MANAGED_V2",
  EXTERNAL: "EXTERNAL",
  AMBIGUOUS: "AMBIGUOUS",
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function exactMarker(value, expected = OWNER_MARKER) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(value).length && keys.every((key) => value[key] === expected[key]);
}

const SOURCE_COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Ownership identity, independent of the plugin revision recorded at install time. */
function markerIdentity(value, expected = OWNER_MARKER) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(expected);
  if (keys.length !== Object.keys(value).length) return false;
  if (!keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  if (value.schema !== expected.schema) return false;
  if (value.managedBy !== expected.managedBy) return false;
  if (value.plugin !== expected.plugin) return false;
  if (value.registration !== expected.registration) return false;
  if (value.source !== "submodule" && value.source !== "local") return false;
  return value.source === "submodule"
    ? SOURCE_COMMIT_SHA.test(value.sourceCommit)
    : value.sourceCommit === null;
}

/** Canonical marker of the management form each plugin uses. */
function managedMarker(pluginName = CONTEXT_CHECKPOINT_NAME) {
  return pluginName === CONTEXT_CHECKPOINT_NAME
    ? ownerMarkerFor(pluginName, { source: "submodule", sourceCommit: CONTEXT_CHECKPOINT_SHA })
    : ownerMarkerFor(pluginName, { source: "local", sourceCommit: null });
}

function packageHasDependency(pkg, name) {
  return [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies]
    .some((group) => group && Object.prototype.hasOwnProperty.call(group, name));
}

export function hasLegacyV1Fingerprint(pluginDir, config, pluginName = CONTEXT_CHECKPOINT_NAME) {
  const pkg = readJson(path.join(pluginDir, "package.json"));
  if (!pkg || !packageHasDependency(pkg, "@opencode-ai/plugin")) return false;
  if (pluginName === CONTEXT_CHECKPOINT_NAME) {
    if (pkg.version !== "1.0.1") return false;
  } else if (pkg.name !== pluginName) {
    return false;
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  try { walk(pluginDir); } catch { return false; }
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  if (!text.includes("PluginInput")) return false;
  if (pluginName === CONTEXT_CHECKPOINT_NAME && !text.includes("SQLite")) return false;
  return configHasLegacyReference(config, pluginName);
}

export function configHasLegacyReference(config, pluginName = CONTEXT_CHECKPOINT_NAME) {
  if (!config || typeof config !== "object") return false;
  const values = [];
  for (const key of ["plugin", "plugins"]) {
    if (Array.isArray(config[key])) values.push(...config[key]);
  }
  return values.some((entry) => {
    const value = typeof entry === "string" ? entry : entry?.path ?? entry?.package;
    if (typeof value !== "string") return false;
    const normalized = value.replaceAll("\\", "/");
    return normalized.includes(`plugins/${pluginName}/`);
  });
}

export function classifyOwnership(pluginDir, { config, pluginName = CONTEXT_CHECKPOINT_NAME } = {}) {
  if (!fs.existsSync(pluginDir)) return { state: OWNERSHIP.ABSENT, path: pluginDir };
  if (fs.lstatSync(pluginDir).isSymbolicLink()) return { state: OWNERSHIP.AMBIGUOUS, path: pluginDir, reason: "symlink" };
  const markerPath = path.join(pluginDir, ".flowtask-plugin-owner.json");
  const markerPresent = fs.existsSync(markerPath);
  const marker = readJson(markerPath);
  if (markerIdentity(marker, managedMarker(pluginName))) return { state: OWNERSHIP.MANAGED_V2, path: pluginDir, marker };
  if (hasLegacyV1Fingerprint(pluginDir, config, pluginName)) return { state: OWNERSHIP.MANAGED_V1, path: pluginDir };
  return markerPresent
    ? { state: OWNERSHIP.AMBIGUOUS, path: pluginDir, reason: "invalid-owner-marker" }
    : { state: OWNERSHIP.EXTERNAL, path: pluginDir, reason: "no-flowtask-ownership-evidence" };
}

export function ownershipDecision(pluginDir, options) {
  return classifyOwnership(pluginDir, options);
}

function writeMarker(dir, marker) {
  const markerPath = path.join(dir, ".flowtask-plugin-owner.json");
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  const parsed = readJson(markerPath);
  if (!exactMarker(parsed, marker)) throw new Error("owner marker verification failed");
}

function atomicJson(configPath, value) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const temp = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, configPath);
    const verified = readJson(configPath);
    if (JSON.stringify(verified) !== JSON.stringify(value)) throw new Error("config verification failed");
  } catch (error) {
    try {
      if (original) fs.writeFileSync(configPath, original);
      else fs.rmSync(configPath, { force: true });
      fs.rmSync(temp, { force: true });
    } catch (rollbackError) {
      error.message += `; config rollback failed: ${rollbackError.message}`;
    }
    throw error;
  }
}

function packagePathMatches(value, pluginName) {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const packagePath = `plugins/${pluginName}`;
  return normalized === packagePath
    || normalized.endsWith(`/${packagePath}`)
    || normalized.startsWith(`${packagePath}/`)
    || normalized.includes(`/${packagePath}/`);
}

export function registerPluginPackageEntry(configPath, pluginName = CONTEXT_CHECKPOINT_NAME, relativeDirectory = `./plugins/${pluginName}`) {
  let config;
  try {
    config = fs.existsSync(configPath) ? readJson(configPath) : {};
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid OpenCode config");
    if (fs.existsSync(configPath) && readJson(configPath) === null) throw new Error("invalid OpenCode config JSON");
    if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error("config.plugins must be an array");
    if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error("config.plugin must be an array");

    const packageEntry = { package: relativeDirectory.replaceAll("\\", "/") };
    const existingPackages = Array.isArray(config.plugins) ? config.plugins : [];
    const preservedPackages = existingPackages.filter((entry) => {
      const value = typeof entry === "string" ? entry : entry?.package;
      return !packagePathMatches(value, pluginName);
    });
    config.plugins = [...preservedPackages, packageEntry];
    if (Array.isArray(config.plugin)) {
      config.plugin = config.plugin.filter((entry) => {
        const value = typeof entry === "string" ? entry : entry?.path ?? entry?.package;
        return !packagePathMatches(value, pluginName);
      });
    }
    if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
    atomicJson(configPath, config);
    return true;
  } catch (error) {
    return false;
  }
}

function snapshotPath(file) {
  if (!fs.existsSync(file)) return { exists: false };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", target: fs.readlinkSync(file) };
  if (stat.isDirectory()) return { exists: true, type: "directory", tree: copyTree(file) };
  return { exists: true, type: "file", data: fs.readFileSync(file).toString("base64"), mode: stat.mode & 0o7777 };
}

function copyTree(dir) {
  const output = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    output[entry.name] = snapshotPath(full);
  }
  return output;
}

function restoreSnapshot(file, snapshot) {
  fs.rmSync(file, { recursive: true, force: true });
  if (!snapshot?.exists) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (snapshot.type === "symlink") fs.symlinkSync(snapshot.target, file);
  else if (snapshot.type === "file") {
    fs.writeFileSync(file, Buffer.from(snapshot.data, "base64"));
    fs.chmodSync(file, snapshot.mode);
  } else {
    fs.mkdirSync(file, { recursive: true });
    for (const [name, child] of Object.entries(snapshot.tree ?? {})) restoreSnapshot(path.join(file, name), child);
  }
}

export function replaceManagedPackage({
  sourceDir,
  destinationDir,
  configPath,
  pluginName = CONTEXT_CHECKPOINT_NAME,
  entrypoint = "index.ts",
  source = "submodule",
  sourceCommit = source === "submodule" ? CONTEXT_CHECKPOINT_SHA : null,
  ownershipDecision: preparedOwnership,
  faultInjector,
} = {}) {
  if (!sourceDir || !destinationDir || !configPath) throw new Error("sourceDir, destinationDir and configPath are required");
  if (source !== "submodule" && source !== "local") throw new Error(`invalid V2 package source: ${source}`);
  if (source === "submodule" && sourceCommit !== CONTEXT_CHECKPOINT_SHA) throw new Error(`unexpected source commit: ${sourceCommit}`);
  const sourcePackage = readJson(path.join(sourceDir, "package.json"));
  if (!sourcePackage || !packageHasDependency(sourcePackage, "@opencode/plugin")) throw new Error("invalid V2 package source");
  if (typeof entrypoint !== "string" || !entrypoint || path.isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid V2 entrypoint: ${entrypoint}`);
  }
  if (!fs.existsSync(path.join(sourceDir, entrypoint))) throw new Error(`V2 entrypoint ${entrypoint} is missing`);
  const marker = ownerMarkerFor(pluginName, { source, sourceCommit });
  if (!exactMarker(marker, managedMarker(pluginName))) throw new Error(`unexpected management source for ${pluginName}`);
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const originalDestination = snapshotPath(destinationDir);
  const ownership = preparedOwnership ?? classifyOwnership(destinationDir, {
    config: originalConfig ? readJson(configPath) : {},
    pluginName,
  });
  if (![OWNERSHIP.ABSENT, OWNERSHIP.MANAGED_V1, OWNERSHIP.MANAGED_V2].includes(ownership.state)) {
    const error = new Error(`ownership-ambiguous: refusing to replace ${destinationDir}`);
    error.code = "OWNERSHIP_AMBIGUOUS";
    throw error;
  }

  const parent = path.dirname(destinationDir);
  const tx = `${path.basename(destinationDir)}.flowtask-${process.pid}-${crypto.randomUUID()}`;
  const stage = path.join(parent, `.stage-${tx}`);
  const backup = path.join(parent, `.backup-${tx}`);
  try {
    fs.mkdirSync(stage, { recursive: true });
    copyDirectoryDelta(sourceDir, stage);
    writeMarker(stage, marker);
    const markerContents = `${JSON.stringify(marker, null, 2)}\n`;
    if (!verifyDirectoryMirror(sourceDir, stage, { expectedExtraFiles: { ".flowtask-plugin-owner.json": markerContents } })) throw new Error("staged source mirror verification failed");
    if (faultInjector) faultInjector("STAGE-PUBLISH");
    if (fs.existsSync(destinationDir)) fs.renameSync(destinationDir, backup);
    fs.renameSync(stage, destinationDir);
    if (faultInjector) faultInjector("CONFIG");
    if (!registerPluginPackageEntry(configPath, pluginName, `./plugins/${pluginName}`)) throw new Error("package registration failed");
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(stage) || fs.existsSync(backup)) throw new Error("transaction cleanup failed");
    return { ownership: ownership.state, destinationDir, configPath, marker };
  } catch (error) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.rmSync(destinationDir, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, destinationDir);
      if (originalConfig) fs.writeFileSync(configPath, originalConfig);
      else fs.rmSync(configPath, { force: true });
      if (!fs.existsSync(destinationDir) && originalDestination.exists) restoreSnapshot(destinationDir, originalDestination);
    } catch (rollbackError) {
      error.message += `; package rollback failed: ${rollbackError.message}`;
    }
    throw error;
  }
}

export const installManagedPackage = replaceManagedPackage;
