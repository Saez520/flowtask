import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
let tempRepo;

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

describe("nested hotfix worktrees", () => {
  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-worktree-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "FlowTask Test");
    fs.writeFileSync(path.join(tempRepo, ".gitignore"), ".worktrees/\n");
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "base\n");
    git("add", ".gitignore", "file.txt");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
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
      assert.match(result.stderr, /destino/i);
      assert.match(result.stderr, /staged/i);
      assert.match(result.stderr, /unstaged/i);
      assert.match(result.stderr, /untracked/i);
      assert.match(result.stderr, /stash\/pop/i);
      assert.ok(fs.existsSync(worktree));
      assert.equal(git("rev-parse", "main"), before);
    });
  }

  it("rejects complete bypass options before changing state", () => {
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
