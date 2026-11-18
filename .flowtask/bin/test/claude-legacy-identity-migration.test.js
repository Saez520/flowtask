// gap: G-2 — el import de readIdentityProfile vuelve a faltar y la migración legacy de identidad revienta con ReferenceError.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { migrateLegacyClaudeRuntime } from "../lib/claude-install.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");

const FIXTURES = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-legacy-identity-"));
  FIXTURES.push(root);
  return root;
}

function cleanupFixtures() {
  while (FIXTURES.length > 0) {
    fs.rmSync(FIXTURES.pop(), { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("legacy identity migration", () => {
  it("migrates the legacy identity profile without a ReferenceError and keeps its base name", () => {
    const root = makeRoot();
    try {
      const claudeUserDir = path.join(root, "claude");
      const runtimeRoot = path.join(root, "runtime");
      const legacyRoot = path.join(claudeUserDir, "flowtask");
      writeJson(path.join(legacyRoot, "runtime.json"), {
        schema: 1,
        payloadId: "legacy-payload",
        files: [],
      });
      writeJson(path.join(legacyRoot, "config", "identity.json"), {
        version: 1,
        baseName: "Maitén",
      });
      fs.mkdirSync(runtimeRoot, { recursive: true });

      const result = migrateLegacyClaudeRuntime({
        flowtaskDir: FLOWTASK_SOURCE,
        runtimeRoot,
        claudeUserDir,
      });

      assert.equal(result.migrated, true);
      const destination = path.join(runtimeRoot, "config", "identity.json");
      assert.equal(fs.existsSync(destination), true, "the legacy identity is migrated to the runtime");
      assert.deepEqual(readJson(destination), { version: 1, baseName: "Maitén" });
      assert.equal(
        fs.existsSync(path.join(legacyRoot, "config", "identity.json")),
        false,
        "the migrated legacy copy is removed",
      );
    } finally {
      cleanupFixtures();
    }
  });
});
