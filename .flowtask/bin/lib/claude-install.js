import fs from "fs";
import path from "path";
import {
  buildSessionStartHook,
  mergeClaudeSettings,
  removeClaudeHook,
  resolveClaudePaths,
  writeFileAtomic,
} from "./claude.js";
import {
  ensureClaudeRuntime,
  ensureClaudeRuntimeConfig,
  readClaudeRuntimeManifest,
} from "./claude-runtime.js";
import { registerClaudeProject } from "./claude-projects.js";
import { ensureUserEngram } from "./claude-mcp.js";
import { CUSTOM_PERSONA_TEXT, buildRuntimeRunnerBody } from "./runner-content.js";
import {
  LAYER_FILES,
  readLayerFile,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "./layers.js";
import { logInfo, logWarn, logSuccess, fileExists } from "./logger.js";

const PERSONA_FILES = Object.freeze({
  training: "tutor-training.md",
  mid: "tutor-mid.md",
  senior: "tutor-senior.md",
});

function readVersion(flowtaskDir) {
  const packagePath = path.join(flowtaskDir, "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

function readProfile(configDir) {
  const filePath = path.join(configDir, LAYER_FILES.persona);
  if (!fileExists(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function readAutonomyProfile(configDir) {
  const filePath = path.join(configDir, LAYER_FILES.autonomy);
  if (!fileExists(filePath)) return "autonomous-dev";
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof value?.profile === "string" ? value.profile : "autonomous-dev";
  } catch {
    return "autonomous-dev";
  }
}

function personaContentFromProfile(flowtaskDir, profile) {
  if (!profile) return null;
  if (profile.persona === "custom" || profile.level === "custom") return CUSTOM_PERSONA_TEXT;
  const fileName = PERSONA_FILES[profile.level];
  if (!fileName) return null;
  const source = path.join(flowtaskDir, "personas", fileName);
  return fileExists(source) ? fs.readFileSync(source, "utf8") : null;
}

function runnerBodyFor(flowtaskDir, runtimeRoot, { personaContent, profile, configDir }) {
  const content = personaContent === undefined
    ? personaContentFromProfile(flowtaskDir, profile ?? readProfile(configDir))
    : personaContent;
  const runnerContent = fs.readFileSync(path.join(flowtaskDir, "agents", "runner.md"), "utf8");
  return buildRuntimeRunnerBody({
    runnerContent,
    runtimeRoot,
    personaContent: content ?? null,
    autonomyDescriptor: {
      profile: readAutonomyProfile(configDir),
      source: "project",
    },
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

// ─── Legacy migration ────────────────────────────────────────────────────────

const LEGACY_LAYERS = Object.freeze([
  { name: "profile", file: LAYER_FILES.persona, validate: validatePersonaLayer },
  { name: "autonomy", file: LAYER_FILES.autonomy, validate: validateAutonomyLayer },
  { name: "permissions", file: LAYER_FILES.permissions, validate: validatePermissionsLayer },
]);

const LEGACY_FLOWTASK_HOOK = 'cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"';
const LEGACY_CLAUDE_START = "<!-- FLOWTASK:START -->";
const LEGACY_CLAUDE_END = "<!-- FLOWTASK:END -->";

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

function migrateLegacyConfig(paths, removed, preserved, manualReview) {
  const configDir = path.join(paths.projectFlowtaskDir, "config");
  const globalConfigDir = paths.runtimeConfigDir;

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

  const templatePath = path.join(flowtaskDir, "claude", "mcp.json");
  const template = readJsonFile(templatePath);
  const entry = read.value?.mcpServers?.engram;
  if (!entry) return;

  const expected = template.ok ? template.value?.mcpServers?.engram : null;
  if (!expected || stableStringify(entry) !== stableStringify(expected)) {
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
 * Remove demonstrably FlowTask-owned artifacts from a legacy per-project
 * Claude Code installation. Unrecognized files are preserved and reported.
 */
export function migrateLegacyClaudeProject({
  projectDir,
  runtimeRoot,
  flowtaskDir,
  runtimeManifest = null,
}) {
  const paths = resolveClaudePaths(projectDir);
  const removed = [];
  const preserved = [];
  const manualReview = [];

  if (!hasLegacyClaudeInstallation({ ...paths, runtimeRoot })) {
    return { removed, preserved, manualReview, migrated: false };
  }

  migrateLegacyConfig(paths, removed, preserved, manualReview);

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

function ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice = null, personaContent = undefined }) {
  const paths = resolveClaudePaths(projectDir);
  const version = readVersion(flowtaskDir);

  migrateLegacyClaudeProject({
    projectDir,
    runtimeRoot: paths.runtimeRoot,
    flowtaskDir,
  });

  const configDir = paths.runtimeConfigDir;
  const profile = readProfile(configDir);

  const runnerBody = runnerBodyFor(flowtaskDir, paths.runtimeRoot, {
    personaContent,
    profile,
    configDir,
  });

  const runtime = ensureClaudeRuntime(flowtaskDir, {
    runtimeRoot: paths.runtimeRoot,
    runnerBody,
    version,
  });

  const config = ensureClaudeRuntimeConfig(configDir, { personaChoice });

  const userSettingsPath = path.join(paths.claudeUserDir, "settings.json");
  const hook = mergeClaudeSettings(userSettingsPath, {
    hooks: buildSessionStartHook(paths.runtimeRoot),
  });
  if (!hook.ok) {
    const error = new Error(
      `Could not register the FlowTask SessionStart hook: ${hook.error ?? "unknown error"}. ` +
        "The project was not registered.",
    );
    error.code = "hook_registration_failed";
    throw error;
  }

  const manifest = readClaudeRuntimeManifest(paths.runtimeRoot);
  const mcp = ensureUserEngram({
    claudeUserDir: paths.claudeUserDir,
    runtimeManifest: manifest,
  });
  if (!mcp.ok) {
    const error = new Error(
      `Could not register Engram in the user scope: ${mcp.error}. The project was not registered.`,
    );
    error.code = "mcp_registration_failed";
    error.command = mcp.command;
    throw error;
  }
  persistMcpState(paths.runtimeRoot, mcp);

  return { paths, version, runtime, config, hook, mcp };
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
}) {
  const surfaces = ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice, personaContent });
  const runtimeManifest = readClaudeRuntimeManifest(surfaces.paths.runtimeRoot);
  const registration = registerClaudeProject({ projectDir, runtimeManifest, flowtaskDir });

  logSuccess(`Claude Code target ready (runtime ${surfaces.version}).`);
  return {
    ok: true,
    target: "claude",
    status: "Success",
    runtime: surfaces.runtime,
    registration,
    mcp: surfaces.mcp,
    hook: surfaces.hook,
  };
}

/**
 * Refresh the user-level runtime. The current project is refreshed only when it
 * is already registered (or carries a legacy installation marker); update never
 * registers a project on its own.
 */
export function updateClaudeTarget({
  flowtaskDir,
  projectDir,
  personaChoice = null,
  personaContent = undefined,
  options = {},
}) {
  const beforePaths = resolveClaudePaths(projectDir);
  const legacyBefore =
    fileExists(path.join(beforePaths.projectFlowtaskDir, ".installation-method")) ||
    hasLegacyClaudeInstallation(beforePaths);

  const surfaces = ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice, personaContent });
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
    };
  }

  const runtimeManifest = readClaudeRuntimeManifest(paths.runtimeRoot);
  const registration = registerClaudeProject({ projectDir, runtimeManifest, flowtaskDir });
  logSuccess("FlowTask project registration refreshed.");
  return {
    ok: true,
    target: "claude",
    status: "Success",
    registered: true,
    runtime: surfaces.runtime,
    registration,
    options,
  };
}
