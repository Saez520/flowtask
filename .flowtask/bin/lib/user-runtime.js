import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveGlobalConfigDir } from "./global-paths.js";
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

/** Schema of the user-level runtime manifest. */
export const USER_RUNTIME_SCHEMA = 2;

/** Payload variants: the canonical one and the Claude Code adaptation. */
export const USER_RUNTIME_VARIANTS = Object.freeze(["canonical", "claude"]);

/** Sources copied into every payload, relative to the FlowTask directory. */
const PAYLOAD_SOURCES = Object.freeze(["skills", "scripts", "agents", "commands"]);

/** Library files copied into every payload. */
const BIN_LIB_ALLOWLIST = Object.freeze([
  "target-direct-transport.js",
  "worktree-commit-message.js",
]);

/** Runner and startup document are generated after the payload id is known. */
const PAYLOAD_ID_EXCLUDED = Object.freeze(["runner.md", "session-start.md"]);

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

/** Relative path and digest of every file below a directory, sorted by path. */
export function buildPayloadFiles(payloadDir) {
  return walkFiles(payloadDir)
    .map((absolutePath) => ({
      path: toManifestPath(payloadDir, absolutePath),
      sha256: sha256File(absolutePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Write a file atomically: temp file in the same directory, then rename. */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* already gone */ }
    throw error;
  }
}

/** SHA-256 hex digest of a file. */
export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyTree(sourceDir, destinationDir) {
  if (!fileExists(sourceDir)) return;
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

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Single resolver for the user-level runtime. The runtime lives once per
 * operating-system account under the global configuration directory; versioned
 * payloads live below `versions/`.
 */
export function resolveUserRuntimePaths(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? resolveGlobalConfigDir();
  return {
    runtimeRoot,
    versionsDir: path.join(runtimeRoot, "versions"),
    manifestPath: path.join(runtimeRoot, "runtime.json"),
    configDir: path.join(runtimeRoot, "config"),
    projectsIndexPath: path.join(runtimeRoot, "projects.json"),
    launcherPath: path.join(runtimeRoot, "bin", "session-start.mjs"),
    launcherDir: path.join(runtimeRoot, "bin"),
    pluginsDir: path.join(runtimeRoot, "plugins"),
  };
}

/**
 * Resolve the paths inside a published payload directory.
 * `payloadIdOrManifest` may be a payload id, a payload entry or the manifest.
 * When it is the manifest, `variant` selects the payload.
 */
export function resolveUserPayloadPaths(runtimeRoot, payloadIdOrManifest, variant = "canonical") {
  let payloadId = payloadIdOrManifest;
  if (payloadIdOrManifest && typeof payloadIdOrManifest === "object") {
    payloadId = payloadIdOrManifest.payloads
      ? payloadIdOrManifest.payloads[variant]?.payloadId
      : payloadIdOrManifest.payloadId;
  }
  if (typeof payloadId !== "string" || !payloadId) {
    throw new Error(`runtime manifest does not declare a ${variant} payloadId`);
  }
  const payloadDir = path.join(runtimeRoot, "versions", payloadId);
  return {
    payloadId,
    payloadDir,
    runnerPath: path.join(payloadDir, "runner.md"),
    sessionStartPath: path.join(payloadDir, "session-start.md"),
    skillsDir: path.join(payloadDir, "skills"),
    scriptsDir: path.join(payloadDir, "scripts"),
    agentsDir: path.join(payloadDir, "agents"),
    commandsDir: path.join(payloadDir, "commands"),
    binLibDir: path.join(payloadDir, "bin", "lib"),
  };
}

/**
 * Identity of a payload: version, descriptor, and the digests of the source
 * tree that is published. The generated runner and startup document are
 * excluded so the id never depends on their content or location.
 */
export function buildPayloadIdFromSource({ version, files, descriptor = {} } = {}) {
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("buildPayloadIdFromSource requires a version.");
  }
  if (!Array.isArray(files)) throw new Error("buildPayloadIdFromSource requires the payload files.");
  const material = files
    .filter((file) => !PAYLOAD_ID_EXCLUDED.includes(file.path))
    .map((file) => `${file.path}\0${file.sha256}`)
    .join("\n");
  const digest = crypto
    .createHash("sha256")
    .update(`${version}\0${JSON.stringify(descriptor)}\0${material}`)
    .digest("hex");
  return `${version}-${digest.slice(0, 12)}`;
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
 * Report whether a config directory holds at least one user-level layer file.
 * Unrelated files alone do not make the directory a layer source.
 */
export function hasLayerFiles(configDir) {
  return [LAYER_FILES.persona, LAYER_FILES.autonomy, LAYER_FILES.permissions]
    .some((fileName) => fileExists(path.join(configDir, fileName)));
}

/**
 * Read-only check of the user-level layers. An invalid operational layer fails
 * before anything is written; a missing layer is reported so the caller can
 * decide which value to write. An invalid or missing persona only warns and
 * continues without persona.
 */
export function preflightUserRuntimeConfig(configDir) {
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
export function ensureUserRuntimeConfig(
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

function manifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validatePayloadFiles(entry, manifestPath, variant) {
  if (!entry || typeof entry !== "object" || typeof entry.payloadId !== "string" || !entry.payloadId) {
    throw manifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} has no valid ${variant} payload. Run: flowtask install`,
    );
  }
  if (!Array.isArray(entry.files)) {
    throw manifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} declares no files for the ${variant} payload. Run: flowtask install`,
    );
  }
}

/**
 * Read and validate the user-level runtime manifest. With `verifyPayload`
 * disabled the schema and entry shapes are still checked, but a missing payload
 * or modified file does not abort: update needs that state to restore it.
 */
export function readUserRuntimeManifest(runtimeRoot, { verifyPayload = true } = {}) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) {
    throw manifestError(
      "runtime_manifest_missing",
      `FlowTask runtime manifest not found at ${manifestPath}. Run: flowtask install`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (parseError) {
    throw manifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} is not valid JSON: ${parseError.message}`,
    );
  }

  if (manifest?.schema !== USER_RUNTIME_SCHEMA) {
    throw manifestError(
      "runtime_manifest_incompatible",
      `FlowTask runtime manifest uses schema ${manifest?.schema ?? "missing"}; this CLI supports schema ${USER_RUNTIME_SCHEMA}. Run: flowtask install`,
    );
  }
  if (!manifest.payloads || typeof manifest.payloads !== "object") {
    throw manifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} is incomplete. Run: flowtask install`,
    );
  }

  for (const variant of USER_RUNTIME_VARIANTS) {
    const entry = manifest.payloads[variant];
    if (entry === undefined) continue;
    validatePayloadFiles(entry, manifestPath, variant);
    const payloadDir = path.join(runtimeRoot, "versions", entry.payloadId);
    if (verifyPayload && !fileExists(payloadDir)) {
      throw manifestError(
        "runtime_payload_missing",
        `FlowTask runtime payload ${entry.payloadId} is missing at ${payloadDir}. Run: flowtask install`,
      );
    }
    for (const file of entry.files) {
      if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
        throw manifestError(
          "runtime_manifest_invalid",
          `FlowTask runtime manifest at ${manifestPath} declares an invalid file entry. Run: flowtask update`,
        );
      }
      const absolute = path.resolve(payloadDir, file.path);
      if (!absolute.startsWith(path.resolve(payloadDir) + path.sep)) {
        throw manifestError(
          "runtime_payload_incomplete",
          `FlowTask runtime payload is incomplete: ${file.path} is missing. Run: flowtask install`,
        );
      }
      if (!verifyPayload) continue;
      if (!fileExists(absolute)) {
        throw manifestError(
          "runtime_payload_incomplete",
          `FlowTask runtime payload is incomplete: ${file.path} is missing. Run: flowtask install`,
        );
      }
      if (sha256File(absolute) !== file.sha256) {
        throw manifestError(
          "runtime_payload_modified",
          `FlowTask runtime payload was modified: ${file.path}. Run: flowtask install`,
        );
      }
    }
  }

  return manifest;
}

// ─── Runtime payload ──────────────────────────────────────────────────────────

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

function stagePayloadSource(flowtaskDir, stagingDir) {
  for (const source of PAYLOAD_SOURCES) {
    copyTree(path.join(flowtaskDir, source), path.join(stagingDir, source));
  }
  // The canonical runner is a source input, not a payload agent: the runtime
  // runner is written at the payload root once its id is known.
  const stagedRunner = path.join(stagingDir, "agents", "runner.md");
  if (fileExists(stagedRunner)) fs.rmSync(stagedRunner, { force: true });
  const stagingBinLib = path.join(stagingDir, "bin", "lib");
  fs.mkdirSync(stagingBinLib, { recursive: true });
  for (const fileName of BIN_LIB_ALLOWLIST) {
    const source = path.join(flowtaskDir, "bin", "lib", fileName);
    if (fileExists(source)) fs.copyFileSync(source, path.join(stagingBinLib, fileName));
  }
}

function publishPayload({ stagingDir, payloadDir, files, previousEntry }) {
  const restoredPaths = [];
  if (!fileExists(payloadDir)) {
    fs.renameSync(stagingDir, payloadDir);
    return { unchanged: false, restoredPaths };
  }

  const existingFiles = buildPayloadFiles(payloadDir);
  if (compareJson(existingFiles, files)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return { unchanged: true, restoredPaths };
  }

  for (const file of files) {
    const existing = existingFiles.find((entry) => entry.path === file.path);
    if (!existing || existing.sha256 !== file.sha256) restoredPaths.push(path.join(payloadDir, file.path));
  }
  if (previousEntry?.files) {
    for (const file of previousEntry.files) {
      const existing = files.find((entry) => entry.path === file.path);
      if (!existing) restoredPaths.push(path.join(payloadDir, file.path));
    }
  }
  const backupDir = `${payloadDir}.backup-${process.pid}-${Date.now()}`;
  fs.renameSync(payloadDir, backupDir);
  try {
    fs.renameSync(stagingDir, payloadDir);
  } catch (error) {
    fs.renameSync(backupDir, payloadDir);
    throw error;
  }
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* the active payload is already published */ }
  return { unchanged: false, restoredPaths };
}

/**
 * Build the requested payload variants atomically and point the manifest at
 * them. Each variant is staged, published by rename and recorded with its
 * digests; the manifest is written last with an atomic write.
 *
 * `buildRunnerBody(payloadPaths)` receives the final payload paths so the
 * runner can reference its own scripts, skills and library.
 */
export function ensureUserRuntime(flowtaskDir, options = {}) {
  const { version, descriptor = {}, buildRunnerBody, targets = null } = options;
  const variants = Array.isArray(options.variants) && options.variants.length > 0
    ? [...new Set(options.variants)]
    : ["canonical"];
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("ensureUserRuntime requires a version.");
  }
  if (typeof buildRunnerBody !== "function") {
    throw new Error("ensureUserRuntime requires a runner body builder.");
  }
  for (const variant of variants) {
    if (!USER_RUNTIME_VARIANTS.includes(variant)) {
      throw new Error(`Unknown runtime payload variant: ${variant}`);
    }
  }

  const paths = resolveUserRuntimePaths({ runtimeRoot: options.runtimeRoot });
  const runtimeRoot = paths.runtimeRoot;
  const runtimeVersionsDir = paths.versionsDir;
  const manifestPath = paths.manifestPath;

  const runtimeRootExists = fileExists(runtimeRoot);
  if (runtimeRootExists) {
    // A migrated configuration or the user plugins may exist before the first
    // payload. Any other entry without a manifest remains an unmanaged root.
    const entries = fs.readdirSync(runtimeRoot).filter((entry) => !["config", "plugins", "worktree-manager"].includes(entry));
    if (entries.length > 0 && !fileExists(manifestPath)) {
      throw manifestError(
        "runtime_root_unmanaged",
        `Refusing to use ${runtimeRoot}: it contains files but no runtime manifest. ` +
          "Move the directory away or run flowtask install after inspecting it.",
      );
    }
  }

  let previousManifest = null;
  if (fileExists(manifestPath)) previousManifest = readUserRuntimeManifest(runtimeRoot, { verifyPayload: false });

  fs.mkdirSync(runtimeVersionsDir, { recursive: true });
  const nextPayloads = { ...(previousManifest?.payloads ?? {}) };
  const previous = {
    canonical: previousManifest?.previous?.canonical ?? null,
    claude: previousManifest?.previous?.claude ?? null,
  };
  const restoredPaths = [];
  const actions = [];
  const runnerSource = fs.readFileSync(path.join(flowtaskDir, "agents", "runner.md"), "utf8");

  for (const variant of variants) {
    const stagingDir = path.join(runtimeVersionsDir, `.staging-${variant}-${process.pid}-${Date.now()}`);
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      stagePayloadSource(flowtaskDir, stagingDir);

      const sourceFiles = buildPayloadFiles(stagingDir);
      const payloadId = buildPayloadIdFromSource({
        version,
        files: sourceFiles,
        descriptor: { ...descriptor, variant },
      });
      const payloadDir = path.join(runtimeVersionsDir, payloadId);
      const payloadPaths = resolveUserPayloadPaths(runtimeRoot, payloadId);

      if (variant === "claude") {
        adaptStagingFlows({ stagingDir, runnerBody: runnerSource, finalPaths: payloadPaths });
      }

      writeFileAtomic(path.join(stagingDir, "runner.md"), buildRunnerBody(payloadPaths));

      const runnerContent = fs.readFileSync(path.join(stagingDir, "runner.md"), "utf8");
      if (variant === "claude") {
        generateClaudeSessionStart({
          skillsDir: payloadPaths.skillsDir,
          runnerPath: payloadPaths.runnerPath,
          sessionStartPath: path.join(stagingDir, "session-start.md"),
          runnerContent,
          verificationSkillsDir: path.join(stagingDir, "skills"),
        });
      }

      const files = buildPayloadFiles(stagingDir);
      const published = publishPayload({
        stagingDir,
        payloadDir,
        files,
        previousEntry: nextPayloads[variant] ?? null,
      });
      restoredPaths.push(...published.restoredPaths);

      let launcher = null;
      if (variant === "claude") {
        const launcherSource = path.join(flowtaskDir, "claude", "session-start.mjs");
        if (fileExists(launcherSource)) {
          const launcherBytes = fs.readFileSync(launcherSource);
          const launcherStat = fs.lstatSync(paths.launcherPath, { throwIfNoEntry: false });
          const launcherChanged = !launcherStat || !launcherStat.isFile() || !fs.readFileSync(paths.launcherPath).equals(launcherBytes);
          if (launcherChanged) {
            writeFileAtomic(paths.launcherPath, launcherBytes);
            if (launcherStat) restoredPaths.push(paths.launcherPath);
          }
          launcher = { path: "bin/session-start.mjs", sha256: sha256File(paths.launcherPath) };
        } else {
          logWarn(`Runtime launcher template not found at ${launcherSource}; the hook will not start until it is installed.`);
        }
      }

      const previousId = previousManifest?.payloads?.[variant]?.payloadId ?? null;
      if (previousId && previousId !== payloadId) {
        previous[variant] = previousId;
      } else if (!previousId) {
        previous[variant] = previous[variant] ?? null;
      }
      nextPayloads[variant] = {
        payloadId,
        files,
        ...(variant === "claude" ? { sessionStart: "session-start.md" } : {}),
        ...(launcher ? { launcher } : {}),
      };
      actions.push(published.unchanged ? "unchanged" : (previousManifest ? "updated" : "installed"));
    } catch (error) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* already gone */ }
      throw error;
    }
  }

  const retainedPayloads = [];
  for (const entry of previousManifest?.retainedPayloads ?? []) {
    if (entry && typeof entry.payloadId === "string" && Array.isArray(entry.files)) retainedPayloads.push(entry);
  }
  for (const variant of USER_RUNTIME_VARIANTS) {
    const previousId = previous[variant];
    if (!previousId) continue;
    const known = previousManifest?.payloads?.[variant];
    const files = known?.payloadId === previousId
      ? known.files
      : (previousManifest?.retainedPayloads ?? []).find(
        (entry) => entry.variant === variant && entry.payloadId === previousId,
      )?.files;
    if (!Array.isArray(files)) continue;
    if (retainedPayloads.some((entry) => entry.variant === variant && entry.payloadId === previousId)) continue;
    retainedPayloads.push({ variant, payloadId: previousId, files });
  }

  const manifest = {
    schema: USER_RUNTIME_SCHEMA,
    version,
    installedAt: previousManifest?.installedAt ?? new Date().toISOString(),
    updatedAt: previousManifest?.updatedAt ?? new Date().toISOString(),
    source: path.resolve(flowtaskDir),
    payloads: nextPayloads,
    previous,
    retainedPayloads,
    plugins: previousManifest?.plugins ?? {},
    targets: { ...(previousManifest?.targets ?? {}), ...(targets ?? {}) },
    mcp: previousManifest?.mcp ?? null,
    hookCommand: buildSessionStartHookCommand(runtimeRoot),
  };

  const previousSerialized = previousManifest ? JSON.stringify(previousManifest, null, 2) : null;
  let serialized = JSON.stringify(manifest, null, 2);
  if (previousSerialized !== serialized) {
    manifest.updatedAt = new Date().toISOString();
    serialized = JSON.stringify(manifest, null, 2);
    writeFileAtomic(manifestPath, serialized);
  }

  const keep = new Set();
  for (const entry of Object.values(nextPayloads)) keep.add(entry.payloadId);
  for (const entry of Object.values(previous)) if (entry) keep.add(entry);
  for (const entry of fs.readdirSync(runtimeVersionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".staging-")) continue;
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(runtimeVersionsDir, entry.name), { recursive: true, force: true });
  }

  let action = actions.every((value) => value === "unchanged") ? (previousManifest ? "unchanged" : "installed") : "updated";
  if (!previousManifest) action = "installed";
  logInfo(
    action === "installed"
      ? `FlowTask runtime ${version} installed at ${runtimeRoot}.`
      : action === "updated"
        ? `FlowTask runtime ${version} updated at ${runtimeRoot}.`
        : `FlowTask runtime ${version} is already up to date at ${runtimeRoot}.`,
  );

  return {
    ok: true,
    action,
    payloads: nextPayloads,
    payloadId: nextPayloads.claude?.payloadId ?? nextPayloads.canonical?.payloadId ?? null,
    previousPayloadId: nextPayloads.claude ? previous.claude : previous.canonical,
    version,
    restoredPaths: [...new Set(restoredPaths)],
    manifest,
  };
}

/** Exact hook command that launches the runtime script without relying on PATH. */
export function buildSessionStartHookCommand(runtimeRoot, nodePath = process.execPath) {
  return `"${nodePath}" "${path.join(runtimeRoot, "bin", "session-start.mjs")}"`;
}

// ─── Runtime removal ──────────────────────────────────────────────────────────

/**
 * Remove only files declared by the manifest whose hash still matches. Unknown
 * files, and files modified after installation, are preserved and reported.
 * `preserveConfig` keeps the user-level layers for a migration.
 */
export function removeUserRuntime(runtimeRoot, { preserveConfig = false } = {}) {
  const removed = [];
  const preserved = [];
  let manifest = null;
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const manifestFileExists = fileExists(manifestPath);

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (parsed?.schema === USER_RUNTIME_SCHEMA && parsed.payloads && typeof parsed.payloads === "object") {
      manifest = { schema: 2, payloads: parsed.payloads, launcher: parsed.payloads.claude?.launcher ?? null, retainedPayloads: parsed.retainedPayloads ?? [] };
    } else if (parsed?.schema === 1 && typeof parsed.payloadId === "string" && Array.isArray(parsed.files)) {
      manifest = { schema: 1, payloads: { claude: { payloadId: parsed.payloadId, files: parsed.files } }, launcher: parsed.launcher ?? null, retainedPayloads: parsed.retainedPayloads ?? [] };
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

    for (const entry of Object.values(manifest.payloads)) {
      if (entry && typeof entry.payloadId === "string" && Array.isArray(entry.files)) {
        removePayload(entry.payloadId, entry.files);
      }
    }
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
    for (const file of walkFiles(versionsDir)) preserved.push(file);
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

  if (!preserveConfig) {
    const configDir = path.join(runtimeRoot, "config");
    for (const fileName of KNOWN_CONFIG_FILES) {
      const filePath = path.join(configDir, fileName);
      if (!fileExists(filePath)) continue;
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    }
    removeIfEmpty(configDir);
  }

  for (const fileName of ["runtime.json", "projects.json"]) {
    const filePath = path.join(runtimeRoot, fileName);
    if (!fileExists(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }

  for (const directory of [
    path.join(runtimeRoot, "bin", "lib"),
    path.join(runtimeRoot, "bin"),
    path.join(runtimeRoot, "plugins"),
    runtimeRoot,
  ]) {
    removeIfEmpty(directory);
  }

  return { removed, preserved };
}
