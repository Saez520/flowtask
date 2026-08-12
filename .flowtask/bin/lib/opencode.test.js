import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { mergeOpencodeConfig } from "./opencode.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-"));
  const flowtaskDir = path.join(root, "flowtask");
  fs.mkdirSync(flowtaskDir, { recursive: true });
  fixtures.push(root);
  return { root, flowtaskDir };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test("merge preserves manual values and repairs duplicate plugins idempotently", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    mcp: { flowtask: { command: ["canonical"] }, newMcp: { enabled: true } },
    agent: { runner: { model: "canonical" } },
    command: { check: { command: "canonical" } },
    plugin: [".opencode/plugins/flowtask-plugin/index.js"],
  });
  const configPath = path.join(root, ".opencode", "opencode.json");
  writeJson(configPath, {
    $schema: "https://custom/schema.json",
    mcp: { flowtask: { command: ["manual"], manual: true } },
    agent: { runner: { model: "manual" } },
    command: { check: { command: "manual" } },
    plugin: [
      "./plugins/flowtask-plugin/old.js",
      "./plugins/external/index.js",
      "./plugins/flowtask-plugin/duplicate.js",
    ],
  });

  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  const first = JSON.parse(fs.readFileSync(configPath, "utf8"));
  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  const second = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.deepEqual(second, first);
  assert.equal(first.$schema, "https://custom/schema.json");
  assert.deepEqual(first.mcp.flowtask, { command: ["manual"], manual: true });
  assert.deepEqual(first.mcp.newMcp, { enabled: true });
  assert.equal(first.agent.runner.model, "manual");
  assert.equal(first.command.check.command, "manual");
  assert.equal(first.plugin.filter((entry) => entry.includes("flowtask-plugin")).length, 1);
  assert.ok(first.plugin.some((entry) => entry.includes("external")));
});
