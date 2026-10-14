import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyOwnership, OWNERSHIP, OWNER_MARKER, registerPluginPackageEntry, replaceManagedPackage } from "./ownership.js";

test("ownership classifies absent, external, symlink, and exact V2 marker deterministically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-owner-"));
  try {
    const plugin = path.join(root, "plugin");
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.ABSENT);
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, "third-party.txt"), "keep");
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.EXTERNAL);
    fs.writeFileSync(path.join(plugin, ".flowtask-plugin-owner.json"), JSON.stringify(OWNER_MARKER));
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.MANAGED_V2);
    fs.rmSync(plugin, { recursive: true });
    fs.symlinkSync(root, plugin);
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.AMBIGUOUS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed package staging validates its generated owner marker and publishes the V2 package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-owner-stage-"));
  try {
    const sourceDir = path.join(root, "source");
    const destinationDir = path.join(root, "plugins", "flowtask-context-checkpoint");
    const configPath = path.join(root, "opencode.json");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "package.json"), JSON.stringify({ dependencies: { "@opencode/plugin": "^1" } }));
    fs.writeFileSync(path.join(sourceDir, "index.ts"), "export {};\n");
    fs.writeFileSync(configPath, JSON.stringify({ plugin: [] }));

    assert.equal(replaceManagedPackage({ sourceDir, destinationDir, configPath }).ownership, OWNERSHIP.ABSENT);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destinationDir, ".flowtask-plugin-owner.json"), "utf8")), OWNER_MARKER);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).plugins, [{ package: "./plugins/flowtask-context-checkpoint" }]);
    assert.deepEqual(fs.readdirSync(path.dirname(destinationDir)), ["flowtask-context-checkpoint"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package registration removes legacy references and is idempotent without changing unrelated entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-owner-register-"));
  try {
    const configPath = path.join(root, "opencode.json");
    const config = {
      $schema: "https://custom.example/schema.json",
      plugin: [
        "./plugins/flowtask-context-checkpoint/index.ts",
        "./plugins/user-plugin/index.ts",
        { path: "plugins/flowtask-context-checkpoint/index.ts", enabled: false },
      ],
      plugins: [
        "./plugins/flowtask-context-checkpoint",
        { package: "./plugins/user-package", options: { enabled: true } },
      ],
      experimental: { preserve: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(config));

    assert.equal(registerPluginPackageEntry(configPath), true);
    const registered = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.deepEqual(registered.plugin, ["./plugins/user-plugin/index.ts"]);
    assert.deepEqual(registered.plugins, [
      { package: "./plugins/user-package", options: { enabled: true } },
      { package: "./plugins/flowtask-context-checkpoint" },
    ]);
    assert.deepEqual(registered.experimental, { preserve: true });
    assert.equal(registered.$schema, config.$schema);

    assert.equal(registerPluginPackageEntry(configPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), registered);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
