import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { CONTEXT_CHECKPOINT_SHA } from "./ownership.js";

export const SUBMODULE_RELATIVE_PATH = ".flowtask/plugins/flowtask-context-checkpoint";
export const JOURNAL_PHASES = Object.freeze([
  "PREPARE", "SNAPSHOT", "STAGE-PUBLISH", "SWAP-WORKTREE", "SWAP-MODULES",
  "POINTERS-CONFIG", "VERIFY", "COMMIT",
]);
const JOURNAL_ROOT = path.join(os.tmpdir(), "flowtask-submodule-publications");

function defaultRunner(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function callRunner(runner, args, options) {
  const result = runner(args, options);
  if (typeof result === "number") return { status: result, stdout: "", stderr: "" };
  return { status: result?.status ?? (result?.ok === false ? 1 : 0), stdout: result?.stdout ?? "", stderr: result?.stderr ?? "" };
}

function runGit(args, cwd, runner = defaultRunner) {
  return callRunner(runner, args, { cwd });
}

function gitOutput(args, cwd, runner = defaultRunner) {
  const result = runGit(args, cwd, runner);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshotEntry(file, { omitObjects = false } = {}) {
  if (!fs.existsSync(file)) return { exists: false };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", target: fs.readlinkSync(file) };
  if (stat.isFile()) return { exists: true, type: "file", mode: stat.mode & 0o7777, data: fs.readFileSync(file).toString("base64") };
  const tree = {};
  for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
    if (omitObjects && (entry.name === "objects" || entry.name === "pack")) continue;
    tree[entry.name] = snapshotEntry(path.join(file, entry.name), { omitObjects });
  }
  return { exists: true, type: "directory", mode: stat.mode & 0o7777, tree };
}

function restoreEntry(file, snapshot) {
  fs.rmSync(file, { recursive: true, force: true });
  if (!snapshot?.exists) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (snapshot.type === "symlink") fs.symlinkSync(snapshot.target, file);
  else if (snapshot.type === "file") {
    fs.writeFileSync(file, Buffer.from(snapshot.data, "base64"));
    fs.chmodSync(file, snapshot.mode);
  } else {
    fs.mkdirSync(file, { recursive: true });
    for (const [name, child] of Object.entries(snapshot.tree ?? {})) restoreEntry(path.join(file, name), child);
    if (snapshot.mode) fs.chmodSync(file, snapshot.mode);
  }
}

function digestEntry(snapshot, prefix = "") {
  if (!snapshot?.exists) return [`${prefix}|absent`];
  if (snapshot.type === "file") return [`${prefix}|file|${snapshot.mode}|${sha256(Buffer.from(snapshot.data, "base64"))}`];
  if (snapshot.type === "symlink") return [`${prefix}|symlink|${snapshot.target}`];
  return Object.entries(snapshot.tree ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, child]) => digestEntry(child, path.posix.join(prefix, name)));
}

function safeRelative(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path escapes root: ${candidate}`);
  return relative;
}

function journalPath(txId) {
  return path.join(JOURNAL_ROOT, `${txId}.json`);
}

function writeJournal(journal) {
  fs.mkdirSync(JOURNAL_ROOT, { recursive: true, mode: 0o700 });
  const file = journalPath(journal.txId);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function removeJournal(txId) {
  fs.rmSync(journalPath(txId), { force: true });
}

function resolveParent(flowtaskDir, runner = defaultRunner) {
  const parentDir = gitOutput(["rev-parse", "--show-toplevel"], path.dirname(flowtaskDir), runner);
  const relativePath = path.relative(parentDir, path.join(flowtaskDir, "plugins", "flowtask-context-checkpoint"));
  if (relativePath !== SUBMODULE_RELATIVE_PATH) throw new Error(`unexpected submodule path: ${relativePath}`);
  return parentDir;
}

export function snapshotSubmoduleParent(parentDir, submodulePath = SUBMODULE_RELATIVE_PATH, runner = defaultRunner) {
  const root = path.resolve(parentDir);
  const absoluteSubmodule = path.resolve(root, submodulePath);
  safeRelative(root, absoluteSubmodule);
  const gitDir = gitOutput(["rev-parse", "--git-dir"], root, runner);
  const resolvedGitDir = path.resolve(root, gitDir);
  const commonDir = path.resolve(root, gitOutput(["rev-parse", "--git-common-dir"], root, runner));
  const config = path.resolve(root, gitOutput(["rev-parse", "--git-path", "config"], root, runner));
  const index = path.resolve(root, gitOutput(["rev-parse", "--git-path", "index"], root, runner));
  let gitlink = "";
  const gitlinkResult = runGit(["rev-parse", `HEAD:${submodulePath}`], root, runner);
  if (gitlinkResult.status === 0) gitlink = gitlinkResult.stdout.trim();
  const sourceGitPointer = path.join(absoluteSubmodule, ".git");
  const modulesPath = path.resolve(root, gitOutput(["rev-parse", "--git-path", `modules/${submodulePath}`], root, runner));
  const trackedPaths = {
    config,
    index,
    gitmodules: path.join(root, ".gitmodules"),
    source: absoluteSubmodule,
    sourceGitPointer,
    modules: modulesPath,
  };
  const snapshots = Object.fromEntries(Object.entries(trackedPaths).map(([name, file]) => [name, snapshotEntry(file, { omitObjects: name === "modules" })]));
  const status = runGit(["status", "--porcelain=v2", "--untracked-files=all"], root, runner);
  return {
    root,
    submodulePath,
    gitDir: resolvedGitDir,
    commonDir,
    parentHead: gitOutput(["rev-parse", "HEAD"], root, runner),
    gitlink,
    status: status.stdout,
    trackedPaths,
    snapshots,
    preDigest: sha256(JSON.stringify(Object.entries(snapshots).flatMap(([name, value]) => digestEntry(value, name)))),
  };
}

export function restoreAndVerify(snapshot, runner = defaultRunner) {
  for (const [name, file] of Object.entries(snapshot.trackedPaths ?? {})) restoreEntry(file, snapshot.snapshots?.[name]);
  const after = snapshotSubmoduleParent(snapshot.root, snapshot.submodulePath, runner);
  const same = after.preDigest === snapshot.preDigest && after.gitlink === snapshot.gitlink && after.status === snapshot.status;
  if (!same) {
    const error = new Error("rollback-incomplete: parent/submodule snapshot differs after restore");
    error.code = "ROLLBACK_INCOMPLETE";
    throw error;
  }
  return true;
}

function transportArgs(transport, submodulePath) {
  if (transport === "https") {
    return ["-c", 'url."https://github.com/Saez520/".insteadOf="git@github.com:Saez520/"', "submodule", "update", "--init", "--recursive", "--", submodulePath];
  }
  return ["submodule", "update", "--init", "--recursive", "--", submodulePath];
}

export function runMaterializationAttempt(snapshot, transport, runner = defaultRunner) {
  const result = runGit(transportArgs(transport, snapshot.submodulePath), snapshot.root, runner);
  return { ...result, transport, args: transportArgs(transport, snapshot.submodulePath) };
}

function verifySource(parentDir, submodulePath, expectedSha, runner = defaultRunner) {
  const sourceDir = path.join(parentDir, submodulePath);
  const actual = gitOutput(["rev-parse", "HEAD"], sourceDir, runner);
  if (actual !== expectedSha) throw new Error(`submodule SHA mismatch: expected ${expectedSha}, got ${actual} at ${sourceDir}`);
  const pkgPath = path.join(sourceDir, "package.json");
  if (!fs.existsSync(pkgPath) || !fs.existsSync(path.join(sourceDir, "index.ts"))) throw new Error(`invalid V2 source at ${sourceDir}: package.json/index.ts required`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (!pkg.dependencies?.["@opencode/plugin"] && !pkg.devDependencies?.["@opencode/plugin"] && !pkg.peerDependencies?.["@opencode/plugin"]) {
    throw new Error(`invalid V2 source at ${sourceDir}: @opencode/plugin dependency required`);
  }
  if (!fs.readFileSync(path.join(sourceDir, "index.ts"), "utf8").includes("Plugin.define")) throw new Error(`invalid V2 source at ${sourceDir}: Plugin.define required`);
  return { sourceDir, sourceCommit: actual, packagePath: pkgPath };
}

export function inspectSubmoduleTopology(parentDir, runner = defaultRunner, stageRoot = null) {
  const root = path.resolve(parentDir);
  const status = gitOutput(["submodule", "status", "--recursive"], root, runner);
  const entries = status.split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^[ +-]?([0-9a-f]{40})\s+([^ ]+)/);
    return match ? { sha: match[1], submodulePath: match[2] } : null;
  }).filter(Boolean);
  const records = [{ level: "P", submodulePath: ".", worktree: root }];
  entries.forEach((entry, index) => {
    const worktree = path.join(root, entry.submodulePath);
    const commonDir = path.resolve(worktree, gitOutput(["rev-parse", "--git-common-dir"], worktree, runner));
    const gitDir = path.resolve(worktree, gitOutput(["rev-parse", "--git-dir"], worktree, runner));
    const coreWorktree = path.join(gitDir, "worktrees", path.basename(worktree));
    const stageWorktree = stageRoot ? path.join(stageRoot, entry.submodulePath) : null;
    const stageCommonDir = stageRoot ? path.resolve(stageRoot, gitOutput(["rev-parse", "--git-common-dir"], stageRoot, runner)) : null;
    const stageModuleGitDir = stageRoot ? path.resolve(stageRoot, gitOutput(["rev-parse", "--git-path", `modules/${entry.submodulePath}`], stageRoot, runner)) : null;
    const parentModuleGitDir = path.resolve(root, gitOutput(["rev-parse", "--git-path", `modules/${entry.submodulePath}`], root, runner));
    if (stageRoot) {
      const relModule = safeRelative(stageCommonDir, stageModuleGitDir);
      const mapped = path.resolve(stageCommonDir, relModule);
      if (mapped !== stageModuleGitDir || !mapped.startsWith(`${stageCommonDir}${path.sep}`)) throw new Error(`ambiguous stage mapping for ${entry.submodulePath}`);
    }
    records.push({
      level: `S${index + 1}`,
      submodulePath: entry.submodulePath,
      stageCommonDir,
      stagePerWorktreeDir: stageRoot ? path.join(stageRoot, ".git", "worktrees") : null,
      parentCommonDir: commonDir,
      parentPerWorktreeDir: path.join(gitDir, "worktrees"),
      stageModuleGitDir,
      parentModuleGitDir,
      stageWorktree,
      parentWorktree: worktree,
      stageGitPointer: stageWorktree ? path.join(stageWorktree, ".git") : null,
      parentGitPointer: path.join(worktree, ".git"),
      expectedCoreWorktree: path.join(gitDir, "config"),
      objectRoots: [path.join(commonDir, "objects")],
      packs: [path.join(commonDir, "objects", "pack")],
      refs: path.join(commonDir, "refs"),
      logs: path.join(commonDir, "logs"),
      fetchHead: path.join(commonDir, "FETCH_HEAD"),
      config: path.join(commonDir, "config"),
      index: path.join(gitDir, "index"),
      locks: [path.join(gitDir, "index.lock"), path.join(commonDir, "config.lock")],
      worktree,
      expectedSha: entry.sha,
    });
  });
  return records;
}

export function recoverPublications({ journalRoot = JOURNAL_ROOT, runner = defaultRunner } = {}) {
  if (!fs.existsSync(journalRoot)) return { recovered: 0, blocked: 0 };
  let recovered = 0;
  let blocked = 0;
  for (const file of fs.readdirSync(journalRoot)) {
    if (!file.endsWith(".json")) continue;
    let journal;
    try { journal = JSON.parse(fs.readFileSync(path.join(journalRoot, file), "utf8")); } catch { blocked++; continue; }
    if (!JOURNAL_PHASES.includes(journal.phase)) { blocked++; continue; }
    try {
      if (journal.phase === "COMMIT" && journal.postDigestVerified) {
        for (const candidate of journal.txOwnedPaths ?? []) fs.rmSync(candidate, { recursive: true, force: true });
      } else if (journal.snapshot) {
        restoreAndVerify(journal.snapshot, runner);
        for (const candidate of journal.txOwnedPaths ?? []) fs.rmSync(candidate, { recursive: true, force: true });
      }
      const recoveredJournal = { ...journal, phase: "COMMIT", recovered: true };
      fs.writeFileSync(path.join(journalRoot, file), `${JSON.stringify(recoveredJournal, null, 2)}\n`);
      fs.rmSync(path.join(journalRoot, file), { force: true });
      recovered++;
    } catch {
      blocked++;
    }
  }
  return { recovered, blocked };
}

export async function ensureCanonicalSubmodule(flowtaskDir, {
  expectedSha = CONTEXT_CHECKPOINT_SHA,
  runner = defaultRunner,
  journalRoot = JOURNAL_ROOT,
} = {}) {
  const parentDir = resolveParent(flowtaskDir, runner);
  const recovery = recoverPublications({ journalRoot, runner });
  if (recovery.blocked) throw new Error(`recovery-blocked: ${recovery.blocked} submodule publication journal(s) require manual inspection`);
  const snapshot = snapshotSubmoduleParent(parentDir, SUBMODULE_RELATIVE_PATH, runner);
  if (snapshot.gitlink !== expectedSha) throw new Error(`gitlink mismatch: expected ${expectedSha}, got ${snapshot.gitlink || "missing"}`);
  let source;
  try { source = verifySource(parentDir, SUBMODULE_RELATIVE_PATH, expectedSha, runner); }
  catch {
    const txId = `submodule-${process.pid}-${crypto.randomUUID()}`;
    const journal = { version: 1, txId, ownerPid: process.pid, phase: "PREPARE", snapshot, txOwnedPaths: [], transports: [] };
    writeJournal(journal);
    let lastError;
    for (const transport of ["ssh", "https"]) {
      journal.phase = "SNAPSHOT";
      journal.transports.push({ transport, phase: journal.phase });
      writeJournal(journal);
      const attempt = runMaterializationAttempt(snapshot, transport, runner);
      journal.transports.at(-1).result = { status: attempt.status, stderr: attempt.stderr.slice(0, 500), args: attempt.args };
      if (attempt.status === 0) {
        try {
          source = verifySource(parentDir, SUBMODULE_RELATIVE_PATH, expectedSha, runner);
          journal.phase = "VERIFY";
          journal.postDigestVerified = true;
          writeJournal(journal);
          journal.phase = "COMMIT";
          writeJournal(journal);
          removeJournal(txId);
          break;
        } catch (error) { lastError = error; }
      } else lastError = new Error(`${transport} materialization failed: ${attempt.stderr.trim() || "unknown git error"}`);
      try { restoreAndVerify(snapshot, runner); }
      catch (rollbackError) {
        journal.phase = "POINTERS-CONFIG";
        journal.rollbackError = rollbackError.message;
        writeJournal(journal);
        const error = new Error(`rollback-incomplete after ${transport}: ${rollbackError.message}`);
        error.code = "ROLLBACK_INCOMPLETE";
        throw error;
      }
    }
    if (!source) {
      removeJournal(txId);
      throw new Error(`submodule materialization failed for ${SUBMODULE_RELATIVE_PATH}; SSH: ${journal.transports[0]?.result?.stderr || "failed"}; HTTPS: ${journal.transports[1]?.result?.stderr || "not attempted"}; ${lastError?.message || "unknown error"}`);
    }
  }
  const final = snapshotSubmoduleParent(parentDir, SUBMODULE_RELATIVE_PATH, runner);
  const checked = verifySource(parentDir, SUBMODULE_RELATIVE_PATH, expectedSha, runner);
  return { ...checked, parentDir, gitlink: final.gitlink, snapshot: final, recovered: recovery };
}

export const materializeCanonicalSubmodule = ensureCanonicalSubmodule;
