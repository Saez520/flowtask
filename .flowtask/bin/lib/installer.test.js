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
  prepareGlobalWorktreeManager,
  reportWorktreeManagerCapabilities,
  detectWorktreeManagerCapabilities,
  ASSETS,
} from "./installer.js";
import { showInteractiveSelector } from "./ui.js";
import { registerPluginArrayEntry, mergeOpencodeConfig } from "./opencode.js";
import { generateClaudeCommands } from "./claude.js";
import { verifyDirectoryMirror, copyDirectoryDelta, copyWithProgress, pruneDirectoryExtras } from "./copy.js";
import { CONTEXT_CHECKPOINT_NAME, CONTEXT_CHECKPOINT_SHA } from "./ownership.js";
import { readComposedRunner } from "../test/helpers/runner-document.js";

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

test("prunes a destination-only worktree.md and verifies the mirror", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "worktree.md"), "stale");
  pruneDirectoryExtras(source, target);
  assert.equal(fs.existsSync(path.join(target, "worktree.md")), false);
  assert.equal(verifyDirectoryMirror(source, target), true);
});

test("prunes homonymous files inside destination-only directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-nested-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(path.join(target, "orphan"), { recursive: true });
  fs.writeFileSync(path.join(source, "same.txt"), "current");
  fs.copyFileSync(path.join(source, "same.txt"), path.join(target, "same.txt"));
  fs.writeFileSync(path.join(target, "orphan", "same.txt"), "stale");
  assert.ok(pruneDirectoryExtras(source, target).removed > 0);
  assert.equal(fs.existsSync(path.join(target, "orphan", "same.txt")), false);
  assert.equal(verifyDirectoryMirror(source, target), true);
});

test("install and update production-order asset sync resolve both file-directory type changes", () => {
  for (const mode of ["install", "update"]) {
    for (const direction of ["file-to-directory", "directory-to-file"]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `flowtask-${mode}-${direction}-`)); fixtures.push(root);
      const source = path.join(root, "source"), target = path.join(root, "target");
      fs.mkdirSync(source); fs.mkdirSync(target);
      if (direction === "file-to-directory") {
        fs.mkdirSync(path.join(source, "typechange"), { recursive: true });
        fs.writeFileSync(path.join(source, "typechange", "new"), "fresh");
        fs.writeFileSync(path.join(target, "typechange"), "old file");
      } else {
        fs.writeFileSync(path.join(source, "typechange"), "fresh file");
        fs.mkdirSync(path.join(target, "typechange"), { recursive: true });
        fs.writeFileSync(path.join(target, "typechange", "old"), "stale");
      }

      let pruned;
      if (mode === "install") {
        pruned = pruneDirectoryExtras(source, target);
        copyWithProgress(source, target, "test", { cursorTo() {}, clearLine() {} });
      } else {
        fs.writeFileSync(path.join(target, "orphan-destination-only"), "stale");
        copyDirectoryDelta(source, target, []);
        pruned = pruneDirectoryExtras(source, target);
      }
      assert.equal(verifyDirectoryMirror(source, target, { ignorePaths: pruned.preserved }), true, `${mode} ${direction}`);
    }
  }
});

test("preserves and ignores a matching preservePaths fragment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-preserve-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "local-preserved.txt"), "local");
  const result = pruneDirectoryExtras(source, target, { preservePaths: ["preserved.txt"] });
  assert.equal(fs.readFileSync(path.join(target, "local-preserved.txt"), "utf8"), "local");
  assert.deepEqual(result.preserved, ["local-preserved.txt"]);
  assert.equal(verifyDirectoryMirror(source, target, { ignorePaths: result.preserved }), true);
});

test("does not remove SKIP_FILES or SKIP_DIRS entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-skip-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, "node_modules")); fs.writeFileSync(path.join(target, "node_modules", "keep"), "skip");
  fs.writeFileSync(path.join(target, "worktree-manager-core.sh"), "skip");
  pruneDirectoryExtras(source, target);
  assert.equal(fs.readFileSync(path.join(target, "node_modules", "keep"), "utf8"), "skip");
  assert.equal(fs.readFileSync(path.join(target, "worktree-manager-core.sh"), "utf8"), "skip");
});

test("removes an external destination symlink without touching its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-link-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target"), outside = path.join(root, "outside");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(outside, "external"); fs.symlinkSync(outside, path.join(target, "external-link"));
  pruneDirectoryExtras(source, target);
  assert.equal(fs.existsSync(path.join(target, "external-link")), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "external");
  assert.equal(verifyDirectoryMirror(source, target), true);
});

test("prunes stale contents on an incompatible file-to-directory type change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-prune-type-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, "nested"), "source file");
  fs.mkdirSync(path.join(target, "nested", "fresh"), { recursive: true });
  fs.writeFileSync(path.join(target, "nested", "fresh", "old"), "stale");
  fs.mkdirSync(path.join(target, "nested", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(target, "nested", "node_modules", "keep"), "skip");
  fs.writeFileSync(path.join(target, "nested", "fresh", "local.txt"), "preserve");
  const result = pruneDirectoryExtras(source, target, { preservePaths: ["local.txt"] });
  assert.equal(fs.readFileSync(path.join(target, "nested", "node_modules", "keep"), "utf8"), "skip");
  assert.equal(fs.readFileSync(path.join(target, "nested", "fresh", "old"), "utf8"), "stale");
  assert.equal(fs.readFileSync(path.join(target, "nested", "fresh", "local.txt"), "utf8"), "preserve");
  assert.deepEqual(result.preserved, [path.join("nested", "fresh", "local.txt")]);
});

test("fails closed on type conflicts containing nested preserved data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-preserved-type-conflict-")); fixtures.push(root);
  const source = path.join(root, "source"), target = path.join(root, "target");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "workspace"), "source file");
  fs.mkdirSync(path.join(target, "workspace", "state"), { recursive: true });
  fs.writeFileSync(path.join(target, "workspace", "state", "keep.json"), "local data");

  const pruned = pruneDirectoryExtras(source, target, { preservePaths: ["workspace/state"] });
  assert.equal(fs.existsSync(path.join(target, "workspace", "state", "keep.json")), true);
  copyDirectoryDelta(source, target, ["workspace/state"]);
  assert.equal(fs.readFileSync(path.join(target, "workspace", "state", "keep.json"), "utf8"), "local data");
  assert.equal(verifyDirectoryMirror(source, target, { ignorePaths: pruned.preserved }), false);
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
      name: "agent-model-selector-opencode",
      path: "agent-model-selector/packages/opencode",
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
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "agent-model-selector-opencode")));
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/agent-model-selector-opencode/dist/tui.js",
  ]);
});

test("CLI plugin installation writes V2 cli config and canonical declaration", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [{ name: "agent-model-selector-opencode", path: "agent-model-selector/packages/opencode", kind: "cli", destinations: ["opencode"], entrypoint: "dist/tui.js" }];
  createSources(flowtaskDir, manifest);
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  writeJson(path.join(root, ".opencode", "cli.json"), { $schema: "https://opencode.ai/cli.json", plugins: ["./plugins/user-cli/index.js"] });
  installManifestPlugins(root, manifest, flowtaskDir);
  assert.deepEqual(readJson(path.join(root, ".opencode", "cli.json")).plugins, [
    "./plugins/user-cli/index.js", "./plugins/agent-model-selector-opencode/dist/tui.js",
  ]);
  assert.deepEqual(readJson(path.join(flowtaskDir, "cli.json")).plugins, [
    "./plugins/agent-model-selector/packages/opencode/dist/tui.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "tui.json")), false);
});

test("CLI installation removes a stale TUI registration for the same plugin", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [{ name: "agent-model-selector-opencode", path: "agent-model-selector/packages/opencode", kind: "cli", destinations: ["opencode"], entrypoint: "dist/tui.js" }];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, ".opencode", "tui.json"), {
    $schema: "https://opencode.ai/tui.json",
    plugin: ["./plugins/user-tui/index.js", "./plugins/agent-model-selector-opencode/dist/tui.js"],
    plugins: ["./plugins/user-tui/index.js", "./plugins/agent-model-selector-opencode/dist/tui.js"],
    keybinds: { input_submit: "return" },
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  const tuiConfig = readJson(path.join(root, ".opencode", "tui.json"));
  assert.deepEqual(tuiConfig.plugin, ["./plugins/user-tui/index.js"]);
  assert.deepEqual(tuiConfig.plugins, ["./plugins/user-tui/index.js"]);
  assert.deepEqual(tuiConfig.keybinds, { input_submit: "return" });
  assert.ok(readJson(path.join(root, ".opencode", "cli.json")).plugins.includes("./plugins/agent-model-selector-opencode/dist/tui.js"));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "agent-model-selector-opencode", "dist", "tui.js")));
});

test("TUI installation removes a stale CLI registration for the same plugin", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [{ name: "agent-model-selector-opencode", path: "agent-model-selector/packages/opencode", kind: "tui", destinations: ["opencode"], entrypoint: "dist/tui.js" }];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, ".opencode", "cli.json"), {
    $schema: "https://opencode.ai/cli.json",
    plugins: ["./plugins/user-cli/index.js", "./plugins/agent-model-selector-opencode/dist/tui.js"],
    plugin: ["./plugins/user-cli/index.js", "./plugins/agent-model-selector-opencode/dist/tui.js"],
    custom: { keep: true },
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  const cliConfig = readJson(path.join(root, ".opencode", "cli.json"));
  assert.deepEqual(cliConfig.plugins, ["./plugins/user-cli/index.js"]);
  assert.deepEqual(cliConfig.plugin, ["./plugins/user-cli/index.js"]);
  assert.deepEqual(cliConfig.custom, { keep: true });
  assert.ok(readJson(path.join(root, ".opencode", "tui.json")).plugin.includes("./plugins/agent-model-selector-opencode/dist/tui.js"));
  assert.ok(fs.existsSync(path.join(root, ".opencode", "plugins", "agent-model-selector-opencode", "dist", "tui.js")));
});

function createSelectorSource(flowtaskDir, { withExtras = false } = {}) {
  const source = path.join(flowtaskDir, "plugins", "agent-model-selector", "packages", "opencode");
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "dist", "tui.js"), "export default {};\n");
  fs.writeFileSync(path.join(source, "tui.ts"), 'export { default } from "./dist/tui.js";\n');
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "agent-model-selector-opencode" }), "utf8");
  fs.writeFileSync(path.join(source, "README.md"), "# agent-model-selector-opencode\n", "utf8");
  if (withExtras) {
    fs.mkdirSync(path.join(source, "src"), { recursive: true });
    fs.writeFileSync(path.join(source, "src", "internal.ts"), "export {};\n");
    fs.mkdirSync(path.join(source, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(source, "node_modules", "dep", "index.js"), "module.exports = {};\n");
    fs.mkdirSync(path.join(source, "tests"), { recursive: true });
    fs.writeFileSync(path.join(source, "tests", "extra.test.js"), "test\n");
  }
  return source;
}

function selectorManifest(overrides = {}) {
  return {
    name: "agent-model-selector-opencode",
    path: "agent-model-selector/packages/opencode",
    kind: "cli",
    destinations: ["opencode"],
    entrypoint: "dist/tui.js",
    files: ["dist", "package.json", "README.md", "tui.ts"],
    ...overrides,
  };
}

test("manifest files allowlist copies only the declared entries", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir, { withExtras: true });

  installManifestPlugins(root, [selectorManifest()], flowtaskDir);

  const dest = path.join(root, ".opencode", "plugins", "agent-model-selector-opencode");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["README.md", "dist", "package.json", "tui.ts"]);
  assert.ok(fs.existsSync(path.join(dest, "dist", "tui.js")));
  assert.equal(
    fs.readFileSync(path.join(dest, "tui.ts"), "utf8").trim(),
    'export { default } from "./dist/tui.js";'
  );
  assert.equal(fs.existsSync(path.join(dest, "src")), false);
  assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(dest, "tests")), false);
});

test("legacy model selector install is removed after the replacement is installed", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir);
  const legacyDir = path.join(root, ".opencode", "plugins", "flowtask-model-selector");
  fs.mkdirSync(path.join(legacyDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "dist", "tui.js"), "export default 'legacy';\n");
  writeJson(path.join(root, ".opencode", "cli.json"), {
    $schema: "https://opencode.ai/cli.json",
    plugins: ["./plugins/user-cli/index.js", "./plugins/flowtask-model-selector/dist/tui.js"],
  });
  writeJson(path.join(flowtaskDir, "cli.json"), {
    $schema: "https://opencode.ai/cli.json",
    plugins: ["./plugins/flowtask-model-selector/dist/tui.js"],
  });
  writeJson(path.join(root, ".opencode", "tui.json"), {
    $schema: "https://opencode.ai/tui.json",
    plugin: ["./plugins/flowtask-model-selector/dist/tui.js", "./plugins/user-tui/index.js"],
  });

  installManifestPlugins(root, [selectorManifest()], flowtaskDir);

  assert.equal(fs.existsSync(legacyDir), false);
  assert.deepEqual(readJson(path.join(root, ".opencode", "cli.json")).plugins, [
    "./plugins/user-cli/index.js",
    "./plugins/agent-model-selector-opencode/dist/tui.js",
  ]);
  assert.deepEqual(readJson(path.join(flowtaskDir, "cli.json")).plugins, [
    "./plugins/agent-model-selector/packages/opencode/dist/tui.js",
  ]);
  assert.deepEqual(readJson(path.join(root, ".opencode", "tui.json")).plugin, [
    "./plugins/user-tui/index.js",
  ]);
});

test("a missing model selector source preserves the legacy installation", () => {
  const { root, flowtaskDir } = createFixture();
  const legacyDir = path.join(root, ".opencode", "plugins", "flowtask-model-selector");
  fs.mkdirSync(path.join(legacyDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "dist", "tui.js"), "export default 'legacy';\n");
  writeJson(path.join(root, ".opencode", "cli.json"), {
    $schema: "https://opencode.ai/cli.json",
    plugins: ["./plugins/flowtask-model-selector/dist/tui.js"],
  });

  const originalLog = console.log;
  const output = [];
  console.log = (message) => output.push(String(message));
  try {
    installManifestPlugins(root, [selectorManifest()], flowtaskDir);
  } finally {
    console.log = originalLog;
  }

  assert.ok(fs.existsSync(legacyDir));
  assert.deepEqual(readJson(path.join(root, ".opencode", "cli.json")).plugins, [
    "./plugins/flowtask-model-selector/dist/tui.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "plugins", "agent-model-selector-opencode")), false);
  assert.match(output.join("\n"), /Plugin source not found/);
});

test("a second update of the allowlisted plugin changes nothing", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir);
  const manifest = [selectorManifest()];

  installManifestPlugins(root, manifest, flowtaskDir);
  const digest = treeDigest(root);
  installManifestPlugins(root, manifest, flowtaskDir);

  assert.equal(treeDigest(root), digest);
});

test("the repository manifest declares the submodule selector and not the legacy entry", () => {
  const manifest = readJson(new URL("../../plugins/flowtask-plugins.json", import.meta.url));
  const entry = manifest.find((item) => item.name === "agent-model-selector-opencode");
  assert.ok(entry);
  assert.equal(entry.path, "agent-model-selector/packages/opencode");
  assert.equal(entry.kind, "cli");
  assert.deepEqual(entry.destinations, ["opencode"]);
  assert.equal(entry.entrypoint, "dist/tui.js");
  assert.deepEqual(entry.files, ["dist", "package.json", "README.md", "tui.ts"]);
  assert.equal(manifest.some((item) => item.name === "flowtask-model-selector"), false);
});

test("manifest entries without files keep copying the full source tree", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir, { withExtras: true });

  installManifestPlugins(root, [selectorManifest({ files: undefined })], flowtaskDir);

  const dest = path.join(root, ".opencode", "plugins", "agent-model-selector-opencode");
  assert.ok(fs.existsSync(path.join(dest, "dist", "tui.js")));
  assert.ok(fs.existsSync(path.join(dest, "src", "internal.ts")));
  assert.ok(fs.existsSync(path.join(dest, "tests", "extra.test.js")));
  assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
});

test("the files allowlist prunes stale destination entries from a previous install", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir);
  const dest = path.join(root, ".opencode", "plugins", "agent-model-selector-opencode");
  fs.mkdirSync(path.join(dest, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dest, "node_modules", "dep", "index.js"), "module.exports = {};\n");
  fs.mkdirSync(path.join(dest, "src"), { recursive: true });
  fs.writeFileSync(path.join(dest, "src", "stale.ts"), "export {};\n");
  fs.writeFileSync(path.join(dest, "package.json"), '{"name":"stale-playground"}\n', "utf8");

  installManifestPlugins(root, [selectorManifest()], flowtaskDir);

  assert.deepEqual(fs.readdirSync(dest).sort(), ["README.md", "dist", "package.json", "tui.ts"]);
  assert.deepEqual(readJson(path.join(dest, "package.json")), { name: "agent-model-selector-opencode" });
  assert.equal(fs.existsSync(path.join(dest, "src")), false);
  assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
});

test("a manifest that still declares the legacy selector preserves its installation", () => {
  const { root, flowtaskDir } = createFixture();
  createSelectorSource(flowtaskDir);
  const legacySource = path.join(flowtaskDir, "plugins", "flowtask-model-selector", "dist");
  fs.mkdirSync(legacySource, { recursive: true });
  fs.writeFileSync(path.join(legacySource, "tui.js"), "export default 'legacy';\n");

  const legacyDir = path.join(root, ".opencode", "plugins", "flowtask-model-selector");
  fs.mkdirSync(path.join(legacyDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "dist", "tui.js"), "export default 'legacy';\n");
  writeJson(path.join(root, ".opencode", "cli.json"), {
    $schema: "https://opencode.ai/cli.json",
    plugins: ["./plugins/flowtask-model-selector/dist/tui.js"],
  });
  const legacyEntry = {
    name: "flowtask-model-selector",
    path: "flowtask-model-selector",
    kind: "cli",
    destinations: ["opencode"],
    entrypoint: "dist/tui.js",
  };

  installManifestPlugins(root, [selectorManifest(), legacyEntry], flowtaskDir);

  assert.ok(fs.existsSync(legacyDir));
  const plugins = readJson(path.join(root, ".opencode", "cli.json")).plugins;
  assert.ok(plugins.includes("./plugins/agent-model-selector-opencode/dist/tui.js"));
  assert.ok(plugins.includes("./plugins/flowtask-model-selector/dist/tui.js"));
  assert.equal(readJson(path.join(flowtaskDir, "cli.json")).plugins.some((plugin) =>
    plugin.includes("flowtask-model-selector")), true);
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
      "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
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
  assert.equal(output.join("\n").split("the classifier plugin was deprecated").length - 1, 1);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/agent-model-selector-opencode/dist/tui.js",
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
  fs.mkdirSync(path.join(pluginRoot, "flowtask-unmanaged"), { recursive: true });
  writeJson(path.join(root, "tui.json"), {
    "$schema": "https://opencode.ai/tui.json",
    keybinds: { input_submit: "return" },
    plugin: [
      "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
      "./.opencode/plugins/flowtask-unmanaged/dist/tui.js",
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

  assert.ok(fs.existsSync(path.join(pluginRoot, "flowtask-unmanaged")));
  assert.deepEqual(readJson(path.join(root, "tui.json")).keybinds, { input_submit: "return" });
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/flowtask-classifier-tui/dist/tui.js",
    "./.opencode/plugins/flowtask-unmanaged/dist/tui.js",
    "./plugins/user-tui/dist/index.js",
  ]);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/user-tui/dist/index.js",
    "./plugins/agent-model-selector-opencode/dist/tui.js",
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
    await assert.rejects(() => showInteractiveSelector({}), /No TTY/);
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

test("Claude copies no runtime assets into the project while the other targets keep scripts", () => {
  assert.deepEqual(ASSETS.claude, [], "the Claude runtime lives once per user, not in the project");
  for (const id of ["opencode", "vscode"]) {
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

test("Runner delegates worktree lifecycle through the consumer adapter", () => {
  const root = path.resolve(path.dirname(FLOWTASK_CLI), "..", "..");
  const runner = readComposedRunner({ root });
  assert.match(runner, /worktree-consumer-adapter\.js/);
  assert.match(runner, /`cli` o `mcp`[\s\S]*?obligatoria y explícita/);
  assert.match(runner, /Engram debe confirmar la asociación efectiva[\s\S]*?antes de despachar Constructor/);
  assert.match(runner, /No repitas una operación[\s\S]*?`uncertain`/);
  assert.doesNotMatch(runner, /Ejecuta `\$\{FLOWTASK_SCRIPTS\}\/worktree\.sh/);
  assert.match(runner, /no ejecuta Git ni mantiene/i);
  assert.match(runner, /init_submodules/);
  assert.match(runner, /`--auto` no agrega permisos ni sustituye\s+consentimientos/i);
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
  assert.ok(output.join("\n").includes("retry with flowtask update"));
});

test("materializes managed config and profile independently for the project-level targets", () => {
  const { root, flowtaskDir } = createFixture();
  writeJson(path.join(flowtaskDir, "config", "review.json"), {
    enabled: true,
    stampPath: ".flowtask/config/.review-stamp",
    criticalPaths: ["**/security/**"],
    diffThreshold: 10,
  });
  const targets = [
    ["opencode", path.join(root, ".opencode", "flowtask"), "senior"],
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

test("migrates the absent layers of a target with the installation defaults", () => {
  const { root, flowtaskDir } = createFixture();
  writeJson(path.join(flowtaskDir, "config", "review.json"), {
    enabled: true,
    stampPath: ".flowtask/config/.review-stamp",
  });
  const targetDir = path.join(root, ".opencode", "flowtask");
  writeJson(path.join(targetDir, "config", "profile.json"), {
    level: "senior", persona: "tutor-senior", onboarded: true,
  });

  const result = syncTargetConfig(flowtaskDir, targetDir, {
    level: "senior", persona: "tutor-senior", onboarded: true,
  });

  assert.equal(result.persona, "valid");
  assert.equal(result.autonomy.status, "valid");
  assert.equal(result.permissions.status, "valid");
  assert.deepEqual(readJson(path.join(targetDir, "config", "autonomy.json")), {
    version: 1, profile: "autonomous-dev",
  });
  assert.deepEqual(readJson(path.join(targetDir, "config", "permissions.json")), {
    version: 1, envelope: "standard",
  });
  assert.deepEqual(readJson(path.join(targetDir, "config", "profile.json")), {
    level: "senior", persona: "tutor-senior", onboarded: true,
  });
});

test("fails the target when a layer is invalid and keeps the file untouched", () => {
  const { root, flowtaskDir } = createFixture();
  writeJson(path.join(flowtaskDir, "config", "review.json"), {
    enabled: true,
    stampPath: ".flowtask/config/.review-stamp",
  });
  const targetDir = path.join(root, ".opencode", "flowtask");
  writeJson(path.join(targetDir, "config", "autonomy.json"), { version: 1, profile: "root" });

  assert.throws(
    () => syncTargetConfig(flowtaskDir, targetDir, {
      level: "senior", persona: "tutor-senior", onboarded: true,
    }),
    (error) => {
      assert.equal(error.code, "autonomy_invalid");
      return true;
    },
  );

  assert.deepEqual(readJson(path.join(targetDir, "config", "autonomy.json")), {
    version: 1, profile: "root",
  });
});

test("does not overwrite an invalid persona profile and keeps the layers intact", () => {
  const { root, flowtaskDir } = createFixture();
  writeJson(path.join(flowtaskDir, "config", "review.json"), {
    enabled: true,
    stampPath: ".flowtask/config/.review-stamp",
  });
  const targetDir = path.join(root, ".opencode", "flowtask");
  writeJson(path.join(targetDir, "config", "profile.json"), { level: "senior" });
  writeJson(path.join(targetDir, "config", "autonomy.json"), { version: 1, profile: "assistant" });
  writeJson(path.join(targetDir, "config", "permissions.json"), { version: 1, envelope: "standard" });

  const result = syncTargetConfig(flowtaskDir, targetDir, {
    level: "mid", persona: "tutor-mid", onboarded: true,
  }, { preserveProfile: true });

  assert.equal(result.persona, "invalid");
  assert.deepEqual(readJson(path.join(targetDir, "config", "profile.json")), { level: "senior" });
  assert.deepEqual(readJson(path.join(targetDir, "config", "autonomy.json")), {
    version: 1, profile: "assistant",
  });
  assert.deepEqual(readJson(path.join(targetDir, "config", "permissions.json")), {
    version: 1, envelope: "standard",
  });
});

test("fans out legacy profile and preserves it when one target fails", () => {
  const { root } = createFixture();
  const legacy = path.join(root, ".flowtask", "profile.json");
  const profile = { level: "senior", persona: "tutor-senior", onboarded: true };
  writeJson(legacy, profile);
  const targets = [
    path.join(root, ".opencode", "flowtask"),
    path.join(root, ".vscode", "flowtask"),
    "/dev/null/flowtask",
  ];

  assert.equal(migrateProfileLocation(root, path.join(root, ".flowtask"), targets), false);
  assert.equal(fs.existsSync(legacy), true);
  assert.deepEqual(readJson(path.join(targets[0], "config", "profile.json")), profile);
  assert.deepEqual(readJson(path.join(targets[1], "config", "profile.json")), profile);
});

test("update preserves divergent valid profiles independently across two project-level targets", () => {
  const { root, flowtaskDir } = createFixture();
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
  const targets = [
    ["opencode", ".opencode/flowtask", { level: "senior", persona: "tutor-senior", onboarded: true }],
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
    input: "n\nn\n",
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readJson(path.join(root, ".opencode/flowtask/config/profile.json")), targets[0][2]);
  assert.deepEqual(readJson(path.join(root, ".vscode/flowtask/config/profile.json")), targets[1][2]);
  const installedScript = path.join(root, ".opencode", "flowtask", "scripts", "worktree.sh");
  assert.ok(fs.existsSync(installedScript));
  assert.equal(fs.statSync(installedScript).mode & 0o111, 0o111);
});

test("does not accept a TUI write failure as a successful registration", () => {
  assert.equal(
    registerPluginArrayEntry("/dev/null/flowtask/tui.json", "../.opencode/plugins/agent-model-selector-opencode/dist/tui.js"),
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
      "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
      "./plugins/user-tui/dist/index.js",
    ],
  });

  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
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
    plugin: ["./.opencode/plugins/agent-model-selector-opencode/dist/tui.js"],
  });

  assert.throws(() => installManifestPlugins(root, manifest, flowtaskDir));
  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
  ]);
  assert.equal(fs.existsSync(path.join(root, ".opencode", "tui.json")), true);
});

test("removes duplicate legacy entries when one TUI plugin is migrated", () => {
  const { root, flowtaskDir } = createFixture();
  const manifest = [createManifest()[2]];
  createSources(flowtaskDir, manifest);
  writeJson(path.join(root, "tui.json"), {
    plugin: [
      "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
      "./plugins/user-tui/dist/index.js",
      "./.opencode/plugins/agent-model-selector-opencode/dist/tui.js",
    ],
  });

  installManifestPlugins(root, manifest, flowtaskDir);
  const firstNative = fs.readFileSync(path.join(root, ".opencode", "tui.json"), "utf8");
  installManifestPlugins(root, manifest, flowtaskDir);

  assert.deepEqual(installedPluginEntries(path.join(root, "tui.json")), [
    "./plugins/user-tui/dist/index.js",
  ]);
  assert.deepEqual(nativeTuiEntries(root), [
    "./plugins/agent-model-selector-opencode/dist/tui.js",
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
    plugin: ["./.opencode/plugins/agent-model-selector-opencode/dist/tui.js"],
  });

  regenerateCanonicalTui(root, flowtaskDir, manifest);
  assert.deepEqual(readJson(path.join(flowtaskDir, "tui.json")), {
    $schema: "https://opencode.ai/tui.json",
    plugin: ["./plugins/agent-model-selector/packages/opencode/dist/tui.js"],
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
    plugin: ["./plugins/agent-model-selector/packages/opencode/dist/tui.js"],
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

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-scripts-home-"));
  fixtures.push(emptyHome);
  const usage = spawnSync(wrapper, ["--help"], {
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome, XDG_CONFIG_HOME: "" },
  });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Worktree Manager is not installed/);
});

// ─── Worktree Manager installation, capabilities and gitlink ──────────────────

const MANAGER_MCP_SERVER_SOURCE = `import json
import sys

from .mcp_contract import TOOL_NAMES


def dispatch(message):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "worktree-manager", "version": "1.0.0"}}
    if method == "tools/list":
        return {"tools": [{"name": name, "description": "Manage repository worktrees",
                           "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}
                          for name in TOOL_NAMES]}
    if method == "tools/call":
        return {"content": []}
    raise ValueError("method_not_found")


def main():
    for line in sys.stdin:
        message = json.loads(line)
        result = dispatch(message)
        if "id" in message and result is not None:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}) + "\\n")
            sys.stdout.flush()
`;

const MANAGER_CLI_SOURCE = `VERSION = "1.0.0"


def main(argv=None):
    import sys
    args = list(sys.argv[1:] if argv is None else argv)
    if "--version" in args:
        print(VERSION)
        return 0
    print("unsupported", file=sys.stderr)
    return 2
`;

function writeManagerFixture(dir, { withPackage = true, withMcp = true, brokenCli = false, brokenMcp = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(path.join(dir, "worktree.sh"), 0o755);
  if (!withPackage) return;
  const packageDir = path.join(dir, "worktree_manager");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "__init__.py"), '"""Fixture manager."""\n__version__ = "1.0.0"\n', "utf8");
  fs.writeFileSync(path.join(packageDir, "__main__.py"), "from .cli import main\n\nraise SystemExit(main())\n", "utf8");
  fs.writeFileSync(path.join(packageDir, "cli.py"), brokenCli
    ? "raise RuntimeError('the CLI entrypoint is broken')\n"
    : MANAGER_CLI_SOURCE, "utf8");
  fs.writeFileSync(path.join(packageDir, "mcp_contract.py"),
    'TOOL_NAMES = ("worktree_create", "worktree_complete", "worktree_cleanup", "worktree_recover", "worktree_list", "worktree_prune", "worktree_status")\n', "utf8");
  fs.writeFileSync(path.join(packageDir, "mcp_operations.py"),
    'def call(name, arguments):\n    return {"operation": name, "arguments": arguments}\n', "utf8");
  if (!withMcp) return;
  fs.writeFileSync(path.join(packageDir, "mcp_server.py"), brokenMcp
    ? "raise RuntimeError('the MCP entrypoint is broken')\n"
    : MANAGER_MCP_SERVER_SOURCE, "utf8");
  fs.writeFileSync(path.join(packageDir, "mcp_transport.py"),
    'from .mcp_server import main\n\nif __name__ == "__main__":\n    main()\n', "utf8");
}

/** Build a flowtask source tree with a manager package fixture and its plugin source. */
function createManagerFixture(managerOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-manager-"));
  fixtures.push(root);
  const sourceDir = path.join(root, "manager-source");
  writeManagerFixture(sourceDir, managerOptions);
  fs.writeFileSync(path.join(sourceDir, "package.json"),
    `${JSON.stringify({ name: "worktree-for-agents", version: "1.0.0" }, null, 2)}\n`, "utf8");

  const parentDir = path.join(root, "flowtask");
  const flowtaskDir = path.join(parentDir, ".flowtask");
  const pluginSource = path.join(flowtaskDir, "plugins", CONTEXT_CHECKPOINT_NAME);
  fs.mkdirSync(pluginSource, { recursive: true });
  fs.writeFileSync(path.join(pluginSource, "package.json"), JSON.stringify({ dependencies: { "@opencode/plugin": "2.0.27" } }), "utf8");
  fs.writeFileSync(path.join(pluginSource, "index.ts"), "export {}\n", "utf8");
  writeJson(path.join(flowtaskDir, "plugins", "flowtask-plugins.json"), [{
    name: CONTEXT_CHECKPOINT_NAME, path: CONTEXT_CHECKPOINT_NAME, kind: "server",
    destinations: ["opencode"], entrypoint: "index.ts",
  }]);
  return { root, parentDir, flowtaskDir, sourceDir };
}

function managerFixtureOptions() {
  return {
    ensureSource: async () => ({
      sourceCommit: CONTEXT_CHECKPOINT_SHA,
      sourceDir: path.join(fixtureFlowtaskDir, "plugins", CONTEXT_CHECKPOINT_NAME),
    }),
  };
}

let fixtureFlowtaskDir = "";

test("both transports are detected when the manager answers the CLI and MCP probes", () => {
  const fixture = createManagerFixture();
  const report = detectWorktreeManagerCapabilities(fixture.sourceDir);
  assert.deepEqual(report.transports, ["cli", "mcp"]);
  assert.equal(report.cli.available, true);
  assert.equal(report.cli.version, "1.0.0");
  assert.equal(report.mcp.available, true);
  assert.equal(report.mcp.tools.length, 7);
  assert.ok(report.mcp.tools.includes("worktree_prune"));
  assert.equal(report.python.available, true);
});

test("the installation continues with the CLI and reports the MCP cause when the MCP entrypoints are missing", () => {
  const fixture = createManagerFixture({ withMcp: false });
  const report = detectWorktreeManagerCapabilities(fixture.sourceDir);
  assert.deepEqual(report.transports, ["cli"]);
  assert.equal(report.cli.available, true);
  assert.equal(report.mcp.available, false);
  assert.match(report.mcp.cause, /missing MCP entrypoints/);
  assert.match(report.mcp.cause, /mcp_transport\.py/);
});

test("the installation continues with the MCP and reports the CLI cause when the CLI entrypoint is broken", () => {
  const fixture = createManagerFixture({ brokenCli: true });
  const report = detectWorktreeManagerCapabilities(fixture.sourceDir);
  assert.deepEqual(report.transports, ["mcp"]);
  assert.equal(report.mcp.available, true);
  assert.equal(report.cli.available, false);
  assert.match(report.cli.cause, /broken/i);
});

test("the installation fails before writing the target when no transport is usable", async () => {
  const fixture = createManagerFixture({ brokenCli: true, brokenMcp: true });
  const projectDir = path.join(fixture.root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "keep.txt"), "untouched\n", "utf8");
  const before = treeDigest(projectDir);
  const capabilities = detectWorktreeManagerCapabilities(fixture.sourceDir);
  await assert.rejects(() => prepareInstallation(fixture.flowtaskDir, projectDir, "install", {
    worktreeManager: { capabilities },
    ensureSource: managerFixtureOptions().ensureSource,
  }), /no usable transport/i);
  assert.equal(treeDigest(projectDir), before, "the target must not be written without a usable transport");
  assert.equal(fs.readFileSync(path.join(projectDir, "keep.txt"), "utf8"), "untouched\n");
});

test("a transport is reported as available only when it answered a read-only probe", () => {
  const fixture = createManagerFixture();
  const capabilities = detectWorktreeManagerCapabilities(fixture.sourceDir);
  assert.equal(capabilities.cli.available, true);
  assert.equal(capabilities.mcp.available, true);
  // A configuration that declares a server is never the evidence of an operational transport.
  const declared = { mcp: { "worktree-manager": { type: "local", command: ["worktree-manager"], enabled: true } } };
  assert.equal(declared.mcp["worktree-manager"].enabled, true);
  assert.equal(capabilities.mcp.available, true, "the capability comes from the probe, not from the declaration");
});

test("repeating the preparation preserves unrelated configuration, work state and permissions", async () => {
  const fixture = createManagerFixture();
  fixtureFlowtaskDir = fixture.flowtaskDir;
  const projectDir = path.join(fixture.root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  writeJson(path.join(projectDir, ".opencode", "opencode.json"), {
    $schema: "https://custom/schema.json",
    mcp: { "unrelated-server": { type: "local", command: ["unrelated"], enabled: true } },
    agent: { "flowtask-runner": { permissions: canonicalRunnerPermission } },
  });
  fs.writeFileSync(path.join(projectDir, ".worktree-manager.conf"), "[manager]\nbase = main\n", "utf8");
  fs.mkdirSync(path.join(projectDir, ".worktrees", "wt-1"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".worktrees", "wt-1", "state.json"), "{}\n", "utf8");
  fs.mkdirSync(path.join(projectDir, ".git", "state", "transactions"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".git", "state", "transactions", "tx-1.json"), "{}\n", "utf8");
  fs.mkdirSync(path.join(projectDir, ".git", "backups"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".git", "backups", "backup-1"), "backup\n", "utf8");
  const before = treeDigest(projectDir);

  const managerReport = { capabilities: detectWorktreeManagerCapabilities(fixture.sourceDir) };
  const installDescriptor = await prepareInstallation(fixture.flowtaskDir, projectDir, "install", {
    targets: [{ id: "standalone", ideDir: "", targetSubDir: ".flowtask" }],
    worktreeManager: managerReport,
    ...managerFixtureOptions(),
  });
  const updateDescriptor = await prepareInstallation(fixture.flowtaskDir, projectDir, "update", {
    targets: [{ id: "standalone", ideDir: "", targetSubDir: ".flowtask" }],
    worktreeManager: managerReport,
    ...managerFixtureOptions(),
  });

  assert.deepEqual(managerReport.capabilities.transports, ["cli", "mcp"]);
  assert.deepEqual(installDescriptor.worktreeManager.capabilities.transports, ["cli", "mcp"]);
  assert.deepEqual(updateDescriptor.worktreeManager.capabilities.transports, ["cli", "mcp"]);
  assert.equal(treeDigest(projectDir), before, "the preparation must not change the project");
  const config = readJson(path.join(projectDir, ".opencode", "opencode.json"));
  assert.deepEqual(Object.keys(config.mcp), ["unrelated-server"]);
  assert.deepEqual(config.agent["flowtask-runner"].permissions, canonicalRunnerPermission);
});

/** A local npm replacement that installs a prepared package into the prefix. */
function writeNpmFixture(root, sourceDir) {
  const file = path.join(root, "fake-npm.mjs");
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const target = path.join(prefix, "node_modules", "worktree-for-agents");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(${JSON.stringify(sourceDir)}, target, { recursive: true });
`, { mode: 0o755 });
  return file;
}

test("an unusable Python blocks the npm publication before any copy is written", () => {
  const fixture = createManagerFixture();
  const npmRoot = path.join(fixture.root, "npm");
  fs.mkdirSync(npmRoot, { recursive: true });
  const npm = writeNpmFixture(npmRoot, fixture.sourceDir);
  const globalDir = path.join(fixture.root, "global", "worktree-manager");
  const missingPython = path.join(fixture.root, "missing-python3");

  assert.throws(
    () => prepareGlobalWorktreeManager({
      npmBin: npm,
      workDir: path.join(npmRoot, "work"),
      globalManagerDir: globalDir,
      pythonBin: missingPython,
    }),
    /Worktree Manager has no usable transport.*python is not usable/is,
  );
  assert.equal(fs.existsSync(globalDir), false);
});

test("the quiet report stays silent only when both transports are operational", () => {
  const fixture = createManagerFixture();
  const report = { capabilities: detectWorktreeManagerCapabilities(fixture.sourceDir) };
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    reportWorktreeManagerCapabilities(report, { quiet: true });
    assert.deepEqual(lines, []);

    reportWorktreeManagerCapabilities(report, { quiet: false });
    assert.match(lines.join("\n"), /Worktree Manager ready/);

    lines.length = 0;
    reportWorktreeManagerCapabilities({
      capabilities: {
        cli: { available: true, version: "1.0.0" },
        mcp: { available: false, cause: "MCP is not available" },
      },
    }, { quiet: true });
    assert.match(lines.join("\n"), /partially installed/);

    lines.length = 0;
    reportWorktreeManagerCapabilities({
      capabilities: {
        cli: { available: false, cause: "CLI is not available" },
        mcp: { available: false, cause: "MCP is not available" },
      },
    }, { quiet: true });
    assert.match(lines.join("\n"), /not operational/);
  } finally {
    console.log = originalLog;
  }
});

test("the manager is never copied into an installation target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-manager-copy-"));
  fixtures.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(source, "worktree-manager"), { recursive: true });
  fs.writeFileSync(path.join(source, "worktree-manager", "worktree.sh"), "#!/bin/sh\n", "utf8");
  fs.writeFileSync(path.join(source, "worktree.sh"), "#!/bin/sh\n", "utf8");
  copyDirectoryDelta(source, target);
  assert.equal(fs.existsSync(path.join(target, "worktree-manager")), false);
  assert.equal(fs.existsSync(path.join(target, "worktree.sh")), true);
});

test("the manager is not registered as a consumer server and no permission is widened", () => {
  const source = path.resolve(path.dirname(FLOWTASK_CLI), "..");
  const flowtaskConfig = JSON.parse(fs.readFileSync(path.join(source, "..", "opencode.json"), "utf8"));
  assert.equal(Object.keys(flowtaskConfig.mcp ?? {}).includes("worktree-manager"), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-manager-server-"));
  fixtures.push(root);
  const targetConfig = path.join(root, "opencode.json");
  writeJson(targetConfig, {
    $schema: "https://custom/schema.json",
    mcp: { "unrelated-server": { type: "local", command: ["unrelated"], enabled: true } },
    agent: { "flowtask-runner": { permissions: canonicalRunnerPermission } },
  });
  mergeOpencodeConfig(targetConfig, source, ".opencode");
  const merged = readJson(targetConfig);
  assert.deepEqual(Object.keys(merged.mcp), ["unrelated-server", "engram", "ferris-search"]);
  assert.equal(Object.keys(merged.mcp).includes("worktree-manager"), false);
  assert.deepEqual(merged.agents["flowtask-runner"].permissions, canonicalRunnerPermission);
  assert.equal(JSON.stringify(merged).includes("worktree-manager"), false);
});


