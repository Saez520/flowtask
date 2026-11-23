import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installUserPlugins } from "./user-plugins.js";

const GATE_ENTRY = Object.freeze({
  name: "flowtask-permission-gate",
  path: "flowtask-permission-gate",
  kind: "server",
  destinations: ["opencode"],
  entrypoint: "dist/index.js",
  managedPackage: true,
  scope: "user",
  distribution: "npm",
  npm: "flowtask-permission-gate@^2.0.0",
});

const CHECKPOINT_ENTRY = Object.freeze({
  name: "flowtask-context-checkpoint",
  path: "flowtask-context-checkpoint",
  kind: "server",
  destinations: ["opencode"],
  entrypoint: "index.ts",
  managedPackage: true,
  scope: "user",
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-user-plugins-"));
  const flowtaskDir = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const sourcePlugins = path.join(flowtaskDir, "plugins");

  writeJson(path.join(sourcePlugins, "flowtask-permission-gate", "package.json"), {
    name: "flowtask-permission-gate",
    version: "2.0.0",
  });
  fs.mkdirSync(path.join(sourcePlugins, "flowtask-permission-gate", "dist"), { recursive: true });
  fs.writeFileSync(path.join(sourcePlugins, "flowtask-permission-gate", "dist", "index.js"), "export default {};\n");

  writeJson(path.join(sourcePlugins, "flowtask-context-checkpoint", "package.json"), {
    name: "flowtask-context-checkpoint",
    version: "1.0.0",
  });
  fs.writeFileSync(path.join(sourcePlugins, "flowtask-context-checkpoint", "index.ts"), "export {};\n");

  writeJson(path.join(runtimeRoot, "runtime.json"), { schema: 2 });
  return { root, flowtaskDir, runtimeRoot };
}

test("a clean install copies the local user plugin and skips the npm distribution", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const result = installUserPlugins({
      flowtaskDir,
      manifest: [GATE_ENTRY, CHECKPOINT_ENTRY],
      runtimeRoot,
    });

    const checkpointDir = path.join(runtimeRoot, "plugins", "flowtask-context-checkpoint");
    assert.deepEqual(result.installed, [checkpointDir]);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "plugins", "flowtask-permission-gate")), false,
      "the npm-distributed gate is never copied into the runtime");
    assert.ok(fs.existsSync(path.join(checkpointDir, "index.ts")));

    const manifest = readJson(path.join(runtimeRoot, "runtime.json"));
    assert.deepEqual(Object.keys(manifest.plugins), ["flowtask-context-checkpoint"]);
    assert.equal(manifest.plugins["flowtask-context-checkpoint"].path, checkpointDir);
    assert.deepEqual(manifest.plugins["flowtask-context-checkpoint"].marker, {
      schema: 1,
      managedBy: "flowtask",
      plugin: "flowtask-context-checkpoint",
      version: "1.0.0",
      scope: "user",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repeated install keeps the local plugin unchanged and leaves foreign directories untouched", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const foreignDir = path.join(runtimeRoot, "plugins", "third-party");
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, "index.js"), "export default 'foreign';\n");

    installUserPlugins({ flowtaskDir, manifest: [GATE_ENTRY, CHECKPOINT_ENTRY], runtimeRoot });
    const firstManifest = fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8");
    const second = installUserPlugins({ flowtaskDir, manifest: [GATE_ENTRY, CHECKPOINT_ENTRY], runtimeRoot });

    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.replaced, []);
    assert.equal(second.unchanged.length, 1);
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8"),
      firstManifest,
      "a repeated install must not rewrite the runtime manifest",
    );
    assert.equal(fs.readFileSync(path.join(foreignDir, "index.js"), "utf8"), "export default 'foreign';\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
