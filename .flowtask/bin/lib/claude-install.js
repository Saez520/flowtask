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
  removeClaudeRuntime,
} from "./claude-runtime.js";
import { readProjectsIndex, registerClaudeProject, removeClaudeProject } from "./claude-projects.js";
import { ensureUserEngram, removeUserEngram } from "./claude-mcp.js";
import { registerWorktreeManagerMcp } from "./worktree-mcp-registration.js";
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

  return { paths, version, runtime, config, hook, mcp, runnerAgent };
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
}) {
  const surfaces = ensureGlobalSurfaces({ flowtaskDir, projectDir, personaChoice, personaContent });
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
export function uninstallClaudeGlobal({ runtimeRoot, claudeUserDir, flowtaskDir = null }) {
  const manualReview = [];
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  const manifestExists = fileExists(manifestPath);
  let manifest = null;

  if (manifestExists) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (parsed?.schema === 1) manifest = parsed;
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

  const runtimeRemoval = removeClaudeRuntime(runtimeRoot);
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
      runnerAgent: surfaces.runnerAgent,
      settingsAgent: null,
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
  };
}
