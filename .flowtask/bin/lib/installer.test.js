import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { installManifestPlugins } from "./installer.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-installer-"));
  const flowtaskDir = path.join(root, "flowtask");
  fs.mkdirSync(path.join(flowtaskDir, "plugins"), { recursive: true });
  fixtures.push(root);
  return { root, flowtaskDir };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createManifest({ hookEnabled = false, tuiEnabled = false } = {}) {
  return [
    {
      name: "flowtask-classifier-hook",
      path: "flowtask-classifier-hook",
      kind: "server",
      destinations: ["opencode"],
      entrypoint: "dist/index.js",
      deprecated: true,
      enabled: hookEnabled,
    },
    {
      name: "flowtask-classifier-tui",
      path: "flowtask-classifier-tui",
      kind: "tui",
      destinations: ["opencode"],
      entrypoint: "dist/tui.js",
      deprecated: true,
      enabled: tuiEnabled,
    },
    {
      name: "flowtask-model-selector",
      path: "flowtask-model-selector",
      kind: "tui",
      destinations: ["opencode"],
      entrypoint: "dist/tui.js",
    },
  ];
}

function createSources(flowtaskDir, manifest) {
  for (const entry of manifest) {
    const entrypoint = path.join(flowtaskDir, "plugins", entry.path, entry.entrypoint);
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, `export default ${JSON.stringify(entry.name)};`, "utf8");
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function installedPluginEntries(configPath) {
  return readJson(configPath).plugin ?? [];
}

test("disabled default does not install classifier plugins", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest();
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), { plugin: [] });
  writeJson(path.join(root, ".opencode", "opencode.json"), { plugin: [] });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.equal(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-hook")), false);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-tui")), false);
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-model-selector")));
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    ".opencode/plugins/flowtask-model-selector/dist/tui.js",
  ]);
});

test("enabled pair installs and registers both classifier plugins", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest({ hookEnabled: true, tuiEnabled: true });
  createSources(flowtaskDir, manifest);

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-hook", "dist", "index.js")));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-tui", "dist", "tui.js")));
  assert.ok(installedPluginEntries(path.join(root, "tui.json")).some((entry) => entry.includes("flowtask-classifier-tui")));
  assert.ok(installedPluginEntries(path.join(root, ".opencode", "opencode.json")).some((entry) => entry.includes("flowtask-classifier-hook")));
});

test("mismatch removes both components and emits the exact deprecation alert once", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest({ hookEnabled: true, tuiEnabled: false });
  createSources(flowtaskDir, manifest);
  const pluginRoot = path.join(root, ".opencode", "plugins");
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-hook"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-tui"), { recursive: true });
  writeJson(path.join(root, "tui.json"), {
    plugin: [
      "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
      "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
    ],
  });
  writeJson(path.join(root, ".opencode", "opencode.json"), {
    plugin: [
      "./plugins/flowtask-classifier-hook/dist/index.js",
      "./plugins/flowtask-review-gate/dist/index.js",
    ],
  });

  const originalLog = console.log;
  const output = [];
  console.log = (message) => output.push(String(message));
  try {
    installManifestPlugins(root, manifest, flowtaskDir);
  } finally {
    console.log = originalLog;
  }

  assert.equal(fs.existsSync(path.join(pluginRoot, "flowtask-classifier-hook")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "flowtask-classifier-tui")), false);
  assert.equal(output.join("\n").split("el plugin de clasificación fue deprecado").length - 1, 1);
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    ".opencode/plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.deepEqual(installedPluginEntries(path.join(root, ".opencode", "opencode.json")), [
    "./plugins/flowtask-review-gate/dist/index.js",
  ]);
});

test("cleanup preserves unrelated plugin directories and config entries", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest();
  createSources(flowtaskDir, manifest);
  const pluginRoot = path.join(root, ".opencode", "plugins");
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-hook"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-tui"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "flowtask-model-selector"), { recursive: true });
  writeJson(path.join(root, "tui.json"), {
    "$schema": "https://opencode.ai/tui.json",
    keybinds: { input_submit: "return" },
    plugin: [
      "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
      "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
    ],
  });
  writeJson(path.join(root, ".opencode", "opencode.json"), {
    "$schema": "https://opencode.ai/config.json",
    plugin: [
      "./plugins/flowtask-classifier-hook/dist/index.js",
      "./plugins/flowtask-review-gate/dist/index.js",
      "./plugins/flowtask-context-checkpoint/index.ts",
    ],
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.ok(fs.existsSync(path.join(pluginRoot, "flowtask-model-selector")));
  assert.deepEqual(readJson(path.join(root, "tui.json")).keybinds, { input_submit: "return" });
  assert.deepEqual(installedPluginEntries(path.join(root, ".opencode", "opencode.json")), [
    "./plugins/flowtask-review-gate/dist/index.js",
    "./plugins/flowtask-context-checkpoint/index.ts",
  ]);
});

test("cleanup detects classifier paths without a leading slash", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest();
  const pluginRoot = path.join(root, ".opencode", "plugins");
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-hook"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "flowtask-classifier-tui"), { recursive: true });
  writeJson(path.join(root, "tui.json"), {
    plugin: ["plugins/flowtask-classifier-tui/dist/tui.js"],
  });
  writeJson(path.join(root, ".opencode", "opencode.json"), {
    plugin: ["plugins/flowtask-classifier-hook/dist/index.js"],
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.equal(fs.existsSync(path.join(pluginRoot, "flowtask-classifier-hook")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "flowtask-classifier-tui")), false);
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), []);
  assert.deepEqual(installedPluginEntries(path.join(root, ".opencode", "opencode.json")), []);
});
