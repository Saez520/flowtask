import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { mergeOpencodeConfig, registerPluginArrayEntry } from "./opencode.js";

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

test("merge removes legacy Runner permission while preserving unrelated config", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    agent: { "flowtask-runner": { description: "canonical" } },
  });
  const configPath = path.join(root, ".opencode", "opencode.json");
  writeJson(configPath, {
    $schema: "https://custom/schema.json",
    mcp: { external: { enabled: true } },
    agent: {
      unrelated: { model: "manual" },
      "flowtask-runner": {
        permission: { bash: "allow", task: { old: "allow" }, "*": "deny" },
        task: { old: "allow" },
      },
    },
    command: { custom: { template: "keep" } },
  });
  const output = [];
  const originalLog = console.log;
  console.log = (message) => output.push(String(message));
  try {
    mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  } finally {
    console.log = originalLog;
  }
  const first = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(Object.hasOwn(first.agent["flowtask-runner"], "permission"), false);
  assert.deepEqual(first.agent["flowtask-runner"].task, { old: "allow" });
  assert.deepEqual(first.agent.unrelated, { model: "manual" });
  assert.deepEqual(first.mcp.external, { enabled: true });
  assert.deepEqual(first.command.custom, { template: "keep" });
  assert.equal(output.some((line) => line.includes("política canónica gestionada")), false);
  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), first);
});

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

test("register replaces FlowTask objects without disturbing third-party entries", () => {
  const { root } = fixture();
  const configPath = path.join(root, ".opencode", "tui.json");
  writeJson(configPath, {
    $schema: "https://custom/tui-schema.json",
    keybinds: { input_submit: "return" },
    plugin: [
      { path: "./plugins/flowtask-model-selector/old.js", enabled: false },
      "./plugins/external/index.js",
      { path: ".\\plugins\\flowtask-model-selector\\duplicate.js" },
    ],
  });

  assert.equal(registerPluginArrayEntry(configPath, "./plugins/flowtask-model-selector/dist/tui.js"), true);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config.keybinds, { input_submit: "return" });
  assert.equal(config.plugin.filter((entry) => JSON.stringify(entry).includes("flowtask-model-selector")).length, 1);
  assert.deepEqual(config.plugin[1], "./plugins/external/index.js");
});

test("invalid existing TUI config fails without replacing it", () => {
  const { root } = fixture();
  const configPath = path.join(root, ".opencode", "tui.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const original = "{ invalid tui config\n";
  fs.writeFileSync(configPath, original);

  assert.equal(registerPluginArrayEntry(configPath, "./plugins/flowtask-model-selector/dist/tui.js"), false);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});
