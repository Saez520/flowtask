import fs from "fs";
import path from "path";
import {
  buildSessionStartHook,
  mergeClaudeSettings,
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
import { LAYER_FILES, readLayerFile } from "./layers.js";
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

function ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice = null, personaContent = undefined }) {
  const paths = resolveClaudePaths(projectDir);
  const version = readVersion(flowtaskDir);
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
  const surfaces = ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice, personaContent });
  const paths = surfaces.paths;
  const legacyMarker = path.join(paths.projectFlowtaskDir, ".installation-method");
  const registered = fileExists(paths.registryPath);

  if (!registered && !fileExists(legacyMarker)) {
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
