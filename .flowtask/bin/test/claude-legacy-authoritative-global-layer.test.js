// gap: G-2 — el mismo caso persiste en las dos funciones de Claude.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyClaudeProject, migrateLegacyClaudeRuntime } from "../lib/claude-install.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function assertLayersRemoved(configDir, files, label) {
  for (const file of files) {
    assert.equal(
      fs.existsSync(path.join(configDir, file)),
      false,
      `the legacy ${file} must be removed when the global layer is valid (${label})`,
    );
  }
}

function assertGlobalLayers(globalConfigDir, layers) {
  for (const [file, value] of Object.entries(layers)) {
    assert.deepEqual(readJson(path.join(globalConfigDir, file)), value, `the global ${file} must stay intact`);
  }
}

describe("legacy Claude layer migration", () => {
  it("removes legacy layers in the project and runtime migrations when the global layers are valid and different", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-claude-legacy-layer-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      const xdgConfigHome = path.join(root, "xdg");
      const runtimeRoot = path.join(xdgConfigHome, "flowtask");
      const globalConfigDir = path.join(runtimeRoot, "config");
      process.env.XDG_CONFIG_HOME = xdgConfigHome;
      process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-user");

      const legacyLayers = {
        "profile.json": { level: "senior", persona: "tutor-senior", onboarded: true },
        "autonomy.json": { version: 1, profile: "autonomous-dev" },
        "permissions.json": { version: 1, envelope: "standard" },
      };
      const globalLayers = {
        "profile.json": { level: "mid", persona: "tutor-mid", onboarded: true },
        "autonomy.json": { version: 1, profile: "assistant" },
        "permissions.json": { version: 1, envelope: "standard" },
      };
      for (const [file, value] of Object.entries(globalLayers)) {
        writeJson(path.join(globalConfigDir, file), value);
      }

      const projectDir = path.join(root, "project");
      const projectConfigDir = path.join(projectDir, ".claude", "flowtask", "config");
      for (const [file, value] of Object.entries(legacyLayers)) {
        writeJson(path.join(projectConfigDir, file), value);
      }

      const projectResult = migrateLegacyClaudeProject({
        projectDir,
        runtimeRoot,
        flowtaskDir: path.join(root, "flowtask"),
      });

      assert.equal(projectResult.migrated, true);
      assertLayersRemoved(projectConfigDir, Object.keys(legacyLayers), "project");
      assert.deepEqual(projectResult.manualReview, [], "the project conflict must not require manual review");
      assertGlobalLayers(globalConfigDir, globalLayers);

      const claudeUserDir = path.join(root, "claude-user");
      const legacyRoot = path.join(claudeUserDir, "flowtask");
      writeJson(path.join(legacyRoot, "runtime.json"), { schema: 1, payloadId: "legacy-payload", files: [] });
      const legacyConfigDir = path.join(legacyRoot, "config");
      for (const [file, value] of Object.entries(legacyLayers)) {
        writeJson(path.join(legacyConfigDir, file), value);
      }
      writeJson(path.join(legacyConfigDir, "identity.json"), { version: 1, baseName: "Maitén" });
      writeJson(path.join(globalConfigDir, "identity.json"), { version: 1, baseName: "Global" });

      const runtimeResult = migrateLegacyClaudeRuntime({
        flowtaskDir: path.join(root, "flowtask"),
        runtimeRoot,
        claudeUserDir,
      });

      assert.equal(runtimeResult.migrated, true);
      assertLayersRemoved(legacyConfigDir, Object.keys(legacyLayers), "runtime");
      assertGlobalLayers(globalConfigDir, globalLayers);
      assert.deepEqual(
        runtimeResult.manualReview.filter((message) => /profile|autonomy|permissions/.test(message)),
        [],
        "valid global layers resolve the conflict without manual review",
      );
      assert.equal(runtimeResult.manualReview.length, 1, "only the identity conflict is preserved for review");
      assert.match(runtimeResult.manualReview[0], /identity/);
      assert.deepEqual(
        readJson(path.join(legacyConfigDir, "identity.json")),
        { version: 1, baseName: "Maitén" },
        "identity.json keeps its conservative behavior",
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
