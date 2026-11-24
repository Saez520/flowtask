import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PYTHON_BIN,
  WORKTREE_MANAGER_MCP_MODULE,
  buildWorktreeManagerMcpEntry,
  isFlowTaskWorktreeManagerEntry,
  removeWorktreeManagerMcp,
} from "./worktree-mcp-registration.js";

const fixtures = [];

function mkTmp(prefix = "flowtask-worktree-mcp-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("the entry uses the absolute interpreter path in both formats", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  const pythonBin = "/opt/homebrew/bin/python3.12";

  assert.deepEqual(buildWorktreeManagerMcpEntry("opencode", managerDir, pythonBin), {
    type: "local",
    command: [pythonBin, "-m", WORKTREE_MANAGER_MCP_MODULE],
    environment: { PYTHONPATH: managerDir },
    enabled: true,
  });
  assert.deepEqual(buildWorktreeManagerMcpEntry("claude", managerDir, pythonBin), {
    type: "stdio",
    command: pythonBin,
    args: ["-m", WORKTREE_MANAGER_MCP_MODULE],
    env: { PYTHONPATH: managerDir },
  });
});

test("python3 remains the fallback when no interpreter is known", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  assert.deepEqual(buildWorktreeManagerMcpEntry("opencode", managerDir).command, [
    DEFAULT_PYTHON_BIN,
    "-m",
    WORKTREE_MANAGER_MCP_MODULE,
  ]);
});

test("managed entries are recognized for command names and absolute interpreter paths", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  const accepted = [
    "python3",
    "python3.12",
    "python",
    "py",
    "py.exe",
    "/usr/bin/python3",
    "/usr/local/bin/python3.11",
    "C:\\Python312\\python.exe",
    "C:\\Python312\\python3.exe",
    `\\\\server\\share\\Python312\\python.exe`,
  ];
  for (const pythonBin of accepted) {
    const opencode = buildWorktreeManagerMcpEntry("opencode", managerDir, pythonBin);
    assert.equal(isFlowTaskWorktreeManagerEntry(opencode, "opencode"), true, `opencode: ${pythonBin}`);
    const claude = buildWorktreeManagerMcpEntry("claude", managerDir, pythonBin);
    assert.equal(isFlowTaskWorktreeManagerEntry(claude, "claude"), true, `claude: ${pythonBin}`);
  }

  const rejected = [
    "python-wrapper",
    "node",
    "/usr/bin/python-wrapper",
    "C:\\Tools\\python-wrapper.exe",
  ];
  for (const pythonBin of rejected) {
    const opencode = buildWorktreeManagerMcpEntry("opencode", managerDir, pythonBin);
    assert.equal(isFlowTaskWorktreeManagerEntry(opencode, "opencode"), false, `opencode: ${pythonBin}`);
    const claude = buildWorktreeManagerMcpEntry("claude", managerDir, pythonBin);
    assert.equal(isFlowTaskWorktreeManagerEntry(claude, "claude"), false, `claude: ${pythonBin}`);
  }
});

test("removing a managed entry deletes the server and the empty section", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  const configPath = path.join(mkTmp(), "opencode.json");
  writeJson(configPath, {
    $schema: "https://opencode.ai/config.json",
    mcp: { worktree_manager: buildWorktreeManagerMcpEntry("opencode", managerDir, "/usr/bin/python3") },
  });

  const result = removeWorktreeManagerMcp({ configPath, format: "opencode" });

  assert.equal(result.status, "removed");
  assert.deepEqual(readJson(configPath), { $schema: "https://opencode.ai/config.json" });
});

test("removing a managed entry preserves foreign MCP servers", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  const configPath = path.join(mkTmp(), ".mcp.json");
  const foreign = { command: "other", args: [] };
  writeJson(configPath, {
    mcpServers: {
      worktree_manager: buildWorktreeManagerMcpEntry("claude", managerDir, "/usr/bin/python3"),
      foreign,
    },
  });

  const result = removeWorktreeManagerMcp({ configPath, format: "claude" });

  assert.equal(result.status, "removed");
  assert.deepEqual(readJson(configPath).mcpServers, { foreign });
});

test("removal preserves a foreign worktree entry, an invalid document and a missing file", () => {
  const configPath = path.join(mkTmp(), "opencode.json");
  const foreign = { type: "remote", url: "https://example.test/mcp" };
  writeJson(configPath, { mcp: { worktree_manager: foreign } });
  const foreignResult = removeWorktreeManagerMcp({ configPath, format: "opencode" });
  assert.equal(foreignResult.status, "preserved");
  assert.deepEqual(readJson(configPath).mcp.worktree_manager, foreign);

  fs.writeFileSync(configPath, "{ not json", "utf8");
  assert.equal(removeWorktreeManagerMcp({ configPath, format: "opencode" }).status, "preserved");

  const absentPath = path.join(mkTmp(), "missing.json");
  assert.equal(removeWorktreeManagerMcp({ configPath: absentPath, format: "claude" }).status, "absent");
});

test("removal is idempotent", () => {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  const configPath = path.join(mkTmp(), "opencode.json");
  writeJson(configPath, { mcp: { worktree_manager: buildWorktreeManagerMcpEntry("opencode", managerDir, "/usr/bin/python3") } });

  assert.equal(removeWorktreeManagerMcp({ configPath, format: "opencode" }).status, "removed");
  assert.equal(removeWorktreeManagerMcp({ configPath, format: "opencode" }).status, "absent");
});
