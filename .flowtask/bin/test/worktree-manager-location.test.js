import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalWorktreeManagerDirectory, isValidManagerCheckout, resolveWorktreeManagerLocation, missingManagerCause } from "../../plugins/flowtask-permission-gate/dist/worktree-manager-location.js";

function mkManager(dir) {
  fs.mkdirSync(path.join(dir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree_manager", "__main__.py"), "x");
  fs.writeFileSync(path.join(dir, "worktree_manager", "mcp_transport.py"), "x");
}

test("global wins when valid", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const globalDir = globalWorktreeManagerDirectory({ env: {}, home });
  mkManager(globalDir);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  fs.mkdirSync(path.join(repo, ".flowtask", "scripts", "worktree-manager", "worktree_manager"), { recursive: true });
  // make repo checkout valid too
  mkManager(path.join(repo, ".flowtask", "scripts", "worktree-manager"));
  const session = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const loc = resolveWorktreeManagerLocation({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.equal(loc.source, "global");
});

test("falls back to repo then session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const session = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  mkManager(path.join(repo, ".flowtask", "scripts", "worktree-manager"));
  const loc = resolveWorktreeManagerLocation({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.equal(loc.source, "repo");
});

test("falls back to the session when neither global nor repo has a manager", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const session = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  mkManager(path.join(session, ".flowtask", "scripts", "worktree-manager"));
  const loc = resolveWorktreeManagerLocation({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.equal(loc.source, "session");
  assert.equal(loc.directory, path.join(session, ".flowtask", "scripts", "worktree-manager"));
});

test("an incomplete global copy does not win over a valid repo copy", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const globalDir = globalWorktreeManagerDirectory({ env: {}, home });
  fs.mkdirSync(path.join(globalDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(globalDir, "worktree_manager", "__main__.py"), "x");
  // mcp_transport.py is missing, so the global candidate is not a valid checkout.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  mkManager(path.join(repo, ".flowtask", "scripts", "worktree-manager"));
  const session = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const loc = resolveWorktreeManagerLocation({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.equal(loc.source, "repo");
});

test("null and cause when none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  const session = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
  const loc = resolveWorktreeManagerLocation({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.equal(loc, null);
  const cause = missingManagerCause({ repoRoot: repo, sessionDir: session, env: {}, home });
  assert.match(cause, /flowtask install/);
  assert.ok(cause.includes(globalWorktreeManagerDirectory({ env: {}, home })));
});
