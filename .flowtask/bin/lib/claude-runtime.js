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
  AUTONOMY_PROFILES,
  LAYER_FILES,
  MIGRATION_DEFAULTS,
  buildProfileForWrite,
  describeOperationalFailure,
  readLayerFile,
  readLayerSources,
  resolveLayers,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "./layers.js";
import { logInfo, logSuccess, logWarn, fileExists } from "./logger.js";
import {
  adaptFlowBodyForClaude,
  extractFlowReferences,
  generateClaudeSessionStart,
} from "./runner-content.js";

const BIN_LIB_ALLOWLIST = Object.freeze([
  "target-direct-transport.js",
  "worktree-commit-message.js",
]);

const KNOWN_CONFIG_FILES = Object.freeze([
  LAYER_FILES.persona,
  LAYER_FILES.autonomy,
  LAYER_FILES.permissions,
  "identity.json",
]);

/** Identity configuration file and its installation default. */
export const IDENTITY_FILE = "identity.json";
export const DEFAULT_BASE_NAME = "Aitana";
export const BASE_NAME_PATTERN = /^[\p{L}][\p{L}\p{M}' -]{0,39}$/u;

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

/** Placeholder payload id used to render the startup document before the real id exists. */
const STARTUP_PAYLOAD_PLACEHOLDER = "__flowtask_payload__";

/**
 * Synthetic runtime root for that provisional render. It keeps the payload id
 * independent of the installation location.
 */
const STARTUP_PLACEHOLDER_ROOT = "__flowtask_runtime__";

export function buildPayloadId(version, files) {
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

/**
 * Rewrite every flow body for Claude Code: skill calls become direct reads of
 * the final payload. The canonical frontmatter is preserved byte for byte.
 */
function adaptStagingFlows({ stagingDir, runnerBody, finalPaths }) {
  const stagingSkillsDir = path.join(stagingDir, "skills");
  for (const reference of extractFlowReferences(runnerBody)) {
    const flowPath = path.join(stagingSkillsDir, reference.flow, "SKILL.md");
    if (!fileExists(flowPath)) {
      const error = new Error(
        `Flow ${reference.flow} is missing from the Claude payload staging copy.`,
      );
      error.code = "runner_flows_missing";
      error.flow = reference.flow;
      throw error;
    }
    const content = fs.readFileSync(flowPath, "utf8");
    const frontmatter = content.match(/^---\n[\s\S]*?\n---\n?/);
    const prefix = frontmatter ? frontmatter[0] : "";
    const body = content.slice(prefix.length);
    const adapted = adaptFlowBodyForClaude(body, {
      skillsDir: finalPaths.skillsDir,
      context: reference.flow,
    });
    writeFileAtomic(flowPath, prefix + adapted);
  }
}

// ─── Global configuration ─────────────────────────────────────────────────────

function invalidIdentity(identityPath, reason) {
  return { status: "invalid", value: null, path: identityPath, reason };
}

/**
 * Read the installation identity. A missing file is a creation opportunity; an
 * invalid file is never replaced with a default.
 */
export function readIdentityProfile(configDir) {
  const identityPath = path.join(configDir, IDENTITY_FILE);
  if (!fileExists(identityPath)) {
    return { status: "missing", value: null, path: identityPath, reason: null };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  } catch (error) {
    return invalidIdentity(identityPath, `${IDENTITY_FILE} is not valid JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidIdentity(identityPath, "the identity profile is not a JSON object");
  }
  if (raw.version !== 1) {
    return invalidIdentity(identityPath, `invalid identity version: ${JSON.stringify(raw.version)}`);
  }
  if (typeof raw.baseName !== "string") {
    return invalidIdentity(identityPath, "the identity profile does not declare a baseName value");
  }
  const baseName = raw.baseName.trim();
  if (!baseName) return invalidIdentity(identityPath, "the base name is empty");
  if (!BASE_NAME_PATTERN.test(baseName)) {
    return invalidIdentity(identityPath, `invalid base name: ${JSON.stringify(raw.baseName)}`);
  }
  if (baseName.toLowerCase() === "hermes") {
    return invalidIdentity(identityPath, "the base name Hermes is reserved");
  }
  return { status: "present", value: { version: 1, baseName }, path: identityPath, reason: null };
}

function invalidOperationalLayerError(name, filePath, reason) {
  const error = new Error(describeOperationalFailure({ layer: name, path: filePath, reason }));
  error.code = `${name}_invalid`;
  error.layer = name;
  error.path = filePath;
  error.reason = reason;
  return error;
}

/**
 * Read-only check of the user-level layers. An invalid operational layer fails
 * before anything is written; a missing layer is reported so the caller can
 * decide which value to write. An invalid or missing persona only warns and
 * continues without persona.
 */
export function preflightClaudeRuntimeConfig(configDir) {
  const resolution = resolveLayers({ project: readLayerSources(configDir) });
  const profilePath = path.join(configDir, LAYER_FILES.persona);

  if (resolution.layers.persona.status === "invalid") {
    logWarn(`Invalid persona profile at ${profilePath}: ${resolution.layers.persona.reason ?? "invalid layer"}. Continuing without persona.`);
  } else if (resolution.layers.persona.status === "missing") {
    logWarn(`No persona profile was found at ${profilePath}; continuing without persona.`);
  }

  const missing = [];
  for (const name of ["autonomy", "permissions"]) {
    const layer = resolution.layers[name];
    if (layer.status === "invalid") {
      throw invalidOperationalLayerError(name, path.join(configDir, LAYER_FILES[name]), layer.reason ?? "invalid layer");
    }
    if (layer.status === "missing") missing.push(name);
  }
  return { resolution, missing };
}

/**
 * Ensure the three user-level layers and the installation identity. A missing
 * operational layer receives the explicit choice or the installation default;
 * an existing invalid layer or identity is never overwritten.
 */
export function ensureClaudeRuntimeConfig(
  configDir,
  { personaChoice = null, autonomyProfile = null, replaceAutonomy = false } = {},
) {
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
      logWarn(`Invalid persona choice for the FlowTask runtime: ${validated.reason}. Continuing without persona.`);
      profile = { status: "invalid", value: null, reason: validated.reason };
    } else {
      const existingFile = fileExists(profilePath) ? readLayerFile(profilePath) : null;
      const existingRaw = existingFile && existingFile.status === "present" ? existingFile.value : null;
      writeJsonIfChanged(profilePath, buildProfileForWrite(existingRaw, validated.value));
      profile = validated;
    }
  } else if (fileExists(profilePath)) {
    const existing = readLayerFile(profilePath);
    const validated = existing.status === "invalid"
      ? { status: "invalid", value: null, reason: existing.reason }
      : validatePersonaLayer(existing.value);
    if (validated.status === "invalid") {
      logWarn(`Invalid persona profile at ${profilePath}: ${validated.reason ?? "invalid layer"}. Continuing without persona.`);
    }
    profile = validated;
  }

  if (autonomyProfile !== null && !AUTONOMY_PROFILES.includes(autonomyProfile)) {
    const error = new Error(`[FlowTask Layers] Invalid autonomy choice: ${JSON.stringify(autonomyProfile)}.`);
    error.code = "autonomy_choice_invalid";
    throw error;
  }

  const operational = {};
  for (const name of ["autonomy", "permissions"]) {
    const filePath = path.join(configDir, LAYER_FILES[name]);
    const validator = name === "autonomy" ? validateAutonomyLayer : validatePermissionsLayer;

    if (!fileExists(filePath)) {
      const value = name === "autonomy" && autonomyProfile
        ? { version: 1, profile: autonomyProfile }
        : MIGRATION_DEFAULTS[name];
      const validatedValue = validator(value);
      if (validatedValue.status !== "valid") {
        throw invalidOperationalLayerError(name, filePath, validatedValue.reason ?? "invalid layer");
      }
      writeFileAtomic(filePath, JSON.stringify(value, null, 2));
      logSuccess(
        name === "autonomy" && autonomyProfile
          ? `autonomy layer written to ${filePath} with the selected value.`
          : `${name} layer written to ${filePath} with the installation default value.`,
      );
      operational[name] = validatedValue;
      continue;
    }

    const existing = readLayerFile(filePath);
    const validated = existing.status === "invalid"
      ? { status: "invalid", value: null, reason: existing.reason }
      : validator(existing.value);
    if (validated.status === "invalid") {
      throw invalidOperationalLayerError(name, filePath, validated.reason ?? "invalid layer");
    }
    if (name === "autonomy" && replaceAutonomy && autonomyProfile && validated.value.profile !== autonomyProfile) {
      const value = { version: 1, profile: autonomyProfile };
      writeFileAtomic(filePath, JSON.stringify(value, null, 2));
      logSuccess(`autonomy layer written to ${filePath} with the selected value.`);
      operational[name] = validator(value);
      continue;
    }
    operational[name] = validated;
  }

  let identity = readIdentityProfile(configDir);
  if (identity.status === "missing") {
    writeJsonIfChanged(path.join(configDir, IDENTITY_FILE), {
      version: 1,
      baseName: DEFAULT_BASE_NAME,
    });
    identity = readIdentityProfile(configDir);
  }
  if (identity.status === "invalid") {
    const error = new Error(
      `Invalid identity profile at ${identity.path}: ${identity.reason}. Fix or move the file and retry.`,
    );
    error.code = "identity_invalid";
    error.path = identity.path;
    error.reason = identity.reason;
    throw error;
  }

  return {
    profile,
    autonomy: operational.autonomy,
    permissions: operational.permissions,
    identity,
  };
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

    // The startup document embeds the payload path, so the id is computed from
    // a provisional copy resolved against a placeholder id. The final copy is
    // regenerated once the id is known and the manifest records its hash.
    const placeholderPaths = resolveActiveRuntimePaths(STARTUP_PLACEHOLDER_ROOT, {
      payloadId: STARTUP_PAYLOAD_PLACEHOLDER,
    });
    generateClaudeSessionStart({
      skillsDir: placeholderPaths.skillsDir,
      runnerPath: placeholderPaths.runnerPath,
      sessionStartPath: path.join(stagingDir, "session-start.md"),
      runnerContent: runnerBody,
      verificationSkillsDir: path.join(stagingDir, "skills"),
    });

    const payloadId = buildPayloadId(version, buildPayloadFiles(stagingDir));
    const payloadDir = path.join(runtimeVersionsDir, payloadId);
    const finalPaths = resolveActiveRuntimePaths(runtimeRoot, { payloadId });
    adaptStagingFlows({ stagingDir, runnerBody, finalPaths });
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
      retainedPayloads:
        previousManifest && previousManifest.payloadId !== payloadId
          ? [{
              payloadId: previousManifest.payloadId,
              files: previousManifest.files ?? [],
            }]
          : [],
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
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const manifestFileExists = fileExists(manifestPath);

  // Removal reads the manifest without adopting it: a tampered payload is not
  // a reason to delete files whose hash does not match.
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (parsed?.schema === CLAUDE_RUNTIME_SCHEMA && typeof parsed.payloadId === "string" && Array.isArray(parsed.files)) {
      manifest = parsed;
    }
  } catch {
    manifest = null;
  }

  if (manifest) {
    const removePayload = (payloadId, files) => {
      const payloadDir = path.join(runtimeRoot, "versions", payloadId);
      for (const file of files) {
        if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") continue;
        const absolute = path.resolve(payloadDir, file.path);
        if (!absolute.startsWith(path.resolve(payloadDir) + path.sep) || !fileExists(absolute)) continue;
        if (sha256File(absolute) !== file.sha256) {
          preserved.push(absolute);
          continue;
        }
        fs.rmSync(absolute, { force: true });
        removed.push(absolute);
      }
    };

    removePayload(manifest.payloadId, manifest.files);
    for (const retained of manifest.retainedPayloads ?? []) {
      if (retained && typeof retained.payloadId === "string" && Array.isArray(retained.files)) {
        removePayload(retained.payloadId, retained.files);
      }
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

  const versionsDir = path.join(runtimeRoot, "versions");
  if (!manifestFileExists && fileExists(versionsDir)) {
    fs.rmSync(versionsDir, { recursive: true, force: true });
    removed.push(versionsDir);
  } else if (fileExists(versionsDir)) {
    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const payloadDir = path.join(versionsDir, entry.name);
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
    removeIfEmpty(versionsDir);
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
