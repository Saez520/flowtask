import fs from "fs";
import path from "path";
import {
  buildSessionStartHook,
  generateClaudeRunnerAgent,
  mergeClaudeSettings,
  removeClaudeAgentSetting,
  removeClaudeHook,
  removeClaudeRunnerAgent,
  resolveClaudePaths,
  writeFileAtomic,
} from "./claude.js";
import {
  ensureClaudeRuntime,
  ensureClaudeRuntimeConfig,
  readClaudeRuntimeManifest,
  readLegacyClaudeRuntimeManifest,
  removeClaudeRuntime,
} from "./claude-runtime.js";
import { readIdentityProfile } from "./user-runtime.js";
import {
  readProjectsIndex,
  registerClaudeProject,
  removeClaudeProject,
} from "./claude-projects.js";
import { readProjectRegistration, reconcileProjectsIndex } from "./project-registration.js";
import { ensureUserEngramOrWarn, removeUserEngram } from "./claude-mcp.js";
import { registerWorktreeManagerMcp } from "./worktree-mcp-registration.js";
import { CUSTOM_PERSONA_TEXT, buildRuntimeRunnerBody } from "./runner-content.js";
import {
  LAYER_FILES,
  PERSONA_FILES,
  readLayerFile,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "./layers.js";
import { logInfo, logWarn, logSuccess, fileExists } from "./logger.js";

function readVersion(flowtaskDir) {
  const packagePath = path.join(flowtaskDir, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

function personaContentFromProfile(flowtaskDir, profile) {
  if (!profile) return null;
  if (profile.persona === "custom") {
    if (!CUSTOM_PERSONA_TEXT.trim()) {
      logWarn("The custom personality has no text; continuing without persona.");
      return null;
    }
    return CUSTOM_PERSONA_TEXT;
  }
  const fileName = PERSONA_FILES[profile.persona];
  if (!fileName) {
    logWarn(`Unknown personality: ${JSON.stringify(profile.persona)}; continuing without persona.`);
    return null;
  }
  const source = path.join(flowtaskDir, "personas", fileName);
  if (!fileExists(source)) {
    logWarn(`Personality file not found: ${source}; continuing without persona.`);
    return null;
  }
  return fs.readFileSync(source, "utf8");
}

function runnerBodyFor(flowtaskDir, runtimeRoot, { personaContent, profile, autonomy }) {
  const profileValue = profile && Object.hasOwn(profile, "status") ? profile.value : profile;
  const content = personaContent === undefined
    ? personaContentFromProfile(flowtaskDir, profileValue)
    : personaContent;
  const runnerContent = fs.readFileSync(path.join(flowtaskDir, "agents", "runner.md"), "utf8");
  return buildRuntimeRunnerBody({
    runnerContent,
    runtimeRoot,
    personaContent: content ?? null,
    autonomyDescriptor: autonomy,
  });
}

function persistMcpState(runtimeRoot, result) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const previous = manifest.mcp?.engram ?? null;
  const managed = result.managed === true || previous?.managed === true;
  manifest.mcp = {
    engram: {
      scope: "user",
      managed,
      addedAt: managed ? previous?.addedAt ?? new Date().toISOString() : null,
    },
  };
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Register the manager server in the project's `.mcp.json`. A manager that was
 * not downloaded already produced its own notice; a downloaded manager whose
 * MCP probe failed is reported with its cause and the config stays untouched.
 */
function registerWorktreeManagerMcpForClaude(paths, worktreeManager) {
  if (!worktreeManager) return null;
  const mcp = worktreeManager.capabilities?.mcp;
  if (mcp?.available !== true) {
    logWarn(`Worktree Manager MCP is not registered in ${paths.projectMcpPath}: ${mcp?.cause ?? "the MCP probe did not succeed"}. Worktrees are not available in this target.`);
    return null;
  }
  const result = registerWorktreeManagerMcp({
    configPath: paths.projectMcpPath,
    format: "claude",
    managerDir: worktreeManager.managerDir,
    pythonBin: worktreeManager.capabilities?.python?.executable,
  });
  switch (result.status) {
    case "registered":
      logSuccess(`Worktree Manager MCP registered in ${paths.projectMcpPath}.`);
      break;
    case "unchanged":
      logInfo(`Worktree Manager MCP already registered in ${paths.projectMcpPath}.`);
      break;
    case "preserved":
      logWarn(`Worktree Manager MCP was not registered in ${paths.projectMcpPath}: ${result.cause}. The existing configuration was preserved.`);
      break;
    case "unavailable":
      logWarn(`Worktree Manager MCP is not available: ${result.cause}. Worktrees are not available in ${paths.projectMcpPath}.`);
      break;
    default:
      logWarn(`Worktree Manager MCP could not be registered in ${paths.projectMcpPath}: ${result.cause ?? "unknown cause"}. Retry with flowtask update.`);
  }
  return result;
}

// ─── Legacy migration ────────────────────────────────────────────────────────

const LEGACY_LAYERS = Object.freeze([
  { name: "profile", file: LAYER_FILES.persona, validate: validatePersonaLayer },
  { name: "autonomy", file: LAYER_FILES.autonomy, validate: validateAutonomyLayer },
  { name: "permissions", file: LAYER_FILES.permissions, validate: validatePermissionsLayer },
]);

const LEGACY_FLOWTASK_HOOK = 'cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"';
const LEGACY_CLAUDE_START = "<!-- FLOWTASK:START -->";
const LEGACY_CLAUDE_END = "<!-- FLOWTASK:END -->";
const ENGRAM_TEMPLATE = Object.freeze({
  type: "stdio",
  command: "engram",
  args: Object.freeze(["mcp"]),
  env: Object.freeze({}),
});

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJsonFile(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function legacyClaudeArtifacts(paths) {
  return [
    path.join(paths.projectFlowtaskDir, ".installation-method"),
    path.join(paths.projectFlowtaskDir, "skills"),
    path.join(paths.projectFlowtaskDir, "scripts"),
    path.join(paths.projectFlowtaskDir, "agents"),
    path.join(paths.projectFlowtaskDir, "commands"),
    paths.legacySessionStartPath,
    path.join(paths.projectFlowtaskDir, "config", "profile.json"),
    path.join(paths.projectFlowtaskDir, "config", "autonomy.json"),
    path.join(paths.projectFlowtaskDir, "config", "permissions.json"),
    path.join(paths.projectFlowtaskDir, "config", "review.json"),
  ];
}

function hasLegacyClaudeInstallation(paths) {
  if (legacyClaudeArtifacts(paths).some((filePath) => fs.existsSync(filePath))) return true;

  if (fileExists(path.join(projectDirFromPaths(paths), "CLAUDE.md"))) {
    const claudeMd = fs.readFileSync(path.join(projectDirFromPaths(paths), "CLAUDE.md"), "utf8");
    if (claudeMd.includes(LEGACY_CLAUDE_START)) return true;
  }

  const settings = readJsonFile(paths.projectSettingsPath);
  if (settings.ok) {
    const hooks = settings.value?.hooks ?? {};
    if (JSON.stringify(hooks).includes(LEGACY_FLOWTASK_HOOK)) return true;
  }

  const mcp = readJsonFile(paths.projectMcpPath);
  if (mcp.ok && mcp.value?.mcpServers?.engram) return true;

  return false;
}

function projectDirFromPaths(paths) {
  return paths.projectDir;
}

function migrateLegacyConfig(paths, removed, preserved, manualReview, { migrate = true } = {}) {
  const configDir = path.join(paths.projectFlowtaskDir, "config");
  const globalConfigDir = paths.runtimeConfigDir;

  if (!migrate) {
    for (const layer of LEGACY_LAYERS) {
      const source = path.join(configDir, layer.file);
      if (!fileExists(source)) continue;
      fs.rmSync(source, { force: true });
      removed.push(source);
    }
    const review = path.join(configDir, "review.json");
    if (fileExists(review)) {
      fs.rmSync(review, { force: true });
      removed.push(review);
    }
    return;
  }

  for (const layer of LEGACY_LAYERS) {
    const source = path.join(configDir, layer.file);
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

    const destination = path.join(globalConfigDir, layer.file);
    if (!fileExists(destination)) {
      writeFileAtomic(destination, JSON.stringify(validated.value, null, 2));
      logInfo(`Legacy ${layer.name} layer migrated to ${destination}.`);
    } else {
      const existing = readLayerFile(destination);
      const existingValidated = existing.status === "invalid"
        ? { status: "invalid", value: null, reason: existing.reason }
        : layer.validate(existing.value);
      if (existingValidated.status !== "valid") {
        preserved.push(source);
        manualReview.push(
          `${destination} is invalid; the legacy ${layer.name} layer at ${source} was preserved.`,
        );
        continue;
      }
    }

    fs.rmSync(source, { force: true });
    removed.push(source);
  }

  const review = path.join(configDir, "review.json");
  if (fileExists(review)) {
    fs.rmSync(review, { force: true });
    removed.push(review);
  }
}

function migrateLegacyRuntimeConfig(legacyConfigDir, configDir, removed, preserved, manualReview) {
  fs.mkdirSync(configDir, { recursive: true });
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

    const destination = path.join(configDir, layer.file);
    if (!fileExists(destination)) {
      writeFileAtomic(destination, JSON.stringify(validated.value, null, 2));
      fs.rmSync(source, { force: true });
      removed.push(source);
      logInfo(`Legacy ${layer.name} layer migrated to ${destination}.`);
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
    fs.rmSync(source, { force: true });
    removed.push(source);
  }

  const identitySource = path.join(legacyConfigDir, "identity.json");
  if (fileExists(identitySource)) {
    const identity = readIdentityProfile(legacyConfigDir);
    const destination = path.join(configDir, "identity.json");
    if (identity.status !== "present") {
      preserved.push(identitySource);
      manualReview.push(`${identitySource} is not a valid identity profile and was preserved.`);
    } else if (!fileExists(destination)) {
      writeFileAtomic(destination, JSON.stringify(identity.value, null, 2));
      fs.rmSync(identitySource, { force: true });
      removed.push(identitySource);
    } else {
      const existing = readIdentityProfile(configDir);
      if (existing.status !== "present" || existing.value.baseName !== identity.value.baseName) {
        preserved.push(identitySource);
        manualReview.push(`${destination} already defines a different identity; the legacy copy at ${identitySource} was preserved.`);
      } else {
        fs.rmSync(identitySource, { force: true });
        removed.push(identitySource);
      }
    }
  }
}

function mergeLegacyProjectsIndex(legacyRoot, runtimeRoot, preserved, manualReview) {
  const legacyIndexPath = path.join(legacyRoot, "projects.json");
  if (!fileExists(legacyIndexPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(legacyIndexPath, "utf8"));
  } catch (error) {
    preserved.push(legacyIndexPath);
    manualReview.push(`${legacyIndexPath} is not valid JSON; its entries were preserved.`);
    return;
  }
  const entries = Array.isArray(parsed?.projects) ? parsed.projects : [];
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string") continue;
    const registration = readProjectRegistration(entry.path, "claude");
    if (registration.status === "active") {
      reconcileProjectsIndex(runtimeRoot, {
        current: { ...registration.registry, targets: ["claude"] },
        mode: "install",
      });
    } else {
      manualReview.push(`Legacy index entry ${entry.path} has no readable registration and was not merged.`);
    }
  }
}

/**
 * Move a schema 1 runtime from the Claude user directory to the global runtime.
 * Only a valid legacy manifest is migrated and removed; declared files are
 * removed with their hash, invalid or conflicting layers are preserved, and
 * the SessionStart hook is repointed before the old runtime is removed.
 */
export function migrateLegacyClaudeRuntime({ flowtaskDir, runtimeRoot, claudeUserDir }) {
  const legacyRoot = path.join(claudeUserDir, "flowtask");
  const removed = [];
  const preserved = [];
  const manualReview = [];
  if (path.resolve(legacyRoot) === path.resolve(runtimeRoot)) {
    return { migrated: false, legacyRoot, removed, preserved, manualReview };
  }

  let manifest;
  try {
    manifest = readLegacyClaudeRuntimeManifest(legacyRoot, { verifyPayload: false });
  } catch (error) {
    if (error.code !== "runtime_manifest_missing") {
      logWarn(`The previous Claude runtime at ${legacyRoot} was preserved: ${error.message}`);
      manualReview.push(`${legacyRoot} was preserved because its manifest is not a valid schema 1 manifest.`);
    }
    return { migrated: false, legacyRoot, removed, preserved, manualReview };
  }

  migrateLegacyRuntimeConfig(
    path.join(legacyRoot, "config"),
    path.join(runtimeRoot, "config"),
    removed,
    preserved,
    manualReview,
  );
  mergeLegacyProjectsIndex(legacyRoot, runtimeRoot, preserved, manualReview);

  const settingsPath = path.join(claudeUserDir, "settings.json");
  const legacyLauncher = path.join(legacyRoot, "bin", "session-start.mjs");
  if (fileExists(settingsPath)) {
    const merge = mergeClaudeSettings(settingsPath, { hooks: buildSessionStartHook(runtimeRoot) });
    if (!merge.ok) {
      manualReview.push(`${settingsPath} could not be updated: ${merge.error}. The previous runtime was preserved.`);
      return { migrated: false, legacyRoot, removed, preserved, manualReview };
    }
    if (merge.changed) removed.push(`${settingsPath}#FlowTask hook`);
    const cleanup = removeClaudeHook(settingsPath, { commandIncludes: legacyLauncher });
    if (!cleanup.ok) {
      manualReview.push(`${settingsPath} keeps the previous FlowTask hook: ${cleanup.error}. The previous runtime was preserved.`);
      return { migrated: false, legacyRoot, removed, preserved, manualReview };
    }
    if (cleanup.changed) removed.push(`${settingsPath}#legacy FlowTask hook`);
  }

  const runtimeRemoval = removeClaudeRuntime(legacyRoot, { preserveConfig: true });
  removed.push(...runtimeRemoval.removed);
  preserved.push(...runtimeRemoval.preserved);

  if (manualReview.length > 0) {
    for (const message of manualReview) logWarn(message);
  }
  logSuccess(`Previous Claude runtime migrated from ${legacyRoot}: ${runtimeRemoval.removed.length} artifact(s) removed.`);
  return { migrated: true, legacyRoot, removed, preserved, manualReview };
}

function removeLegacyClaudeBlock(projectDir, removed, preserved, manualReview) {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (!fileExists(claudeMdPath)) return;

  const current = fs.readFileSync(claudeMdPath, "utf8");
  const start = current.indexOf(LEGACY_CLAUDE_START);
  const end = current.indexOf(LEGACY_CLAUDE_END);
  if (start === -1 || end === -1 || end < start) {
    preserved.push(claudeMdPath);
    return;
  }

  let prefix = current.slice(0, start);
  let suffix = current.slice(end + LEGACY_CLAUDE_END.length);
  prefix = prefix.replace(/\n\n---\n\n$/, "");
  suffix = suffix.replace(/^\n*/, "");
  const next = `${prefix}${suffix}`.trimEnd();

  if (next.trim() === "") {
    fs.rmSync(claudeMdPath, { force: true });
    removed.push(claudeMdPath);
    return;
  }

  writeFileAtomic(claudeMdPath, `${next}\n`);
  removed.push(`${claudeMdPath}#FlowTask section`);
}

function removeLegacyProjectMcp(paths, flowtaskDir, removed, preserved, manualReview) {
  const mcpPath = paths.projectMcpPath;
  if (!fileExists(mcpPath)) return;

  const read = readJsonFile(mcpPath);
  if (!read.ok) {
    preserved.push(mcpPath);
    manualReview.push(`${mcpPath} is not valid JSON; its Engram entry was not removed.`);
    return;
  }

  const template = flowtaskDir
    ? readJsonFile(path.join(flowtaskDir, "claude", "mcp.json"))
    : { ok: false };
  const entry = read.value?.mcpServers?.engram;
  if (!entry) return;

  const expected = template.ok ? template.value?.mcpServers?.engram : ENGRAM_TEMPLATE;
  if (stableStringify(entry) !== stableStringify(expected)) {
    preserved.push(`${mcpPath}#mcpServers.engram`);
    manualReview.push(
      `${mcpPath} keeps an Engram entry that does not match the FlowTask template; review it manually.`,
    );
    return;
  }

  const next = { ...read.value, mcpServers: { ...read.value.mcpServers } };
  delete next.mcpServers.engram;
  if (Object.keys(next.mcpServers).length === 0) delete next.mcpServers;

  if (Object.keys(next).length === 0) {
    fs.rmSync(mcpPath, { force: true });
  } else {
    writeFileAtomic(mcpPath, JSON.stringify(next, null, 2));
  }
  removed.push(`${mcpPath}#mcpServers.engram`);
}

/**
 * Move the valid layers of a legacy per-project Claude installation into the
 * user configuration before the installer writes its defaults. The full
 * project cleanup still runs later; this only protects the user's choices
 * from being replaced by installation defaults. An existing user layer wins
 * and a different legacy value is preserved for manual review.
 */
export function migrateLegacyClaudeProjectConfig(projectDir) {
  const paths = resolveClaudePaths(projectDir);
  const removed = [];
  const preserved = [];
  const manualReview = [];
  const configDir = path.join(paths.projectFlowtaskDir, "config");
  if (!fileExists(configDir)) return { removed, preserved, manualReview };

  migrateLegacyConfig(paths, removed, preserved, manualReview);
  if (manualReview.length > 0) {
    for (const message of manualReview) logWarn(message);
  }
  return { removed, preserved, manualReview };
}

/**
 * Remove demonstrably FlowTask-owned artifacts from a legacy per-project
 * Claude Code installation. Unrecognized files are preserved and reported.
 */
export function migrateLegacyClaudeProject({
  projectDir,
  runtimeRoot,
  flowtaskDir = null,
  runtimeManifest = null,
  migrateConfig = true,
}) {
  const paths = resolveClaudePaths(projectDir);
  const removed = [];
  const preserved = [];
  const manualReview = [];

  if (!hasLegacyClaudeInstallation({ ...paths, runtimeRoot })) {
    return { removed, preserved, manualReview, migrated: false };
  }

  migrateLegacyConfig(paths, removed, preserved, manualReview, { migrate: migrateConfig });

  for (const directory of ["skills", "scripts", "agents", "commands"]) {
    const target = path.join(paths.projectFlowtaskDir, directory);
    if (!fileExists(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }

  const marker = path.join(paths.projectFlowtaskDir, ".installation-method");
  if (fileExists(marker)) {
    fs.rmSync(marker, { force: true });
    removed.push(marker);
  }

  if (fileExists(paths.legacySessionStartPath)) {
    fs.rmSync(paths.legacySessionStartPath, { force: true });
    removed.push(paths.legacySessionStartPath);
  }

  if (fileExists(paths.projectSettingsPath)) {
    const result = removeClaudeHook(paths.projectSettingsPath, { command: LEGACY_FLOWTASK_HOOK });
    if (!result.ok) {
      preserved.push(paths.projectSettingsPath);
      manualReview.push(`${paths.projectSettingsPath} could not be updated: ${result.error}.`);
    } else if (result.changed) {
      removed.push(`${paths.projectSettingsPath}#FlowTask hook`);
    }
  }

  removeLegacyClaudeBlock(projectDir, removed, preserved, manualReview);
  removeLegacyProjectMcp(paths, flowtaskDir, removed, preserved, manualReview);

  const configDir = path.join(paths.projectFlowtaskDir, "config");
  if (fileExists(configDir)) {
    try {
      if (fs.readdirSync(configDir).length === 0) {
        fs.rmdirSync(configDir);
        removed.push(configDir);
      }
    } catch {
      // Left in place for the report.
    }
  }

  if (manualReview.length > 0) {
    for (const message of manualReview) logWarn(message);
  }

  logSuccess(`Legacy Claude Code installation migrated: ${removed.length} artifact(s) removed.`);
  return { removed, preserved, manualReview, migrated: true };
}

function ensureGlobalSurfaces({
  flowtaskDir,
  projectDir,
  personaChoice = null,
  personaContent = undefined,
  autonomyProfile = null,
  replaceAutonomy = false,
  allowEngramTools = false,
  userConfig = null,
}) {
  const paths = resolveClaudePaths(projectDir);
  const version = readVersion(flowtaskDir);

  migrateLegacyClaudeProject({
    projectDir,
    runtimeRoot: paths.runtimeRoot,
    flowtaskDir,
  });

  const configDir = paths.runtimeConfigDir;
  const config = userConfig ?? ensureClaudeRuntimeConfig(configDir, {
    personaChoice,
    autonomyProfile,
    replaceAutonomy,
  });

  const runtime = ensureClaudeRuntime(flowtaskDir, {
    runtimeRoot: paths.runtimeRoot,
    version,
    descriptor: {
      persona: config.profile?.value?.persona ?? null,
      level: config.profile?.value?.level ?? null,
      autonomy: config.autonomy?.value?.profile ?? null,
    },
    buildRunnerBody: (payloadPaths) => runnerBodyFor(flowtaskDir, payloadPaths.payloadDir, {
      personaContent,
      profile: config.profile,
      autonomy: {
        profile: config.autonomy.value.profile,
        source: "user",
      },
    }),
  });

  migrateLegacyClaudeRuntime({
    flowtaskDir,
    runtimeRoot: paths.runtimeRoot,
    claudeUserDir: paths.claudeUserDir,
  });

  const runnerAgent = generateClaudeRunnerAgent({
    claudeUserDir: paths.claudeUserDir,
    runtimeRoot: paths.runtimeRoot,
    runtimeManifest: runtime,
    baseName: config.identity.value.baseName,
  });
  if (runnerAgent.status === "preserved") {
    logWarn(
      `Preserved an existing runner agent without the FlowTask marker at ${runnerAgent.path}. ` +
        "Move the file and run flowtask update to activate the FlowTask runner.",
    );
  }

  const userSettingsPath = path.join(paths.claudeUserDir, "settings.json");
  const settings = mergeClaudeSettings(userSettingsPath, {
    hooks: buildSessionStartHook(paths.runtimeRoot),
    permissions: allowEngramTools ? { allow: ["mcp__engram__*"] } : undefined,
  });
  if (!settings.ok) {
    const error = new Error(
      `Could not update the Claude user settings: ${settings.error ?? "unknown error"}. ` +
        "The project was not registered.",
    );
    error.code = "settings_registration_failed";
    throw error;
  }

  const manifest = readClaudeRuntimeManifest(paths.runtimeRoot);
  const mcp = ensureUserEngramOrWarn({
    claudeUserDir: paths.claudeUserDir,
    runtimeManifest: manifest,
  });
  persistMcpState(paths.runtimeRoot, mcp);

  return { paths, version, runtime, config, hook: settings, mcp, runnerAgent };
}

function collectRestoredPaths({ runtime, runnerAgent, materialized }) {
  const paths = [];
  if (Array.isArray(runtime?.restoredPaths)) paths.push(...runtime.restoredPaths);
  if (runnerAgent?.restored === true && runnerAgent.path) paths.push(runnerAgent.path);
  for (const file of materialized?.agents?.restored ?? []) paths.push(file);
  for (const file of materialized?.commands?.restored ?? []) paths.push(file);
  return [...new Set(paths)];
}

/**
 * Install or refresh only the user-level Claude surfaces: runtime, hook,
 * runner agent and user MCP registration. No project registration is written.
 */
export function installClaudeUserSurface({
  flowtaskDir,
  projectDir,
  personaChoice = null,
  personaContent = undefined,
  options = {},
  autonomyProfile = null,
  replaceAutonomy = false,
  userConfig = null,
}) {
  return ensureGlobalSurfaces({
    flowtaskDir,
    projectDir,
    personaChoice,
    personaContent,
    autonomyProfile,
    replaceAutonomy,
    allowEngramTools: options.allowEngramTools === true,
    userConfig,
  });
}

/**
 * Install or refresh the user-level runtime, the SessionStart hook, the user
 * MCP registration, and the current project registration.
 */
export function installClaudeTarget({
  flowtaskDir,
  projectDir,
  personaChoice = null,
  personaContent = undefined,
  options = {},
  worktreeManager = null,
  autonomyProfile = null,
  replaceAutonomy = false,
  userConfig = null,
}) {
  const surfaces = ensureGlobalSurfaces({
    flowtaskDir,
    projectDir,
    personaChoice,
    personaContent,
    autonomyProfile,
    replaceAutonomy,
    allowEngramTools: options.allowEngramTools === true,
    userConfig,
  });
  const runtimeManifest = readClaudeRuntimeManifest(surfaces.paths.runtimeRoot);
  const registration = registerClaudeProject({
    projectDir,
    runtimeManifest,
    flowtaskDir,
    baseName: surfaces.config.identity.value.baseName,
    runnerAgentStatus: surfaces.runnerAgent.status,
  });
  const worktreeMcp = registerWorktreeManagerMcpForClaude(surfaces.paths, worktreeManager);

  logSuccess(`Claude Code target ready (runtime ${surfaces.version}).`);
  return {
    ok: true,
    target: "claude",
    status: "Success",
    runtime: surfaces.runtime,
    registration,
    mcp: surfaces.mcp,
    hook: surfaces.hook,
    worktreeMcp,
    runnerAgent: surfaces.runnerAgent,
    settingsAgent: registration.settingsAgent,
    restoredPaths: collectRestoredPaths({
      runtime: surfaces.runtime,
      runnerAgent: surfaces.runnerAgent,
      materialized: registration.materialized,
    }),
  };
}

/**
 * Refresh the user-level runtime. The current project is refreshed only when it
 * is already registered (or carries a legacy installation marker); update never
 * registers a project on its own.
 */
export function uninstallClaudeProject({ projectDir, runtimeRoot, flowtaskDir = null }) {
  const paths = resolveClaudePaths(projectDir);
  const effectiveRuntimeRoot = runtimeRoot ?? paths.runtimeRoot;
  const legacy = migrateLegacyClaudeProject({
    projectDir,
    runtimeRoot: effectiveRuntimeRoot,
    flowtaskDir,
    migrateConfig: false,
  });
  const settingsAgent = removeClaudeAgentSetting(paths.projectLocalSettingsPath, "flowtask-runner");
  const removal = removeClaudeProject({
    projectDir,
    runtimeRoot: fileExists(effectiveRuntimeRoot) ? effectiveRuntimeRoot : null,
  });
  return { ok: true, ...removal, settingsAgent, legacy };
}

/**
 * Remove the user-level runtime, the FlowTask hook, the Engram registration it
 * added, and every project listed in the index. It stops before deleting the
 * runtime when a global surface or a project cannot be cleaned.
 */
export function uninstallClaudeGlobal({ runtimeRoot, claudeUserDir, flowtaskDir = null, removeRuntime = true }) {
  const manualReview = [];
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const manifestExists = fileExists(manifestPath);
  let manifest = null;

  if (manifestExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (parsed?.schema === 1 || parsed?.schema === 2) manifest = parsed;
    } catch {
      manifest = null;
    }
  }

  const indexRead = readProjectsIndex(runtimeRoot);
  if (!indexRead.ok) {
    return {
      ok: false,
      error: `The projects index is unreadable and uninstall stopped before removing the runtime: ${indexRead.error}`,
      removed: [],
      preserved: [],
      failures: [],
      manualReview,
    };
  }

  const hook = removeClaudeHook(path.join(claudeUserDir, "settings.json"), {
    command: manifest?.hookCommand ?? null,
    commandIncludes: path.join(runtimeRoot, "bin", "session-start.mjs"),
  });
  if (!hook.ok) {
    return {
      ok: false,
      error: `The FlowTask hook could not be removed: ${hook.error}`,
      removed: [],
      preserved: [],
      failures: [],
      manualReview,
    };
  }

  let mcp;
  if (manifest) {
    mcp = removeUserEngram({ claudeUserDir, runtimeManifest: manifest });
    if (!mcp.ok) {
      return {
        ok: false,
        error: `Engram could not be removed from the user scope: ${mcp.error}`,
        mcp,
        removed: [],
        preserved: [],
        failures: [],
        manualReview,
      };
    }
  } else {
    mcp = { ok: true, action: "manual", managed: false, error: null };
    manualReview.push(
      "The runtime manifest is missing; if FlowTask added Engram, run: claude mcp remove --scope user engram",
    );
  }

  const failures = [];
  const projects = [];
  const settingsAgents = [];
  for (const entry of indexRead.index.projects) {
    if (!entry || typeof entry.path !== "string") continue;
    const targets = Array.isArray(entry.targets) ? entry.targets : ["claude"];
    if (!targets.includes("claude")) continue;
    try {
      const result = uninstallClaudeProject({
        projectDir: entry.path,
        runtimeRoot,
        flowtaskDir,
      });
      projects.push({
        path: entry.path,
        removed: result.removed.length,
        preserved: result.preserved,
        settingsAgent: result.settingsAgent,
      });
      settingsAgents.push({ path: entry.path, ...result.settingsAgent });
    } catch (error) {
      failures.push({ path: entry.path, error: error.message });
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error: "One or more projects could not be uninstalled; the runtime was preserved.",
      mcp,
      hook,
      projects,
      failures,
      removed: [],
      preserved: [],
      manualReview,
    };
  }

  const agentPath = path.join(claudeUserDir, "agents", "flowtask-runner.md");
  let runnerAgent;
  const agentStillReferenced = settingsAgents.some(
    (entry) => entry.status !== "removed" && entry.status !== "absent",
  );
  if (agentStillReferenced) {
    runnerAgent = { status: "preserved", path: agentPath };
    logWarn(
      `The FlowTask runner agent at ${agentPath} was preserved because at least one project still references it.`,
    );
  } else {
    runnerAgent = removeClaudeRunnerAgent({ claudeUserDir });
    if (runnerAgent.status === "preserved") {
      logWarn(
        `The FlowTask runner agent at ${runnerAgent.path} has no ownership marker and was preserved.`,
      );
    }
  }

  const runtimeRemoval = removeRuntime
    ? removeClaudeRuntime(runtimeRoot)
    : { removed: [], preserved: [] };
  return {
    ok: true,
    mcp,
    hook,
    projects,
    failures,
    manualReview,
    settingsAgents,
    runnerAgent,
    ...runtimeRemoval,
  };
}

export function updateClaudeTarget({
  flowtaskDir,
  projectDir,
  personaChoice = null,
  personaContent = undefined,
  options = {},
  worktreeManager = null,
  autonomyProfile = null,
  replaceAutonomy = false,
  userConfig = null,
}) {
  const beforePaths = resolveClaudePaths(projectDir);
  const legacyBefore =
    fileExists(path.join(beforePaths.projectFlowtaskDir, ".installation-method")) ||
    hasLegacyClaudeInstallation(beforePaths);

  const surfaces = ensureGlobalSurfaces({
    flowtaskDir,
    projectDir,
    personaChoice,
    personaContent,
    autonomyProfile,
    replaceAutonomy,
    allowEngramTools: options.allowEngramTools === true,
    userConfig,
  });
  const paths = surfaces.paths;
  const registered = fileExists(paths.registryPath);

  if (!registered && !legacyBefore) {
    logWarn("This project is not registered with FlowTask; the runtime was updated without registering it.");
    logInfo("Run flowtask install in this project to register it.");
    return {
      ok: true,
      target: "claude",
      status: "Success",
      registered: false,
      runtime: surfaces.runtime,
      project: null,
      options,
      runnerAgent: surfaces.runnerAgent,
      settingsAgent: null,
      restoredPaths: collectRestoredPaths({
        runtime: surfaces.runtime,
        runnerAgent: surfaces.runnerAgent,
      }),
    };
  }

  const runtimeManifest = readClaudeRuntimeManifest(paths.runtimeRoot);
  const registration = registerClaudeProject({
    projectDir,
    runtimeManifest,
    flowtaskDir,
    baseName: surfaces.config.identity.value.baseName,
    runnerAgentStatus: surfaces.runnerAgent.status,
  });
  const worktreeMcp = registerWorktreeManagerMcpForClaude(paths, worktreeManager);
  logSuccess("FlowTask project registration refreshed.");
  return {
    ok: true,
    target: "claude",
    status: "Success",
    registered: true,
    runtime: surfaces.runtime,
    registration,
    options,
    worktreeMcp,
    runnerAgent: surfaces.runnerAgent,
    settingsAgent: registration.settingsAgent,
    restoredPaths: collectRestoredPaths({
      runtime: surfaces.runtime,
      runnerAgent: surfaces.runnerAgent,
      materialized: registration.materialized,
    }),
  };
}
