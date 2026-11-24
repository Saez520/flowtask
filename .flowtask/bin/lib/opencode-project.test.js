import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanConfigFile } from "./opencode-project.js";

test("cleaning a project configuration removes the legacy FlowTask agent entries only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-project-"));
  try {
    const configPath = path.join(root, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        "flowtask-planner": { model: "p/m", variant: "max" },
        "third-party": { model: "other/model" },
      },
      agents: { "flowtask-planner": {}, "third-party-agents": { model: "foreign/model" } },
    }), "utf8");

    const result = cleanConfigFile(configPath, { flowtaskDir: root });

    assert.equal(result.changed, true);
    assert.ok(result.removed.includes("agent.flowtask-planner"));
    assert.ok(result.removed.includes("agents.flowtask-planner"));
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      agent: { "third-party": { model: "other/model" } },
      agents: { "third-party-agents": { model: "foreign/model" } },
    });

    fs.writeFileSync(configPath, JSON.stringify({ agent: { "flowtask-runner": {} } }), "utf8");
    cleanConfigFile(configPath, { flowtaskDir: root });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleaning a project configuration retires the managed worktree manager only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-project-wm-"));
  try {
    const configPath = path.join(root, "opencode.json");
    const managed = {
      type: "local",
      command: ["/usr/bin/python3", "-m", "worktree_manager.mcp_transport"],
      environment: { PYTHONPATH: path.join(root, "manager") },
      enabled: true,
    };
    const foreign = { type: "remote", url: "https://example.test/mcp" };
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { worktree_manager: managed, foreign },
    }), "utf8");

    const result = cleanConfigFile(configPath, { flowtaskDir: root, removeEngram: false });
    assert.equal(result.changed, true);
    assert.ok(result.removed.includes("mcp.worktree_manager"));
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      mcp: { foreign },
    });

    fs.writeFileSync(configPath, JSON.stringify({ mcp: { worktree_manager: foreign } }), "utf8");
    const foreignResult = cleanConfigFile(configPath, { flowtaskDir: root, removeEngram: false });
    assert.equal(foreignResult.changed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).mcp.worktree_manager, foreign);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
