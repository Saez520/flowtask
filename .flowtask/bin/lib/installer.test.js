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
  regenerateCanonicalCli,
  removeLegacyConsumerFiles,
  prepareInstallation,
  ASSETS,
} from "./installer.js";
import { showInteractiveSelector } from "./ui.js";
import { registerPluginArrayEntry } from "./opencode.js";
import { generateClaudeCommands } from "./claude.js";
import { verifyDirectoryMirror, copyDirectoryDelta } from "./copy.js";
import { CONTEXT_CHECKPOINT_NAME, CONTEXT_CHECKPOINT_SHA } from "./ownership.js";

const fixtures = [];
const FLOWTASK_CLI = fileURLToPath(new URL("../flowtask.js", import.meta.url));

test("mirror verification rejects missing, altered, and truncated files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-mirror-"));
  fixtures.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(source, "runner.md"), "descriptor\n");
  fs.copyFileSync(path.join(source, "runner.md"), path.join(target, "runner.md"));
  assert.equal(verifyDirectoryMirror(source, target), true);
  fs.writeFileSync(path.join(target, "runner.md"), "altered");
  assert.equal(verifyDirectoryMirror(source, target), false);
  fs.copyFileSync(path.join(source, "runner.md"), path.join(target, "runner.md"));
  fs.truncateSync(path.join(target, "runner.md"), 0);
  assert.equal(verifyDirectoryMirror(source, target), false);
  fs.copyFileSync(path.join(source, "runner.md"), path.join(target, "runner.md"));
  fs.rmSync(path.join(target, "runner.md"));
  assert.equal(verifyDirectoryMirror(source, target), false);
  fs.copyFileSync(path.join(source, "runner.md"), path.join(target, "runner.md"));
  fs.writeFileSync(path.join(target, "stale"), "stale");
  assert.equal(verifyDirectoryMirror(source, target), false);
  fs.rmSync(path.join(target, "stale"));
  fs.symlinkSync("runner.md", path.join(source, "runner-link"));
  fs.symlinkSync("runner.md", path.join(target, "runner-link"));
  assert.equal(verifyDirectoryMirror(source, target), true);
  fs.unlinkSync(path.join(target, "runner-link"));
  fs.symlinkSync("other", path.join(target, "runner-link"));
  assert.equal(verifyDirectoryMirror(source, target), false);
});

test("mirror verification accepts only the explicitly expected generated owner marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-marker-mirror-"));
  fixtures.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "index.ts"), "export {};\n");
  fs.copyFileSync(path.join(source, "index.ts"), path.join(target, "index.ts"));
  const markerPath = ".flowtask-plugin-owner.json";
  const marker = '{"managedBy":"flowtask"}\n';
  fs.writeFileSync(path.join(target, markerPath), marker);
  assert.equal(verifyDirectoryMirror(source, target, { expectedExtraFiles: { [markerPath]: marker } }), true);
  fs.writeFileSync(path.join(target, markerPath), '{"managedBy":"other"}\n');
  assert.equal(verifyDirectoryMirror(source, target, { expectedExtraFiles: { [markerPath]: marker } }), false);
  fs.writeFileSync(path.join(target, markerPath), marker);
  fs.writeFileSync(path.join(target, "stale"), "unexpected");
  assert.equal(verifyDirectoryMirror(source, target, { expectedExtraFiles: { [markerPath]: marker } }), false);
});

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

function treeDigest(root) {
  const rows = [];
  const walk = (current, relative = "") => {
    if (!fs.existsSync(current)) { rows.push(`${relative}|absent`); return; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) { rows.push(`${relative}|link|${fs.readlinkSync(current)}`); return; }
    if (stat.isFile()) {
      rows.push(`${relative}|file|${stat.mode & 0o7777}|${fs.readFileSync(current).toString("base64")}`);
      return;
    }
    rows.push(`${relative}|dir|${stat.mode & 0o7777}`);
    for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), path.posix.join(relative, name));
  };
  walk(root);
  return rows.join("\n");
}

function createPreflightFixture({ manifest = true, config, owner = "absent" } = {}) {
  const { root, flowtaskDir } = createFixture();
  const source = path.join(flowtaskDir, "plugins", CONTEXT_CHECKPOINT_NAME);
  fs.mkdirSync(source, { recursive: true });
  writeJson(path.join(source, "package.json"), { dependencies: { "@opencode/plugin": "2.0.27" } });
  fs.writeFileSync(path.join(source, "index.ts"), "export {}\n");
  if (manifest) writeJson(path.join(flowtaskDir, "plugins", "flowtask-plugins.json"), [{
    name: CONTEXT_CHECKPOINT_NAME, path: CONTEXT_CHECKPOINT_NAME, kind: "server",
    destinations: ["opencode"], entrypoint: "index.ts",
  }]);
  if (config !== undefined) writeJson(path.join(root, ".opencode", "opencode.json"), config);
  const dest = path.join(root, ".opencode", "plugins", CONTEXT_CHECKPOINT_NAME);
  if (owner === "ambiguous") {
    fs.mkdirSync(dest, { recursive: true });
    writeJson(path.join(dest, ".flowtask-plugin-owner.json"), { managedBy: "someone-else" });
  } else if (owner === "external") {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "user.txt"), "preserve me");
  }
  return { root, flowtaskDir };
}

test("install/update preflight rejects invalid inputs without mutating the sandbox", async (t) => {
  const cases = [
    ["missing manifest", { manifest: false }, /manifest/i],
    ["invalid manifest shape", { manifest: "invalid" }, /array/i],
    ["malformed config", { config: { plugins: "not-an-array" } }, /config/i],
    ["ambiguous ownership", { owner: "ambiguous" }, /ownership-ambiguous/i],
    ["external ownership", { owner: "external" }, /ownership-external/i],
  ];
  for (const [label, fixtureOptions, expected] of cases) {
    await t.test(label, async () => {
      const { root, flowtaskDir } = createPreflightFixture(fixtureOptions);
      if (fixtureOptions.manifest === "invalid") {
        writeJson(path.join(flowtaskDir, "plugins", "flowtask-plugins.json"), { not: "an array" });
      }
      const before = treeDigest(root);
      for (const mode of ["install", "update"]) {
        await assert.rejects(() => prepareInstallation(flowtaskDir, root, mode, {
          ensureSource: async () => ({ sourceCommit: CONTEXT_CHECKPOINT_SHA, sourceDir: path.join(flowtaskDir, "plugins", CONTEXT_CHECKPOINT_NAME) }),
        }), expected);
        assert.equal(treeDigest(root), before, `${mode} changed sandbox after ${label}`);
      }
    });
  }
  await t.test("unavailable source", async () => {
    const { root, flowtaskDir } = createPreflightFixture();
    const before = treeDigest(root);
    for (const mode of ["install", "update"]) {
      await assert.rejects(() => prepareInstallation(flowtaskDir, root, mode, {
        ensureSource: async () => { throw new Error("source unavailable"); },
      }), /source unavailable/);
      assert.equal(treeDigest(root), before, `${mode} changed sandbox after source failure`);
    }
  });
});

const canonicalRunnerPermission = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "subagent", resource: "flowtask-*", effect: "allow" },
  { action: "subagent", resource: "flowtask-runner", effect: "deny" },
  { action: "skill", resource: "*", effect: "allow" },
  { action: "engram_*", resource: "*", effect: "allow" },
];

function installedPluginEntries(configPath) {
  const config = readJson(configPath);
  return config.plugins ?? config.plugin ?? [];
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

test("CLI plugin installation writes V2 cli config and canonical declaration", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [{ name: "flowtask-model-selector", path: "flowtask-model-selector", kind: "cli", destinations: ["opencode"], entrypoint: "dist/tui.js" }];
  createSources(flowtaskDir, manifest);
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  writeJson(path.join(root, ".opencode", "cli.json"), { $schema: "https://opencode.ai/cli.json", plugins: ["./plugins/user-cli/index.js"] });
  installManifestPlugins(root, manifest, flowtaskDir);
  assert.deepEqual(readJson(path.join(root, ".opencode", "cli.json")).plugins, [
    "./plugins/user-cli/index.js", "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.deepEqual(readJson(path.join(flowtaskDir, "cli.json")).plugins, [
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "tui.json")), false);
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
      "./plugins/flowtask-permission-gate/dist/index.js",
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
    "./plugins/flowtask-permission-gate/dist/index.js",
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
      "./plugins/flowtask-permission-gate/dist/index.js",
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
      "./plugins/flowtask-permission-gate/dist/index.js",
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

test("standalone assets include scripts for the canonical root location", () => {
  assert.deepEqual(ASSETS.standalone.find(({ src }) => src === "scripts"), {
    src: "scripts",
    dest: "scripts",
  });
});

test("IDE assets include scripts in their target directories", () => {
  for (const id of ["opencode", "claude", "vscode"]) {
    assert.deepEqual(ASSETS[id].find(({ src }) => src === "scripts"), { src: "scripts", dest: "scripts" });
  }
});

test("canonical command source offers no retired command and still ships current ones", () => {
  const canonicalDir = fileURLToPath(new URL("../../commands", import.meta.url));
  const shipped = fs
    .readdirSync(canonicalDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));

  const retired = ["init", "new-ca", "run", "inspect", "evolve-agent", "status"];
  for (const name of retired) {
    assert.equal(shipped.includes(name), false, `retired command still shipped: ${name}`);
  }

  for (const name of ["init-types", "init-data", "init-business", "init-config", "init-api", "onboard", "update"]) {
    assert.equal(shipped.includes(name), true, `current command missing from canonical source: ${name}`);
  }
});

test("the canonical manifest offers no retired command entry", () => {
  const manifest = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../../../opencode.json", import.meta.url)), "utf8"),
  );
  const offered = Object.keys(manifest.commands ?? manifest.command ?? {});

  for (const name of ["init", "new-ca", "run", "inspect", "evolve-agent", "status"]) {
    assert.equal(offered.includes(name), false, `retired command still offered by manifest: ${name}`);
  }
  for (const name of ["init-types", "init-data", "init-business", "init-config", "init-api", "onboard", "update"]) {
    assert.equal(offered.includes(name), true, `current command missing from manifest: ${name}`);
  }
});

test("Claude generation produces current commands and never re-creates retired ones", () => {
  const { root, flowtaskDir } = createFixture();
  const commandsSrc = path.join(flowtaskDir, "commands");
  fs.mkdirSync(commandsSrc, { recursive: true });
  fs.writeFileSync(path.join(commandsSrc, "update.md"), "---\ndescription: current\n---\nbody\n", "utf8");
  fs.writeFileSync(path.join(commandsSrc, "run.md"), "---\ndescription: retired\n---\nbody\n", "utf8");

  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });

  const { generated } = generateClaudeCommands(flowtaskDir, projectDir);
  const destDir = path.join(projectDir, ".claude", "commands");

  assert.equal(generated, 2);
  assert.equal(fs.existsSync(path.join(destDir, "update.md")), true);

  fs.rmSync(path.join(commandsSrc, "run.md"));
  const second = generateClaudeCommands(flowtaskDir, projectDir);

  assert.equal(second.generated, 1);
  assert.equal(fs.existsSync(path.join(destDir, "update.md")), true, "current command lost");
  // A pre-existing destination is left untouched on purpose: this CA adds no
  // consumer-cleanup routine, so removal only prevents future regeneration.
  assert.equal(fs.existsSync(path.join(destDir, "run.md")), true);
});

test("update integrates config and cleans legacy scripts into an installed target", () => {
  const { root, flowtaskDir } = createFixture();
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
  fs.mkdirSync(path.join(root, ".flowtask", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".flowtask", "scripts", "worktree.sh"), "legacy", "utf8");
  const targetDir = path.join(root, ".opencode", "flowtask");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, ".installation-method"), JSON.stringify({ target: "opencode" }));
  writeJson(path.join(root, ".flowtask", "config", "profile.json"), {
    level: "senior",
    persona: "tutor-senior",
    onboarded: true,
  });
  writeJson(path.join(root, ".flowtask", "opencode.json"), {
    default_agent: "flowtask-runner",
    agents: { "flowtask-runner": { permissions: canonicalRunnerPermission, task: { legacy: "keep" } } },
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
  assert.ok(updatedConfig.agents["flowtask-validator"], "update must merge the new canonical agent");
  assert.equal(updatedConfig.agents["flowtask-validator"].system, "{file:flowtask/agents/validator.md}");
  assert.equal(updatedConfig.default_agent, "flowtask-runner");
  assert.deepEqual(updatedConfig.agents.existing, { description: "manual" });
  assert.equal(Object.hasOwn(updatedConfig.agents["flowtask-runner"], "permission"), false);
  assert.equal(Object.hasOwn(updatedConfig, "plugin"), false);
  assert.ok(updatedConfig.agents["flowtask-runner"]);
  // The V2 runner permissions remain enforced in the installed target.
  const permission = canonicalRunnerPermission;
  assert.equal(updatedConfig.agents["flowtask-runner"].permissions[0].action, permission[0].action);
  assert.ok(updatedConfig.agents["flowtask-runner"].permissions.some(
    ({ action, resource, effect }) => action === "subagent" && resource === "flowtask-runner" && effect === "deny",
  ));
  assert.ok(updatedConfig.agents["flowtask-runner"].permissions.some(
    ({ action, resource, effect }) => action === "shell" && resource.startsWith("git status") && effect === "allow",
  ));
  assert.equal(Object.hasOwn(updatedConfig.agents["flowtask-runner"], "permission"), false);
  const installedScript = path.join(root, ".opencode", "flowtask", "scripts", "worktree.sh");
  assert.ok(fs.existsSync(installedScript));
  assert.equal(fs.statSync(installedScript).mode & 0o111, 0o111);
  assert.equal(fs.existsSync(path.join(root, ".flowtask", "scripts")), false);
});

test("update fails closed before writers when canonical source has no Git publication metadata", () => {
  const { root } = createFixture();
  const flowtaskDir = path.join(root, ".flowtask");
  fs.cpSync(path.resolve(path.dirname(FLOWTASK_CLI), ".."), flowtaskDir, { recursive: true });
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "source\n", "utf8");
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "lib", "worktree-manager-core.sh"), "canonical-core\n", "utf8");

  const targetDir = path.join(root, ".opencode", "flowtask");
  fs.mkdirSync(path.join(targetDir, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(targetDir, "scripts", "worktree.sh"), "stale\n", "utf8");
  fs.writeFileSync(path.join(targetDir, "scripts", "lib", "worktree-manager-core.sh"), "stale-core\n", "utf8");
  fs.writeFileSync(path.join(targetDir, ".installation-method"), JSON.stringify({ target: "opencode" }));
  writeJson(path.join(flowtaskDir, "config", "profile.json"), {
    level: "senior",
    persona: "tutor-senior",
    onboarded: true,
  });
  writeJson(path.join(flowtaskDir, "opencode.json"), {
    agent: { "flowtask-runner": { permission: canonicalRunnerPermission } },
  });
  writeJson(path.join(root, ".opencode", "opencode.json"), {
    agent: { existing: { description: "manual" } },
  });

  const originCli = path.join(flowtaskDir, "bin", "flowtask.js");
  const result = spawnSync(process.execPath, [originCli, "update", "--persona", "senior"], {
    cwd: root,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "xdg-config") },
    input: "n\n",
    encoding: "utf8",
    timeout: 120000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Worktree Manager submodule unavailable/i);
  assert.ok(fs.existsSync(path.join(root, ".flowtask", "scripts")));
  assert.equal(fs.readFileSync(path.join(root, ".flowtask", "scripts", "worktree.sh"), "utf8"), "source\n");
  assert.equal(fs.readFileSync(path.join(targetDir, "scripts", "worktree.sh"), "utf8"), "stale\n");
  assert.equal(fs.readFileSync(path.join(flowtaskDir, "scripts", "lib", "worktree-manager-core.sh"), "utf8"), "canonical-core\n");
  assert.equal(fs.readFileSync(path.join(targetDir, "scripts", "lib", "worktree-manager-core.sh"), "utf8"), "stale-core\n");
  assert.doesNotMatch(result.stdout, /Legacy scripts cleaned/);
});

test("Runner worktree contract keeps init opt-in and excludes CA2 routing", () => {
  const source = path.resolve(path.dirname(FLOWTASK_CLI), "..", "agents", "runner.md");
  const runner = fs.readFileSync(source, "utf8");
  const invocations = runner.match(/\$\{FLOWTASK_SCRIPTS\}\/worktree\.sh (?:create|complete)[^\n]*/g) ?? [];
  assert.ok(invocations.length >= 2);
  for (const invocation of invocations) {
    assert.match(invocation, /--base/);
    assert.doesNotMatch(invocation, /--(?:target|repo|parent-repo)|link-parent/);
  }
  assert.match(runner, /init_submodules/);
  assert.match(runner, /--init-submodules/);
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
  const { root, flowtaskDir } = createFixture();
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
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
  const installedScript = path.join(root, ".opencode", "flowtask", "scripts", "worktree.sh");
  assert.ok(fs.existsSync(installedScript));
  assert.equal(fs.statSync(installedScript).mode & 0o111, 0o111);
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

test("scripts distribution carries the wrapper and adapter without legacy implementations", () => {
  const source = path.resolve(path.dirname(FLOWTASK_CLI), "..");
  assert.ok(
    ASSETS.opencode.some(({ src, dest }) => src === "scripts" && dest === "scripts"),
    "opencode debe distribuir scripts/"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-scripts-dist-"));
  fixtures.push(root);
  const flowtaskDir = path.join(root, "flowtask");
  copyDirectoryDelta(path.join(source, "scripts"), path.join(flowtaskDir, "scripts"));

  const wrapper = path.join(flowtaskDir, "scripts", "worktree.sh");
  const adapter = path.join(flowtaskDir, "scripts", "worktree-adapter.sh");
  assert.ok(fs.existsSync(wrapper), "el wrapper público debe distribuirse");
  assert.ok(fs.existsSync(adapter), "el adapter debe distribuirse junto al wrapper");
  assert.equal(fs.existsSync(path.join(flowtaskDir, "scripts", "lib", "worktree-manager-core.sh")), false);
  assert.equal(fs.existsSync(path.join(flowtaskDir, "scripts", "lib", "worktree-manager-target-direct.sh")), false);
  assert.equal(fs.existsSync(path.join(flowtaskDir, "scripts", "worktree-manager")), false,
    "el gitlink se materializa desde la fuente canónica, no como una copia del payload");

  const usage = spawnSync(wrapper, ["--help"], { encoding: "utf8" });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /standalone ausente o no inicializado/);
});
