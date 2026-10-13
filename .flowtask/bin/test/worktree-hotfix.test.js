import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
let tempRepo;
const temporarySubmoduleRepos = [];
const CA1_REQUIRED_CASES = [
  "parser", "default", "opt-in", "nested", "init-failure", "deinit", "dirty", "conflict",
  "sha-divergence", "crash-pre", "crash-post", "discard", "preserve-dirty", "recover", "prune",
];
const ca1ObservedCases = new Set();

function markCa1Case(...cases) {
  for (const name of cases) ca1ObservedCases.add(name);
}

after(() => {
  assert.deepEqual([...ca1ObservedCases].sort(), [...CA1_REQUIRED_CASES].sort(), "CA1_REQUIRED_CASES sentinel: falta una regresión obligatoria");
});

function run(...args) {
  return execFileSync(SCRIPT, args, { cwd: tempRepo, encoding: "utf8", stdio: "pipe" });
}

function git(...args) {
  return execFileSync("git", args, { cwd: tempRepo, encoding: "utf8", stdio: "pipe" });
}

function runResult(...args) {
  const result = spawnSync(SCRIPT, args, { cwd: tempRepo, encoding: "utf8" });
  return { ...result, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function worktreeFor(name) {
  return path.join(tempRepo, ".worktrees", ...name.split("/"));
}

function createCommittedWorktree(name) {
  run("create", name, "--base", "main");
  const worktree = worktreeFor(name);
  fs.writeFileSync(path.join(worktree, "change.txt"), `${name}\n`);
  git("-C", worktree, "add", "change.txt");
  git("-C", worktree, "commit", "-qm", "worktree change");
  return worktree;
}

function createNestedSubmoduleFixture() {
  const nested = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-nested-submodule-"));
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-upstream-submodule-"));
  for (const repo of [nested, upstream]) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "FlowTask Test"], { cwd: repo });
  }
  fs.writeFileSync(path.join(nested, "nested.txt"), "nested\n");
  execFileSync("git", ["add", "nested.txt"], { cwd: nested });
  execFileSync("git", ["commit", "-qm", "nested"], { cwd: nested });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", nested, "nested"], { cwd: upstream });
  execFileSync("git", ["commit", "-qam", "upstream with nested"], { cwd: upstream });
  execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub"], { cwd: tempRepo });
  execFileSync("git", ["add", ".gitmodules", "sub"], { cwd: tempRepo });
  execFileSync("git", ["commit", "-qm", "parent with nested submodule"], { cwd: tempRepo });
  temporarySubmoduleRepos.push(nested, upstream);
  return { nested, upstream };
}

function closeMetaFor(name) {
  const common = path.resolve(tempRepo, git("rev-parse", "--git-common-dir").trim());
  return path.join(common, "worktree-manager", "close", Buffer.from(name).toString("hex"), "meta");
}

function closeJournalFor(name) {
  return path.join(path.dirname(closeMetaFor(name)), "journal");
}

function counterValues(counterPath) {
  if (!fs.existsSync(counterPath)) return [];
  return fs.readFileSync(counterPath, "utf8").trim().split(/\n/).filter(Boolean);
}

function testCounterPath(label) {
  return path.join(os.tmpdir(), `flowtask-counter-${process.pid}-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function runWithFailingSubmoduleStatus(...args) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-git-shim-"));
  const shim = path.join(shimDir, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    shim,
    "#!/bin/sh\n" +
      "case \" $* \" in\n" +
      "  *\" submodule status --recursive \"*) echo submodule-status-failure >&2; exit 77 ;;\n" +
      "esac\n" +
      "exec \"$REAL_GIT\" \"$@\"\n",
    { mode: 0o755 },
  );
  try {
    return runResultWithEnv({
      REAL_GIT: realGit,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    }, ...args);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

function cleanupTemporarySubmoduleRepos() {
  for (const repo of temporarySubmoduleRepos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
}

// Mensaje de rechazo destino-dirty: plantilla fija, única variable permitida es
// el ca_name (parámetro de invocación, nunca dato del repositorio).
function expectedRejection(caName) {
  return (
    `No se puede completar '${caName}': el destino tiene cambios sin commitear.\n` +
    "Inspeccionalo vos mismo con 'git status' antes de reintentar.\n" +
    "El cierre fue cancelado; no se modificó nada.\n"
  );
}

function initTempRepo() {
  tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-worktree-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "FlowTask Test");
  // Espejo del .gitignore real: stamp ignorado (premisa AC2.8) y backups runtime.
  fs.writeFileSync(
    path.join(tempRepo, ".gitignore"),
    ".worktrees/\n.flowtask/config/.review-stamp\n.flowtask/backups/\n"
  );
  fs.writeFileSync(path.join(tempRepo, "file.txt"), "base\n");
  git("add", ".gitignore", "file.txt");
  git("commit", "-qm", "initial");
}

// Crea suciedad en el destino con el nombre hostil indicado, en la categoría pedida.
function createHostileDestination(category, relPath) {
  const abs = path.join(tempRepo, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "hostile\n");
  if (category === "untracked") return;
  git("add", abs);
  if (category === "unstaged") {
    git("commit", "-qm", "track hostile");
    fs.appendFileSync(abs, "modified\n");
  }
}

// Corre un rechazo contra una suciedad de control (nombre normal) y devuelve su
// stderr completo, para comparación byte-idéntica entre casos.
function captureControlRejection(caName) {
  const control = path.join(tempRepo, "control-dirty.txt");
  fs.writeFileSync(control, "control\n");
  const result = runResult("complete", caName, "--base", "main");
  fs.rmSync(control, { force: true });
  assert.equal(result.status, 1);
  return result.stderr;
}

describe("nested hotfix worktrees", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    cleanupTemporarySubmoduleRepos();
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("creates, lists, completes, and cleans a nested hotfix", () => {
    run("create", "hotfix/test-001", "--base", "main");
    assert.ok(fs.existsSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001")));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/test-001/);
    fs.writeFileSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001", "file.txt"), "fixed\n");
    git("-C", path.join(tempRepo, ".worktrees", "hotfix", "test-001"), "add", "file.txt");
    git("-C", path.join(tempRepo, ".worktrees", "hotfix", "test-001"), "commit", "-qm", "hotfix");
    assert.match(run("list"), /worktree\/hotfix\/test-001/);
    run("complete", "hotfix/test-001", "--base", "main");
    assert.equal(fs.existsSync(path.join(tempRepo, ".worktrees", "hotfix", "test-001")), false);
    assert.doesNotMatch(git("branch", "--list"), /worktree\/hotfix\/test-001/);
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "fixed\n");
  });

  it("preserves the hotfix worktree and branch on merge conflict", () => {
    markCa1Case("conflict");
    run("create", "hotfix/test-002", "--base", "main");
    const hotfix = path.join(tempRepo, ".worktrees", "hotfix", "test-002");
    fs.writeFileSync(path.join(hotfix, "file.txt"), "hotfix\n");
    git("-C", hotfix, "add", "file.txt");
    git("-C", hotfix, "commit", "-qm", "hotfix conflict");
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "base conflict\n");
    git("add", "file.txt");
    git("commit", "-qm", "base conflict");
    assert.throws(() => run("complete", "hotfix/test-002", "--base", "main"));
    assert.ok(fs.existsSync(hotfix));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/test-002/);
  });

  it("keeps CA identifiers compatible", () => {
    run("create", "CA-legacy", "--base", "main");
    assert.ok(fs.existsSync(path.join(tempRepo, ".worktrees", "CA-legacy")));
    run("cleanup", "CA-legacy", "--base", "main");
    assert.equal(fs.existsSync(path.join(tempRepo, ".worktrees", "CA-legacy")), false);
  });

  for (const name of ["CA-no-commit", "hotfix/no-commit"]) {
    it(`rejects ${name} without a commit and preserves it`, () => {
      run("create", name, "--base", "main");
      const worktree = worktreeFor(name);
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /falta.*commit/i);
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-local-changes", "hotfix/local-changes"]) {
    it(`reports all local change categories for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(worktree, "staged.txt"), "staged\n");
      git("-C", worktree, "add", "staged.txt");
      fs.appendFileSync(path.join(worktree, "change.txt"), "unstaged\n");
      fs.writeFileSync(path.join(worktree, "untracked.txt"), "untracked\n");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /worktree/i);
      assert.match(result.stderr, /staged/i);
      assert.match(result.stderr, /unstaged/i);
      assert.match(result.stderr, /untracked/i);
      assert.match(result.stderr, /crear.*commit/i);
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-stash", "hotfix/stash"]) {
    it(`rejects pending stash for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(worktree, "pending.txt"), "pending\n");
      git("-C", worktree, "stash", "push", "-u", "-m", "pending");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.match(result.stderr, /stash pendiente/i);
      assert.match(result.stderr, /resolver|restaurar/i);
      assert.ok(fs.existsSync(worktree));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  for (const name of ["CA-dirty-destination", "hotfix/dirty-destination"]) {
    it(`rejects dirty destination for ${name}`, () => {
      const worktree = createCommittedWorktree(name);
      fs.writeFileSync(path.join(tempRepo, "destination-staged.txt"), "staged\n");
      git("add", "destination-staged.txt");
      fs.appendFileSync(path.join(tempRepo, "file.txt"), "unstaged\n");
      fs.writeFileSync(path.join(tempRepo, "destination-untracked.txt"), "untracked\n");
      const before = git("rev-parse", "main");
      const result = runResult("complete", name, "--base", "main");

      assert.equal(result.status, 1);
      assert.equal(result.stderr, expectedRejection(name));
      assert.ok(fs.existsSync(worktree));
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name.replace("/", "\\/")}`));
      assert.equal(git("rev-parse", "main"), before);
      assert.equal(git("stash", "list").trim(), "");
    });
  }

  it("rejects complete bypass options before changing state", () => {
    markCa1Case("parser");
    const worktree = createCommittedWorktree("hotfix/no-force");
    const before = git("rev-parse", "main");
    for (const option of ["--force", "--unknown"]) {
      const result = runResult("complete", "hotfix/no-force", "--base", "main", option);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /opción|argumento|desconocido/i);
    }
    assert.ok(fs.existsSync(worktree));
    assert.match(git("branch", "--list"), /worktree\/hotfix\/no-force/);
    assert.equal(git("rev-parse", "main"), before);
  });
});

describe("complete submodule lifecycle (Git 2.54.0)", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    cleanupTemporarySubmoduleRepos();
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("keeps submodules unpopulated by default and closes a clean parent", () => {
    markCa1Case("default", "deinit");
    const fixture = createNestedSubmoduleFixture();
    run("create", "sub-default", "--base", "main");
    const worktree = worktreeFor("sub-default");
    assert.match(git("-C", worktree, "submodule", "status", "--recursive"), /^-/m);
    assert.match(fs.readFileSync(closeMetaFor("sub-default"), "utf8"), /^init_requested=false$/m);
    assert.match(fs.readFileSync(closeMetaFor("sub-default"), "utf8"), /^init_result=not_requested$/m);
    fs.writeFileSync(path.join(worktree, "file.txt"), "submodule default\n");
    git("-C", worktree, "add", "file.txt");
    git("-C", worktree, "commit", "-qm", "default close");
    run("complete", "sub-default", "--base", "main");
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git("branch", "--list"), /worktree\/sub-default/);
    run("create", "sub-complete-init", "--base", "main");
    const initializedOnComplete = worktreeFor("sub-complete-init");
    fs.writeFileSync(path.join(initializedOnComplete, "file.txt"), "complete init\n");
    git("-C", initializedOnComplete, "add", "file.txt");
    git("-C", initializedOnComplete, "commit", "-qm", "complete init");
    const initialized = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "complete", "sub-complete-init", "--base", "main", "--init-submodules");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(fs.readFileSync(closeMetaFor("sub-complete-init"), "utf8"), /^init_result=initialized$/m);
    assert.equal(fixture.nested.length > 0, true);
  });

  it("initializes root and nested submodules only with the opt-in flag", () => {
    markCa1Case("opt-in", "nested");
    const fixture = createNestedSubmoduleFixture();
    const created = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-opt-in", "--base", "main", "--init-submodules");
    assert.equal(created.status, 0, created.stderr);
    const worktree = worktreeFor("sub-opt-in");
    const status = git("-C", worktree, "submodule", "status", "--recursive");
    assert.doesNotMatch(status, /^-/m);
    assert.match(status, /sub\/nested/);
    assert.match(fs.readFileSync(closeMetaFor("sub-opt-in"), "utf8"), /^init_requested=true$/m);
    assert.match(fs.readFileSync(closeMetaFor("sub-opt-in"), "utf8"), /^init_result=initialized$/m);
    fs.writeFileSync(path.join(worktree, "file.txt"), "submodule opt-in\n");
    git("-C", worktree, "add", "file.txt");
    git("-C", worktree, "commit", "-qm", "opt-in close");
    const completed = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "complete", "sub-opt-in", "--base", "main");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fixture.upstream.length > 0, true);
  });

  it("retains the worktree and pending init journal when initialization fails", () => {
    markCa1Case("init-failure");
    const fixture = createNestedSubmoduleFixture();
    fs.rmSync(fixture.upstream, { recursive: true, force: true });
    const failed = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-init-failure", "--base", "main", "--init-submodules");
    assert.equal(failed.status, 1);
    const worktree = worktreeFor("sub-init-failure");
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git("branch", "--list"), /worktree\/sub-init-failure/);
    assert.match(fs.readFileSync(closeMetaFor("sub-init-failure"), "utf8"), /^phase=init_started$/m);
    assert.match(fs.readFileSync(closeMetaFor("sub-init-failure"), "utf8"), /^init_result=pending$/m);
  });

  it("ignores the complete-only close crash hook during create init", () => {
    markCa1Case("crash-pre");
    const fixture = createNestedSubmoduleFixture();
    const name = "sub-create-close-hook";
    const created = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CLOSE_CRASH_AFTER: "init_started", GIT_ALLOW_PROTOCOL: "file" },
      "create", name, "--base", "main", "--init-submodules",
    );

    assert.equal(created.status, 0, created.stderr);
    const worktree = worktreeFor(name);
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git("branch", "--list"), new RegExp(`worktree/${name}`));
    const status = git("-C", worktree, "submodule", "status", "--recursive");
    assert.doesNotMatch(status, /^-/m);
    assert.match(status, /sub\/nested/);
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^phase=initialized$/m);
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^init_result=initialized$/m);
    assert.equal(fs.readFileSync(closeJournalFor(name), "utf8"), "initialized\n");
    assert.equal(fixture.nested.length > 0, true);
  });

  it("retains the normal non-force cleanup error for a populated submodule", () => {
    createNestedSubmoduleFixture();
    const created = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-cleanup-normal", "--base", "main", "--init-submodules");
    assert.equal(created.status, 0, created.stderr);
    const worktree = worktreeFor("sub-cleanup-normal");
    const rejected = runResult("cleanup", "sub-cleanup-normal", "--base", "main");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /submodule|force|retirar|remove/i);
    assert.equal(fs.existsSync(worktree), true);
    assert.match(git("branch", "--list"), /worktree\/sub-cleanup-normal/);
  });

  it("rejects populated dirty submodules and gitlink divergence before retirement", () => {
    markCa1Case("dirty", "sha-divergence");
    const fixture = createNestedSubmoduleFixture();
    runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-dirty", "--base", "main", "--init-submodules");
    const dirtyWorktree = worktreeFor("sub-dirty");
    fs.appendFileSync(path.join(dirtyWorktree, "sub", "nested", "nested.txt"), "dirty\n");
    const dirty = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "complete", "sub-dirty", "--base", "main");
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /Submodule|cambios|diverge/i);
    assert.equal(fs.existsSync(dirtyWorktree), true);
    assert.match(git("branch", "--list"), /worktree\/sub-dirty/);

    runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-diverge", "--base", "main", "--init-submodules");
    const divergedWorktree = worktreeFor("sub-diverge");
    fs.appendFileSync(path.join(divergedWorktree, "file.txt"), "diverged parent\n");
    git("-C", divergedWorktree, "add", "file.txt");
    git("-C", divergedWorktree, "commit", "-qm", "diverge close");
    fs.appendFileSync(path.join(divergedWorktree, "sub", "nested", "nested.txt"), "divergent gitlink\n");
    git("-C", divergedWorktree + "/sub/nested", "add", "nested.txt");
    git("-C", divergedWorktree + "/sub/nested", "-c", "user.email=test@example.invalid", "-c", "user.name=FlowTask Test", "commit", "-qm", "divergent nested commit");
    const divergence = runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "complete", "sub-diverge", "--base", "main");
    assert.equal(divergence.status, 1);
    assert.equal(fs.existsSync(divergedWorktree), true);
    assert.match(divergence.stderr, /worktree|HEAD|rama|diverge|cambios/i);
    assert.match(git("branch", "--list"), /worktree\/sub-diverge/);
    assert.equal(fixture.nested.length > 0, true);
  });

  it("keeps public discard independent from the close journal", () => {
    markCa1Case("discard");
    createNestedSubmoduleFixture();
    runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-discard", "--base", "main", "--init-submodules");
    const worktree = worktreeFor("sub-discard");
    const metaPath = closeMetaFor("sub-discard");
    const before = fs.readFileSync(metaPath, "utf8");
    const discarded = runResult("cleanup", "sub-discard", "--base", "main", "--discard");
    assert.equal(discarded.status, 0, discarded.stderr);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(fs.readFileSync(metaPath, "utf8"), before);
  });

  it("does not report nested submodule gitdirs as prune orphans", () => {
    markCa1Case("prune");
    createNestedSubmoduleFixture();
    runResultWithEnv({ GIT_ALLOW_PROTOCOL: "file" }, "create", "sub-prune", "--base", "main", "--init-submodules");
    const orphan = path.join(tempRepo, ".worktrees", "independent-orphan");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, ".git"), "gitdir: /not-registered\n");
    const pruned = runResult("prune");
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.match(pruned.stdout, /independent-orphan/);
    assert.doesNotMatch(pruned.stdout, /sub\/nested/);
  });
});

describe("complete close journal crash phases", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  for (const phase of [
    ["merge_started", "merge_started"],
    ["merged_after", "merge_started"],
    ["deinit_started", "deinit_started"],
    ["deinitialized_after", "deinit_started"],
    ["remove_started", "remove_started"],
    ["removed_after", "remove_started"],
    ["branch_cleanup_started", "branch_cleanup_started"],
    ["branch_cleanup_after", "branch_cleanup_started"],
  ]) {
    it(`resumes idempotently after ${phase[0]}`, () => {
      markCa1Case(phase[0].includes("after") ? "crash-post" : "crash-pre");
      const name = `crash-${phase[0]}`;
      const worktree = createCommittedWorktree(name);
      const before = git("rev-parse", "main").trim();
      const crashed = runResultWithEnv(
        { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CLOSE_CRASH_AFTER: phase[0] },
        "complete", name, "--base", "main",
      );
      assert.equal(crashed.status, 99, crashed.stderr);
      assert.equal(fs.readFileSync(closeMetaFor(name), "utf8").match(/^phase=(.*)$/m)?.[1], phase[1]);
      const resumed = runResult("complete", name, "--base", "main");
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(git("rev-list", "--count", `${before}..main`).trim(), "1");
      assert.equal(fs.existsSync(worktree), false);
      assert.doesNotMatch(git("branch", "--list"), new RegExp(`worktree/${name}`));
      const repeated = runResult("complete", name, "--base", "main");
      assert.equal(repeated.status, 0, repeated.stderr);
    });
  }

  it("does not advance removal after a branch SHA divergence", () => {
    markCa1Case("sha-divergence");
    const name = "crash-sha-divergence";
    const worktree = createCommittedWorktree(name);
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CLOSE_CRASH_AFTER: "removed_after" },
      "complete", name, "--base", "main",
    );
    assert.equal(crashed.status, 99, crashed.stderr);
    assert.equal(fs.existsSync(worktree), false);
    const branch = `refs/heads/worktree/${name}`;
    git("update-ref", branch, git("rev-parse", "main").trim());
    const retry = runResult("complete", name, "--base", "main");
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /rama cambió|SHA/i);
    assert.equal(git("rev-parse", branch).trim(), git("rev-parse", "main").trim());
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^phase=remove_started$/m);
  });

  it("does not squash when merge_started is retried after the path was removed", () => {
    markCa1Case("crash-pre");
    const name = "crash-merge-path-removed";
    const worktree = createCommittedWorktree(name);
    const before = git("rev-parse", "main").trim();
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CLOSE_CRASH_AFTER: "merge_started" },
      "complete", name, "--base", "main",
    );
    assert.equal(crashed.status, 99, crashed.stderr);
    fs.rmSync(worktree, { recursive: true, force: true });

    const counter = testCounterPath("merge-path-removed");
    const retry = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_COUNTER_FILE: counter },
      "complete", name, "--base", "main",
    );
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /merge_started|worktree|base|modifica/i);
    assert.equal(git("rev-parse", "main").trim(), before);
    assert.match(git("branch", "--list"), /worktree\/crash-merge-path-removed/);
    assert.equal(counterValues(counter).includes("squash"), false);
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^phase=merge_started$/m);
  });

  it("rejects close journal/meta phase mismatch and corruption without mutating the base", () => {
    for (const [label, mutate] of [
      ["mismatch", (name) => fs.writeFileSync(closeJournalFor(name), "merged\n")],
      ["journal-corrupt", (name) => fs.writeFileSync(closeJournalFor(name), "not-a-phase\n")],
      ["meta-corrupt", (name) => {
        const meta = fs.readFileSync(closeMetaFor(name), "utf8");
        fs.writeFileSync(closeMetaFor(name), meta.replace(/^phase=.*$/m, "phase=not-a-phase"));
      }],
      ["merged-without-squash", (name) => {
        const meta = fs.readFileSync(closeMetaFor(name), "utf8");
        fs.writeFileSync(closeMetaFor(name), meta.replace(/^phase=.*$/m, "phase=merged"));
        fs.writeFileSync(closeJournalFor(name), "merged\n");
      }],
      ["impossible-init", (name) => {
        const meta = fs.readFileSync(closeMetaFor(name), "utf8");
        fs.writeFileSync(closeMetaFor(name), meta.replace(/^init_requested=.*$/m, "init_requested=false").replace(/^init_result=.*$/m, "init_result=initialized"));
      }],
    ]) {
      const name = `journal-${label}`;
      const worktree = createCommittedWorktree(name);
      const before = git("rev-parse", "main").trim();
      const crashed = runResultWithEnv(
        { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CLOSE_CRASH_AFTER: "merge_started" },
        "complete", name, "--base", "main",
      );
      assert.equal(crashed.status, 99, crashed.stderr);
      mutate(name);
      const retry = runResult("complete", name, "--base", "main");
      assert.equal(retry.status, 1);
      assert.match(retry.stderr, /journal|corrupt|fase|phase/i);
      assert.equal(git("rev-parse", "main").trim(), before);
      assert.equal(fs.existsSync(worktree), true);
      assert.match(git("branch", "--list"), new RegExp(`worktree/${name}`));
    }
  });

  it("does not repeat squash, deinit, remove, or normal identity validation across post-action retries", () => {
    for (const crashPhase of ["merged_after", "deinitialized_after", "removed_after", "branch_cleanup_after"]) {
      const name = `counter-${crashPhase}`;
      const worktree = createCommittedWorktree(name);
      const counter = testCounterPath(name);
      const crashed = runResultWithEnv(
        {
          FLOWTASK_TEST_MODE: "1",
          FLOWTASK_TEST_CLOSE_CRASH_AFTER: crashPhase,
          FLOWTASK_TEST_COUNTER_FILE: counter,
        },
        "complete", name, "--base", "main",
      );
      assert.equal(crashed.status, 99, crashed.stderr);
      const retried = runResultWithEnv(
        { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_COUNTER_FILE: counter },
        "complete", name, "--base", "main",
      );
      assert.equal(retried.status, 0, retried.stderr);
      const values = counterValues(counter);
      assert.equal(values.filter((value) => value === "squash").length, 1, crashPhase);
      assert.equal(values.filter((value) => value === "deinit").length, 1, crashPhase);
      assert.equal(values.filter((value) => value === "remove").length, 1, crashPhase);
      assert.equal(values.filter((value) => value === "branch_cleanup").length, 1, crashPhase);
      assert.equal(values.filter((value) => value === "validate_identity").length, 1, crashPhase);
      assert.equal(fs.existsSync(worktree), false);
    }
  });

  it("crash before init action in complete leaves init_started and retries from verified metadata", () => {
    markCa1Case("crash-pre");
    createNestedSubmoduleFixture();
    const name = "crash-init-started";
    const counter = testCounterPath("crash-init-started");
    run("create", name, "--base", "main");
    const worktree = worktreeFor(name);
    fs.writeFileSync(path.join(worktree, "file.txt"), "init retry\n");
    git("-C", worktree, "add", "file.txt");
    git("-C", worktree, "commit", "-qm", "init retry");
    const crashed = runResultWithEnv(
      {
        FLOWTASK_TEST_MODE: "1",
        FLOWTASK_TEST_CLOSE_CRASH_AFTER: "init_started",
        FLOWTASK_TEST_COUNTER_FILE: counter,
        GIT_ALLOW_PROTOCOL: "file",
      },
      "complete", name, "--base", "main", "--init-submodules",
    );
    assert.equal(crashed.status, 99, crashed.stderr);
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^phase=init_started$/m);
    assert.match(fs.readFileSync(closeMetaFor(name), "utf8"), /^init_result=pending$/m);
    assert.equal(counterValues(counter).includes("init"), false);
    const retried = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_COUNTER_FILE: counter, GIT_ALLOW_PROTOCOL: "file" },
      "complete", name, "--base", "main", "--init-submodules",
    );
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(counterValues(counter).filter((value) => value === "init").length, 1);
    assert.equal(fs.existsSync(worktree), false);
  });

  it("blocks the preflight when submodule status cannot be queried", () => {
    const worktree = createCommittedWorktree("submodule-status-failure");
    fs.writeFileSync(path.join(tempRepo, "preflight-dirty.txt"), "dirty\n");
    const before = git("rev-parse", "main").trim();
    const failed = runWithFailingSubmoduleStatus(
      "complete", "submodule-status-failure", "--base", "main", "--preserve-dirty",
    );
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /no se pudo verificar.*submodules/i);
    assert.equal(git("rev-parse", "main").trim(), before);
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(fs.existsSync(path.join(tempRepo, ".flowtask", "backups")), false);
  });
});

// Fixtures hostiles rescatados de #4275/#4262: el mensaje de rechazo debe ser
// invariante ante cualquier nombre legal en git, sin filtrar nunca el nombre.
const HOSTILE_FIXTURES = [
  { label: "espacios", relPath: "archivo con espacios.txt", tokens: ["archivo con espacios.txt", "espacios"] },
  { label: "ene", relPath: "archivo ñandú.txt", tokens: ["ñandú"] },
  { label: "comillas", relPath: `comi'lla"doble.txt`, tokens: [`comi'lla"doble`] },
  { label: "command-subst", relPath: "$(id).txt", tokens: ["$(id)"] },
  { label: "dash-file", relPath: "-dato.txt", tokens: ["-dato"] },
  { label: "dash-exact", relPath: "-", tokens: [] },
  { label: "dash-dir", relPath: "-dir/archivo.txt", tokens: ["-dir/"] },
  { label: "dash-dir-espacios", relPath: "-dir con espacios/archivo.txt", tokens: ["-dir con espacios"] },
  { label: "newline", relPath: "con\nsalto.txt", tokens: ["con\nsalto.txt", "salto"] },
  { label: "tab", relPath: "con\tsalto.txt", tokens: ["con\tsalto.txt", "salto"] },
];

describe("adversarial dirty destination rejection", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  const CA = "CA-adversarial";

  for (const fixture of HOSTILE_FIXTURES) {
    for (const category of ["staged", "unstaged", "untracked"]) {
      it(`rejects ${category} destination named ${fixture.label}`, () => {
        createCommittedWorktree(CA);
        // Control byte-idéntico: mismo ca_name, suciedad de nombre normal.
        const control = captureControlRejection(CA);
        createHostileDestination(category, fixture.relPath);
        const before = git("rev-parse", "main");
        const result = runResult("complete", CA, "--base", "main");

        assert.equal(result.status, 1);
        assert.equal(result.stderr, control);
        assert.ok(fs.existsSync(worktreeFor(CA)));
        assert.match(git("branch", "--list"), /worktree\/CA-adversarial/);
        assert.equal(git("rev-parse", "main"), before);
        assert.equal(git("stash", "list").trim(), "");
        for (const token of fixture.tokens) {
          assert.ok(!result.stdout.includes(token), `stdout filtra ${JSON.stringify(token)}`);
          assert.ok(!result.stderr.includes(token), `stderr filtra ${JSON.stringify(token)}`);
        }
      });
    }
  }
});

// ─── Suite transaccional (--preserve-dirty) ─────────────────────────────────

// Registro de salidas para el barrido anti-exfiltración transversal: en NINGÚN
// camino (rechazo, happy, recover, pending_manual) puede aparecer un token
// hostil de fixture ni convertirse en comando ejecutable.
const CAPTURED_OUTPUTS = [];
function record(result) {
  CAPTURED_OUTPUTS.push({ stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  return result;
}
const EXFIL_TOKENS = [
  "archivo con espacios.txt",
  "ñandú",
  `comi'lla"doble`,
  "$(id)",
  "-dato",
  "-dir/",
  "-dir con espacios",
  "con\nsalto.txt",
  "con\tsalto.txt",
];

function runResultWithEnv(extraEnv, ...args) {
  const result = spawnSync(SCRIPT, args, {
    cwd: tempRepo,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return record({ ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

function enableConsent() {
  fs.mkdirSync(path.join(tempRepo, ".flowtask", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRepo, ".flowtask", "config", "worktree.json"),
    JSON.stringify({ preserveDirty: true })
  );
}

// Suciedad mixta estándar: staged nuevo + unstaged sobre tracked + untracked.
function createMixedDirtyDestination(prefix) {
  fs.writeFileSync(path.join(tempRepo, `${prefix}-staged.txt`), "staged\n");
  git("add", `${prefix}-staged.txt`);
  fs.appendFileSync(path.join(tempRepo, "file.txt"), "cambio sin preparar\n");
  fs.writeFileSync(path.join(tempRepo, `${prefix}-untracked.txt`), "untracked\n");
}

function backupsDir() {
  return path.join(tempRepo, ".flowtask", "backups");
}

function backupRefs() {
  return git("for-each-ref", "refs/flowtask/backups", "--format=%(refname)").trim();
}

describe("transactional preservation", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    // Barrido anti-exfiltración transversal sobre TODAS las salidas capturadas.
    for (const out of CAPTURED_OUTPUTS) {
      for (const token of EXFIL_TOKENS) {
        assert.ok(
          !out.stdout.includes(token) && !out.stderr.includes(token),
          `fuga de datos del repo en la salida: ${JSON.stringify(token)}`
        );
      }
    }
    CAPTURED_OUTPUTS.length = 0;
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it("recover without pending transactions is an informative no-op", () => {
    markCa1Case("recover");
    const result = runResult("recover");
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /no hay transacciones/i);
  });

  // AC2.1 — consent gating
  it("rejects dirty destination without any consent and captures nothing", () => {
    createCommittedWorktree("CA-tx-gate");
    createMixedDirtyDestination("gate");
    const before = git("rev-parse", "main");
    const result = runResult("complete", "CA-tx-gate", "--base", "main");

    assert.equal(result.status, 1);
    assert.equal(result.stderr, expectedRejection("CA-tx-gate"));
    assert.equal(fs.existsSync(backupsDir()), false);
    assert.equal(backupRefs(), "");
    assert.equal(git("rev-parse", "main"), before);
  });

  it("preserves with CLI flag alone (AC2.1)", () => {
    markCa1Case("preserve-dirty");
    createCommittedWorktree("CA-tx-flag");
    createMixedDirtyDestination("flag");
    const result = runResult("complete", "CA-tx-flag", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^preserve: \S+/m);
    assert.match(git("diff", "--cached", "--name-only"), /flag-staged\.txt/);
  });

  it("preserves with persisted config alone (AC2.1)", () => {
    createCommittedWorktree("CA-tx-config");
    createMixedDirtyDestination("cfg");
    enableConsent();
    const result = runResult("complete", "CA-tx-config", "--base", "main");

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^preserve: \S+/m);
  });

  // AC2.2 — happy path mixto con nombres hostiles en las tres categorías
  it("preserves fine-grained state with hostile names in all categories", () => {
    createCommittedWorktree("CA-tx-hostile");
    createHostileDestination("staged", "-dir con espacios/staged ñ.txt");
    createHostileDestination("unstaged", "con\tsalto.txt");
    createHostileDestination("untracked", "$(id).txt");
    const statusBefore = git("status", "--porcelain");
    const result = runResult("complete", "CA-tx-hostile", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    // Fusión aplicada
    assert.equal(fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"), "CA-tx-hostile\n");
    // Estado fino: mismo status que antes de la transacción (categorías y contenidos)
    assert.equal(git("status", "--porcelain"), statusBefore);
    // Contenido restaurado byte-idéntico
    assert.equal(
      fs.readFileSync(path.join(tempRepo, "-dir con espacios", "staged ñ.txt"), "utf8"),
      "hostile\n"
    );
    assert.ok(fs.readFileSync(path.join(tempRepo, "con\tsalto.txt"), "utf8").endsWith("modified\n"));
    assert.equal(fs.readFileSync(path.join(tempRepo, "$(id).txt"), "utf8"), "hostile\n");
    // Stash público intacto; backups privados vivos; worktree y branch limpiados
    assert.equal(git("stash", "list").trim(), "");
    assert.ok(backupRefs().length > 0);
    assert.equal(fs.existsSync(worktreeFor("CA-tx-hostile")), false);
    assert.doesNotMatch(git("branch", "--list"), /worktree\/CA-tx-hostile/);
  });

  // AC2.3 — setups no soportados: avisa categoría, no captura nada
  it("rejects with submodules present before capturing anything", () => {
    createCommittedWorktree("CA-tx-sub");
    const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-upstream-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: upstream });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: upstream });
    execFileSync("git", ["config", "user.name", "FlowTask Test"], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, "lib.txt"), "lib\n");
    execFileSync("git", ["add", "lib.txt"], { cwd: upstream });
    execFileSync("git", ["commit", "-qm", "lib"], { cwd: upstream });
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub"],
      { cwd: tempRepo }
    );
    fs.writeFileSync(path.join(tempRepo, "dirty.txt"), "dirty\n");
    const result = runResult("complete", "CA-tx-sub", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /submodules/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
    assert.ok(fs.readFileSync(path.join(tempRepo, "dirty.txt"), "utf8") === "dirty\n");
    fs.rmSync(upstream, { recursive: true, force: true });
  });

  it("rejects with sparse-checkout active", () => {
    createCommittedWorktree("CA-tx-sparse");
    createMixedDirtyDestination("sp");
    git("sparse-checkout", "init", "--cone");
    const result = runResult("complete", "CA-tx-sparse", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /sparse-checkout/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
  });

  it("rejects when a tracked dirty path has a clean/smudge filter", () => {
    createCommittedWorktree("CA-tx-filter");
    fs.writeFileSync(path.join(tempRepo, ".gitattributes"), "*.bin filter=proceso\n");
    fs.writeFileSync(path.join(tempRepo, "data.bin"), "aaa\n");
    git("add", ".gitattributes", "data.bin");
    const result = runResult("complete", "CA-tx-filter", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /filters/);
    assert.equal(backupRefs(), "");
    assert.equal(fs.existsSync(backupsDir()), false);
  });

  // AC2.4 — interrupción por fase + recuperación idempotente + doble recover
  for (const phase of ["captured", "merge_started", "merged"]) {
    it(`recovers fully after a crash right after ${phase}`, () => {
      createCommittedWorktree("CA-tx-crash");
      createMixedDirtyDestination("crash");
      const statusBefore = git("status", "--porcelain");

      const crashed = runResultWithEnv(
        { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: phase },
        "complete", "CA-tx-crash", "--base", "main", "--preserve-dirty"
      );
      assert.equal(crashed.status, 99);

      // La transacción quedó registrada con sus refs de backup
      assert.ok(backupRefs().length > 0);
      const txId = fs.readdirSync(backupsDir())[0];

      // Recover conduce desde la última fase hasta el estado final correcto
      const rec1 = runResult("recover");
      assert.equal(rec1.status, 0);
      assert.equal(git("status", "--porcelain"), statusBefore);
      assert.equal(
        fs.readFileSync(path.join(tempRepo, "change.txt"), "utf8"),
        "CA-tx-crash\n"
      );
      assert.ok(fs.readFileSync(path.join(tempRepo, "crash-untracked.txt"), "utf8") === "untracked\n");
      assert.equal(git("stash", "list").trim(), "");
      assert.equal(fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"), "restored\n");

      // Doble recover: segunda pasada es no-op seguro con idéntico resultado
      const headAfterFirst = git("rev-parse", "HEAD");
      const statusAfterFirst = git("status", "--porcelain");
      const rec2 = runResult("recover");
      assert.equal(rec2.status, 0);
      assert.equal(git("rev-parse", "HEAD"), headAfterFirst);
      assert.equal(git("status", "--porcelain"), statusAfterFirst);
    });
  }

  // AC2.5 — bloqueo de re-cierre mientras falta restaurar
  it("blocks a new completion while a transaction awaits restoration", () => {
    createCommittedWorktree("CA-tx-open");
    createMixedDirtyDestination("open");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "merged" },
      "complete", "CA-tx-open", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];
    const headAfterMerge = git("rev-parse", "main");

    // Otro CA limpio intenta cerrar → bloqueado con guía al recover correcto
    createCommittedWorktree("CA-tx-other");
    const blocked = runResult("complete", "CA-tx-other", "--base", "main");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, new RegExp(`recover ${txId}`));
    assert.equal(git("rev-parse", "main"), headAfterMerge);

    // Resuelta la pendiente, el operador resuelve la suciedad restaurada
    // (el recover la deja en el destino, como corresponde) y el cierre procede.
    run("recover");
    git("reset", "--hard");
    fs.rmSync(path.join(tempRepo, "open-untracked.txt"), { force: true });
    const ok = runResult("complete", "CA-tx-other", "--base", "main");
    assert.equal(ok.status, 0);
    assert.equal(fs.existsSync(worktreeFor("CA-tx-other")), false);
  });

  // AC2.6 — conflicto post-fusión: fusión intacta, backup intacto, pendiente-manual
  it("marks pending-manual on restoration conflict without discarding anything", () => {
    createCommittedWorktree("CA-tx-conflict");
    const worktree = worktreeFor("CA-tx-conflict");
    fs.writeFileSync(path.join(worktree, "file.txt"), "version worktree\n");
    git("-C", worktree, "add", "file.txt");
    git("-C", worktree, "commit", "-qm", "worktree rewrites file");
    // El destino tenía una modificación staged del MISMO archivo
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "version destino staged\n");
    git("add", "file.txt");
    const stampPath = path.join(tempRepo, ".flowtask", "config", ".review-stamp");
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ ts: "2026-08-25T20:00:00Z", branch: "main" }));
    const stampBefore = fs.readFileSync(stampPath, "utf8");
    const stampMtimeBefore = fs.statSync(stampPath).mtimeMs;

    const result = runResultWithEnv(
      {},
      "complete", "CA-tx-conflict", "--base", "main", "--preserve-dirty"
    );

    assert.equal(result.status, 1);
    // Fusión conservada (HEAD avanzó con la versión del worktree)
    assert.equal(fs.readFileSync(path.join(tempRepo, "file.txt"), "utf8"), "version worktree\n");
    // Backup intacto
    assert.ok(backupRefs().length > 0);
    const txId = fs.readdirSync(backupsDir())[0];
    assert.equal(
      fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"),
      "pending_manual\n"
    );
    // Instrucciones seguras: plantillas fijas + tx-id, SIN paths del repo
    assert.match(result.stderr, new RegExp(txId));
    assert.match(result.stderr, /pendiente-manual/);
    assert.ok(!result.stderr.includes("file.txt"), "el mensaje filtra un path del repo");
    // AC2.8: sello inalterado también en pending_manual
    assert.equal(fs.readFileSync(stampPath, "utf8"), stampBefore);
    assert.equal(fs.statSync(stampPath).mtimeMs, stampMtimeBefore);

    // Un retry no puede convertir la transacción pendiente en un cierre: no
    // deinit/remove/branch cleanup mientras la restauración manual siga abierta.
    const baseAfterFailure = git("rev-parse", "main");
    const retry = runResult("complete", "CA-tx-conflict", "--base", "main");
    assert.equal(retry.status, 1);
    assert.match(retry.stderr, /pending_manual/);
    assert.match(retry.stderr, new RegExp(`recover ${txId}`));
    assert.equal(git("rev-parse", "main"), baseAfterFailure);
    assert.ok(fs.existsSync(worktree));
    assert.match(git("branch", "--list"), /worktree\/CA-tx-conflict/);
    assert.equal(
      fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"),
      "pending_manual\n"
    );
  });

  // AC2.8 — sello de validación inalterado en happy path
  it("leaves the review stamp content and mtime untouched on success", () => {
    createCommittedWorktree("CA-tx-stamp");
    createMixedDirtyDestination("stamp");
    const stampPath = path.join(tempRepo, ".flowtask", "config", ".review-stamp");
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, JSON.stringify({ ts: "2026-08-25T20:00:00Z", branch: "main" }));
    const stampBefore = fs.readFileSync(stampPath, "utf8");
    const stampMtimeBefore = fs.statSync(stampPath).mtimeMs;

    const result = runResult("complete", "CA-tx-stamp", "--base", "main", "--preserve-dirty");

    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(stampPath, "utf8"), stampBefore);
    assert.equal(fs.statSync(stampPath).mtimeMs, stampMtimeBefore);
  });
});

describe("portable configuration, preflight, cleanup and locks", () => {
  beforeEach(() => {
    initTempRepo();
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  function writePortableConfig(contents) {
    const config = path.join(tempRepo, ".worktree-manager.conf");
    fs.writeFileSync(config, contents);
    return config;
  }

  function waitForFile(file) {
    return new Promise((resolve) => {
      const check = () => (fs.existsSync(file) ? resolve() : setImmediate(check));
      check();
    });
  }

  function waitForExit(child) {
    return new Promise((resolve) => child.on("exit", (status) => resolve(status)));
  }

  it("rejects invalid or repeated data configuration before creating resources", () => {
    writePortableConfig("branch_prefix=worktree/\nbranch_prefix=other/\n");
    const result = runResult("create", "invalid-config", "--base", "main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /repetida/i);
    assert.equal(fs.existsSync(worktreeFor("invalid-config")), false);
    assert.doesNotMatch(git("branch", "--list"), /invalid-config/);
  });

  it("uses configured external paths and runs declared actions in order", () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-external-")).replaceAll("\\", "/");
    const logName = "action.log";
    writePortableConfig(
      `worktrees_dir=${external}\nbranch_prefix=standalone/\nstate_dir=portable-state\n` +
      `prepare_command=printf prepare >> ${logName}\nverify_command=printf verify >> ${logName}\n`
    );

    const result = runResult("create", "generic-001", "--base", "main", "--prepare", "--verify");
    assert.equal(result.status, 0, result.stderr);
    const created = path.join(external, "generic-001");
    assert.ok(fs.existsSync(created));
    assert.equal(fs.readFileSync(path.join(created, logName), "utf8"), "prepareverify");
    assert.match(result.stdout, /prepare: passed/);
    assert.match(result.stdout, /verify: passed/);
    assert.match(git("branch", "--list"), /standalone\/generic-001/);
    assert.ok(fs.existsSync(path.join(tempRepo, ".git", "portable-state", "locks")));
    fs.rmSync(external, { recursive: true, force: true });
  });

  it("keeps a worktree after a requested action fails and rejects unsafe IDs", () => {
    writePortableConfig("prepare_command=false\n");
    const failed = runResult("create", "action-fails", "--base", "main", "--prepare");
    assert.equal(failed.status, 1);
    assert.ok(fs.existsSync(worktreeFor("action-fails")));
    assert.match(failed.stdout, /prepare: failed/);

    const unsafe = runResult("create", "../escape", "--base", "main");
    assert.equal(unsafe.status, 1);
    assert.equal(fs.existsSync(path.join(tempRepo, "escape")), false);
  });

  it("requires discard for dirty public cleanup and uses it only for that work", () => {
    const worktree = createCommittedWorktree("cleanup-guard");
    fs.writeFileSync(path.join(worktree, "pending.txt"), "pending\n");
    const rejected = runResult("cleanup", "cleanup-guard", "--base", "main");
    assert.equal(rejected.status, 1);
    assert.ok(fs.existsSync(worktree));
    assert.match(rejected.stderr, /--discard/);

    const discarded = runResult("cleanup", "cleanup-guard", "--base", "main", "--discard");
    assert.equal(discarded.status, 0, discarded.stderr);
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git("branch", "--list"), /cleanup-guard/);
  });

  it("locks recover against cleanup discard without waiting or mutating resources", async () => {
    createCommittedWorktree("lock-recover");
    createMixedDirtyDestination("lock");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "captured" },
      "complete", "lock-recover", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];
    const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-lock-barrier-"));
    const recover = spawn(SCRIPT, ["recover", txId], {
      cwd: tempRepo,
      env: { ...process.env, FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_LOCK_BARRIER_DIR: barrier, FLOWTASK_TEST_HOLD_AFTER_LOCK: "recover" },
      stdio: "pipe",
    });
    await waitForFile(path.join(barrier, "recover.ready"));
    const rejected = runResult("cleanup", "lock-recover", "--base", "main", "--discard");
    assert.equal(rejected.status, 1);
    assert.ok(fs.existsSync(worktreeFor("lock-recover")));
    assert.match(git("branch", "--list"), /worktree\/lock-recover/);
    fs.writeFileSync(path.join(barrier, "release"), "ok\n");
    assert.equal(await waitForExit(recover), 0);
    fs.rmSync(barrier, { recursive: true, force: true });
  });

  // B1 — el cierre squash verificado retira sus propios recursos sin --discard,
  // sin `-D` y sin borrado forzado, y solo después del restore cuando aplica.
  it("closes a two-commit squash through the internal capability and removes its resources", () => {
    const worktree = createCommittedWorktree("squash-close");
    fs.appendFileSync(path.join(worktree, "change.txt"), "segundo\n");
    git("-C", worktree, "add", "change.txt");
    git("-C", worktree, "commit", "-qm", "second worktree change");

    const mainBefore = git("rev-parse", "main").trim();
    const result = runResult("complete", "squash-close", "--base", "main");
    assert.equal(result.status, 0, result.stderr);

    // Exactamente un commit nuevo en la base, con contenido de ambos commits.
    const mainAfter = git("rev-parse", "main").trim();
    assert.notEqual(mainAfter, mainBefore);
    assert.equal(git("rev-list", "--count", `${mainBefore}..main`).trim(), "1");
    assert.match(git("log", "-1", "--format=%s"), /squash merge/);
    assert.match(git("show", "main:change.txt"), /segundo/);

    // `completed` solo después de retirar worktree y rama.
    assert.match(result.stdout, /completed: squash-close/);
    assert.equal(fs.existsSync(worktree), false);
    assert.doesNotMatch(git("branch", "--list"), /squash-close/);

    // Ningún stash público quedó y no hubo descarte explícito en la invocación.
    assert.equal(git("stash", "list").trim(), "");
    assert.doesNotMatch(result.stdout, /discard/);
  });

  it("keeps squash-close resources intact after a preserve recover and routes removal to public cleanup", () => {
    createCommittedWorktree("recover-keep");
    createMixedDirtyDestination("keep");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "merged" },
      "complete", "recover-keep", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];

    const recovered = runResult("recover", txId);
    assert.equal(recovered.status, 0, recovered.stderr);
    // B1: recover no invoca la capacidad interna de cierre.
    assert.match(recovered.stdout, /recovered:/);
    assert.ok(fs.existsSync(worktreeFor("recover-keep")));
    assert.match(git("branch", "--list"), /worktree\/recover-keep/);
    assert.equal(fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"), "restored\n");

    // Y el retiro posterior es el camino público, explícito.
    const cleaned = runResult("cleanup", "recover-keep", "--base", "main", "--discard");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(worktreeFor("recover-keep")), false);
    assert.doesNotMatch(git("branch", "--list"), /recover-keep/);
  });

  it("lets complete continue its own close after recover restores a preserve transaction", () => {
    createCommittedWorktree("recover-then-complete");
    createMixedDirtyDestination("continue");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "merged" },
      "complete", "recover-then-complete", "--base", "main", "--preserve-dirty",
    );
    assert.equal(crashed.status, 99);
    assert.equal(runResult("recover").status, 0);
    git("reset", "--hard");
    fs.rmSync(path.join(tempRepo, "continue-untracked.txt"), { force: true });
    const completed = runResult("complete", "recover-then-complete", "--base", "main");
    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(fs.existsSync(worktreeFor("recover-then-complete")), false);
  });

  it("rejects cleanup of own commits without --discard and keeps resources on refusal", () => {
    createCommittedWorktree("own-commits");
    const rejected = runResult("cleanup", "own-commits", "--base", "main");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--discard/);
    assert.ok(fs.existsSync(worktreeFor("own-commits")));
    assert.match(git("branch", "--list"), /worktree\/own-commits/);
  });

  // B2 — orden inverso: cleanup --discard sostiene el lock y recover falla ya.
  it("blocks recover while cleanup discard holds the shared work lock", async () => {
    createCommittedWorktree("lock-cleanup");
    createMixedDirtyDestination("rev");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "captured" },
      "complete", "lock-cleanup", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];
    const journalBefore = fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8");
    const refsBefore = backupRefs();

    const barrier = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-lock-barrier-"));
    const cleanup = spawn(SCRIPT, ["cleanup", "lock-cleanup", "--base", "main", "--discard"], {
      cwd: tempRepo,
      env: { ...process.env, FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_LOCK_BARRIER_DIR: barrier, FLOWTASK_TEST_HOLD_AFTER_LOCK: "cleanup" },
      stdio: "pipe",
    });
    await waitForFile(path.join(barrier, "cleanup.ready"));

    const rejected = runResult("recover", txId);
    assert.equal(rejected.status, 1);
    // recover no alteró journal ni backups, y no retiró recursos ajenos al lock.
    assert.equal(fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"), journalBefore);
    assert.equal(backupRefs(), refsBefore);

    fs.writeFileSync(path.join(barrier, "release"), "ok\n");
    assert.equal(await waitForExit(cleanup), 0);
    assert.equal(fs.existsSync(worktreeFor("lock-cleanup")), false);
    fs.rmSync(barrier, { recursive: true, force: true });
  });

  // Preflight conservador: verifica la exclusión sin editar .gitignore.
  it("refuses a local worktree path Git does not ignore and never edits .gitignore", () => {
    fs.writeFileSync(path.join(tempRepo, ".gitignore"), "file.txt\n");
    git("add", ".gitignore");
    git("commit", "-qm", "drop worktrees ignore");
    const gitignoreBefore = fs.readFileSync(path.join(tempRepo, ".gitignore"), "utf8");

    const result = runResult("create", "not-ignored", "--base", "main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no está excluida por Git/);
    assert.equal(fs.existsSync(worktreeFor("not-ignored")), false);
    assert.doesNotMatch(git("branch", "--list"), /not-ignored/);
    assert.equal(fs.readFileSync(path.join(tempRepo, ".gitignore"), "utf8"), gitignoreBefore);
  });

  it("rejects unknown config keys, missing action commands and a non-existent requested config", () => {
    writePortableConfig("unknown_key=1\n");
    const unknown = runResult("create", "cfg-unknown", "--base", "main");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /desconocida/i);
    assert.equal(fs.existsSync(worktreeFor("cfg-unknown")), false);

    // Acción solicitada sin comando declarado: rechazo antes de crear.
    writePortableConfig("");
    const noCommand = runResult("create", "cfg-noaction", "--base", "main", "--verify");
    assert.equal(noCommand.status, 1);
    assert.match(noCommand.stderr, /--verify requiere verify_command/);
    assert.equal(fs.existsSync(worktreeFor("cfg-noaction")), false);

    const missingConfig = runResult("--config", path.join(tempRepo, "nope.conf"), "list");
    assert.equal(missingConfig.status, 1);
    assert.match(missingConfig.stderr, /archivo absoluto existente/);
  });

  it("reuses legacy backups for recovery without migrating or deleting prior state", () => {
    createCommittedWorktree("legacy-tx");
    createMixedDirtyDestination("legacy");
    const crashed = runResultWithEnv(
      { FLOWTASK_TEST_MODE: "1", FLOWTASK_TEST_CRASH_AFTER: "captured" },
      "complete", "legacy-tx", "--base", "main", "--preserve-dirty"
    );
    assert.equal(crashed.status, 99);
    const txId = fs.readdirSync(backupsDir())[0];

    // Config nueva: el journal nuevo vive bajo common-dir, el legacy se sigue leyendo.
    writePortableConfig("state_dir=portable-state\n");
    const recovered = runResult("recover", txId);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.readFileSync(path.join(backupsDir(), txId, "journal"), "utf8"), "restored\n");
    // El estado previo no se borra ni se migra.
    assert.ok(fs.existsSync(path.join(backupsDir(), txId, "meta")));
  });
});
