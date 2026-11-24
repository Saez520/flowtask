import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureUserWorktreeManager, removeUserWorktreeManager } from "../lib/claude-mcp.js";
import { migrateProjectWorktreeMcpForClaude } from "../lib/claude-install.js";
import { WORKTREE_MANAGER_MCP_MODULE } from "../lib/worktree-mcp-registration.js";

const fixtures = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-claude-worktree-"));
  fixtures.push(root);
  const claudeUserDir = path.join(root, "claude");
  const managerDir = path.join(root, "manager");
  fs.mkdirSync(path.join(managerDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"), "", "utf8");
  fs.mkdirSync(claudeUserDir, { recursive: true });
  return { root, claudeUserDir, managerDir, stateFile: path.join(claudeUserDir, ".claude.json") };
}

function writeState(stateFile, value) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function managedEntry(managerDir) {
  return {
    type: "stdio",
    command: "/usr/bin/python3",
    args: ["-m", WORKTREE_MANAGER_MCP_MODULE],
    env: { PYTHONPATH: managerDir },
  };
}

test.afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("registers the manager in the Claude user scope with an explicit PYTHONPATH", () => {
  const { claudeUserDir, managerDir } = makeFixture();
  const calls = [];
  let present = false;
  const spawn = (bin, args) => {
    calls.push({ bin, args });
    if (args[1] === "get") {
      return present
        ? { status: 0, stdout: "worktree_manager:\n  Scope: user\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "No MCP server named worktree_manager" };
    }
    if (args[1] === "add") {
      present = true;
      return { status: 0, stdout: "added", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };

  const result = ensureUserWorktreeManager({
    claudeUserDir,
    managerDir,
    pythonBin: "/usr/bin/python3",
    claudeBin: "claude",
    spawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "added");
  assert.equal(result.managed, true);
  const add = calls.find(({ args }) => args[1] === "add");
  assert.ok(add);
  assert.deepEqual(add.args, [
    "mcp", "add", "--scope", "user", "worktree_manager",
    "-e", `PYTHONPATH=${managerDir}`,
    "--", "/usr/bin/python3", "-m", WORKTREE_MANAGER_MCP_MODULE,
  ]);
});

test("falls back to the state file with a backup when the CLI is unavailable", () => {
  const { claudeUserDir, managerDir, stateFile } = makeFixture();
  const before = { mcpServers: { engram: { command: "engram", args: ["mcp"] } }, theme: "dark" };
  writeState(stateFile, before);
  const original = fs.readFileSync(stateFile);
  const spawn = () => ({ error: new Error("command not found"), status: null, stdout: "", stderr: "" });

  const result = ensureUserWorktreeManager({
    claudeUserDir,
    managerDir,
    pythonBin: "/usr/bin/python3",
    claudeBin: "claude",
    spawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "added");
  assert.equal(result.transport, "state-file");
  assert.deepEqual(fs.readFileSync(`${stateFile}.flowtask-backup`), original);
  const state = readState(stateFile);
  assert.deepEqual(state.mcpServers.worktree_manager, managedEntry(managerDir));
  assert.deepEqual(state.mcpServers.engram, before.mcpServers.engram);
  assert.equal(state.theme, "dark");
});

test("preserves a foreign worktree entry when the CLI is unavailable", () => {
  const { claudeUserDir, managerDir, stateFile } = makeFixture();
  const foreign = { type: "remote", url: "https://example.test/mcp" };
  writeState(stateFile, { mcpServers: { worktree_manager: foreign } });
  const original = fs.readFileSync(stateFile);
  const spawn = () => ({ error: new Error("command not found"), status: null, stdout: "", stderr: "" });

  const result = ensureUserWorktreeManager({
    claudeUserDir,
    managerDir,
    pythonBin: "/usr/bin/python3",
    claudeBin: "claude",
    spawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "preserved");
  assert.deepEqual(fs.readFileSync(stateFile), original);
  assert.equal(fs.existsSync(`${stateFile}.flowtask-backup`), false);
});

test("does not register a manager whose MCP entrypoint is missing", () => {
  const { claudeUserDir, root, stateFile } = makeFixture();
  const emptyManager = path.join(root, "empty-manager");
  fs.mkdirSync(emptyManager, { recursive: true });
  let calls = 0;
  const spawn = () => {
    calls += 1;
    return { status: 0, stdout: "Scope: user", stderr: "" };
  };

  const result = ensureUserWorktreeManager({
    claudeUserDir,
    managerDir: emptyManager,
    pythonBin: "/usr/bin/python3",
    claudeBin: "claude",
    spawn,
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "unavailable");
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(stateFile), false);
});

test("removes only the managed user-scope registration", () => {
  const { claudeUserDir, managerDir } = makeFixture();
  let present = true;
  const spawn = (bin, args) => {
    if (args[1] === "get") {
      return present
        ? { status: 0, stdout: "worktree_manager:\n  Scope: user\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "No MCP server named worktree_manager" };
    }
    if (args[1] === "remove") {
      present = false;
      return { status: 0, stdout: "removed", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };

  const preserved = removeUserWorktreeManager({
    claudeUserDir,
    managerDir,
    runtimeManifest: { mcp: { worktree_manager: { managed: false } } },
    claudeBin: "claude",
    spawn,
  });
  assert.equal(preserved.action, "preserved");

  const removed = removeUserWorktreeManager({
    claudeUserDir,
    managerDir,
    runtimeManifest: { mcp: { worktree_manager: { managed: true } } },
    claudeBin: "claude",
    spawn,
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.action, "removed");
});

test("removes the managed registration from the state file when the CLI is unavailable", () => {
  const { claudeUserDir, managerDir, stateFile } = makeFixture();
  const foreign = { type: "remote", url: "https://example.test/mcp" };
  writeState(stateFile, { mcpServers: { worktree_manager: managedEntry(managerDir), foreign } });
  const spawn = () => ({ error: new Error("command not found"), status: null, stdout: "", stderr: "" });

  const result = removeUserWorktreeManager({
    claudeUserDir,
    managerDir,
    runtimeManifest: { mcp: { worktree_manager: { managed: true } } },
    claudeBin: "claude",
    spawn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "removed");
  assert.deepEqual(readState(stateFile).mcpServers, { foreign });
});


test("migrates the project entry only after the user-scope registration is managed", () => {
  const { root, managerDir } = makeFixture();
  const projectMcpPath = path.join(root, "project", ".mcp.json");
  writeState(projectMcpPath, {
    mcpServers: {
      keep: { type: "stdio", command: "keep" },
      worktree_manager: managedEntry(managerDir),
    },
  });

  const result = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: true, action: "added", managed: true },
  });

  assert.equal(result.status, "removed");
  const config = readState(projectMcpPath);
  assert.deepEqual(config.mcpServers, { keep: { type: "stdio", command: "keep" } });
});

test("preserves the project entry when the user-scope registration fails or is foreign", () => {
  const { root, managerDir } = makeFixture();
  const projectMcpPath = path.join(root, "project", ".mcp.json");
  writeState(projectMcpPath, { mcpServers: { worktree_manager: managedEntry(managerDir) } });
  const before = fs.readFileSync(projectMcpPath);

  const failed = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: false, action: "failed", managed: false, error: "cli unavailable" },
  });
  assert.equal(failed.status, "preserved");
  assert.deepEqual(fs.readFileSync(projectMcpPath), before);

  const foreign = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: true, action: "preserved", managed: false },
    runtimeManifest: { mcp: { worktree_manager: { managed: true } } },
  });
  assert.equal(foreign.status, "preserved");
  assert.deepEqual(fs.readFileSync(projectMcpPath), before);
});

test("a later confirmed registration retries the project migration idempotently", () => {
  const { root, managerDir } = makeFixture();
  const projectMcpPath = path.join(root, "project", ".mcp.json");
  writeState(projectMcpPath, { mcpServers: { worktree_manager: managedEntry(managerDir) } });

  const retry = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: true, action: "present", managed: false },
    runtimeManifest: { mcp: { worktree_manager: { managed: true } } },
  });
  assert.equal(retry.status, "removed");
  assert.deepEqual(readState(projectMcpPath), {});

  const second = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: true, action: "present", managed: false },
    runtimeManifest: { mcp: { worktree_manager: { managed: true } } },
  });
  assert.equal(second.status, "absent");
});

test("a foreign project entry is preserved even when the user scope is managed", () => {
  const { root, managerDir } = makeFixture();
  const projectMcpPath = path.join(root, "project", ".mcp.json");
  const foreign = { type: "stdio", command: "python-wrapper", args: ["-m", WORKTREE_MANAGER_MCP_MODULE], env: { PYTHONPATH: managerDir } };
  writeState(projectMcpPath, { mcpServers: { worktree_manager: foreign } });
  const before = fs.readFileSync(projectMcpPath);

  const result = migrateProjectWorktreeMcpForClaude({
    paths: { projectMcpPath },
    worktreeMcp: { ok: true, managed: true },
  });

  assert.equal(result.status, "preserved");
  assert.deepEqual(fs.readFileSync(projectMcpPath), before);
});
