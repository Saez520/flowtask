import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import {
  installManifestPlugins,
  migrateProfileLocation,
  syncTargetConfig,
  regenerateCanonicalTui,
  removeLegacyConsumerFiles,
} from "./installer.js";
import { showInteractiveSelector } from "./ui.js";
import { registerPluginArrayEntry } from "./opencode.js";

const fixtures = [];
const FLOWTASK_CLI = fileURLToPath(new URL("../flowtask.js", import.meta.url));

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

const canonicalRunnerPermission = {
  "*": "deny",
  bash: {
    "*": "deny",
    "node .flowtask/bin/flowtask.js graphify *": "allow",
    "git status": "allow", "git add": "allow", "git restore --staged": "allow",
    "git commit": "allow", "git push": "allow", "git merge": "allow",
    "./.flowtask/scripts/worktree.sh create": "allow",
    "./.flowtask/scripts/worktree.sh complete": "allow",
    "./.flowtask/scripts/worktree.sh list": "allow",
  },
  task: {
    "*": "deny", "flowtask-ca-writer": "allow", "flowtask-planner": "allow",
    "flowtask-plan-auditor": "allow", "flowtask-constructor": "allow",
    "flowtask-validator": "allow", "flowtask-initializer": "allow", "flowtask-logger": "allow",
    "flowtask-tester": "allow", "flowtask-review-orchestrator": "allow",
    "flowtask-inspector": "allow", "flowtask-onboarder": "allow",
    "flowtask-graphify-docs-media": "allow", "flowtask-runner": "deny",
  },
  skill: "allow", "engram_*": "allow",
};

function installedPluginEntries(configPath) {
  return readJson(configPath).plugin ?? [];
}

function nativeTuiEntries(root) {
  return installedPluginEntries(path.join(root, ".opencode", "tui.json"));
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
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
});

test("enabled pair installs and registers both classifier plugins", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest({ hookEnabled: true, tuiEnabled: true });
  createSources(flowtaskDir, manifest);

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-hook", "dist", "index.js")));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "flowtask-classifier-tui", "dist", "tui.js")));
  assert.ok(nativeTuiEntries(root).some((entry) => entry.includes("flowtask-classifier-tui")));
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
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
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
      "./plugins/user-tui/dist/index.js",
    ],
  });
  writeJson(path.join(root, ".opencode", "tui.json"), {
    "$schema": "https://custom/tui-schema.json",
    keybinds: { input_submit: "tab" },
    plugin: ["./plugins/user-tui/dist/index.js"],
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
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
    "./plugins/user-tui/dist/index.js",
  ]);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/user-tui/dist/index.js",
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.deepEqual(readJson(path.join(root, ".opencode", "tui.json")).keybinds, { input_submit: "tab" });
  assert.equal(readJson(path.join(root, ".opencode", "tui.json")).$schema, "https://custom/tui-schema.json");
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
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "plugins/flowtask-classifier-tui/dist/tui.js",
  ]);
  assert.deepEqual(installedPluginEntries(path.join(root, ".opencode", "opencode.json")), []);
});

test("target selector rejects non-TTY stdin without touching raw mode", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  try {
    await assert.rejects(() => showInteractiveSelector({}), /No hay TTY/);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else delete process.stdin.isTTY;
  }
});

test("update integrates the canonical OpenCode config into an installed target", () => {
  const { root } = createFixture();
  const targetDir = path.join(root, ".opencode", "flowtask");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, ".installation-method"), JSON.stringify({ target: "opencode" }));
  writeJson(path.join(root, ".flowtask", "config", "profile.json"), {
    level: "senior",
    persona: "tutor-senior",
    onboarded: true,
  });
  writeJson(path.join(root, ".flowtask", "opencode.json"), {
    agent: { "flowtask-runner": { permission: canonicalRunnerPermission } },
  });
  writeJson(path.join(root, ".opencode", "opencode.json"), {
    $schema: "https://custom/schema.json",
    agent: { existing: { description: "manual" } },
  });

  const result = spawnSync(process.execPath, [FLOWTASK_CLI, "update", "--persona", "senior"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "xdg-config") },
    input: "n\n",
    encoding: "utf8",
    timeout: 120000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const updatedConfig = readJson(path.join(root, ".opencode", "opencode.json"));
  assert.ok(updatedConfig.agent["flowtask-validator"], "update must merge the new canonical agent");
  assert.equal(updatedConfig.agent["flowtask-validator"].prompt, "{file:flowtask/agents/validator.md}");
  assert.deepEqual(updatedConfig.agent.existing, { description: "manual" });
  const permission = updatedConfig.agent["flowtask-runner"].permission;
  assert.deepEqual(Object.keys(permission), ["*", "bash", "task", "skill", "engram_*"]);
  assert.equal(Object.keys(permission.bash)[0], "*");
  assert.equal(Object.keys(permission.task)[0], "*");
  assert.equal(Object.keys(permission.task).at(-1), "flowtask-runner");
  assert.equal(permission.skill, "allow");
  assert.equal(permission["engram_*"], "allow");
  assert.equal(Object.hasOwn(updatedConfig.agent["flowtask-runner"], "task"), false);
});

test("writes TUI only in the native consumer manifest", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest();
  createSources(flowtaskDir, manifest);

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.ok(fs.existsSync(path.join(root, ".opencode", "tui.json")));
  assert.equal(fs.existsSync(path.join(flowtaskDir, "tui.json")), false);
  assert.equal(fs.existsSync(path.join(root, "tui.json")), false);
});

test("migrates a legacy profile only after destination verification", () => {
  const { root, flowtaskDir } = createFixture();
  const legacy = path.join(root, ".flowtask", "profile.json");
  writeJson(legacy, { level: "senior", persona: "tutor-senior", onboarded: true });

  assert.equal(migrateProfileLocation(root, flowtaskDir), true);
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(readJson(path.join(flowtaskDir, "config", "profile.json")), {
    level: "senior", persona: "tutor-senior", onboarded: true,
  });
});

test("preserves legacy profile when installation destination cannot be written", () => {
  const { root } = createFixture();
  const legacy = path.join(root, ".flowtask", "profile.json");
  writeJson(legacy, { level: "senior" });

  const output = [];
  const originalLog = console.log;
  console.log = (message) => output.push(String(message));
  try {
    assert.equal(migrateProfileLocation(root, "/dev/null/flowtask"), false);
  } finally {
    console.log = originalLog;
  }

  assert.equal(fs.existsSync(legacy), true);
  assert.ok(output.join("\n").includes("reintenta con flowtask update"));
});

test("materializes managed config and profile independently for three targets", () => {
  const { root, flowtaskDir } = createFixture();
  writeJson(path.join(flowtaskDir, "config", "review.json"), {
    enabled: true,
    stampPath: ".flowtask/config/.review-stamp",
    criticalPaths: ["**/security/**"],
    diffThreshold: 10,
  });
  const targets = [
    ["opencode", path.join(root, ".opencode", "flowtask"), "senior"],
    ["claude", path.join(root, ".claude", "flowtask"), "mid"],
    ["vscode", path.join(root, ".vscode", "flowtask"), "training"],
  ];

  for (const [, targetDir, level] of targets) {
    syncTargetConfig(flowtaskDir, targetDir, { level, persona: `tutor-${level}`, onboarded: true });
    const configDir = path.join(targetDir, "config");
    assert.ok(fs.existsSync(path.join(configDir, "review.json")));
    assert.deepEqual(readJson(path.join(configDir, "profile.json")), {
      level, persona: `tutor-${level}`, onboarded: true,
    });
    assert.equal(readJson(path.join(configDir, "review.json")).stampPath,
      path.relative(root, path.join(configDir, ".review-stamp")));
    assert.equal(fs.existsSync(path.join(root, ".flowtask", "config", "review.json")), false);
  }
});

test("fans out legacy profile and preserves it when one target fails", () => {
  const { root } = createFixture();
  const legacy = path.join(root, ".flowtask", "profile.json");
  const profile = { level: "senior", persona: "tutor-senior", onboarded: true };
  writeJson(legacy, profile);
  const targets = [
    path.join(root, ".opencode", "flowtask"),
    path.join(root, ".claude", "flowtask"),
    "/dev/null/flowtask",
  ];

  assert.equal(migrateProfileLocation(root, path.join(root, ".flowtask"), targets), false);
  assert.equal(fs.existsSync(legacy), true);
  assert.deepEqual(readJson(path.join(targets[0], "config", "profile.json")), profile);
  assert.deepEqual(readJson(path.join(targets[1], "config", "profile.json")), profile);
});

test("update preserves divergent valid profiles independently across two targets", () => {
  const { root } = createFixture();
  const targets = [
    ["opencode", ".opencode/flowtask", { level: "senior", persona: "tutor-senior", onboarded: true }],
    ["claude", ".claude/flowtask", { level: "mid", persona: "tutor-mid", onboarded: true }],
    ["vscode", ".vscode/flowtask", { level: "training", persona: "tutor-training", onboarded: true }],
  ];
  for (const [id, subDir, profile] of targets) {
    const targetDir = path.join(root, subDir);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".installation-method"), JSON.stringify({ target: id }));
    writeJson(path.join(targetDir, "config", "profile.json"), profile);
  }
  const result = spawnSync(process.execPath, [FLOWTASK_CLI, "update"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "xdg-config") },
    input: "n\nn\nn\n",
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readJson(path.join(root, ".opencode/flowtask/config/profile.json")), targets[0][2]);
  assert.deepEqual(readJson(path.join(root, ".claude/flowtask/config/profile.json")), targets[1][2]);
  assert.deepEqual(readJson(path.join(root, ".vscode/flowtask/config/profile.json")), targets[2][2]);
});

test("does not accept a TUI write failure as a successful registration", () => {
  assert.equal(
    registerPluginArrayEntry("/dev/null/flowtask/tui.json", "../.opencode/plugins/flowtask-model-selector/dist/tui.js"),
    false,
  );
});

test("does not remove a manifest TUI entry when its source was not copied", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = createManifest({ hookEnabled: true, tuiEnabled: true });
  createSources(flowtaskDir, manifest.slice(0, 2));
  writeJson(path.join(root, "tui.json"), {
    plugin: [
      "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
      "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
      "./plugins/user-tui/dist/index.js",
    ],
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
    "./plugins/user-tui/dist/index.js",
  ]);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/flowtask-classifier-tui/dist/tui.js",
  ]);
});

test("preserves an unmanifested TUI plugin even when its source exists", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), {
    plugin: ["./.opencode/plugins/flowtask-unmanaged/dist/tui.js"],
  });
  fs.mkdirSync(path.join(flowtaskDir, "plugins", "flowtask-unmanaged"), { recursive: true });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-unmanaged/dist/tui.js",
  ]);
});

test("preserves an unmanifested TUI plugin when its source is absent", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), {
    plugin: ["./.opencode/plugins/flowtask-unmanaged/dist/tui.js"],
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-unmanaged/dist/tui.js",
  ]);
});

test("preserves a legacy entry when installation TUI registration fails", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  fs.mkdirSync(path.join(root, ".opencode", "tui.json"), { recursive: true });
  writeJson(path.join(root, "tui.json"), {
    plugin: ["./.opencode/plugins/flowtask-model-selector/dist/tui.js"],
  });

  assert.throws(() => installManifestPlugins(root, manifest, flowtaskDir));
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "tui.json")), true);
});

test("removes duplicate legacy entries when one TUI plugin is migrated", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), {
    plugin: [
      "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
      "./plugins/user-tui/dist/index.js",
      "./.opencode/plugins/flowtask-model-selector/dist/tui.js",
    ],
  });

  installManifestPlugins(root, manifest, flowtaskDir);
  const firstNative = fs.readFileSync(path.join(root, ".opencode", "tui.json"), "utf8");
  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./plugins/user-tui/dist/index.js",
  ]);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.equal(fs.readFileSync(path.join(root, ".opencode", "tui.json"), "utf8"), firstNative);
});

test("regenerates canonical standalone TUI and discards contaminated residual", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(flowtaskDir, "tui.json"), {
    plugin: ["/Users/other-project/ClipLab/plugins/foreign/dist/tui.js"],
  });
  writeJson(path.join(root, "tui.json"), {
    plugin: ["./.opencode/plugins/flowtask-model-selector/dist/tui.js"],
  });

  regenerateCanonicalTui(root, flowtaskDir, manifest);
  assert.deepEqual(readJson(path.join(flowtaskDir, "tui.json")), {
    $schema: "https://opencode.ai/tui.json",
    plugin: ["./plugins/flowtask-model-selector/dist/tui.js"],
  });
  assert.equal(removeLegacyConsumerFiles(root, ["tui.json"]), true);
  assert.equal(fs.existsSync(path.join(root, "tui.json")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(flowtaskDir, "tui.json"), "utf8"), /ClipLab/);
});

test("regenerates an empty canonical TUI from an empty manifest", () => {
  const { root, flowtaskDir } = createFixture();

  regenerateCanonicalTui(root, flowtaskDir, []);

  assert.deepEqual(readJson(path.join(flowtaskDir, "tui.json")), {
    $schema: "https://opencode.ai/tui.json",
    plugin: [],
  });
});

test("preserves legacy keybinds and other top-level fields before removing root TUI", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), {
    $schema: "https://legacy.example/tui.json",
    keybinds: { input_newline: "shift+return", input_submit: "return" },
    theme: "custom-dark",
    editor: { tabSize: 4 },
    plugin: ["./plugins/user-tui/dist/index.js"],
  });

  regenerateCanonicalTui(root, flowtaskDir, manifest);

  assert.deepEqual(readJson(path.join(flowtaskDir, "tui.json")), {
    keybinds: { input_newline: "shift+return", input_submit: "return" },
    theme: "custom-dark",
    editor: { tabSize: 4 },
    $schema: "https://opencode.ai/tui.json",
    plugin: ["./plugins/flowtask-model-selector/dist/tui.js"],
  });
  assert.equal(removeLegacyConsumerFiles(root, ["tui.json"]), true);
  assert.equal(fs.existsSync(path.join(root, "tui.json")), false);

  const first = fs.readFileSync(path.join(flowtaskDir, "tui.json"));
  regenerateCanonicalTui(root, flowtaskDir, manifest);
  assert.deepEqual(fs.readFileSync(path.join(flowtaskDir, "tui.json")), first);
});

test("legacy CLAUDE.md cleanup is idempotent and does not recreate the file", () => {
  const { root } = createFixture();
  const claudePath = path.join(root, "CLAUDE.md");
  fs.writeFileSync(claudePath, "residuo local", "utf8");

  assert.equal(removeLegacyConsumerFiles(root, ["CLAUDE.md"]), true);
  assert.equal(removeLegacyConsumerFiles(root, ["CLAUDE.md"]), true);
  assert.equal(fs.existsSync(claudePath), false);
});

test("canonical TUI bytes remain identical on a second regeneration", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);

  regenerateCanonicalTui(root, flowtaskDir, manifest);
  const first = fs.readFileSync(path.join(flowtaskDir, "tui.json"));
  regenerateCanonicalTui(root, flowtaskDir, manifest);
  assert.deepEqual(fs.readFileSync(path.join(flowtaskDir, "tui.json")), first);
});
