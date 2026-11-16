import fs from "fs";
import path from "path";
import { logSuccess, logWarn, fileExists } from "./logger.js";
import {
  resolveUserRuntimePaths,
  writeFileAtomic,
} from "./user-runtime.js";

const OWNER_MARKER_FILE = ".flowtask-plugin-owner.json";
const OWNER_MARKER_SCHEMA = 1;
const COPY_SKIP_NAMES = new Set([".git", ".DS_Store", "node_modules", "test", "tests"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    return { ok: false, value: null };
  }
}

function writeJson(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function pluginVersion(sourceDir) {
  const pkg = readJson(path.join(sourceDir, "package.json"));
  return pkg.ok && typeof pkg.value?.version === "string" ? pkg.value.version : null;
}

function markerFor(name, version) {
  return {
    schema: OWNER_MARKER_SCHEMA,
    managedBy: "flowtask",
    plugin: name,
    version,
    scope: "user",
  };
}

function readMarker(directory) {
  const marker = readJson(path.join(directory, OWNER_MARKER_FILE));
  if (!marker.ok) return null;
  const value = marker.value;
  if (!isPlainObject(value) || value.schema !== OWNER_MARKER_SCHEMA) return null;
  if (value.managedBy !== "flowtask" || value.scope !== "user" || typeof value.plugin !== "string") return null;
  return value;
}

function isOwned(directory, name) {
  const marker = readMarker(directory);
  return Boolean(marker && marker.plugin === name);
}

function copyFilter(source) {
  const base = path.basename(source);
  if (COPY_SKIP_NAMES.has(base)) return false;
  if (/\.test\.[^.]+$/.test(base) || /\.spec\.[^.]+$/.test(base)) return false;
  return true;
}

function filesEqual(leftDir, rightDir) {
  const walk = (root, current = root, output = []) => {
    if (!fileExists(current)) return output;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (COPY_SKIP_NAMES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(root, absolute, output);
      else if (entry.isFile() && !/\.(test|spec)\.[^.]+$/.test(entry.name)) {
        output.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
    }
    return output;
  };
  try {
    const left = walk(leftDir).filter((file) => file !== OWNER_MARKER_FILE).sort();
    const right = walk(rightDir).filter((file) => file !== OWNER_MARKER_FILE).sort();
    if (left.length !== right.length) return false;
    for (const [index, file] of left.entries()) {
      if (file !== right[index]) return false;
      if (!fs.readFileSync(path.join(leftDir, file)).equals(fs.readFileSync(path.join(rightDir, file)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function replaceDirectory(sourceDir, destinationDir, marker) {
  const parent = path.dirname(destinationDir);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, `.stage-${path.basename(destinationDir)}-${process.pid}-${Date.now()}`);
  const backup = path.join(parent, `.backup-${path.basename(destinationDir)}-${process.pid}-${Date.now()}`);
  try {
    fs.cpSync(sourceDir, stage, { recursive: true, filter: copyFilter });
    writeJson(path.join(stage, OWNER_MARKER_FILE), marker);
    if (fileExists(destinationDir)) fs.renameSync(destinationDir, backup);
    fs.renameSync(stage, destinationDir);
    if (fileExists(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      if (fileExists(backup) && !fileExists(destinationDir)) fs.renameSync(backup, destinationDir);
    } catch {
      // The original error is the actionable failure.
    }
    throw error;
  }
}

function updateManifestPlugins(runtimeRoot, plugins) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) return;
  const parsed = readJson(manifestPath);
  if (!parsed.ok || !isPlainObject(parsed.value) || parsed.value.schema !== 2) return;
  const manifest = { ...parsed.value, plugins };
  writeJson(manifestPath, manifest);
}

/**
 * Install the manifest entries declared with `scope: "user"` once per account.
 * Each plugin lives under `<runtime>/plugins/<name>` with an ownership marker.
 * A directory without the marker is preserved and reported; an owned one is
 * replaced atomically. Tests and repository metadata are not copied.
 */
export function installUserPlugins({ flowtaskDir, manifest, runtimeRoot = null } = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const paths = resolveUserRuntimePaths({ runtimeRoot: root });
  const entries = (Array.isArray(manifest) ? manifest : [])
    .filter((entry) => entry && entry.scope === "user" && entry.destinations?.includes("opencode"));
  const installed = [];
  const replaced = [];
  const unchanged = [];
  const preserved = [];
  const plugins = {};

  for (const entry of entries) {
    const sourceDir = path.join(flowtaskDir, "plugins", entry.path);
    if (!fileExists(sourceDir)) {
      logWarn(`User plugin source not found, skipping: ${sourceDir}`);
      continue;
    }
    const destinationDir = path.join(paths.pluginsDir, entry.name);
    const version = pluginVersion(sourceDir);
    const marker = markerFor(entry.name, version);

    if (fileExists(destinationDir)) {
      if (!isOwned(destinationDir, entry.name)) {
        preserved.push(destinationDir);
        logWarn(`Preserved ${destinationDir}: it has no FlowTask ownership marker.`);
        continue;
      }
      if (filesEqual(sourceDir, destinationDir) && readMarker(destinationDir)?.version === version) {
        unchanged.push(destinationDir);
        plugins[entry.name] = { path: destinationDir, marker };
        continue;
      }
      replaceDirectory(sourceDir, destinationDir, marker);
      replaced.push(destinationDir);
      plugins[entry.name] = { path: destinationDir, marker };
      continue;
    }

    replaceDirectory(sourceDir, destinationDir, marker);
    installed.push(destinationDir);
    plugins[entry.name] = { path: destinationDir, marker };
  }

  if (Object.keys(plugins).length > 0) updateManifestPlugins(root, plugins);
  if (installed.length > 0 || replaced.length > 0) {
    logSuccess(`FlowTask user plugins ready: ${installed.length} installed, ${replaced.length} replaced.`);
  }
  return { installed, replaced, unchanged, preserved, plugins };
}

/** Remove only user plugin directories that carry the FlowTask marker. */
export function removeUserPlugins({ runtimeRoot = null } = {}) {
  const root = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const paths = resolveUserRuntimePaths({ runtimeRoot: root });
  const removed = [];
  const preserved = [];
  if (fileExists(paths.pluginsDir)) {
    for (const entry of fs.readdirSync(paths.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(paths.pluginsDir, entry.name);
      if (!readMarker(directory)) {
        preserved.push(directory);
        continue;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      removed.push(directory);
    }
  }
  if (removed.length > 0) updateManifestPlugins(root, {});
  if (preserved.length > 0) {
    logWarn(`Preserved ${preserved.length} plugin director${preserved.length === 1 ? "y" : "ies"} without a FlowTask marker.`);
  }
  return { removed, preserved };
}
