import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { describeClaudeModResults, installClaudeModPlugins } from "./claude-plugin.js";
import { setLogSink } from "./logger.js";

// gap: G-1 — a regression in argument assembly, marketplace resolution, or enabledPlugins reading would install a different version or fail silently

const fixtures = [];
const ENTRY = {
  name: "agent-model-selector-claude-code",
  path: "agent-model-selector/packages/claude-code",
  kind: "mod",
  destinations: ["claude-code"],
  entrypoint: "hooks/dist/register.js",
  marketplaceRoot: "agent-model-selector",
};
const PLUGIN_REF = "flowtask-model@agent-model-selector";

afterEach(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
  fixtures.length = 0;
  setLogSink(null);
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function createFixture({ enabledPlugins, marketplaceSource = "./packages/claude-code" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-test-"));
  fixtures.push(root);
  const flowtaskDir = path.join(root, ".flowtask");
  const claudeUserDir = path.join(root, "claude-user");
  const marketplaceRoot = path.join(flowtaskDir, "plugins", "agent-model-selector");
  const pluginDir = path.join(marketplaceRoot, "packages", "claude-code");
  writeJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), {
    name: "agent-model-selector",
    plugins: [{ name: "flowtask-model", source: marketplaceSource }],
  });
  writeJson(path.join(pluginDir, ".claude-plugin", "plugin.json"), {
    name: "flowtask-model",
    version: "0.3.0",
  });
  writeJson(path.join(pluginDir, "package.json"), { name: "flowtask-model", version: "9.9.9" });
  fs.mkdirSync(path.join(pluginDir, "hooks", "dist"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "hooks", "dist", "register.js"), "", "utf8");
  if (enabledPlugins !== undefined) {
    writeJson(path.join(claudeUserDir, "settings.json"), { enabledPlugins });
  }
  return { flowtaskDir, claudeUserDir, marketplaceRoot };
}

function install(fixture, calls, outcome) {
  return installClaudeModPlugins({
    flowtaskDir: fixture.flowtaskDir,
    manifest: [ENTRY],
    claudeUserDir: fixture.claudeUserDir,
    runner: (args) => {
      calls.push(args);
      return outcome(args);
    },
  });
}

test("G-1: installs or updates the declared plugin version and reports a failed run", () => {
  const logs = [];
  setLogSink(({ kind, message }) => logs.push({ kind, message }));

  const installFixture = createFixture();
  const installCalls = [];
  const installed = install(installFixture, installCalls, () => ({ ok: true, stdout: "{}" }));

  assert.deepEqual(installCalls, [[
    "plugin", "install", "flowtask-model",
    "--marketplace", installFixture.marketplaceRoot,
    "--scope", "user", "-y", "--json",
  ]]);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].ref, PLUGIN_REF);
  assert.equal(installed[0].version, "0.3.0", "the version must come from plugin.json, not package.json");
  assert.equal(installed[0].status, "installed");
  assert.equal(installed[0].cause, null);
  assert.equal(describeClaudeModResults(installed), `${PLUGIN_REF} · 0.3.0 · installed`);

  const updateFixture = createFixture({ enabledPlugins: { [PLUGIN_REF]: true } });
  const updateCalls = [];
  const updated = install(updateFixture, updateCalls, () => ({ ok: true, stdout: "" }));

  assert.deepEqual(updateCalls, [
    ["plugin", "marketplace", "add", updateFixture.marketplaceRoot, "--scope", "user"],
    ["plugin", "update", PLUGIN_REF, "--scope", "user", "-y", "--json"],
  ]);
  assert.equal(updated[0].status, "updated");
  assert.equal(updated[0].version, "0.3.0");

  const malformedFixture = createFixture({ enabledPlugins: [PLUGIN_REF] });
  const malformedCalls = [];
  install(malformedFixture, malformedCalls, () => ({ ok: true, stdout: "" }));

  assert.equal(malformedCalls.length, 1);
  assert.deepEqual(malformedCalls[0].slice(0, 2), ["plugin", "install"]);

  const failureFixture = createFixture();
  const failureCalls = [];
  logs.length = 0;
  const failed = install(failureFixture, failureCalls, (args) => {
    if (args[1] === "install") return { ok: false, cause: "install rejected: marketplace unreachable" };
    if (args[1] === "marketplace") return { ok: true, stdout: "" };
    return { ok: false, cause: "update rejected: plugin missing" };
  });

  assert.deepEqual(failureCalls, [
    ["plugin", "install", "flowtask-model", "--marketplace", failureFixture.marketplaceRoot, "--scope", "user", "-y", "--json"],
    ["plugin", "marketplace", "add", failureFixture.marketplaceRoot, "--scope", "user"],
    ["plugin", "update", PLUGIN_REF, "--scope", "user", "-y", "--json"],
  ]);
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].ref, PLUGIN_REF);
  assert.equal(failed[0].version, "0.3.0");
  assert.equal(failed[0].cause, "install rejected: marketplace unreachable");
  assert.equal(failed[0].action, "run the plugin install manually and retry with flowtask update");
  assert.equal(describeClaudeModResults(failed), `${PLUGIN_REF} · 0.3.0 · not installed`);
  const warnings = logs.filter(({ kind }) => kind === "warn").map(({ message }) => message);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /install rejected: marketplace unreachable/);
  assert.match(warnings[0], /run the plugin install manually and retry with flowtask update/);

  const mismatchedFixture = createFixture({ marketplaceSource: "./packages/other" });
  const mismatchedCalls = [];
  logs.length = 0;
  const unresolved = install(mismatchedFixture, mismatchedCalls, () => ({ ok: true, stdout: "" }));

  assert.deepEqual(mismatchedCalls, [], "a marketplace entry that points elsewhere must not install anything");
  assert.equal(unresolved[0].status, "failed");
  assert.equal(unresolved[0].ref, null);
  assert.equal(unresolved[0].version, null);
  assert.match(unresolved[0].cause, /has no entry pointing to/);
  assert.match(unresolved[0].action, /git submodule update --init/);
});
