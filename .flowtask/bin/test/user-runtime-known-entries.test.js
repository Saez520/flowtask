// gap: G-1 — el guard vuelve a rechazar projects.json, graphify.json o .DS_Store antes del manifiesto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { ensureClaudeRuntime } from "../lib/claude-runtime.js";
import { adaptRunnerForRuntime } from "../lib/runner-content.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");

const FIXTURES = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-known-entries-"));
  FIXTURES.push(root);
  return root;
}

function cleanupFixtures() {
  while (FIXTURES.length > 0) {
    fs.rmSync(FIXTURES.pop(), { recursive: true, force: true });
  }
}

function minimalRuntimeRunner() {
  return [
    "---",
    "name: runner",
    "---",
    "# Runtime runner",
    "",
    'FLOWTASK_SCRIPTS="./.flowtask/scripts"',
    "Skills live in `.flowtask/skills/`.",
    "Transport: `.flowtask/bin/lib/target-direct-transport.js`.",
    "",
    "## Skills disponibles",
    "",
    'skill({ name: "investigacion" })',
    'skill({ name: "memory-protocol" })',
    'skill({ name: "zero-assumptions" })',
    "",
    "***",
    "",
  ].join("\n");
}

function writeMinimalRuntimeSource(root) {
  const flowtaskDir = path.join(root, "runtime-source");
  for (const skill of ["investigacion", "memory-protocol", "zero-assumptions"]) {
    const dir = path.join(flowtaskDir, "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
  }
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
  fs.mkdirSync(path.join(flowtaskDir, "bin", "lib"), { recursive: true });
  for (const file of ["target-direct-transport.js", "worktree-commit-message.js"]) {
    fs.writeFileSync(path.join(flowtaskDir, "bin", "lib", file), `// ${file}\n`, "utf8");
  }
  fs.mkdirSync(path.join(flowtaskDir, "claude"), { recursive: true });
  fs.copyFileSync(
    path.join(FLOWTASK_SOURCE, "claude", "session-start.mjs"),
    path.join(flowtaskDir, "claude", "session-start.mjs"),
  );
  fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), minimalRuntimeRunner(), "utf8");
  fs.mkdirSync(path.join(flowtaskDir, "commands"), { recursive: true });
  fs.writeFileSync(
    path.join(flowtaskDir, "package.json"),
    JSON.stringify({ name: "flowtask-cli", version: "9.9.9" }),
    "utf8",
  );
  return flowtaskDir;
}

function writeKnownEntries(runtimeRoot) {
  fs.mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "versions"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "projects.json"), JSON.stringify({ projects: [] }), "utf8");
  fs.writeFileSync(path.join(runtimeRoot, "graphify.json"), JSON.stringify({ projects: {} }), "utf8");
  fs.writeFileSync(path.join(runtimeRoot, ".DS_Store"), "system metadata", "utf8");
}

describe("runtime root known entries", () => {
  it("accepts the known runtime state without a manifest and still rejects an unknown entry", () => {
    const root = makeRoot();
    try {
      const flowtaskDir = writeMinimalRuntimeSource(root);
      const body = (payloadPaths) => adaptRunnerForRuntime(minimalRuntimeRunner(), payloadPaths.payloadDir);

      const knownRoot = path.join(root, "known");
      writeKnownEntries(knownRoot);
      const result = ensureClaudeRuntime(flowtaskDir, {
        runtimeRoot: knownRoot,
        buildRunnerBody: body,
        version: "1.0.0",
      });
      assert.equal(result.action, "installed");
      assert.equal(
        fs.existsSync(path.join(knownRoot, "runtime.json")),
        true,
        "the update creates the manifest once the known state is accepted",
      );
      for (const entry of ["projects.json", "graphify.json", ".DS_Store"]) {
        assert.equal(fs.existsSync(path.join(knownRoot, entry)), true, `${entry} is preserved`);
      }

      const unmanagedRoot = path.join(root, "unmanaged");
      writeKnownEntries(unmanagedRoot);
      fs.writeFileSync(path.join(unmanagedRoot, "stray.txt"), "keep", "utf8");
      assert.throws(
        () => ensureClaudeRuntime(flowtaskDir, {
          runtimeRoot: unmanagedRoot,
          buildRunnerBody: body,
          version: "1.0.0",
        }),
        (error) => error.code === "runtime_root_unmanaged",
        "an unknown visible entry still blocks the unmanaged root",
      );
      assert.equal(fs.existsSync(path.join(unmanagedRoot, "runtime.json")), false);
    } finally {
      cleanupFixtures();
    }
  });
});
