import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  CLAUDE_RUNTIME_SCHEMA,
  buildSessionStartHookCommand,
  resolveActiveRuntimePaths,
  resolveClaudePaths,
  sha256File,
  writeFileAtomic,
} from "./claude.js";
import {
  LAYER_FILES,
  MIGRATION_DEFAULTS,
  readLayerFile,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "./layers.js";
import { logInfo, logSuccess, logWarn, fileExists } from "./logger.js";
import { generateClaudeSessionStart } from "./runner-content.js";

const BIN_LIB_ALLOWLIST = Object.freeze([
  "target-direct-transport.js",
  "worktree-consumer-adapter.js",
  "worktree-consumer-contract.js",
  "worktree-commit-message.js",
]);

const KNOWN_CONFIG_FILES = Object.freeze([
  LAYER_FILES.persona,
  LAYER_FILES.autonomy,
  LAYER_FILES.permissions,
]);

function compareJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writeJsonIfChanged(filePath, value) {
  if (fileExists(filePath)) {
    try {
      if (compareJson(JSON.parse(fs.readFileSync(filePath, "utf8")), value)) return false;
    } catch {
      // An unreadable file is never silently replaced by this helper.
      return false;
    }
  }
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
  return true;
}

function walkFiles(rootDir, currentDir = rootDir, output = []) {
  if (!fileExists(currentDir)) return output;
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isDirectory()) walkFiles(rootDir, absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function toManifestPath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function buildPayloadFiles(payloadDir) {
  return walkFiles(payloadDir)
    .map((absolutePath) => ({
      path: toManifestPath(payloadDir, absolutePath),
      sha256: sha256File(absolutePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildPayloadId(version, files) {
  const digest = crypto
    .createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.sha256}`).join("\n"))
    .digest("hex");
  return `${version}-${digest.slice(0, 12)}`;
}

function copyTree(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (candidate) => path.basename(candidate) !== ".DS_Store",
  });
}

function removeIfEmpty(directory) {
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {
    // Missing or non-empty directories are left untouched.
  }
}

// ─── Global configuration ─────────────────────────────────────────────────────

/**
 * Ensure the three user-level layers. A missing operational layer receives the
 * installation default; an existing invalid layer is never overwritten.
 */
export function ensureClaudeRuntimeConfig(configDir, { personaChoice = null } = {}) {
  fs.mkdirSync(configDir, { recursive: true });

  const profilePath = path.join(configDir, LAYER_FILES.persona);
  let profile = validatePersonaLayer(null);

  if (personaChoice) {
    const value = {
      level: personaChoice.level,
      persona: personaChoice.persona,
      onboarded: personaChoice.onboarded === true,
    };
    const validated = validatePersonaLayer(value);
    if (validated.status !== "valid") {
      const error = new Error(`Invalid persona choice for the FlowTask runtime: ${validated.reason}.`);
      error.code = "profile_invalid";
      throw error;
    }
    writeJsonIfChanged(profilePath, validated.value);
    profile = validated;
  } else if (fileExists(profilePath)) {
    const existing = readLayerFile(profilePath);
    const validated = existing.status === "invalid"
      ? { status: "invalid", value: null, reason: existing.reason }
      : validatePersonaLayer(existing.value);
    if (validated.status === "invalid") {
      const error = new Error(
        `Invalid persona profile at ${profilePath}: ${validated.reason}. Fix or move the file and retry.`,
      );
      error.code = "profile_invalid";
      throw error;
    }
    profile = validated;
    if (profile.status === "missing") logWarn(`No persona profile was found at ${profilePath}; continuing without persona.`);
  }

  const operational = {};
  for (const name of ["autonomy", "permissions"]) {
    const filePath = path.join(configDir, LAYER_FILES[name]);
    const validator = name === "autonomy" ? validateAutonomyLayer : validatePermissionsLayer;

    if (!fileExists(filePath)) {
      writeFileAtomic(filePath, JSON.stringify(MIGRATION_DEFAULTS[name], null, 2));
      logSuccess(`${name} layer written to ${filePath} with the installation default value.`);
      operational[name] = validator(MIGRATION_DEFAULTS[name]);
      continue;
    }

    const existing = readLayerFile(filePath);
    const validated = existing.status === "invalid"
      ? { status: "invalid", value: null, reason: existing.reason }
      : validator(existing.value);
    if (validated.status === "invalid") {
      const error = new Error(
        `Invalid ${name} layer at ${filePath}: ${validated.reason}. Fix or move the file and retry.`,
      );
      error.code = `${name}_invalid`;
      error.path = filePath;
      error.reason = validated.reason;
      throw error;
    }
    operational[name] = validated;
  }

  return { profile, autonomy: operational.autonomy, permissions: operational.permissions };
}

// ─── Runtime manifest ─────────────────────────────────────────────────────────

export function readClaudeRuntimeManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) {
    const error = new Error(`FlowTask runtime manifest not found at ${manifestPath}. Run: flowtask install`);
    error.code = "runtime_manifest_missing";
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (parseError) {
    const error = new Error(`FlowTask runtime manifest at ${manifestPath} is not valid JSON: ${parseError.message}`);
    error.code = "runtime_manifest_invalid";
    throw error;
  }

  if (manifest?.schema !== CLAUDE_RUNTIME_SCHEMA) {
    const error = new Error(
      `FlowTask runtime manifest uses schema ${manifest?.schema ?? "missing"}; this CLI supports schema ${CLAUDE_RUNTIME_SCHEMA}. Run: flowtask install`,
    );
    error.code = "runtime_manifest_incompatible";
    throw error;
  }
  if (typeof manifest.payloadId !== "string" || !manifest.payloadId || !Array.isArray(manifest.files)) {
    const error = new Error(`FlowTask runtime manifest at ${manifestPath} is incomplete. Run: flowtask install`);
    error.code = "runtime_manifest_invalid";
    throw error;
  }

  const active = resolveActiveRuntimePaths(runtimeRoot, manifest);
  if (!fileExists(active.payloadDir)) {
    const error = new Error(
      `FlowTask runtime payload ${manifest.payloadId} is missing at ${active.payloadDir}. Run: flowtask install`,
    );
    error.code = "runtime_payload_missing";
    throw error;
  }

  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
      const error = new Error(`FlowTask runtime manifest at ${manifestPath} declares an invalid file entry. Run: flowtask update`);
      error.code = "runtime_manifest_invalid";
      throw error;
    }
    const absolute = path.resolve(active.payloadDir, file.path);
    if (!absolute.startsWith(path.resolve(active.payloadDir) + path.sep) || !fileExists(absolute)) {
      const error = new Error(`FlowTask runtime payload is incomplete: ${file.path} is missing. Run: flowtask install`);
      error.code = "runtime_payload_incomplete";
      throw error;
    }
    if (sha256File(absolute) !== file.sha256) {
      const error = new Error(`FlowTask runtime payload was modified: ${file.path}. Run: flowtask install`);
      error.code = "runtime_payload_modified";
      throw error;
    }
  }

  return manifest;
}

// ─── Runtime payload ──────────────────────────────────────────────────────────

/**
 * Build the versioned runtime payload atomically and point `runtime.json` at it.
 * An existing runtime root without a valid manifest fails closed.
 */
export function ensureClaudeRuntime(flowtaskDir, options = {}) {
  const { runnerBody, version } = options;
  if (typeof runnerBody !== "string" || !runnerBody.trim()) {
    throw new Error("ensureClaudeRuntime requires a runner body.");
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("ensureClaudeRuntime requires a version.");
  }

  const runtimeRoot = options.runtimeRoot ?? resolveClaudePaths(process.cwd()).runtimeRoot;
  const runtimeVersionsDir = path.join(runtimeRoot, "versions");
  const manifestPath = path.join(runtimeRoot, "runtime.json");

  const runtimeRootExists = fileExists(runtimeRoot);
  if (runtimeRootExists) {
    // A migrated configuration may be created before the first payload. Any
    // other entry without a manifest remains an unmanaged runtime root.
    const entries = fs.readdirSync(runtimeRoot).filter((entry) => entry !== "config");
    if (entries.length > 0 && !fileExists(manifestPath)) {
      const error = new Error(
        `Refusing to use ${runtimeRoot}: it contains files but no runtime manifest. ` +
          "Move the directory away or run flowtask install after inspecting it.",
      );
      error.code = "runtime_root_unmanaged";
      throw error;
    }
  }

  let previousManifest = null;
  if (fileExists(manifestPath)) previousManifest = readClaudeRuntimeManifest(runtimeRoot);

  fs.mkdirSync(runtimeVersionsDir, { recursive: true });
  const stagingDir = path.join(runtimeVersionsDir, `.staging-${process.pid}-${Date.now()}`);

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    copyTree(path.join(flowtaskDir, "skills"), path.join(stagingDir, "skills"));
    copyTree(path.join(flowtaskDir, "scripts"), path.join(stagingDir, "scripts"));

    const stagingBinLib = path.join(stagingDir, "bin", "lib");
    fs.mkdirSync(stagingBinLib, { recursive: true });
    for (const fileName of BIN_LIB_ALLOWLIST) {
      const source = path.join(flowtaskDir, "bin", "lib", fileName);
      if (fileExists(source)) fs.copyFileSync(source, path.join(stagingBinLib, fileName));
    }

    writeFileAtomic(path.join(stagingDir, "runner.md"), runnerBody);

    // The payload id is derived from the runtime files that do not embed the
    // payload path. The startup document is generated afterwards against the
    // final path and its hash is added to the manifest.
    const payloadId = buildPayloadId(version, buildPayloadFiles(stagingDir));
    const payloadDir = path.join(runtimeVersionsDir, payloadId);
    const finalPaths = resolveActiveRuntimePaths(runtimeRoot, { payloadId });
    generateClaudeSessionStart({
      skillsDir: finalPaths.skillsDir,
      runnerPath: finalPaths.runnerPath,
      sessionStartPath: path.join(stagingDir, "session-start.md"),
      runnerContent: runnerBody,
      verificationSkillsDir: path.join(stagingDir, "skills"),
    });

    const files = buildPayloadFiles(stagingDir);

    let action = previousManifest ? "updated" : "installed";
    let payloadExisted = fileExists(payloadDir);

    if (payloadExisted) {
      const existingFiles = buildPayloadFiles(payloadDir);
      if (compareJson(existingFiles, files)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        if (previousManifest?.payloadId === payloadId && previousManifest.version === version) {
          return {
            ok: true,
            action: "unchanged",
            payloadId,
            previousPayloadId: previousManifest.previousPayloadId ?? null,
            version,
          };
        }
      } else {
        // The directory carries the expected id but not the expected content:
        // never adopt it silently.
        const error = new Error(
          `Runtime payload ${payloadId} exists with different content. ` +
            "Remove it manually after inspecting it and retry flowtask update.",
        );
        error.code = "runtime_payload_collision";
        throw error;
      }
    } else {
      fs.renameSync(stagingDir, payloadDir);
    }

    const launcherSource = path.join(flowtaskDir, "claude", "session-start.mjs");
    const launcherPath = path.join(runtimeRoot, "bin", "session-start.mjs");
    let launcher = null;
    if (fileExists(launcherSource)) {
      writeFileAtomic(launcherPath, fs.readFileSync(launcherSource));
      launcher = { path: "bin/session-start.mjs", sha256: sha256File(launcherPath) };
    } else {
      logWarn(`Runtime launcher template not found at ${launcherSource}; the hook will not start until it is installed.`);
    }

    const manifest = {
      schema: CLAUDE_RUNTIME_SCHEMA,
      version,
      payloadId,
      previousPayloadId:
        previousManifest && previousManifest.payloadId !== payloadId
          ? previousManifest.payloadId
          : previousManifest?.previousPayloadId ?? null,
      installedAt: new Date().toISOString(),
      source: path.resolve(flowtaskDir),
      files,
      launcher,
      hookCommand: buildSessionStartHookCommand(runtimeRoot),
      mcp: previousManifest?.mcp ?? null,
    };
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

    const keep = new Set([payloadId, manifest.previousPayloadId].filter(Boolean));
    for (const entry of fs.readdirSync(runtimeVersionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".staging-")) continue;
      if (keep.has(entry.name)) continue;
      fs.rmSync(path.join(runtimeVersionsDir, entry.name), { recursive: true, force: true });
    }

    logInfo(
      action === "installed"
        ? `FlowTask runtime ${version} installed at ${runtimeRoot}.`
        : `FlowTask runtime ${version} updated at ${runtimeRoot}.`,
    );
    return {
      ok: true,
      action,
      payloadId,
      previousPayloadId: manifest.previousPayloadId,
      version,
    };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* already gone */ }
    throw error;
  }
}

// ─── Runtime removal ──────────────────────────────────────────────────────────

/**
 * Remove only files declared by the manifest whose hash still matches. Unknown
 * files, and files modified after installation, are preserved and reported.
 */
export function removeClaudeRuntime(runtimeRoot) {
  const removed = [];
  const preserved = [];
  let manifest = null;

  try {
    manifest = readClaudeRuntimeManifest(runtimeRoot);
  } catch {
    manifest = null;
  }

  if (manifest) {
    const active = resolveActiveRuntimePaths(runtimeRoot, manifest);
    for (const file of manifest.files) {
      const absolute = path.resolve(active.payloadDir, file.path);
      if (!absolute.startsWith(path.resolve(active.payloadDir) + path.sep) || !fileExists(absolute)) continue;
      if (sha256File(absolute) !== file.sha256) {
        preserved.push(absolute);
        continue;
      }
      fs.rmSync(absolute, { force: true });
      removed.push(absolute);
    }
  }

  const launcherPath = path.join(runtimeRoot, "bin", "session-start.mjs");
  if (fileExists(launcherPath)) {
    const expected = manifest?.launcher?.sha256;
    if (!expected || sha256File(launcherPath) === expected) {
      fs.rmSync(launcherPath, { force: true });
      removed.push(launcherPath);
    } else {
      preserved.push(launcherPath);
    }
  }

  if (!manifest) {
    const versionsDir = path.join(runtimeRoot, "versions");
    if (fileExists(versionsDir)) {
      fs.rmSync(versionsDir, { recursive: true, force: true });
      removed.push(versionsDir);
    }
  } else {
    const versionsDir = path.join(runtimeRoot, "versions");
    if (fileExists(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        const payloadDir = path.join(versionsDir, entry.name);
        if (entry.isDirectory()) {
          for (const file of walkFiles(payloadDir)) {
            if (!removed.includes(file) && !preserved.includes(file)) preserved.push(file);
          }
          try {
            if (walkFiles(payloadDir).length === 0) {
              fs.rmSync(payloadDir, { recursive: true, force: true });
              removed.push(payloadDir);
            }
          } catch {
            // Left in place for the report.
          }
        }
      }
      removeIfEmpty(versionsDir);
    }
  }

  const configDir = path.join(runtimeRoot, "config");
  for (const fileName of KNOWN_CONFIG_FILES) {
    const filePath = path.join(configDir, fileName);
    if (!fileExists(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }
  removeIfEmpty(configDir);

  for (const fileName of ["runtime.json", "projects.json"]) {
    const filePath = path.join(runtimeRoot, fileName);
    if (!fileExists(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }

  for (const directory of [
    path.join(runtimeRoot, "bin", "lib"),
    path.join(runtimeRoot, "bin"),
    runtimeRoot,
  ]) {
    removeIfEmpty(directory);
  }

  return { removed, preserved };
}
