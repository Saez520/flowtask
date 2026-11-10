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
  registerWorktreeManagerMcp,
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

function managerFixture() {
  const managerDir = path.join(mkTmp(), "worktree-manager");
  fs.mkdirSync(path.join(managerDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"), "", "utf8");
  return managerDir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("the registration writes the absolute interpreter path in both formats", () => {
  const managerDir = managerFixture();
  const pythonBin = "/opt/homebrew/bin/python3.12";
  const root = mkTmp();

  const opencodePath = path.join(root, ".opencode", "opencode.json");
  const opencode = registerWorktreeManagerMcp({ configPath: opencodePath, format: "opencode", managerDir, pythonBin });
  assert.equal(opencode.status, "registered");
  assert.deepEqual(readJson(opencodePath).mcp.worktree_manager.command, [
    pythonBin,
    "-m",
    WORKTREE_MANAGER_MCP_MODULE,
  ]);

  const claudePath = path.join(root, ".mcp.json");
  const claude = registerWorktreeManagerMcp({ configPath: claudePath, format: "claude", managerDir, pythonBin });
  assert.equal(claude.status, "registered");
  assert.equal(readJson(claudePath).mcpServers.worktree_manager.command, pythonBin);
});

test("python3 remains the fallback when no capabilities are available", () => {
  const managerDir = managerFixture();
  const root = mkTmp();
  const configPath = path.join(root, "opencode.json");

  registerWorktreeManagerMcp({ configPath, format: "opencode", managerDir });
  assert.deepEqual(readJson(configPath).mcp.worktree_manager.command, [
    DEFAULT_PYTHON_BIN,
    "-m",
    WORKTREE_MANAGER_MCP_MODULE,
  ]);
});

test("a managed python3 entry is migrated to the resolved interpreter", () => {
  const managerDir = managerFixture();
  const root = mkTmp();
  const configPath = path.join(root, "opencode.json");
  writeJson(configPath, {
    mcp: {
      worktree_manager: {
        type: "local",
        command: ["python3", "-m", WORKTREE_MANAGER_MCP_MODULE],
        environment: { PYTHONPATH: "/previous/manager" },
        enabled: true,
      },
      other: { type: "local", command: ["other"], enabled: true },
    },
  });

  const result = registerWorktreeManagerMcp({
    configPath,
    format: "opencode",
    managerDir,
    pythonBin: "C:\\Python312\\python.exe",
  });

  assert.equal(result.status, "registered");
  const config = readJson(configPath);
  assert.deepEqual(config.mcp.worktree_manager.command, [
    "C:\\Python312\\python.exe",
    "-m",
    WORKTREE_MANAGER_MCP_MODULE,
  ]);
  assert.deepEqual(config.mcp.worktree_manager.environment, { PYTHONPATH: managerDir });
  assert.deepEqual(config.mcp.other, { type: "local", command: ["other"], enabled: true });
});

test("a matching entry stays unchanged and a foreign entry is preserved byte for byte", () => {
  const managerDir = managerFixture();
  const root = mkTmp();
  const pythonBin = "/usr/bin/python3.11";

  const configPath = path.join(root, "opencode.json");
  registerWorktreeManagerMcp({ configPath, format: "opencode", managerDir, pythonBin });
  const before = fs.readFileSync(configPath, "utf8");
  const repeated = registerWorktreeManagerMcp({ configPath, format: "opencode", managerDir, pythonBin });
  assert.equal(repeated.status, "unchanged");
  assert.equal(fs.readFileSync(configPath, "utf8"), before);

  const foreignPath = path.join(root, "foreign.json");
  writeJson(foreignPath, {
    mcp: {
      worktree_manager: {
        type: "local",
        command: ["custom-python-wrapper", "-m", WORKTREE_MANAGER_MCP_MODULE],
        environment: { PYTHONPATH: managerDir },
        enabled: true,
      },
    },
  });
  const foreignBefore = fs.readFileSync(foreignPath, "utf8");
  const foreign = registerWorktreeManagerMcp({ configPath: foreignPath, format: "opencode", managerDir, pythonBin });
  assert.equal(foreign.status, "preserved");
  assert.equal(fs.readFileSync(foreignPath, "utf8"), foreignBefore);
});

test("managed entries are recognized for command names and absolute interpreter paths", () => {
  const managerDir = "/managed/worktree-manager";
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
