import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  FLOWTASK_MANAGED_MARKER,
  PROJECT_REGISTRY_SCHEMA,
  PROJECTS_INDEX_SCHEMA,
  resolveClaudePaths,
  writeFileAtomic,
} from "./claude.js";
import { generateClaudeAgents, generateClaudeCommands } from "./claude.js";
import { logInfo, logSuccess, logWarn, logError, fileExists } from "./logger.js";

const EXCLUDE_START = "# FlowTask managed";
const EXCLUDE_END = "# End FlowTask managed";

function realProjectPath(projectDir) {
  return fs.realpathSync(projectDir);
}

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(filePath, label) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error: `${label} is not valid JSON: ${error.message}` };
  }
}

// ─── Project registration ─────────────────────────────────────────────────────

/**
 * Read and validate the per-project registration. Returns `null` when the
 * project is not registered.
 */
export function readProjectRegistry(projectDir) {
  const { registryPath } = resolveClaudePaths(projectDir);
  if (!fileExists(registryPath)) return null;

  const parsed = readJson(registryPath, registryPath);
  if (!parsed.ok) {
    const error = new Error(`FlowTask project registration is unreadable: ${parsed.error}`);
    error.code = "registry_unreadable";
    throw error;
  }
  return validateProjectRegistry(parsed.value, registryPath);
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

function writeProjectGitignore(projectDir) {
  const { projectFlowtaskDir } = resolveClaudePaths(projectDir);
  const gitignorePath = path.join(projectFlowtaskDir, ".gitignore");
  const content = "*\n";
  if (fileExists(gitignorePath) && fs.readFileSync(gitignorePath, "utf8") === content) return false;
  fs.mkdirSync(projectFlowtaskDir, { recursive: true });
  writeFileAtomic(gitignorePath, content);
  return true;
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
export function materializeClaudeProject({ projectDir, flowtaskDir, version, registry = null }) {
  const agentResult = generateClaudeAgents(flowtaskDir, projectDir);
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

// ─── Git exclude ──────────────────────────────────────────────────────────────

function runGit(projectDir, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", projectDir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function repoContext(projectDir) {
  const root = runGit(projectDir, ["rev-parse", "--show-toplevel"]);
  if (!root.ok || !root.stdout) return { ok: false, reason: "the project is not a Git repository" };

  const exclude = runGit(projectDir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!exclude.ok || !exclude.stdout) return { ok: false, reason: "the Git exclude path is unavailable" };

  const excludePath = path.isAbsolute(exclude.stdout)
    ? exclude.stdout
    : path.resolve(projectDir, exclude.stdout);
  return { ok: true, root: root.stdout, excludePath };
}

function isIgnored(projectDir, relativePath) {
  const result = runGit(projectDir, ["check-ignore", "-q", "--", relativePath]);
  return result.ok;
}

function toRepoRelative(repoRoot, absolutePath) {
  let root = repoRoot;
  let target = absolutePath;
  try {
    root = fs.realpathSync(repoRoot);
    target = fs.realpathSync(absolutePath);
  } catch {
    root = path.resolve(repoRoot);
    target = path.resolve(absolutePath);
  }
  const relative = path.relative(root, target).split(path.sep).join("/");
  return relative.startsWith("..") ? null : relative;
}

/**
 * Add the registration folder and the materialized artifacts to
 * `.git/info/exclude`. The repository's root `.gitignore` is never modified.
 */
export function updateProjectExclude(projectDir, { files = [] } = {}) {
  const context = repoContext(projectDir);
  if (!context.ok) return { ok: false, reason: context.reason };

  const registrationDir = toRepoRelative(context.root, path.join(projectDir, ".claude", "flowtask"));
  const candidates = [
    registrationDir ? `${registrationDir}/` : null,
    ...files
      .map((file) => toRepoRelative(context.root, file))
      .filter(Boolean),
  ].filter((candidate) => candidate && !candidate.startsWith(".."));

  const desired = [];
  for (const candidate of candidates) {
    if (isIgnored(projectDir, candidate)) continue;
    if (!desired.includes(candidate)) desired.push(candidate);
  }
  if (desired.length === 0) return { ok: true, changed: false, path: context.excludePath };

  let current = "";
  if (fileExists(context.excludePath)) current = fs.readFileSync(context.excludePath, "utf8");
  const start = current.indexOf(EXCLUDE_START);
  const end = current.indexOf(EXCLUDE_END);

  let prefix = current;
  let suffix = "";
  if (start !== -1 && end !== -1 && end > start) {
    prefix = current.slice(0, start).trimEnd();
    suffix = current.slice(end + EXCLUDE_END.length).replace(/^\n*/, "");
  }

  const block = [EXCLUDE_START, ...desired, EXCLUDE_END].join("\n");
  const next = [prefix, block, suffix].filter((part) => part !== "").join("\n\n") + "\n";
  if (next === current) return { ok: true, changed: false, path: context.excludePath };

  writeFileAtomic(context.excludePath, next);
  return { ok: true, changed: true, path: context.excludePath };
}

/** Remove the FlowTask block from `.git/info/exclude`, preserving the rest. */
export function removeProjectExclude(projectDir) {
  const context = repoContext(projectDir);
  if (!context.ok) return { ok: false, reason: context.reason };
  if (!fileExists(context.excludePath)) return { ok: true, changed: false };

  const current = fs.readFileSync(context.excludePath, "utf8");
  const start = current.indexOf(EXCLUDE_START);
  const end = current.indexOf(EXCLUDE_END);
  if (start === -1 || end === -1 || end < start) return { ok: true, changed: false };

  const prefix = current.slice(0, start).trimEnd();
  const suffix = current.slice(end + EXCLUDE_END.length).replace(/^\n*/, "");
  const next = [prefix, suffix].filter((part) => part !== "").join("\n\n");
  writeFileAtomic(context.excludePath, next === "" ? "" : `${next}\n`);
  return { ok: true, changed: true };
}

// ─── Project index ────────────────────────────────────────────────────────────

function indexPath(runtimeRoot) {
  return path.join(runtimeRoot, "projects.json");
}

function emptyProjectsIndex() {
  return { schema: PROJECTS_INDEX_SCHEMA, updatedAt: null, projects: [] };
}

export function readProjectsIndex(runtimeRoot) {
  const filePath = indexPath(runtimeRoot);
  if (!fileExists(filePath)) return { ok: true, index: emptyProjectsIndex() };

  const parsed = readJson(filePath, filePath);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const index = parsed.value;
  if (!index || typeof index !== "object" || index.schema !== PROJECTS_INDEX_SCHEMA || !Array.isArray(index.projects)) {
    return { ok: false, error: `${filePath} does not declare the supported projects index schema` };
  }
  return { ok: true, index };
}

function withProjectsIndexLock(runtimeRoot, fn) {
  const lockPath = path.join(runtimeRoot, ".projects.lock");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
  if (handle === null) return { ok: false, reason: "projects index is locked" };

  try {
    return fn();
  } finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
  }
}

function writeProjectsIndex(runtimeRoot, index) {
  const next = {
    schema: PROJECTS_INDEX_SCHEMA,
    updatedAt: new Date().toISOString(),
    projects: index.projects,
  };
  return withProjectsIndexLock(runtimeRoot, () => {
    writeFileAtomic(indexPath(runtimeRoot), JSON.stringify(next, null, 2));
    return { ok: true, index: next };
  });
}

function projectsIndexEntry(registry) {
  return {
    path: registry.projectPath,
    registeredAt: registry.registeredAt,
    runtimeVersion: registry.runtimeVersion,
  };
}

/**
 * Rebuild the user-level index from the registrations that still exist.
 * An unreadable index is rebuilt on install/update and fails closed on uninstall.
 */
export function reconcileProjectsIndex(runtimeRoot, { current = null, mode = "install" } = {}) {
  const read = readProjectsIndex(runtimeRoot);
  let index;
  if (!read.ok) {
    if (mode === "uninstall") return { ok: false, error: read.error };
    index = emptyProjectsIndex();
  } else {
    index = read.index;
  }

  const projects = [];
  const seen = new Set();
  for (const entry of index.projects) {
    if (!entry || typeof entry.path !== "string") continue;
    if (seen.has(comparablePath(entry.path))) continue;
    seen.add(comparablePath(entry.path));

    let registry = null;
    try {
      registry = readProjectRegistry(entry.path);
    } catch {
      registry = null;
    }
    if (!registry || !pathsEqual(registry.projectPath, entry.path)) continue;
    projects.push(projectsIndexEntry(registry));
  }

  if (current) {
    const key = comparablePath(current.projectPath);
    if (!seen.has(key)) {
      projects.push(projectsIndexEntry(current));
      seen.add(key);
    } else {
      const position = projects.findIndex((entry) => comparablePath(entry.path) === key);
      if (position !== -1) projects[position] = projectsIndexEntry(current);
    }
  }

  const changed = JSON.stringify(projects) !== JSON.stringify(
    (read.ok ? read.index.projects : []).filter((entry) => entry && typeof entry.path === "string"),
  );
  if (!changed && read.ok) return { ok: true, index, changed: false };

  const written = writeProjectsIndex(runtimeRoot, { ...index, projects });
  if (!written.ok) return written;
  return { ok: true, index: written.index, changed: true };
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register one project: materialize owned artifacts, write the ignored
 * registration, update the Git exclude, and refresh the user-level index.
 */
export function registerClaudeProject({ projectDir, runtimeManifest, flowtaskDir }) {
  const existing = readProjectRegistry(projectDir);
  const realPath = realProjectPath(projectDir);
  if (existing && !pathsEqual(existing.projectPath, realPath)) {
    logWarn(`Replacing a FlowTask registration that points to another project: ${existing.projectPath}`);
  }

  const version = runtimeManifest.version;
  const materialized = materializeClaudeProject({
    projectDir,
    flowtaskDir,
    version,
    registry: existing,
  });

  writeProjectGitignore(projectDir);

  const registry = {
    schema: PROJECT_REGISTRY_SCHEMA,
    projectPath: realPath,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    runtimeVersion: version,
    materialized: {
      agents: version,
      commands: version,
    },
  };
  const { registryPath } = resolveClaudePaths(projectDir);
  const registryContent = JSON.stringify(registry, null, 2);
  if (!fileExists(registryPath) || fs.readFileSync(registryPath, "utf8") !== registryContent) {
    writeFileAtomic(registryPath, registryContent);
  }

  const exclude = updateProjectExclude(projectDir, {
    files: [...materialized.agents.files, ...materialized.commands.files],
  });
  if (!exclude.ok) {
    logWarn(`Could not update .git/info/exclude: ${exclude.reason}. The registration continues.`);
  }

  const projectPaths = resolveClaudePaths(projectDir);
  const reconcile = reconcileProjectsIndex(projectPaths.runtimeRoot, {
    current: registry,
    mode: "install",
  });
  if (!reconcile.ok) {
    logWarn(`Could not reconcile the projects index: ${reconcile.error ?? reconcile.reason}.`);
  }

  logSuccess(`FlowTask project registered at ${registryPath}.`);
  return { ok: true, registry, materialized, exclude, index: reconcile.index ?? null };
}

// ─── Project removal ──────────────────────────────────────────────────────────

/**
 * Remove the registration, owned materialized files, and Git exclude block of
 * one project. Unknown files and `graphify.json` are preserved.
 */
export function removeClaudeProject({ projectDir, runtimeRoot }) {
  const { projectFlowtaskDir, registryPath, projectAgentsDir, projectCommandsDir } =
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

  if (fileExists(registryPath)) {
    fs.rmSync(registryPath, { force: true });
    removed.push(registryPath);
  }

  const gitignorePath = path.join(projectFlowtaskDir, ".gitignore");
  if (fileExists(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (content.trim() === "*") {
      fs.rmSync(gitignorePath, { force: true });
      removed.push(gitignorePath);
    } else {
      preserved.push(gitignorePath);
    }
  }

  const exclude = removeProjectExclude(projectDir);
  if (!exclude.ok) logWarn(`Could not remove the Git exclude block: ${exclude.reason}.`);

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
