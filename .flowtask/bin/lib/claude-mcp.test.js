import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ensureUserEngram, ensureUserEngramOrWarn, ensureUserWorktreeManager } from "./claude-mcp.js";
import { buildWorktreeManagerMcpEntry } from "./worktree-mcp-registration.js";

const fixtures = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-claude-mcp-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const claudeUserDir = path.join(home, ".claude");
  const managerDir = path.join(root, "manager");
  fs.mkdirSync(path.join(managerDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"), "", "utf8");
  fs.mkdirSync(claudeUserDir, { recursive: true });
  return { home, claudeUserDir, managerDir, stateFile: path.join(home, ".claude.json") };
}

function withTemporaryHome(home, run) {
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
}

function writeState(stateFile, value) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function managedEntry(managerDir) {
  return buildWorktreeManagerMcpEntry("claude", managerDir, "/usr/bin/python3");
}

function projectScopeResult() {
  return {
    status: 0,
    stdout: "worktree_manager:\n  Scope: Project config (shared via .mcp.json)\n",
    stderr: "",
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("reports the user-scope entry from the state file when the CLI resolves the project scope", () => {
  const { home, claudeUserDir, managerDir, stateFile } = makeFixture();
  const entry = managedEntry(managerDir);
  writeState(stateFile, { mcpServers: { worktree_manager: entry } });
  const original = fs.readFileSync(stateFile);
  const calls = [];

  const result = withTemporaryHome(home, () =>
    ensureUserWorktreeManager({
      claudeUserDir,
      managerDir,
      pythonBin: "/usr/bin/python3",
      claudeBin: "claude",
      spawn: (bin, args) => {
        calls.push(args);
        return projectScopeResult();
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "present");
  assert.equal(result.managed, false);
  assert.equal(calls.some((args) => args[1] === "add"), false);
  assert.deepEqual(fs.readFileSync(stateFile), original);
});

test("adds through the CLI and verifies the user-scope entry in the state file", () => {
  const { home, claudeUserDir, managerDir, stateFile } = makeFixture();
  const entry = managedEntry(managerDir);
  writeState(stateFile, { mcpServers: {} });
  const calls = [];

  const result = withTemporaryHome(home, () =>
    ensureUserWorktreeManager({
      claudeUserDir,
      managerDir,
      pythonBin: "/usr/bin/python3",
      claudeBin: "claude",
      spawn: (bin, args) => {
        calls.push(args);
        if (args[1] === "get") return { status: 1, stdout: "", stderr: "No MCP server named worktree_manager" };
        if (args[1] === "add") {
          writeState(stateFile, { mcpServers: { worktree_manager: entry } });
          return { status: 0, stdout: "added", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "added");
  assert.equal(result.managed, true);
  assert.equal(calls.some((args) => args[1] === "add"), true);
  assert.deepEqual(readState(stateFile).mcpServers.worktree_manager, entry);
});

test("preserves a foreign user-scope entry", () => {
  const { home, claudeUserDir, managerDir, stateFile } = makeFixture();
  const foreign = { type: "remote", url: "https://example.test/mcp" };
  writeState(stateFile, { mcpServers: { worktree_manager: foreign } });
  const original = fs.readFileSync(stateFile);
  const calls = [];

  const result = withTemporaryHome(home, () =>
    ensureUserWorktreeManager({
      claudeUserDir,
      managerDir,
      pythonBin: "/usr/bin/python3",
      claudeBin: "claude",
      spawn: (bin, args) => {
        calls.push(args);
        return projectScopeResult();
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "preserved");
  assert.equal(result.managed, false);
  assert.equal(calls.some((args) => args[1] === "add"), false);
  assert.deepEqual(fs.readFileSync(stateFile), original);
});

test("reports the state-file entry when the CLI is unavailable", () => {
  const { home, claudeUserDir, managerDir, stateFile } = makeFixture();
  const entry = managedEntry(managerDir);
  writeState(stateFile, { mcpServers: { worktree_manager: entry } });
  const original = fs.readFileSync(stateFile);
  const calls = [];

  const result = withTemporaryHome(home, () =>
    ensureUserWorktreeManager({
      claudeUserDir,
      managerDir,
      pythonBin: "/usr/bin/python3",
      claudeBin: "claude",
      spawn: (bin, args) => {
        calls.push(args);
        return { error: new Error("command not found"), status: null, stdout: "", stderr: "" };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, "present");
  assert.equal(calls.some((args) => args[1] === "add"), false);
  assert.deepEqual(fs.readFileSync(stateFile), original);
  assert.equal(fs.existsSync(`${stateFile}.flowtask-backup`), false);
});

// gap: G-1 — a failing user-scope registration used to abort the whole update; it must degrade to a warning and keep the Claude surfaces usable

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-test-"));
  fixtures.push(dir);
  return dir;
}

test("G-1: a failed user-scope registration warns with the error and the manual command", () => {
  const failure = {
    ok: false,
    action: "failed",
    managed: false,
    error:
      "The Claude Code CLI is unavailable (spawnSync claude ENOENT). " +
      "Run manually: claude mcp add --scope user engram -- engram mcp",
    command: "claude mcp add --scope user engram -- engram mcp",
  };
  const warnings = [];
  const calls = [];

  const result = ensureUserEngramOrWarn({
    claudeUserDir: path.join(makeTempDir(), ".claude"),
    ensure: (input) => {
      calls.push(input);
      return failure;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(result, failure, "the caller receives the original result");
  assert.equal(calls.length, 1, "the registration is attempted exactly once");
  assert.equal(warnings.length, 1, "a degraded registration emits a single warning");
  assert.match(warnings[0], /Could not register Engram in the Claude user scope/);
  assert.ok(warnings[0].includes(failure.error), "the warning keeps the original error");
  assert.ok(
    warnings[0].includes("claude mcp add --scope user engram -- engram mcp"),
    "the warning keeps the exact manual command",
  );
});

test("G-1: a successful user-scope registration does not warn", () => {
  const success = { ok: true, action: "present", managed: false, error: null, command: "claude mcp add --scope user engram -- engram mcp" };
  const warnings = [];

  const result = ensureUserEngramOrWarn({
    claudeUserDir: path.join(makeTempDir(), ".claude"),
    ensure: () => success,
    warn: (message) => warnings.push(message),
  });

  assert.equal(result, success);
  assert.equal(warnings.length, 0, "an available registration stays silent");
});

test("G-1: an unavailable CLI reports the manual command instead of editing the user state", () => {
  const claudeUserDir = path.join(makeTempDir(), ".claude");

  const result = ensureUserEngram({
    claudeUserDir,
    claudeBin: "claude",
    spawn: () => ({ error: new Error("spawnSync claude ENOENT"), status: null }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "failed");
  assert.match(result.error, /claude mcp add --scope user engram -- engram mcp/);
  assert.equal(
    fs.existsSync(path.join(claudeUserDir, ".claude.json")),
    false,
    "the manual fallback never writes the user state",
  );
});
