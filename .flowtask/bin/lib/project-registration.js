import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { writeFileAtomic, resolveUserRuntimePaths } from "./user-runtime.js";

/** Schema of every per-project registration file. */
export const REGISTRATION_SCHEMA = 1;
/** Schema of the user-level project index. */
export const PROJECTS_INDEX_SCHEMA = 1;

/** Registration directory of each target, relative to the project root. */
export const TARGET_REGISTRATION_PATHS = Object.freeze({
  claude: Object.freeze([".claude", "flowtask"]),
  opencode: Object.freeze([".opencode", "flowtask"]),
  vscode: Object.freeze([".vscode", "flowtask"]),
  standalone: Object.freeze([".flowtask"]),
});

export const TARGET_IDS = Object.freeze(Object.keys(TARGET_REGISTRATION_PATHS));

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

function assertTarget(target) {
  if (!TARGET_REGISTRATION_PATHS[target]) throw new Error(`Unknown project registration target: ${target}`);
}

/** Absolute directory that holds the registration of one target. */
export function resolveRegistrationDir(projectDir, target) {
  assertTarget(target);
  return path.join(projectDir, ...TARGET_REGISTRATION_PATHS[target]);
}

/** Absolute path of the registration file of one target. */
export function resolveRegistrationPath(projectDir, target) {
  return path.join(resolveRegistrationDir(projectDir, target), "project.json");
}

/**
 * Read and validate the registration of one target.
 *
 * The state is `absent` when the file does not exist, `unreadable` when it
 * cannot be parsed, `unsupported` when it declares another schema, `inactive`
 * when its project path does not resolve to this project, and `active` when it
 * is a usable registration.
 */
export function readProjectRegistration(projectDir, target) {
  const registrationPath = resolveRegistrationPath(projectDir, target);
  const registrationDir = resolveRegistrationDir(projectDir, target);
  if (!fs.existsSync(registrationPath)) {
    return { status: "absent", registry: null, path: registrationPath, dir: registrationDir, projectDir, target };
  }

  const parsed = readJson(registrationPath, registrationPath);
  if (!parsed.ok) {
    return {
      status: "unreadable",
      registry: null,
      path: registrationPath,
      dir: registrationDir,
      projectDir,
      target,
      reason: parsed.error,
    };
  }
  const registry = parsed.value;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return {
      status: "unreadable",
      registry: null,
      path: registrationPath,
      dir: registrationDir,
      projectDir,
      target,
      reason: `${registrationPath} is not a JSON object`,
    };
  }
  if (registry.schema !== REGISTRATION_SCHEMA) {
    return {
      status: "unsupported",
      registry,
      path: registrationPath,
      dir: registrationDir,
      projectDir,
      target,
      reason: `schema ${registry.schema ?? "missing"}`,
    };
  }
  if (typeof registry.projectPath !== "string" || !registry.projectPath) {
    return {
      status: "unreadable",
      registry,
      path: registrationPath,
      dir: registrationDir,
      projectDir,
      target,
      reason: `${registrationPath} does not declare a project path`,
    };
  }

  let active = false;
  try {
    active = pathsEqual(registry.projectPath, realProjectPath(projectDir));
  } catch {
    active = false;
  }
  return {
    status: active ? "active" : "inactive",
    registry,
    path: registrationPath,
    dir: registrationDir,
    projectDir,
    target,
  };
}

function writeRegistrationGitignore(projectDir, target) {
  const registrationDir = resolveRegistrationDir(projectDir, target);
  const gitignorePath = path.join(registrationDir, ".gitignore");
  const content = "*\n";
  if (fs.existsSync(gitignorePath) && fs.readFileSync(gitignorePath, "utf8") === content) return false;
  fs.mkdirSync(registrationDir, { recursive: true });
  writeFileAtomic(gitignorePath, content);
  return true;
}

/**
 * Write the registration of one target: an ignored folder, the minimal
 * registration file and the Git exclude entry. The registration is idempotent:
 * two identical writes change no bytes and preserve `registeredAt`.
 * Additional target-specific fields are merged without changing the schema.
 */
export function writeProjectRegistration({
  projectDir,
  target,
  runtimeVersion,
  extra = {},
  files = [],
  runtimeRoot = null,
} = {}) {
  assertTarget(target);
  const registrationDir = resolveRegistrationDir(projectDir, target);
  const registrationPath = resolveRegistrationPath(projectDir, target);
  const existingRead = readProjectRegistration(projectDir, target);
  const existing = existingRead.status === "active" ? existingRead.registry : null;
  if (existingRead.status === "inactive") {
    // A registration that points at another project is replaced; its
    // registeredAt is not inherited.
  } else if (existingRead.status === "unsupported" || existingRead.status === "unreadable") {
    const error = new Error(
      `FlowTask project registration at ${registrationPath} is ${existingRead.status}: ${existingRead.reason}. ` +
        "Move the file away and retry.",
    );
    error.code = existingRead.status === "unsupported" ? "registry_schema_unsupported" : "registry_unreadable";
    error.path = registrationPath;
    throw error;
  }

  const registry = {
    schema: REGISTRATION_SCHEMA,
    projectPath: realProjectPath(projectDir),
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    runtimeVersion,
    ...extra,
  };
  fs.mkdirSync(registrationDir, { recursive: true });
  writeRegistrationGitignore(projectDir, target);
  const content = JSON.stringify(registry, null, 2);
  const changed = !fs.existsSync(registrationPath) || fs.readFileSync(registrationPath, "utf8") !== content;
  if (changed) writeFileAtomic(registrationPath, content);

  const exclude = updateProjectExclude(projectDir, {
    registrationDir: path.relative(projectDir, registrationDir).split(path.sep).join("/"),
    files,
  });
  const indexRoot = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const reconcile = reconcileProjectsIndex(indexRoot, {
    current: { ...registry, targets: [target] },
    mode: "install",
  });
  return {
    ok: true,
    registry,
    path: registrationPath,
    dir: registrationDir,
    changed,
    exclude,
    existing: existingRead.status,
    index: reconcile.ok ? reconcile.index : null,
  };
}

/**
 * Remove the registration of one target: the registration file, the owned
 * `.gitignore` and the folder when nothing else remains. Unknown files are
 * preserved and reported.
 */
export function removeProjectRegistration(projectDir, target, { runtimeRoot = null } = {}) {
  assertTarget(target);
  const registrationDir = resolveRegistrationDir(projectDir, target);
  const registrationPath = path.join(registrationDir, "project.json");
  const removed = [];
  const preserved = [];
  const read = readProjectRegistration(projectDir, target);
  const registry = read.registry;

  if (fs.existsSync(registrationPath)) {
    fs.rmSync(registrationPath, { force: true });
    removed.push(registrationPath);
  }

  const gitignorePath = path.join(registrationDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (content.trim() === "*") {
      fs.rmSync(gitignorePath, { force: true });
      removed.push(gitignorePath);
    } else {
      preserved.push(gitignorePath);
    }
  }

  let remaining = [];
  try {
    remaining = fs.readdirSync(registrationDir);
  } catch {
    remaining = [];
  }
  if (remaining.length === 0 && fs.existsSync(registrationDir)) {
    fs.rmdirSync(registrationDir);
    removed.push(registrationDir);
  } else {
    for (const entry of remaining) preserved.push(path.join(registrationDir, entry));
  }

  const exclude = removeProjectExclude(projectDir, {
    registrationDir: path.relative(projectDir, registrationDir).split(path.sep).join("/"),
  });
  if (!exclude.ok) preserved.push(`${exclude.path ?? "git exclude"}#FlowTask block`);
  const indexRoot = runtimeRoot ?? resolveUserRuntimePaths().runtimeRoot;
  const reconcile = reconcileProjectsIndex(indexRoot, { mode: "uninstall" });
  return {
    ok: true,
    removed,
    preserved,
    registry,
    index: reconcile.ok ? reconcile.index : null,
    indexError: reconcile.ok ? null : (reconcile.error ?? reconcile.reason ?? null),
  };
}

/**
 * Find the closest registered project walking up from `startDir`. Only an
 * active registration of a requested target qualifies.
 */
export function findRegisteredProject(startDir, { targets = TARGET_IDS } = {}) {
  let current;
  try {
    current = realProjectPath(startDir);
  } catch {
    return null;
  }
  for (;;) {
    for (const target of targets) {
      const read = readProjectRegistration(current, target);
      if (read.status === "active") {
        return { target, projectDir: current, path: read.path, registry: read.registry };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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
export function updateProjectExclude(projectDir, { registrationDir = null, files = [] } = {}) {
  const context = repoContext(projectDir);
  if (!context.ok) return { ok: false, reason: context.reason };

  const candidates = [
    registrationDir ? `${registrationDir.replace(/\/$/, "")}/` : null,
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
  if (fs.existsSync(context.excludePath)) current = fs.readFileSync(context.excludePath, "utf8");
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
export function removeProjectExclude(projectDir, { registrationDir = null } = {}) {
  const context = repoContext(projectDir);
  if (!context.ok) return { ok: false, reason: context.reason };
  if (!fs.existsSync(context.excludePath)) return { ok: true, changed: false };

  const current = fs.readFileSync(context.excludePath, "utf8");
  const start = current.indexOf(EXCLUDE_START);
  const end = current.indexOf(EXCLUDE_END);
  if (start === -1 || end === -1 || end < start) return { ok: true, changed: false };

  const entries = current
    .slice(start + EXCLUDE_START.length, end)
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const owned = registrationDir ? `${registrationDir.replace(/\/$/, "")}/` : null;
  const remaining = owned ? entries.filter((entry) => entry !== owned) : [];

  const prefix = current.slice(0, start).trimEnd();
  const suffix = current.slice(end + EXCLUDE_END.length).replace(/^\n*/, "");
  const block = remaining.length > 0 ? [EXCLUDE_START, ...remaining, EXCLUDE_END].join("\n") : "";
  const next = [prefix, block, suffix].filter((part) => part !== "").join("\n\n");
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

function normalizeTargets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((target) => TARGET_IDS.includes(target)))];
}

export function readProjectsIndex(runtimeRoot) {
  const filePath = indexPath(runtimeRoot);
  if (!fs.existsSync(filePath)) return { ok: true, index: emptyProjectsIndex() };

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

function projectsIndexEntry(entry) {
  return {
    path: entry.path,
    registeredAt: entry.registeredAt ?? null,
    runtimeVersion: entry.runtimeVersion ?? null,
    targets: normalizeTargets(entry.targets),
  };
}

/**
 * Rebuild the user-level index from the registrations that still exist,
 * merging destinations by real project path. An unreadable index is rebuilt on
 * install/update and fails closed on uninstall.
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
  const byPath = new Map();
  const addEntry = (entry) => {
    const entryPath = entry?.path ?? entry?.projectPath;
    if (typeof entryPath !== "string" || !entryPath) return;
    const key = comparablePath(entryPath);
    const existing = byPath.get(key);
    if (!existing) {
      const normalized = projectsIndexEntry({ ...entry, path: entryPath });
      byPath.set(key, normalized);
      projects.push(normalized);
      return;
    }
    existing.targets = normalizeTargets([...existing.targets, ...normalizeTargets(entry.targets)]);
    existing.registeredAt = existing.registeredAt ?? entry.registeredAt ?? null;
    existing.runtimeVersion = entry.runtimeVersion ?? existing.runtimeVersion ?? null;
  };

  for (const entry of index.projects) {
    if (!entry || typeof entry.path !== "string") continue;
    const targets = normalizeTargets(entry.targets);
    const candidates = targets.length > 0 ? targets : ["claude"];
    const active = [];
    for (const target of candidates) {
      const registration = readProjectRegistration(entry.path, target);
      if (registration.status === "active" && pathsEqual(registration.registry.projectPath, entry.path)) {
        active.push(target);
      }
    }
    if (active.length === 0) continue;
    addEntry({ ...entry, targets: active });
  }

  if (current) {
    addEntry({ ...current, targets: normalizeTargets(current.targets) });
  }

  const changed = JSON.stringify(projects) !== JSON.stringify(index.projects);
  if (!changed && read.ok) return { ok: true, index, changed: false };

  const written = writeProjectsIndex(runtimeRoot, { ...index, projects });
  if (!written.ok) return written;
  return { ok: true, index: written.index, changed: true };
}
