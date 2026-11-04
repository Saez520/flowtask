/**
 * Compatibility boundary of the worktree consumer.
 *
 * The adapter translates a legacy setting or a legacy transaction only when the
 * request asks for it explicitly, it declares the compatibility it applies and
 * it never writes a legacy artifact. These tests exercise that boundary over
 * real repositories and the real manager: the backend is never mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { globalWorktreeManagerDirectory } from "../../plugins/flowtask-permission-gate/dist/worktree-manager-location.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONSUMER = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
const MANAGER = path.join(
  process.env.WORKTREE_MANAGER_SUBMODULE
    ? path.resolve(process.env.WORKTREE_MANAGER_SUBMODULE)
    : globalWorktreeManagerDirectory(),
  "worktree.sh",
);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ft-adapter-compat-"));
process.on("exit", () => { try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
}

function run(script, args, options = {}) {
  const result = spawnSync(script, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { ...result, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/** A repository with the configuration the manager expects. */
function createRepository(name, options = {}) {
  const repo = path.join(temporaryRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Adapter Compatibility");
  git(repo, "config", "user.email", "adapter-compat@example.invalid");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n.flowtask/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  if (options.legacyConfig !== undefined) {
    const directory = path.join(repo, ".flowtask", "config");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "worktree.json"), options.legacyConfig);
  }
  return repo;
}

/** A worktree with one commit, ready to be completed. */
function createCommittedWorktree(repo, workId) {
  const created = run(CONSUMER, ["create", workId, "--base", "main"], { cwd: repo });
  assert.equal(created.status, 0, created.stderr);
  const worktree = path.join(repo, ".worktrees", workId);
  fs.writeFileSync(path.join(worktree, "change.txt"), `${workId}\n`);
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "worktree change");
  return worktree;
}

/** The legacy artifacts the adapter must never create. */
function legacyArtifacts(repo) {
  return {
    backups_directory: fs.existsSync(path.join(repo, ".flowtask", "backups")),
    backup_refs: git(repo, "for-each-ref", "refs/flowtask/backups", "--format=%(refname)").trim(),
  };
}

function assertNoLegacyArtifacts(repo, label) {
  const observed = legacyArtifacts(repo);
  assert.equal(observed.backups_directory, false, `${label}: the legacy backup directory must not exist`);
  assert.equal(observed.backup_refs, "", `${label}: the legacy backup refs must stay empty`);
}

/** The published output with the repository path replaced by a stable token. */
function normalize(text, repo) {
  return text.split(repo).join("<repo>").split(fs.realpathSync(repo)).join("<repo>");
}

function canonicalTransactionRoot(repo) {
  const gitDir = git(repo, "rev-parse", "--git-dir").trim();
  return path.resolve(repo, gitDir);
}

test("A: the canonical manager operates on a repository that has no consumer state", () => {
  const repo = createRepository("scenario-a");
  const created = run(MANAGER, ["create", "solo", "--base", "main"], { cwd: repo });
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /result: success/);

  const worktree = path.join(repo, ".worktrees", "solo");
  fs.writeFileSync(path.join(worktree, "change.txt"), "changed\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "worktree change");

  const listed = run(MANAGER, ["list"], { cwd: repo });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /solo/);

  const completed = run(MANAGER, ["complete", "solo", "--base", "main"], { cwd: repo });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "base\n");
  assert.equal(fs.readFileSync(path.join(repo, "change.txt"), "utf8"), "changed\n");
  assert.equal(fs.existsSync(path.join(repo, ".flowtask")), false, "the manager creates no consumer state");
  assert.equal(git(repo, "for-each-ref", "refs/flowtask/backups", "--format=%(refname)").trim(), "");
});

test("B: no operation writes a legacy mirror", () => {
  const repo = createRepository("scenario-b");
  createCommittedWorktree(repo, "mirror");
  assertNoLegacyArtifacts(repo, "after create");

  const completed = run(CONSUMER, ["complete", "mirror", "--base", "main"], { cwd: repo });
  assert.equal(completed.status, 0, completed.stderr);
  assertNoLegacyArtifacts(repo, "after complete");

  const second = createCommittedWorktree(repo, "mirror-two");
  const cleaned = run(CONSUMER, ["cleanup", "mirror-two", "--base", "main", "--discard"], { cwd: repo });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assertNoLegacyArtifacts(repo, "after cleanup");

  const pruned = run(CONSUMER, ["prune"], { cwd: repo });
  assert.equal(pruned.status, 0, pruned.stderr);
  assertNoLegacyArtifacts(repo, "after prune");
});

test("C: the legacy preserveDirty setting is applied and declared", () => {
  const repo = createRepository("scenario-c", { legacyConfig: JSON.stringify({ preserveDirty: true }) });
  createCommittedWorktree(repo, "preserve");
  fs.appendFileSync(path.join(repo, "base.txt"), "local\n");

  const completed = run(CONSUMER, ["complete", "preserve", "--base", "main", "--preserve-dirty"], { cwd: repo });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stderr, /Compatibility: legacy FlowTask preserveDirty setting applied\./);
  assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "base\nlocal\n", "the destination changes are preserved");
  assert.equal(fs.existsSync(path.join(repo, "change.txt")), true, "the worktree change is integrated");
  assertNoLegacyArtifacts(repo, "after the legacy preserve");
});

test("D: an invalid legacy configuration blocks the operation without changing anything", () => {
  const repo = createRepository("scenario-d", { legacyConfig: "{ this is not json" });
  const worktree = createCommittedWorktree(repo, "invalid");
  const before = git(repo, "rev-parse", "main").trim();

  const completed = run(CONSUMER, ["complete", "invalid", "--base", "main", "--preserve-dirty"], { cwd: repo });
  assert.equal(completed.status, 3, completed.stderr);
  assert.equal(fs.existsSync(worktree), true, "the worktree is preserved");
  assert.equal(git(repo, "rev-parse", "main").trim(), before, "the base is unchanged");
  assertNoLegacyArtifacts(repo, "after the blocked operation");
});

test("E: an explicit configuration wins and the legacy configuration is declared as ignored", () => {
  const repo = createRepository("scenario-e", { legacyConfig: "{ this is not json" });
  createCommittedWorktree(repo, "explicit");
  fs.appendFileSync(path.join(repo, "base.txt"), "local\n");

  const config = path.join(temporaryRoot, "explicit.conf");
  fs.writeFileSync(config, "preserve_dirty=true\n");
  const completed = run(CONSUMER, ["--config", config, "complete", "explicit", "--base", "main", "--preserve-dirty"], { cwd: repo });
  assert.equal(completed.status, 0, completed.stderr);
  assert.match(completed.stderr, /Compatibility: legacy FlowTask configuration ignored because --config was provided\./);
  assert.equal(fs.readFileSync(path.join(repo, "base.txt"), "utf8"), "base\nlocal\n", "the destination changes are preserved");
  assertNoLegacyArtifacts(repo, "after the explicit configuration");
});

test("F: a legacy transaction is imported once and the canonical manager recovers it", () => {
  const repo = createRepository("scenario-f");
  createCommittedWorktree(repo, "recover");

  const crashed = run(CONSUMER, ["complete", "recover", "--base", "main"], {
    cwd: repo,
    env: { WORKTREE_MANAGER_TEST_CRASH_AFTER_TRANSACTION_PHASE: "merge_started" },
  });
  assert.notEqual(crashed.status, 0, "the interrupted completion does not succeed");

  const transactions = path.join(canonicalTransactionRoot(repo), "worktree-manager", "transactions");
  const pending = fs.readdirSync(transactions).filter((entry) => fs.existsSync(path.join(transactions, entry, "journal")));
  assert.equal(pending.length, 1, "the interrupted completion leaves one pending transaction");
  const transaction = pending[0];

  const legacyDirectory = path.join(repo, ".flowtask", "backups", transaction);
  fs.mkdirSync(path.dirname(legacyDirectory), { recursive: true });
  fs.cpSync(path.join(transactions, transaction), legacyDirectory, { recursive: true });
  fs.rmSync(path.join(transactions, transaction), { recursive: true, force: true });
  const legacyBefore = fs.readdirSync(legacyDirectory).sort();

  const recovered = run(CONSUMER, ["recover", transaction], { cwd: repo });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, new RegExp(`Compatibility: legacy FlowTask transaction ${transaction} imported for recovery\\.`));
  assert.ok(fs.existsSync(path.join(transactions, transaction)), "the transaction is in the canonical state");
  assert.deepEqual(fs.readdirSync(legacyDirectory).sort(), legacyBefore, "the legacy copy is not written back");
  assert.equal(fs.readFileSync(path.join(legacyDirectory, "journal"), "utf8"), "merge_started\n", "the legacy journal is byte-identical");

  const recoveredAgain = run(CONSUMER, ["recover", transaction], { cwd: repo });
  assert.equal(recoveredAgain.status, 0, recoveredAgain.stderr);
  assert.doesNotMatch(recoveredAgain.stderr, /imported for recovery/);
});

test("G: a conflict between the canonical and the legacy record blocks the operation", () => {
  const repo = createRepository("scenario-g");
  createCommittedWorktree(repo, "conflict");

  const transactions = path.join(canonicalTransactionRoot(repo), "worktree-manager", "transactions");
  const transaction = "conflict-transaction";
  const canonicalDirectory = path.join(transactions, transaction);
  fs.mkdirSync(canonicalDirectory, { recursive: true });
  fs.writeFileSync(path.join(canonicalDirectory, "journal"), "captured\n");
  fs.writeFileSync(
    path.join(canonicalDirectory, "binding.json"),
    JSON.stringify({ transaction_id: transaction, repo: repo, work_id: "canonical-work" }),
  );
  const legacyDirectory = path.join(repo, ".flowtask", "backups", transaction);
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(path.join(legacyDirectory, "journal"), "captured\n");
  fs.writeFileSync(
    path.join(legacyDirectory, "binding.json"),
    JSON.stringify({ transaction_id: transaction, repo: repo, work_id: "legacy-work" }),
  );
  const canonicalBefore = fs.readFileSync(path.join(canonicalDirectory, "journal"), "utf8");
  const legacyBefore = fs.readFileSync(path.join(legacyDirectory, "journal"), "utf8");

  const blocked = run(CONSUMER, ["recover", transaction], { cwd: repo });
  assert.equal(blocked.status, 5, blocked.stderr);
  assert.equal(fs.readFileSync(path.join(canonicalDirectory, "journal"), "utf8"), canonicalBefore, "the canonical record is preserved");
  assert.equal(fs.readFileSync(path.join(legacyDirectory, "journal"), "utf8"), legacyBefore, "the legacy record is preserved");

  const referenceTransaction = "reference-transaction";
  const referenceCommit = git(repo, "rev-parse", "main").trim();
  fs.appendFileSync(path.join(repo, "base.txt"), "other\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-qm", "other");
  const otherCommit = git(repo, "rev-parse", "main").trim();
  const referenceLegacy = path.join(repo, ".flowtask", "backups", referenceTransaction);
  fs.mkdirSync(referenceLegacy, { recursive: true });
  fs.writeFileSync(path.join(referenceLegacy, "journal"), "captured\n");
  fs.writeFileSync(
    path.join(referenceLegacy, "binding.json"),
    JSON.stringify({ transaction_id: referenceTransaction, repo, work_id: "reference-work" }),
  );
  git(repo, "update-ref", `refs/flowtask/backups/${referenceTransaction}`, referenceCommit);
  git(repo, "update-ref", `refs/worktree-manager/backups/${referenceTransaction}`, otherCommit);
  const emptyTransactions = path.join(transactions, referenceTransaction);
  assert.equal(fs.existsSync(emptyTransactions), false);

  const blockedReference = run(CONSUMER, ["recover", referenceTransaction], { cwd: repo });
  assert.equal(blockedReference.status, 5, blockedReference.stderr);
  assert.equal(fs.existsSync(emptyTransactions), false, "no transaction is created for a conflicting reference");
  assert.equal(git(repo, "rev-parse", `refs/worktree-manager/backups/${referenceTransaction}`).trim(), otherCommit);
});

test("H: the legacy environment variables are inert", () => {
  const plain = createRepository("scenario-h-plain");
  const withLegacyEnvironment = createRepository("scenario-h-legacy");
  const legacyEnvironment = {
    FLOWTASK_TEST_MODE: "1",
    FLOWTASK_TEST_CRASH_AFTER: "captured",
    FLOWTASK_TEST_CLOSE_CRASH_AFTER: "init_started",
    FLOWTASK_TEST_TARGET_CRASH_AFTER: "staged_started",
    FLOWTASK_TEST_COUNTER_FILE: path.join(temporaryRoot, "counter"),
    FLOWTASK_CONFIG: path.join(temporaryRoot, "legacy.conf"),
  };
  fs.writeFileSync(legacyEnvironment.FLOWTASK_CONFIG, "preserve_dirty=true\n");

  const plainResult = run(CONSUMER, ["create", "inert", "--base", "main"], { cwd: plain });
  const legacyResult = run(CONSUMER, ["create", "inert", "--base", "main"], {
    cwd: withLegacyEnvironment,
    env: legacyEnvironment,
  });

  assert.equal(plainResult.status, 0, plainResult.stderr);
  assert.equal(legacyResult.status, 0, legacyResult.stderr);
  assert.equal(
    normalize(legacyResult.stdout, withLegacyEnvironment),
    normalize(plainResult.stdout, plain),
    "the legacy environment does not change the execution",
  );
  assert.match(git(withLegacyEnvironment, "worktree", "list", "--porcelain"), /worktree\/inert/);
  assert.equal(fs.existsSync(legacyEnvironment.FLOWTASK_TEST_COUNTER_FILE), false, "the legacy counter is not created");
  assertNoLegacyArtifacts(withLegacyEnvironment, "after the inert operation");
});
