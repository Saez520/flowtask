import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import plugin, { isAuthorizedRunnerCommand, RUNNER_DELEGATION_MESSAGE, tokenizeCommand } from "../dist/index.js";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

test("matches canonical Runner commands structurally", () => {
  for (const command of [
    "./.flowtask/scripts/worktree.sh create wt-1 --base main",
    "./.flowtask/scripts/worktree.sh complete wt-1 --base main",
    "./.flowtask/scripts/worktree.sh list", "git status --short", "git add file.ts",
    "git restore --staged file.ts", 'git commit -m "mensaje de prueba"', "git push origin branch",
    "node .flowtask/bin/flowtask.js graphify query --limit 2",
  ]) assert.equal(isAuthorizedRunnerCommand(command), true, command);
});

test("rejects malformed and compound commands", () => {
  for (const command of ["git log", "git diff", "git status && git diff", "git status; git diff", "./.flowtask/scripts/worktree.sh create wt-1", "jq . file"]) {
    assert.equal(isAuthorizedRunnerCommand(command), false, command);
  }
  assert.equal(tokenizeCommand("git status && git diff"), null);
});

test("Runner receives exact delegation feedback", async () => {
  const hooks = await plugin({ directory: process.cwd() });
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "bash", agent: "flowtask-runner", sessionID: "s", callID: "c" }, { args: { command: "git diff" } }),
    (error) => error instanceof Error && error.message === RUNNER_DELEGATION_MESSAGE,
  );
});

test("commit gate remains universal and consumes a valid stamp", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-gate-")); roots.push(root);
  fs.mkdirSync(path.join(root, ".opencode/flowtask/config"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode/flowtask/config/review.json"), JSON.stringify({ enabled: true, stampPath: ".flowtask/config/.review-stamp" }));
  fs.mkdirSync(path.join(root, ".flowtask/config"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flowtask/config/.review-stamp"), new Date().toISOString());
  const hooks = await plugin({ directory: root });
  await hooks["tool.execute.before"]({ tool: "bash", agent: "flowtask-constructor", sessionID: "s", callID: "c" }, { args: { command: 'git commit -m "ok"', workdir: root } });
  assert.equal(fs.existsSync(path.join(root, ".flowtask/config/.review-stamp")), false);
});
