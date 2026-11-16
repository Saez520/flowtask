import fs from "fs";
import path from "path";
import { logInfo, logSuccess, logWarn, fileExists } from "./logger.js";
import { findOpencodeConfig } from "./opencode.js";
import {
  classifyOwnership,
  OWNERSHIP,
} from "./ownership.js";
import {
  removeProjectRegistration,
  resolveRegistrationDir,
  writeProjectRegistration,
} from "./project-registration.js";
import {
  LAYER_FILES,
  readLayerFile,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "./layers.js";
import {
  resolveUserRuntimePaths,
  writeFileAtomic,
} from "./user-runtime.js";

const LEGACY_LAYERS = Object.freeze([
  { name: "profile", file: LAYER_FILES.persona, validate: validatePersonaLayer },
  { name: "autonomy", file: LAYER_FILES.autonomy, validate: validateAutonomyLayer },
  { name: "permissions", file: LAYER_FILES.permissions, validate: validatePermissionsLayer },
]);

const FLOWTASK_MANAGED_PLUGINS = Object.freeze([
  "flowtask-permission-gate",
  "flowtask-context-checkpoint",
  "flowtask-classifier-hook",
  "flowtask-classifier-tui",
]);

const ENGRAM_TEMPLATE = Object.freeze({
  type: "local",
  command: Object.freeze(["engram", "mcp"]),
  enabled: true,
});

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: `${filePath} is not valid JSON: ${error.message}` };
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeJsonIfChanged(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (fileExists(filePath) && fs.readFileSync(filePath, "utf8") === content) return false;
  writeFileAtomic(filePath, content);
  return true;
}

function walkFiles(rootDir, currentDir = rootDir, output = []) {
  if (!fileExists(currentDir)) return output;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) walkFiles(rootDir, absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function relativeFiles(rootDir) {
  return walkFiles(rootDir)
    .map((absolute) => ({
      path: path.relative(rootDir, absolute).split(path.sep).join("/"),
      content: fs.readFileSync(absolute),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function treesEqual(sourceDir, destinationDir) {
  if (!fileExists(sourceDir) || !fileExists(destinationDir)) return false;
  try {
    const source = relativeFiles(sourceDir);
    const destination = relativeFiles(destinationDir);
    if (source.length !== destination.length) return false;
    for (const [index, entry] of source.entries()) {
      const other = destination[index];
      if (!other || entry.path !== other.path || !entry.content.equals(other.content)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pruneEmptyDirectories(rootDir) {
  if (!fileExists(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirectories(path.join(rootDir, entry.name));
  }
  try {
    if (fs.readdirSync(rootDir).length === 0) fs.rmdirSync(rootDir);
  } catch {
    // Left in place for the report.
  }
}

function canonicalEngramTemplate(flowtaskDir) {
  const source = findOpencodeConfig(flowtaskDir);
  if (source) {
    const parsed = readJson(source);
    if (parsed.ok && parsed.value?.mcp?.engram) return parsed.value.mcp.engram;
  }
  return ENGRAM_TEMPLATE;
}

function flowTaskPluginName(entry) {
  const value = typeof entry === "string" ? entry : entry?.path ?? entry?.package;
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/");
  const match = normalized.match(/plugins\/([^/]+)/);
  return match ? match[1] : null;
}

function cleanConfigFile(configPath, { flowtaskDir, removeEngram = true } = {}) {
  if (!fileExists(configPath)) return { changed: false, removed: [] };
  const parsed = readJson(configPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { changed: false, removed: [], preserved: configPath };
  }
  const config = { ...parsed.value };
  const removed = [];

  if (config.agents && typeof config.agents === "object" && !Array.isArray(config.agents)) {
    const agents = { ...config.agents };
    for (const name of Object.keys(agents)) {
      if (name.startsWith("flowtask-")) {
        delete agents[name];
        removed.push(`agents.${name}`);
      }
    }
    if (Object.keys(agents).length > 0) config.agents = agents;
    else delete config.agents;
  }

  if (config.default_agent === "flowtask-runner") {
    delete config.default_agent;
    removed.push("default_agent");
  }

  for (const key of ["plugins", "plugin"]) {
    if (!Array.isArray(config[key])) continue;
    const kept = config[key].filter((entry) => {
      const name = flowTaskPluginName(entry);
      const ours = name && (FLOWTASK_MANAGED_PLUGINS.includes(name) || name.startsWith("flowtask-"));
      if (ours) removed.push(`${key}:${name}`);
      return !ours;
    });
    if (kept.length > 0) config[key] = kept;
    else delete config[key];
  }

  if (Array.isArray(config.skills)) {
    const kept = config.skills.filter((entry) => {
      if (typeof entry !== "string") return true;
      const normalized = entry.replaceAll("\\", "/");
      const ours = normalized.includes(".opencode/flowtask/skills") || normalized.includes(".flowtask/skills");
      if (ours) removed.push(`skills:${entry}`);
      return !ours;
    });
    if (kept.length > 0) config.skills = kept;
    else delete config.skills;
  }

  if (removeEngram && config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)) {
    const template = canonicalEngramTemplate(flowtaskDir);
    if (stableStringify(config.mcp.engram) === stableStringify(template)) {
      const mcp = { ...config.mcp };
      delete mcp.engram;
      if (Object.keys(mcp).length > 0) config.mcp = mcp;
      else delete config.mcp;
      removed.push("mcp.engram");
    }
  }

  if (removed.length === 0) return { changed: false, removed };
  return { changed: writeJsonIfChanged(configPath, config), removed };
}

function cleanPluginArrays(configPath) {
  if (!fileExists(configPath)) return { changed: false, removed: [] };
  const parsed = readJson(configPath);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { changed: false, removed: [] };
  }
  const config = { ...parsed.value };
  const removed = [];
  for (const key of ["plugin", "plugins"]) {
    if (!Array.isArray(config[key])) continue;
    const kept = config[key].filter((entry) => {
      const name = flowTaskPluginName(entry);
      if (name && FLOWTASK_MANAGED_PLUGINS.includes(name)) {
        removed.push(`${key}:${name}`);
        return false;
      }
      return true;
    });
    if (kept.length > 0) config[key] = kept;
    else delete config[key];
  }
  if (removed.length === 0) return { changed: false, removed };
  return { changed: writeJsonIfChanged(configPath, config), removed };
}

function containsCanonicalFile(sourceDir, destinationDir) {
  if (!fileExists(sourceDir) || !fileExists(destinationDir)) return false;
  for (const entry of relativeFiles(sourceDir)) {
    const destination = path.join(destinationDir, entry.path);
    if (fileExists(destination) && fs.readFileSync(destination).equals(entry.content)) return true;
  }
  return false;
}

function hasLegacyOpencodeArtifacts(projectDir, flowtaskDir, markerPath) {
  if (fileExists(markerPath)) return true;
  const flowtaskDirProject = path.join(projectDir, ".opencode", "flowtask");
  for (const directory of ["agents", "scripts", "skills"]) {
    if (containsCanonicalFile(path.join(flowtaskDir, directory), path.join(flowtaskDirProject, directory))) {
      return true;
    }
  }
  for (const layer of LEGACY_LAYERS) {
    if (fileExists(path.join(flowtaskDirProject, "config", layer.file))) return true;
  }
  for (const name of FLOWTASK_MANAGED_PLUGINS) {
    for (const pluginsDir of [
      path.join(flowtaskDirProject, "plugins"),
      path.join(projectDir, ".opencode", "plugins"),
    ]) {
      if (fileExists(path.join(pluginsDir, name, ".flowtask-plugin-owner.json"))) return true;
    }
  }
  return false;
}

function migrateLegacyLayers(projectDir, runtimeConfigDir, removed, preserved, manualReview, { removeReview = false, configDir = null } = {}) {
  const legacyConfigDir = configDir ?? path.join(projectDir, ".opencode", "flowtask", "config");
  if (!fileExists(legacyConfigDir)) return;
  fs.mkdirSync(runtimeConfigDir, { recursive: true });
  for (const layer of LEGACY_LAYERS) {
    const source = path.join(legacyConfigDir, layer.file);
    if (!fileExists(source)) continue;
    const read = readLayerFile(source);
    const validated = read.status === "invalid"
      ? { status: "invalid", value: null, reason: read.reason }
      : layer.validate(read.value);
    if (validated.status !== "valid") {
      preserved.push(source);
      manualReview.push(`${source} is not a valid ${layer.name} layer and was preserved.`);
      continue;
    }
    const destination = path.join(runtimeConfigDir, layer.file);
    if (!fileExists(destination)) {
      writeFileAtomic(destination, JSON.stringify(validated.value, null, 2));
      fs.rmSync(source, { force: true });
      removed.push(source);
      continue;
    }
    const existing = readLayerFile(destination);
    const existingValidated = existing.status === "invalid"
      ? { status: "invalid", value: null, reason: existing.reason }
      : layer.validate(existing.value);
    if (existingValidated.status !== "valid") {
      preserved.push(source);
      manualReview.push(`${destination} is invalid; the legacy ${layer.name} layer at ${source} was preserved.`);
      continue;
    }
    if (JSON.stringify(existingValidated.value) !== JSON.stringify(validated.value)) {
      preserved.push(source);
      manualReview.push(`${destination} already defines a different ${layer.name} layer; the legacy copy at ${source} was preserved.`);
      continue;
    }
    fs.rmSync(source, { force: true });
    removed.push(source);
  }

  const review = path.join(legacyConfigDir, "review.json");
  if (removeReview && fileExists(review)) {
    fs.rmSync(review, { force: true });
    removed.push(review);
  }
  pruneEmptyDirectories(legacyConfigDir);
}

function removeCanonicalTree(sourceDir, destinationDir, removed, preserved) {
  if (!fileExists(destinationDir)) return;
  for (const entry of relativeFiles(destinationDir)) {
    const source = path.join(sourceDir, entry.path);
    const destination = path.join(destinationDir, entry.path);
    if (fileExists(source) && fs.readFileSync(source).equals(entry.content)) {
      fs.rmSync(destination, { force: true });
      removed.push(destination);
    } else {
      preserved.push(destination);
    }
  }
  pruneEmptyDirectories(destinationDir);
}

function removeManagedPluginDirectories(pluginsDirs, config, removed, preserved) {
  for (const pluginsDir of pluginsDirs) {
    if (!fileExists(pluginsDir)) continue;
    for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!FLOWTASK_MANAGED_PLUGINS.includes(name)) continue;
      const directory = path.join(pluginsDir, name);
      const decision = classifyOwnership(directory, { config, pluginName: name });
      if ([OWNERSHIP.MANAGED_V1, OWNERSHIP.MANAGED_V2].includes(decision.state)) {
        fs.rmSync(directory, { recursive: true, force: true });
        removed.push(directory);
      } else {
        preserved.push(directory);
      }
    }
    pruneEmptyDirectories(pluginsDir);
  }
}

function materializeReview(flowtaskDir, projectDir) {
  const sourcePath = path.join(flowtaskDir, "config", "review.json");
  if (!fileExists(sourcePath)) return null;
  const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const configDir = path.join(projectDir, ".opencode", "flowtask", "config");
  const stampPath = path.relative(projectDir, path.join(configDir, ".review-stamp")) || path.join(configDir, ".review-stamp");
  const materialized = { ...config, stampPath: stampPath.split(path.sep).join("/") };
  fs.mkdirSync(configDir, { recursive: true });
  const destination = path.join(configDir, "review.json");
  writeJsonIfChanged(destination, materialized);
  return { path: destination };
}

/**
 * Register an OpenCode project: only the ignored registration, the generated
 * review configuration and the global index change. No engine file is copied.
 */
export function registerOpencodeProject({ projectDir, runtimeManifest, flowtaskDir }) {
  const registration = writeProjectRegistration({
    projectDir,
    target: "opencode",
    runtimeVersion: runtimeManifest.version,
  });
  const review = materializeReview(flowtaskDir, projectDir);
  logSuccess(`FlowTask project registered for OpenCode at ${registration.path}.`);
  return { ok: true, registry: registration.registry, registration, review };
}

/**
 * Move a legacy per-project OpenCode installation to the global runtime.
 * Only demonstrably FlowTask-owned files are removed; modified files, unknown
 * plugins and the model selector are preserved and reported.
 */
export function migrateLegacyOpencodeProject({ projectDir, flowtaskDir, runtimeRoot = null }) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const runtimePaths = resolveUserRuntimePaths({ runtimeRoot: root });
  const flowtaskDirProject = path.join(projectDir, ".opencode", "flowtask");
  const markerPath = path.join(flowtaskDirProject, ".installation-method");
  const removed = [];
  const preserved = [];
  const manualReview = [];
  const legacyConfigPath = path.join(projectDir, ".opencode", "opencode.json");

  if (!hasLegacyOpencodeArtifacts(projectDir, flowtaskDir, markerPath)) {
    return { migrated: false, removed, preserved, manualReview };
  }

  const legacyLayerFiles = LEGACY_LAYERS.some((layer) =>
    fileExists(path.join(flowtaskDirProject, "config", layer.file)));
  migrateLegacyLayers(
    projectDir,
    runtimePaths.configDir,
    removed,
    preserved,
    manualReview,
    { removeReview: fileExists(markerPath) || legacyLayerFiles },
  );

  removeCanonicalTree(
    path.join(flowtaskDir, "agents"),
    path.join(flowtaskDirProject, "agents"),
    removed,
    preserved,
  );
  removeCanonicalTree(
    path.join(flowtaskDir, "scripts"),
    path.join(flowtaskDirProject, "scripts"),
    removed,
    preserved,
  );
  removeCanonicalTree(
    path.join(flowtaskDir, "skills"),
    path.join(flowtaskDirProject, "skills"),
    removed,
    preserved,
  );

  const legacyConfig = readJson(legacyConfigPath);
  removeManagedPluginDirectories(
    [
      path.join(projectDir, ".opencode", "plugins"),
      path.join(flowtaskDirProject, "plugins"),
    ],
    legacyConfig.ok ? legacyConfig.value : {},
    removed,
    preserved,
  );

  const projectSkillsDir = path.join(projectDir, ".opencode", "skills");
  if (fileExists(projectSkillsDir)) {
    const canonicalSkillsDir = path.join(flowtaskDir, "skills");
    for (const entry of fs.readdirSync(projectSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const destination = path.join(projectSkillsDir, entry.name);
      const source = path.join(canonicalSkillsDir, entry.name);
      if (treesEqual(source, destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
        removed.push(destination);
      } else {
        preserved.push(destination);
      }
    }
    pruneEmptyDirectories(projectSkillsDir);
  }

  if (fileExists(markerPath)) {
    fs.rmSync(markerPath, { force: true });
    removed.push(markerPath);
  }
  pruneEmptyDirectories(flowtaskDirProject);

  const configCleanup = cleanConfigFile(legacyConfigPath, { flowtaskDir });
  if (configCleanup.changed) removed.push(`${legacyConfigPath}#FlowTask entries`);
  if (configCleanup.preserved) preserved.push(configCleanup.preserved);

  for (const configPath of [
    path.join(projectDir, ".opencode", "tui.json"),
    path.join(projectDir, ".opencode", "cli.json"),
    path.join(projectDir, "tui.json"),
  ]) {
    const cleanup = cleanPluginArrays(configPath);
    if (cleanup.changed) removed.push(`${configPath}#FlowTask plugins`);
  }

  if (manualReview.length > 0) {
    for (const message of manualReview) logWarn(message);
  }
  if (removed.length > 0 || preserved.length > 0) {
    logSuccess(`Legacy OpenCode installation migrated: ${removed.length} artifact(s) removed, ${preserved.length} preserved.`);
  }
  return { migrated: true, removed, preserved, manualReview };
}

/**
 * Move a legacy VS Code or standalone installation to the global runtime.
 * Only demonstrably FlowTask-owned files are removed; unrelated files are
 * preserved and reported.
 */
export function migrateLegacyTargetProject({ projectDir, flowtaskDir, target, runtimeRoot = null }) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const runtimePaths = resolveUserRuntimePaths({ runtimeRoot: root });
  const targetDir = resolveRegistrationDir(projectDir, target);
  const markerPath = path.join(targetDir, ".installation-method");
  const removed = [];
  const preserved = [];
  const manualReview = [];

  const legacyLayerFiles = LEGACY_LAYERS.some((layer) =>
    fileExists(path.join(targetDir, "config", layer.file)));
  const hasOwned = fileExists(markerPath)
    || legacyLayerFiles
    || ["agents", "commands", "skills", "scripts"].some((directory) =>
      containsCanonicalFile(path.join(flowtaskDir, directory), path.join(targetDir, directory)))
    || FLOWTASK_MANAGED_PLUGINS.some((name) =>
      fileExists(path.join(targetDir, "plugins", name, ".flowtask-plugin-owner.json")));
  if (!hasOwned) return { migrated: false, removed, preserved, manualReview };

  migrateLegacyLayers(
    projectDir,
    runtimePaths.configDir,
    removed,
    preserved,
    manualReview,
    {
      removeReview: fileExists(markerPath) || legacyLayerFiles,
      configDir: path.join(targetDir, "config"),
    },
  );

  for (const directory of ["agents", "commands", "skills", "scripts"]) {
    removeCanonicalTree(
      path.join(flowtaskDir, directory),
      path.join(targetDir, directory),
      removed,
      preserved,
    );
  }
  removeManagedPluginDirectories(
    [path.join(targetDir, "plugins")],
    {},
    removed,
    preserved,
  );

  if (fileExists(markerPath)) {
    fs.rmSync(markerPath, { force: true });
    removed.push(markerPath);
  }
  pruneEmptyDirectories(targetDir);

  if (manualReview.length > 0) {
    for (const message of manualReview) logWarn(message);
  }
  if (removed.length > 0 || preserved.length > 0) {
    logSuccess(`Legacy ${target} installation migrated: ${removed.length} artifact(s) removed, ${preserved.length} preserved.`);
  }
  return { migrated: true, removed, preserved, manualReview };
}

/** Remove the OpenCode project registration and its generated review config. */
export function removeOpencodeProject({ projectDir, runtimeRoot = null }) {
  const registration = removeProjectRegistration(projectDir, "opencode", { runtimeRoot });
  const removed = [...registration.removed];
  const review = path.join(projectDir, ".opencode", "flowtask", "config", "review.json");
  if (fileExists(review)) {
    fs.rmSync(review, { force: true });
    removed.push(review);
  }
  pruneEmptyDirectories(path.join(projectDir, ".opencode", "flowtask"));
  if (registration.indexError) {
    logWarn(`The project index could not be updated: ${registration.indexError}`);
  }
  if (registration.registry) logInfo(`FlowTask OpenCode registration removed from ${projectDir}.`);
  return { ok: true, removed, preserved: registration.preserved, registry: registration.registry };
}
