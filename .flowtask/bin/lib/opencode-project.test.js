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
