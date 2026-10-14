import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { copyDirectoryDelta, verifyDirectoryMirror } from "./copy.js";

export const CONTEXT_CHECKPOINT_NAME = "flowtask-context-checkpoint";
export const CONTEXT_CHECKPOINT_SHA = "d21ad9fe148a513d5a776ae7dfac064463f3bac7";
export const OWNER_MARKER = {
  schema: 1,
  managedBy: "flowtask",
  plugin: CONTEXT_CHECKPOINT_NAME,
  source: "submodule",
  sourceCommit: CONTEXT_CHECKPOINT_SHA,
  registration: "opencode-v2-package",
};

export const OWNERSHIP = Object.freeze({
  ABSENT: "ABSENT",
  MANAGED_V1: "MANAGED_V1",
  MANAGED_V2: "MANAGED_V2",
  EXTERNAL: "EXTERNAL",
  AMBIGUOUS: "AMBIGUOUS",
});

const markerKeys = Object.keys(OWNER_MARKER);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function exactMarker(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return markerKeys.length === Object.keys(value).length && markerKeys.every((key) => value[key] === OWNER_MARKER[key]);
}

function packageHasDependency(pkg, name) {
  return [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies]
    .some((group) => group && Object.prototype.hasOwnProperty.call(group, name));
}

export function hasLegacyV1Fingerprint(pluginDir, config) {
  const pkg = readJson(path.join(pluginDir, "package.json"));
  if (pkg?.version !== "1.0.1" || !packageHasDependency(pkg, "@opencode-ai/plugin")) return false;
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
  if (!text.includes("PluginInput") || !text.includes("SQLite")) return false;
  return configHasLegacyReference(config, CONTEXT_CHECKPOINT_NAME);
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
    return normalized.includes(`/plugins/${pluginName}/`) && normalized.endsWith("/index.ts");
  });
}

export function classifyOwnership(pluginDir, { config } = {}) {
  if (!fs.existsSync(pluginDir)) return { state: OWNERSHIP.ABSENT, path: pluginDir };
  if (fs.lstatSync(pluginDir).isSymbolicLink()) return { state: OWNERSHIP.AMBIGUOUS, path: pluginDir, reason: "symlink" };
  const markerPath = path.join(pluginDir, ".flowtask-plugin-owner.json");
  const markerPresent = fs.existsSync(markerPath);
  const marker = readJson(markerPath);
  if (exactMarker(marker)) return { state: OWNERSHIP.MANAGED_V2, path: pluginDir, marker };
  if (hasLegacyV1Fingerprint(pluginDir, config)) return { state: OWNERSHIP.MANAGED_V1, path: pluginDir };
  return markerPresent
    ? { state: OWNERSHIP.AMBIGUOUS, path: pluginDir, reason: "invalid-owner-marker" }
    : { state: OWNERSHIP.EXTERNAL, path: pluginDir, reason: "no-flowtask-ownership-evidence" };
}

export function ownershipDecision(pluginDir, options) {
  return classifyOwnership(pluginDir, options);
}

function writeMarker(dir) {
  const markerPath = path.join(dir, ".flowtask-plugin-owner.json");
  fs.writeFileSync(markerPath, `${JSON.stringify(OWNER_MARKER, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  const parsed = readJson(markerPath);
  if (!exactMarker(parsed)) throw new Error("owner marker verification failed");
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
  return normalized === `plugins/${pluginName}` || normalized.endsWith(`/plugins/${pluginName}`);
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

export function replaceManagedPackage({ sourceDir, destinationDir, configPath, pluginName = CONTEXT_CHECKPOINT_NAME, sourceCommit = CONTEXT_CHECKPOINT_SHA, ownershipDecision: preparedOwnership, faultInjector } = {}) {
  if (!sourceDir || !destinationDir || !configPath) throw new Error("sourceDir, destinationDir and configPath are required");
  const sourcePackage = readJson(path.join(sourceDir, "package.json"));
  if (!sourcePackage || !packageHasDependency(sourcePackage, "@opencode/plugin")) throw new Error("invalid V2 package source");
  if (!fs.existsSync(path.join(sourceDir, "index.ts"))) throw new Error("V2 entrypoint index.ts is missing");
  if (sourceCommit !== CONTEXT_CHECKPOINT_SHA) throw new Error(`unexpected source commit: ${sourceCommit}`);
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const originalDestination = snapshotPath(destinationDir);
  const ownership = preparedOwnership ?? classifyOwnership(destinationDir, { config: originalConfig ? readJson(configPath) : {} });
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
    writeMarker(stage);
    const markerContents = `${JSON.stringify(OWNER_MARKER, null, 2)}\n`;
    if (!verifyDirectoryMirror(sourceDir, stage, { expectedExtraFiles: { ".flowtask-plugin-owner.json": markerContents } })) throw new Error("staged source mirror verification failed");
    if (faultInjector) faultInjector("STAGE-PUBLISH");
    if (fs.existsSync(destinationDir)) fs.renameSync(destinationDir, backup);
    fs.renameSync(stage, destinationDir);
    if (faultInjector) faultInjector("CONFIG");
    if (!registerPluginPackageEntry(configPath, pluginName, `./plugins/${pluginName}`)) throw new Error("package registration failed");
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(stage) || fs.existsSync(backup)) throw new Error("transaction cleanup failed");
    return { ownership: ownership.state, destinationDir, configPath, marker: OWNER_MARKER };
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
