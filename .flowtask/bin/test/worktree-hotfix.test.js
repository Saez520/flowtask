import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

describe("nested hotfix worktrees", () => {
  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-worktree-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "FlowTask Test");
    fs.writeFileSync(path.join(tempRepo, "file.txt"), "base\n");
    git("add", "file.txt");
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
});
