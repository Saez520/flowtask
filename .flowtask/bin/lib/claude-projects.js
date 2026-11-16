import fs from "fs";
import path from "path";
import {
  FLOWTASK_MANAGED_MARKER,
  PROJECT_REGISTRY_SCHEMA,
  ensureClaudeAgentSetting,
  resolveActiveRuntimePaths,
  resolveClaudePaths,
} from "./claude.js";
import { generateClaudeAgents, generateClaudeCommands } from "./claude.js";
import {
  readProjectRegistration,
  readProjectsIndex,
  reconcileProjectsIndex,
  removeProjectExclude,
  removeProjectRegistration,
  resolveRegistrationPath,
  updateProjectExclude,
  writeProjectRegistration,
} from "./project-registration.js";
import { logInfo, logSuccess, logWarn, fileExists } from "./logger.js";

export { readProjectsIndex, removeProjectExclude, updateProjectExclude };

function realProjectPath(projectDir) {
  return fs.realpathSync(projectDir);
}

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

// ─── Project registration ─────────────────────────────────────────────────────

/**
 * Read and validate the per-project Claude registration. Returns `null` when
 * the project is not registered; an unreadable or unsupported file fails.
 */
export function readProjectRegistry(projectDir) {
  const read = readProjectRegistration(projectDir, "claude");
  if (read.status === "absent") return null;
  if (read.status === "unreadable") {
    const error = new Error(`FlowTask project registration is unreadable: ${read.reason}`);
    error.code = "registry_unreadable";
    throw error;
  }
  if (read.status === "unsupported") {
    const error = new Error(
      `FlowTask project registration uses schema ${read.registry?.schema ?? "missing"}; this runtime supports schema ${PROJECT_REGISTRY_SCHEMA}. Run: flowtask install`,
    );
    error.code = "registry_schema_unsupported";
    throw error;
  }
  return read.registry;
}

export function validateProjectRegistry(raw, source = "project.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const error = new Error(`FlowTask project registration at ${source} is not a JSON object.`);
    error.code = "registry_invalid";
    throw error;
  }
  if (raw.schema !== PROJECT_REGISTRY_SCHEMA) {
    const error = new Error(
      `FlowTask project registration uses schema ${raw.schema ?? "missing"}; this runtime supports schema ${PROJECT_REGISTRY_SCHEMA}. Run: flowtask install`,
    );
    error.code = "registry_schema_unsupported";
    throw error;
  }
  if (typeof raw.projectPath !== "string" || !raw.projectPath) {
    const error = new Error(`FlowTask project registration at ${source} does not declare a project path.`);
    error.code = "registry_invalid";
    throw error;
  }
  return raw;
}

export function registryMatchesProject(registry, projectDir) {
  if (!registry?.projectPath) return false;
  try {
    return pathsEqual(registry.projectPath, realProjectPath(projectDir));
  } catch {
    return false;
  }
}

function existingOwnedCommands(commandsDir, expectedFiles) {
  if (!fileExists(commandsDir)) return [];
  const expected = new Set(expectedFiles.map((file) => path.resolve(file)));
  const stale = [];
  for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(commandsDir, entry.name);
    if (expected.has(path.resolve(filePath))) continue;
    try {
      if (fs.readFileSync(filePath, "utf8").includes(FLOWTASK_MANAGED_MARKER)) stale.push(filePath);
    } catch {
      // Unreadable files are preserved.
    }
  }
  return stale;
}

function existingOwnedAgents(agentsDir, expectedFiles) {
  if (!fileExists(agentsDir)) return [];
  const expected = new Set(expectedFiles.map((file) => path.resolve(file)));
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^flowtask-.*\.md$/.test(entry.name))
    .map((entry) => path.join(agentsDir, entry.name))
    .filter((filePath) => !expected.has(path.resolve(filePath)));
}

/**
 * Materialize the per-project artifacts Claude Code discovers: agent
 * definitions and commands. Stale owned files are removed; unmarked commands
 * are preserved and reported.
 */
export function materializeClaudeProject({ projectDir, flowtaskDir, version, registry = null, runtimeManifest }) {
  const active = resolveActiveRuntimePaths(
    resolveClaudePaths(projectDir).runtimeRoot,
    runtimeManifest,
  );
  const agentResult = generateClaudeAgents(flowtaskDir, projectDir, { skillsDir: active.skillsDir });
  const commandResult = generateClaudeCommands(flowtaskDir, projectDir);

  const removed = [];
  for (const stale of existingOwnedAgents(path.join(projectDir, ".claude", "agents"), agentResult.files)) {
    fs.rmSync(stale, { force: true });
    removed.push(stale);
  }
  for (const stale of existingOwnedCommands(path.join(projectDir, ".claude", "commands"), commandResult.files)) {
    fs.rmSync(stale, { force: true });
    removed.push(stale);
  }

  if (commandResult.skipped.length > 0) {
    logWarn(
      `Preserved ${commandResult.skipped.length} existing command(s) without a FlowTask marker: ` +
        commandResult.skipped.map((file) => path.basename(file)).join(", "),
    );
  }

  return {
    version,
    agents: agentResult,
    commands: commandResult,
    removed,
    previous: registry?.materialized ?? null,
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register one project: materialize owned artifacts, write the ignored
 * registration, update the Git exclude, and refresh the user-level index.
 */
export function registerClaudeProject({
  projectDir,
  runtimeManifest,
  flowtaskDir,
  baseName = null,
  runnerAgentStatus = null,
}) {
  const existing = readProjectRegistry(projectDir);
  const realPath = realProjectPath(projectDir);
  if (existing && !pathsEqual(existing.projectPath, realPath)) {
    logWarn(`Replacing a FlowTask registration that points to another project: ${existing.projectPath}`);
  }

  const paths = resolveClaudePaths(projectDir);
  const version = runtimeManifest.version;
  const materialized = materializeClaudeProject({
    projectDir,
    flowtaskDir,
    version,
    registry: existing,
    runtimeManifest,
  });

  let settingsAgent = { status: "skipped" };
  if (runnerAgentStatus === "written" || runnerAgentStatus === "unchanged") {
    settingsAgent = ensureClaudeAgentSetting(paths.projectLocalSettingsPath, "flowtask-runner");
    if (!settingsAgent.ok) {
      const error = new Error(
        `Could not activate the FlowTask runner in ${paths.projectLocalSettingsPath}: ${settingsAgent.error}. ` +
          "The project was not registered.",
      );
      error.code = "agent_setting_invalid";
      error.path = paths.projectLocalSettingsPath;
      error.cause = settingsAgent.error;
      throw error;
    }
  } else {
    logWarn(
      `The FlowTask runner agent was not activated for ${projectDir} because it is ` +
        `${runnerAgentStatus ?? "unavailable"}. Move ${path.join(paths.claudeAgentsDir, "flowtask-runner.md")} ` +
        "and run flowtask update.",
    );
  }

  const registration = writeProjectRegistration({
    projectDir,
    target: "claude",
    runtimeVersion: version,
    extra: {
      materialized: {
        agents: version,
        commands: version,
      },
    },
  });

  const exclude = updateProjectExclude(projectDir, {
    registrationDir: path.relative(projectDir, registration.dir).split(path.sep).join("/"),
    files: [
      ...materialized.agents.files,
      ...materialized.commands.files,
      paths.projectLocalSettingsPath,
    ],
  });
  if (!exclude.ok) {
    logWarn(`Could not update .git/info/exclude: ${exclude.reason}. The registration continues.`);
  }

  const reconcile = reconcileProjectsIndex(paths.runtimeRoot, {
    current: { ...registration.registry, targets: ["claude"] },
    mode: "install",
  });
  if (!reconcile.ok) {
    logWarn(`Could not reconcile the projects index: ${reconcile.error ?? reconcile.reason}.`);
  }

  logSuccess(`FlowTask project registered at ${resolveRegistrationPath(projectDir, "claude")}.`);
  return {
    ok: true,
    registry: registration.registry,
    materialized,
    exclude,
    index: reconcile.index ?? null,
    settingsAgent,
  };
}

// ─── Project removal ──────────────────────────────────────────────────────────

/**
 * Remove the registration, owned materialized files, and Git exclude block of
 * one project. Unknown files and `graphify.json` are preserved.
 */
export function removeClaudeProject({ projectDir, runtimeRoot }) {
  const { projectFlowtaskDir, projectAgentsDir, projectCommandsDir } =
    resolveClaudePaths(projectDir);
  const removed = [];
  const preserved = [];

  let registry = null;
  try {
    registry = readProjectRegistry(projectDir);
  } catch {
    registry = null;
  }

  for (const entry of fs.existsSync(projectAgentsDir) ? fs.readdirSync(projectAgentsDir) : []) {
    if (!/^flowtask-.*\.md$/.test(entry)) {
      preserved.push(path.join(projectAgentsDir, entry));
      continue;
    }
    const filePath = path.join(projectAgentsDir, entry);
    fs.rmSync(filePath, { force: true });
    removed.push(filePath);
  }

  if (fs.existsSync(projectCommandsDir)) {
    for (const entry of fs.readdirSync(projectCommandsDir)) {
      const filePath = path.join(projectCommandsDir, entry);
      try {
        if (!fs.readFileSync(filePath, "utf8").includes(FLOWTASK_MANAGED_MARKER)) {
          preserved.push(filePath);
          continue;
        }
      } catch {
        preserved.push(filePath);
        continue;
      }
      fs.rmSync(filePath, { force: true });
      removed.push(filePath);
    }
  }

  for (const directory of [projectAgentsDir, projectCommandsDir]) {
    try {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
        removed.push(directory);
      }
    } catch {
      // Left in place for the report.
    }
  }

  const configDir = path.join(projectFlowtaskDir, "config");
  if (fileExists(configDir)) {
    for (const entry of fs.readdirSync(configDir)) {
      const filePath = path.join(configDir, entry);
      if (["profile.json", "autonomy.json", "permissions.json", "review.json"].includes(entry)) {
        fs.rmSync(filePath, { force: true });
        removed.push(filePath);
      } else {
        preserved.push(filePath);
      }
    }
    try {
      if (fs.readdirSync(configDir).length === 0) {
        fs.rmdirSync(configDir);
        removed.push(configDir);
      }
    } catch {
      // Left in place for the report.
    }
  }

  const registration = removeProjectRegistration(projectDir, "claude");
  removed.push(...registration.removed);
  preserved.push(...registration.preserved);

  try {
    if (fs.existsSync(projectFlowtaskDir) && fs.readdirSync(projectFlowtaskDir).length === 0) {
      fs.rmdirSync(projectFlowtaskDir);
      removed.push(projectFlowtaskDir);
    }
  } catch {
    // Left in place for the report.
  }

  if (runtimeRoot) {
    const reconcile = reconcileProjectsIndex(runtimeRoot, { mode: "uninstall" });
    if (!reconcile.ok) logWarn(`Could not remove the project from the index: ${reconcile.error ?? reconcile.reason}.`);
  }

  if (registry) logInfo(`FlowTask registration removed from ${projectDir}.`);
  return { ok: true, removed, preserved, registry };
}
