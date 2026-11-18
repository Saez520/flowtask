// gap: G-1 — la copia legada se preserva y el aviso se repite cuando la capa global válida difiere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyOpencodeProject } from "../lib/opencode-project.js";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("legacy OpenCode layer migration", () => {
  it("removes legacy layers when the global layers are valid and different", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-legacy-layer-"));
    try {
      const projectDir = path.join(root, "project");
      const flowtaskDir = path.join(root, "flowtask");
      const runtimeRoot = path.join(root, "runtime");
      const legacyConfigDir = path.join(projectDir, ".opencode", "flowtask", "config");
      const globalConfigDir = path.join(runtimeRoot, "config");
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
      for (const [file, value] of Object.entries(legacyLayers)) {
        writeJson(path.join(legacyConfigDir, file), value);
      }
      for (const [file, value] of Object.entries(globalLayers)) {
        writeJson(path.join(globalConfigDir, file), value);
      }

      const result = migrateLegacyOpencodeProject({ projectDir, flowtaskDir, runtimeRoot });

      assert.equal(result.migrated, true);
      for (const file of Object.keys(legacyLayers)) {
        assert.equal(
          fs.existsSync(path.join(legacyConfigDir, file)),
          false,
          `the legacy ${file} must be removed when the global layer is valid`,
        );
      }
      assert.deepEqual(result.manualReview, [], "a valid global layer resolves the conflict without manual review");
      for (const [file, value] of Object.entries(globalLayers)) {
        assert.deepEqual(readJson(path.join(globalConfigDir, file)), value, `the global ${file} must stay intact`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
