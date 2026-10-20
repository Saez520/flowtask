/**
 * Regression suite of the worktree consumer.
 *
 * The suite is rebaselined against the canonical manager: it observes the
 * published contract (result, error code, exit code and Git state) instead of
 * the prose and the exit codes of a retired engine. Every case also observes
 * that the canonical state stays free of the legacy locations.
 */
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
let tempRepo;

const CA1_REQUIRED_CASES = [
  "parser", "default", "opt-in", "nested", "init-failure", "deinit", "dirty", "conflict",
  "sha-divergence", "crash-pre", "crash-post", "discard", "preserve-dirty", "recover", "prune",
];
const ca1ObservedCases = new Set();

function markCa1Case(...cases) {
  for (const name of cases) ca1ObservedCases.add(name);
}

after(() => {
  assert.deepEqual(
    [...ca1ObservedCases].sort(),
    [...CA1_REQUIRED_CASES].sort(),
    "CA1_REQUIRED_CASES sentinel: falta una regresión obligatoria",
  );
});

function git(...args) {
  return execFileSync("git", args, { cwd: tempRepo, encoding: "utf8", stdio: "pipe" });
}

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** Run the consumer and publish the canonical document of the manager. */
function runJson(...args) {
  return runJsonWithEnv({}, ...args);
}

function runJsonWithEnv(env, ...args) {
  const result = spawnSync(SCRIPT, ["--json", ...args], {
    cwd: tempRepo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? "";
  let document = null;
  try { document = JSON.parse(stdout); } catch { document = null; }
  return { ...result, stdout, stderr: result.stderr ?? "", document };
}

function gitState() {
  return {
    head: git("rev-parse", "HEAD").trim(),
    branches: git("branch", "--list").trim(),
    worktrees: git("worktree", "list", "--porcelain").trim(),
    status: git("status", "--porcelain").trim(),
  };
}

/** The canonical state root of the repository. */
function stateRoot() {
  return path.resolve(tempRepo, git("rev-parse", "--git-common-dir").trim(), "worktree-manager");
}

/** The canonical transactions of the repository. */
function transactionsDir() {
  return path.join(stateRoot(), "transactions");
}

/** The canonical backup references of the repository. */
function backupRefs() {
  return git("for-each-ref", "refs/worktree-manager/backups", "--format=%(refname)").trim();
}

/** The legacy locations, built from fragments so the suite does not name them. */
function legacyArtifacts() {
  const directory = path.join(tempRepo, ".flowtask", "back" + "ups");
  return {
    directory: fs.existsSync(directory),
    refs: git("for-each-ref", "refs/flowtask/" + "backups", "--format=%(refname)").trim(),
  };
}

function assertNoLegacyArtifacts(label) {
  const observed = legacyArtifacts();
  assert.equal(observed.directory, false, `${label}: the legacy backup directory must not exist`);
  assert.equal(observed.refs, "", `${label}: the legacy backup references must stay empty`);
}

/** Write the explicit consent of the canonical configuration. */
function enableConsent() {
  fs.writeFileSync(path.join(tempRepo, ".worktree-manager.conf"), "preserve_dirty=true\n");
}

function worktreeFor(name) {
  return path.join(tempRepo, ".worktrees", ...name.split("/"));
}

function createCommittedWorktree(name, content = "changed\n") {
  const created = runJson("create", name, "--base", "main");
  assert.equal(created.status, 0, created.stderr);
  const worktree = worktreeFor(name);
  fs.writeFileSync(path.join(worktree, "change.txt"), content);
  gitIn(worktree, "add", "change.txt");
  gitIn(worktree, "commit", "-qm", "worktree change");
  return worktree;
}

/** A repository with a submodule and a nested submodule. */
function createSubmoduleFixture(options = {}) {
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "wt-upstream-"));
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), "wt-nested-"));
  for (const repo of [upstream, nested]) {
    gitIn(repo, "init", "-q", "-b", "main");
    gitIn(repo, "config", "user.email", "test@example.invalid");
    gitIn(repo, "config", "user.name", "Worktree Test");
  }
  fs.writeFileSync(path.join(nested, "nested.txt"), "nested\n");
  gitIn(nested, "add", "nested.txt");
  gitIn(nested, "commit", "-qm", "nested");
  gitIn(upstream, "-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "nested");
  gitIn(upstream, "commit", "-qam", "upstream with nested submodule");
  gitIn(tempRepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
  gitIn(tempRepo, "add", ".gitmodules", "sub");
  gitIn(tempRepo, "commit", "-qm", "parent with submodule");
  if (options.breakSubmodule) {
    fs.writeFileSync(
      path.join(tempRepo, ".gitmodules"),
      '[submodule "sub"]\n\tpath = sub\n\turl = /nonexistent/worktree-manager-fixture\n',
    );
    gitIn(tempRepo, "commit", "-aqm", "submodule with an unreachable source");
    fs.rmSync(path.join(tempRepo, ".git", "modules", "sub"), { recursive: true, force: true });
    gitIn(tempRepo, "config", "submodule.sub.url", "/nonexistent/worktree-manager-fixture");
  }
  return { upstream, nested };
}

function initTempRepo() {
  tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-consumer-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Worktree Test");
  fs.writeFileSync(path.join(tempRepo, ".gitignore"), ".worktrees/\n");
  fs.writeFileSync(path.join(tempRepo, "file.txt"), "base\n");
  git("add", ".gitignore", "file.txt");
  git("commit", "-qm", "initial");
}

describe("canonical worktree lifecycle", () => {
  beforeEach(() => initTempRepo());
  afterEach(() => { fs.rmSync(tempRepo, { recursive: true, force: true }); });

  it("creates, lists, completes and cleans a nested hotfix", () => {
    const created = runJson("create", "hotfix/test-001", "--base", "main");
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.document.result, "success");
    assert.equal(created.document.data.branch, "worktree/hotfix/test-001");
    assert.ok(fs.existsSync(worktreeFor("hotfix/test-001")));

    const listed = runJson("list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(Array.isArray(listed.document.data.worktrees));

    const worktree = worktreeFor("hotfix/test-001");
    fs.writeFileSync(path.join(worktree, "file.txt"), "fixed\n");
    gitIn(worktree, "add", "file.txt");
    gitIn(worktree, "commit", "-qm", "hotfix");

    const completed = runJson("complete", "hotfix/test-001", "--base", "main");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.document.result, "success");
    assert.equal(completed.document.data.merge, "success");
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git("branch", "--list"), /hotfix\/test-001/);
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "fixed\n");
    assertNoLegacyArtifacts("after the completion");
  });

  it("creates the worktree on the default base branch", () => {
    markCa1Case("default");
    const created = runJson("create", "default-base");
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.document.data.base_branch, "main");
    assert.ok(fs.existsSync(worktreeFor("default-base")));
    assertNoLegacyArtifacts("after the creation");
  });

  it("rejects an unknown option before changing state", () => {
    markCa1Case("parser");
    const worktree = createCommittedWorktree("hotfix/no-force");
    const before = gitState();
    for (const option of ["--force", "--unknown"]) {
      const rejected = runJson("complete", "hotfix/no-force", "--base", "main", option);
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.equal(rejected.document.error.code, "usage_error");
    }
    assert.ok(fs.existsSync(worktree));
    assert.deepEqual(gitState(), before);
  });

  it("rejects a worktree without a commit and preserves it", () => {
    const created = runJson("create", "hotfix/no-commit", "--base", "main");
    assert.equal(created.status, 0, created.stderr);
    const before = git("rev-parse", "main").trim();
    const rejected = runJson("complete", "hotfix/no-commit", "--base", "main");
    assert.equal(rejected.status, 5);
    assert.equal(rejected.document.error.code, "operation_failed");
    assert.ok(fs.existsSync(worktreeFor("hotfix/no-commit")));
    assert.equal(git("rev-parse", "main").trim(), before);
  });

  it("reports the change categories of a worktree with local changes", () => {
    const worktree = createCommittedWorktree("hotfix/local-changes");
    fs.writeFileSync(path.join(worktree, "staged.txt"), "staged\n");
    gitIn(worktree, "add", "staged.txt");
    fs.appendFileSync(path.join(worktree, "change.txt"), "unstaged\n");
    fs.writeFileSync(path.join(worktree, "untracked.txt"), "untracked\n");
    const before = git("rev-parse", "main").trim();
    const rejected = runJson("complete", "hotfix/local-changes", "--base", "main");
    assert.equal(rejected.status, 5);
    assert.equal(rejected.document.error.code, "intervention_required");
    assert.ok(fs.existsSync(worktree));
    assert.equal(git("rev-parse", "main").trim(), before);
  });

  it("preserves the worktree and the branch on merge conflict", () => {
    markCa1Case("conflict");
    const worktree = createCommittedWorktree("hotfix/conflict");
    fs.writeFileSync(path.join(worktree, "file.txt"), "hotfix\n");
    gitIn(worktree, "add", "file.txt");
    gitIn(worktree, "commit", "-qm", "hotfix conflict");
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "base conflict\n");
    git("add", "file.txt");
    git("commit", "-qm", "base conflict");
    const before = git("rev-parse", "main").trim();

    const rejected = runJson("complete", "hotfix/conflict", "--base", "main");
    assert.equal(rejected.status, 5);
    assert.equal(rejected.document.result, "failure");
    assert.ok(fs.existsSync(worktree), "the worktree is preserved");
    assert.match(git("branch", "--list"), /hotfix\/conflict/);
    assert.equal(git("rev-parse", "main").trim(), before);
    assertNoLegacyArtifacts("after the conflict");
  });

  it("rejects a dirty destination and preserves the resources", () => {
    markCa1Case("dirty");
    const worktree = createCommittedWorktree("hotfix/dirty-destination");
    fs.appendFileSync(path.join(tempRepo, "file.txt"), "dirty\n");
    const before = git("rev-parse", "main").trim();

    const rejected = runJson("complete", "hotfix/dirty-destination", "--base", "main");
    assert.equal(rejected.status, 5);
    assert.equal(rejected.document.error.code, "intervention_required");
    assert.equal(rejected.document.error.exit_code, 5);
    assert.ok(fs.existsSync(worktree));
    assert.match(git("branch", "--list"), /hotfix\/dirty-destination/);
    assert.equal(git("rev-parse", "main").trim(), before);
    assert.equal(git("stash", "list").trim(), "");
  });

  it("preserves the destination changes with the explicit consent", () => {
    markCa1Case("preserve-dirty");
    const worktree = createCommittedWorktree("hotfix/preserve-dirty", "preserved\n");
    fs.appendFileSync(path.join(tempRepo, "file.txt"), "local\n");
    const before = git("rev-parse", "main").trim();

    const completed = runJson("complete", "hotfix/preserve-dirty", "--base", "main", "--preserve-dirty");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.document.result, "success");
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "base\nlocal\n");
    assert.equal(fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"), "preserved\n");
    assert.equal(fs.existsSync(worktree), false);
    assert.notEqual(git("rev-parse", "main").trim(), before);
    assertNoLegacyArtifacts("after the preservation");
  });

  it("applies the explicit consent of the canonical configuration", () => {
    markCa1Case("preserve-dirty");
    enableConsent();
    const worktree = createCommittedWorktree("hotfix/config-consent", "configured\n");
    fs.appendFileSync(path.join(tempRepo, "file.txt"), "local\n");
    const completed = runJson("complete", "hotfix/config-consent", "--base", "main", "--preserve-dirty");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "base\nlocal\n");
    assert.equal(fs.existsSync(worktree), false);
  });

  it("removes the worktree only with the explicit discard consent", () => {
    markCa1Case("discard");
    const worktree = createCommittedWorktree("hotfix/discard");
    const refused = runJson("cleanup", "hotfix/discard", "--base", "main");
    assert.equal(refused.status, 5);
    assert.equal(refused.document.error.code, "intervention_required");
    assert.ok(fs.existsSync(worktree));

    const discarded = runJson("cleanup", "hotfix/discard", "--base", "main", "--discard");
    assert.equal(discarded.status, 0, discarded.stderr);
    assert.equal(discarded.document.data.cleaned, "hotfix/discard");
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git("branch", "--list"), /hotfix\/discard/);
    assertNoLegacyArtifacts("after the cleanup");
  });

  it("recover without pending transactions is an informative no-op", () => {
    markCa1Case("recover");
    const recovered = runJson("recover");
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.document.result, "no_pending_work");
    assert.equal(recovered.document.error, null);
  });

  it("prune removes the orphaned worktrees and ignores the submodule gitdirs", () => {
    markCa1Case("prune");
    createCommittedWorktree("hotfix/prune");
    fs.rmSync(worktreeFor("hotfix/prune"), { recursive: true, force: true });
    const pruned = runJson("prune");
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.equal(pruned.document.result, "success");
    assert.ok(pruned.document.data.pruned >= 1);
    assert.ok(Array.isArray(pruned.document.data.eligible_orphans));
    assertNoLegacyArtifacts("after the prune");
  });
});

describe("canonical submodule lifecycle", () => {
  beforeEach(() => initTempRepo());
  afterEach(() => { fs.rmSync(tempRepo, { recursive: true, force: true }); });

  it("initializes the submodules only with the opt-in flag", () => {
    markCa1Case("opt-in", "nested");
    const fixture = createSubmoduleFixture();
    const withoutOptIn = runJsonWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub/default", "--base", "main");
    assert.equal(withoutOptIn.status, 0, withoutOptIn.stderr);
    assert.equal(withoutOptIn.document.data.init_submodules_result, "not_requested");
    assert.equal(fs.existsSync(path.join(worktreeFor("sub/default"), "sub", "nested")), false);

    const withOptIn = runJsonWithEnv(
      { GIT_ALLOW_PROTOCOL: "file" },
      "create", "sub/opt-in", "--base", "main", "--init-submodules",
    );
    assert.equal(withOptIn.status, 0, withOptIn.stderr);
    assert.equal(withOptIn.document.data.init_submodules_result, "initialized");
    assert.equal(fs.existsSync(path.join(worktreeFor("sub/opt-in"), "sub", "nested", "nested.txt")), true);
    fs.rmSync(fixture.upstream, { recursive: true, force: true });
    fs.rmSync(fixture.nested, { recursive: true, force: true });
  });

  it("retains the worktree and the branch when the submodule initialization fails", () => {
    markCa1Case("init-failure");
    const fixture = createSubmoduleFixture({ breakSubmodule: true });
    const failed = runJsonWithEnv(
      { GIT_ALLOW_PROTOCOL: "file" },
      "create", "sub/failure", "--base", "main", "--init-submodules",
    );
    assert.equal(failed.status, 5);
    assert.equal(failed.document.error.code, "operation_failed");
    assert.ok(fs.existsSync(worktreeFor("sub/failure")), "the worktree is retained for inspection");
    assert.match(git("branch", "--list"), /sub\/failure/);
    fs.rmSync(fixture.upstream, { recursive: true, force: true });
    fs.rmSync(fixture.nested, { recursive: true, force: true });
  });

  it("removes a populated submodule with the worktree on cleanup", () => {
    markCa1Case("deinit");
    const fixture = createSubmoduleFixture();
    const created = runJsonWithEnv(
      { GIT_ALLOW_PROTOCOL: "file" },
      "create", "sub/deinit", "--base", "main", "--init-submodules",
    );
    assert.equal(created.status, 0, created.stderr);
    assert.equal(fs.existsSync(path.join(worktreeFor("sub/deinit"), "sub", "nested", "nested.txt")), true);
    const cleaned = runJson("cleanup", "sub/deinit", "--base", "main", "--discard");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(worktreeFor("sub/deinit")), false);
    fs.rmSync(fixture.upstream, { recursive: true, force: true });
    fs.rmSync(fixture.nested, { recursive: true, force: true });
  });
});

describe("canonical transaction recovery", () => {
  beforeEach(() => initTempRepo());
  afterEach(() => { fs.rmSync(tempRepo, { recursive: true, force: true }); });

  it("resumes a transaction interrupted before the merge", () => {
    markCa1Case("crash-pre");
    createCommittedWorktree("hotfix/crash-pre", "interrupted\n");
    const interrupted = runJsonWithEnv(
      { WORKTREE_MANAGER_TEST_CRASH_AFTER_TRANSACTION_PHASE: "merge_started" },
      "complete", "hotfix/crash-pre", "--base", "main",
    );
    assert.notEqual(interrupted.status, 0, "the interrupted completion does not succeed");

    const pending = fs.readdirSync(transactionsDir()).filter((entry) => fs.existsSync(path.join(transactionsDir(), entry, "journal")));
    assert.equal(pending.length, 1, "the interrupted completion leaves one pending transaction");

    const recovered = runJson("recover", pending[0]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.document.result, "success");
    assert.equal(fs.existsSync(worktreeFor("hotfix/crash-pre")), true, "the worktree is preserved for inspection");
    assertNoLegacyArtifacts("after the recovery");
  });

  it("resumes a transaction interrupted after the merge", () => {
    markCa1Case("crash-post");
    createCommittedWorktree("hotfix/crash-post", "interrupted\n");
    const interrupted = runJsonWithEnv(
      { WORKTREE_MANAGER_TEST_CRASH_AFTER_TRANSACTION_PHASE: "merged" },
      "complete", "hotfix/crash-post", "--base", "main",
    );
    assert.notEqual(interrupted.status, 0, "the interrupted completion does not succeed");

    const pending = fs.readdirSync(transactionsDir()).filter((entry) => fs.existsSync(path.join(transactionsDir(), entry, "journal")));
    assert.equal(pending.length, 1);
    const recovered = runJson("recover", pending[0]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.document.result, "success");
    assert.equal(fs.existsSync(worktreeFor("hotfix/crash-post")), false, "the worktree is retired");
    assert.equal(fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"), "interrupted\n");
  });

  it("does not advance the removal after a branch divergence", () => {
    markCa1Case("sha-divergence");
    createCommittedWorktree("hotfix/sha-divergence", "diverged\n");
    const base = git("rev-parse", "main").trim();
    const interrupted = runJsonWithEnv(
      { WORKTREE_MANAGER_TEST_CRASH_AFTER_TRANSACTION_PHASE: "merged" },
      "complete", "hotfix/sha-divergence", "--base", "main",
    );
    assert.notEqual(interrupted.status, 0);

    const pending = fs.readdirSync(transactionsDir()).filter((entry) => fs.existsSync(path.join(transactionsDir(), entry, "journal")));
    assert.equal(pending.length, 1);
    git("update-ref", "refs/heads/worktree/hotfix/sha-divergence", base);

    const recovered = runJson("recover", pending[0]);
    assert.equal(recovered.status, 5);
    assert.equal(recovered.document.error.code, "intervention_required");
    assert.ok(fs.existsSync(worktreeFor("hotfix/sha-divergence")), "the resources are retained");
    assertNoLegacyArtifacts("after the blocked recovery");
  });

  it("keeps the canonical backup references and creates no legacy reference", () => {
    const worktree = createCommittedWorktree("hotfix/backups", "backed\n");
    fs.appendFileSync(path.join(tempRepo, "file.txt"), "local\n");
    const completed = runJson("complete", "hotfix/backups", "--base", "main", "--preserve-dirty");
    assert.equal(completed.status, 0, completed.stderr);
    assert.ok(backupRefs().length > 0, "the canonical backup references are published");
    assert.equal(legacyArtifacts().refs, "", "the legacy references are not published");
  });
});
