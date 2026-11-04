import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("canonical child agent frontmatter remains selectable in the materialized V2 config", () => {
  const manifestPath = fileURLToPath(new URL("../../../opencode.json", import.meta.url));
  const agentsDir = fileURLToPath(new URL("../../agents/", import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const childAgents = Object.entries(manifest.agents)
    .filter(([name]) => name !== "flowtask-runner");

  assert.ok(childAgents.length > 0);
  for (const [name, declaration] of childAgents) {
    const sourceName = name.replace(/^flowtask-/, "");
    const source = fs.readFileSync(path.join(agentsDir, `${sourceName}.md`), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/m)?.[1] ?? "";

    assert.match(frontmatter, /^hidden:\s*false\s*$/m, `${name} source must be selectable`);
    assert.equal(declaration.hidden, false, `${name} materialized declaration must be selectable`);
    assert.equal(declaration.mode, "subagent", `${name} must remain a child agent`);
  }

  assert.equal(manifest.agents["flowtask-runner"].mode, "primary");
  assert.equal(manifest.agents["flowtask-runner"].hidden, false);
  assert.ok(manifest.agents["flowtask-runner"].permissions.some(
    ({ action, resource, effect }) => action === "subagent" && resource === "flowtask-*" && effect === "allow",
  ));
  assert.ok(manifest.agents["flowtask-runner"].permissions.some(
    ({ action, resource, effect }) => action === "subagent" && resource === "flowtask-runner" && effect === "deny",
  ));
});

test("merge removes legacy Runner permission while preserving unrelated config", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    agents: { "flowtask-runner": { description: "canonical" } },
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
  assert.equal(Object.hasOwn(first.agents["flowtask-runner"], "permission"), false);
  assert.deepEqual(first.agents["flowtask-runner"].task, { old: "allow" });
  assert.deepEqual(first.agents.unrelated, { model: "manual" });
  assert.deepEqual(first.mcp.external, { enabled: true });
  assert.deepEqual(first.command.custom, { template: "keep" });
  assert.equal(output.some((line) => line.includes("política canónica gestionada")), false);
  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), first);
});

test("merge installs the canonical default agent and preserves a manual update", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    default_agent: "flowtask-runner",
    agents: { "flowtask-runner": { description: "canonical" } },
  });
  const configPath = path.join(root, ".opencode", "opencode.json");
  writeJson(configPath, { mcp: { external: { enabled: true } } });

  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  const installed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(installed.default_agent, "flowtask-runner");
  assert.deepEqual(installed.mcp.external, { enabled: true });

  installed.default_agent = "manual-agent";
  writeJson(configPath, installed);
  mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).default_agent, "manual-agent");
});

test("merge preserves manual values and repairs duplicate plugins idempotently", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    mcp: { flowtask: { command: ["canonical"] }, newMcp: { enabled: true } },
    agents: { runner: { model: "canonical" } },
    commands: { check: { command: "canonical" } },
    plugins: [".opencode/plugins/flowtask-plugin/index.js"],
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
  assert.equal(first.agents.runner.model, "manual");
  assert.equal(first.commands.check.command, "manual");
  assert.equal(first.plugins.filter((entry) => entry.includes("flowtask-plugin")).length, 1);
  assert.ok(first.plugins.some((entry) => entry.includes("external")));
  assert.equal(Object.hasOwn(first, "plugin"), false);
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

/*
 * gap_ref: C3
 * criterio: con búsqueda global existente y copia local, install/update elimina
 *   la copia local del target, preserva la global y muestra lo retirado.
 * defecto: un update que conserve o reintroduzca la copia local pasaría
 *   inadvertido.
 * why_not_detected: no había prueba que montara global y local simultáneos;
 *   la expectativa anterior solo afirmaba la fusión canónica.
 * comportamiento observable: el merge devuelve removedFerrisSearch=true la
 *   primera vez, el target queda sin mcp.ferris-search, la configuración global
 *   conserva sus bytes y la segunda ejecución devuelve false sin reescribir.
 */
test("merge removes the project-local web search while preserving the existing user configuration", () => {
  const { root, flowtaskDir } = fixture();
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    mcp: {
      engram: { type: "local", command: ["engram", "mcp"] },
      "ferris-search": { type: "local", command: ["ferris-search"], enabled: true },
    },
  });

  const homeDir = path.join(root, "home");
  const globalConfigPath = path.join(homeDir, ".config", "opencode", "opencode.json");
  writeJson(globalConfigPath, {
    $schema: "https://opencode.ai/config.json",
    theme: "system",
    mcp: {
      "ferris-search": {
        type: "local",
        command: ["ferris-search"],
        env: { DEFAULT_SEARCH_ENGINE: "bing" },
        enabled: true,
      },
    },
  });
  const globalBefore = fs.readFileSync(globalConfigPath);

  const configPath = path.join(root, "project", ".opencode", "opencode.json");
  writeJson(configPath, {
    $schema: "https://custom/schema.json",
    mcp: {
      external: { enabled: true },
      "ferris-search": { type: "local", command: ["ferris-search"], enabled: true },
    },
  });

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const first = mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
    assert.equal(first.ok, true);
    assert.equal(first.removedFerrisSearch, true);

    const merged = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(Object.hasOwn(merged.mcp, "ferris-search"), false);
    assert.deepEqual(merged.mcp.external, { enabled: true });
    assert.deepEqual(merged.mcp.engram, { type: "local", command: ["engram", "mcp"] });
    assert.deepEqual(fs.readFileSync(globalConfigPath), globalBefore);

    const firstBytes = fs.readFileSync(configPath);
    const second = mergeOpencodeConfig(configPath, flowtaskDir, ".opencode");
    assert.equal(second.ok, true);
    assert.equal(second.removedFerrisSearch, false);
    assert.deepEqual(fs.readFileSync(configPath), firstBytes);
    assert.deepEqual(fs.readFileSync(globalConfigPath), globalBefore);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
