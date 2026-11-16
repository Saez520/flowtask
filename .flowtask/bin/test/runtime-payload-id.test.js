import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ensureClaudeRuntime,
  readClaudeRuntimeManifest,
} from "../lib/claude-runtime.js";
import { buildPayloadIdFromSource } from "../lib/user-runtime.js";
import { resolveActiveRuntimePaths, sha256File } from "../lib/claude.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");
const VERSION = "9.9.9";
const STARTUP_VARIANT = "## Startup — run before answering (variant build)";
const STARTUP_ORIGINAL = '"## Startup — run before answering"';
const PLACEHOLDER_PATH_MARKER = "__flowtask_payload__";

const FIXTURES = [];

function makeRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  FIXTURES.push(root);
  return root;
}

function cleanupFixtures() {
  while (FIXTURES.length > 0) {
    fs.rmSync(FIXTURES.pop(), { recursive: true, force: true });
  }
}

function writeRuntimeSource(root) {
  const flowtaskDir = path.join(root, "runtime-source");
  for (const skill of ["investigacion", "memory-protocol", "zero-assumptions"]) {
    const dir = path.join(flowtaskDir, "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
  }
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
  fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(flowtaskDir, "agents", "runner.md"),
    [
      "---",
      "name: runner",
      "---",
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
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(path.join(flowtaskDir, "claude"), { recursive: true });
  fs.copyFileSync(
    path.join(FLOWTASK_SOURCE, "claude", "session-start.mjs"),
    path.join(flowtaskDir, "claude", "session-start.mjs"),
  );
  return flowtaskDir;
}

function runnerBody(marker) {
  return [
    "---",
    "name: runner",
    "---",
    `# Runtime runner ${marker}`,
    "",
    "## Skills disponibles",
    "",
    'skill({ name: "investigacion" })',
    'skill({ name: "memory-protocol" })',
    'skill({ name: "zero-assumptions" })',
    "",
  ].join("\n");
}

function writeVariantRuntime(root) {
  const sourceLib = path.join(FLOWTASK_SOURCE, "bin", "lib");
  const targetRoot = path.join(root, "variant-runtime");
  const targetLib = path.join(targetRoot, "lib");
  fs.mkdirSync(targetLib, { recursive: true });
  for (const entry of fs.readdirSync(sourceLib)) {
    if (!entry.endsWith(".js")) continue;
    fs.copyFileSync(path.join(sourceLib, entry), path.join(targetLib, entry));
  }
  fs.writeFileSync(path.join(targetRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");

  const runnerContentPath = path.join(targetLib, "runner-content.js");
  const content = fs.readFileSync(runnerContentPath, "utf8");
  const patched = content.replace(STARTUP_ORIGINAL, JSON.stringify(STARTUP_VARIANT));
  assert.notEqual(patched, content, "the startup block must be patchable for the variant runtime");
  fs.writeFileSync(runnerContentPath, patched, "utf8");
  return path.join(targetLib, "claude-runtime.js");
}

describe("runtime payload id", () => {
  it("derives the same id from identical inputs in different runtime roots", () => {
    const rootA = makeRoot("flowtask-payload-a-");
    const rootB = makeRoot("flowtask-payload-b-");
    const body = runnerBody("stable");
    try {
      const first = ensureClaudeRuntime(writeRuntimeSource(rootA), {
        runtimeRoot: path.join(rootA, "runtime"),
        runnerBody: body,
        version: VERSION,
      });
      const second = ensureClaudeRuntime(writeRuntimeSource(rootB), {
        runtimeRoot: path.join(rootB, "runtime"),
        runnerBody: body,
        version: VERSION,
      });

      assert.equal(first.payloadId, second.payloadId);
      assert.match(first.payloadId, /^9\.9\.9-[0-9a-f]{12}$/);
    } finally {
      cleanupFixtures();
    }
  });

  it("keeps the id stable when only the runner and the startup document change", () => {
    const files = (startupHash, skillHash = "b".repeat(64)) => [
      { path: "runner.md", sha256: "a".repeat(64) },
      { path: "session-start.md", sha256: startupHash },
      { path: "skills/investigacion/SKILL.md", sha256: skillHash },
    ];
    const id = (startupHash, skillHash) =>
      buildPayloadIdFromSource({ version: VERSION, files: files(startupHash, skillHash) });

    assert.equal(
      id("c".repeat(64)),
      id("d".repeat(64)),
      "the generated runner and startup document must not change the payload identity",
    );
    assert.notEqual(
      id("c".repeat(64)),
      id("c".repeat(64), "e".repeat(64)),
      "a change in the source tree must produce a new payload identity",
    );
    assert.equal(id("c".repeat(64)), id("c".repeat(64)));
  });

  it("republishes the startup document inside the same payload when it changes", async () => {
    const root = makeRoot("flowtask-payload-startup-");
    const flowtaskDir = writeRuntimeSource(root);
    const runtimeRoot = path.join(root, "runtime");
    const body = runnerBody("stable");
    try {
      const first = ensureClaudeRuntime(flowtaskDir, {
        runtimeRoot,
        runnerBody: body,
        version: VERSION,
      });
      const firstManifest = readClaudeRuntimeManifest(runtimeRoot);
      assert.equal(firstManifest.schema, 2);
      const firstPayload = firstManifest.payloads.claude;

      const variantModule = await import(pathToFileURL(writeVariantRuntime(root)).href);
      const second = variantModule.ensureClaudeRuntime(flowtaskDir, {
        runtimeRoot,
        runnerBody: body,
        version: VERSION,
      });

      assert.equal(second.action, "updated");
      assert.equal(second.payloadId, first.payloadId, "the startup document must not move the payload");
      assert.equal(second.previousPayloadId, null, "no previous payload is retained for an in-place republication");
      assert.ok(
        second.restoredPaths.some((file) => file.endsWith("session-start.md")),
        "the regenerated startup document is reported as restored",
      );

      const secondManifest = readClaudeRuntimeManifest(runtimeRoot);
      const secondPayload = secondManifest.payloads.claude;
      assert.equal(secondPayload.payloadId, firstPayload.payloadId);
      const secondActive = resolveActiveRuntimePaths(runtimeRoot, secondManifest);
      const finalStartup = fs.readFileSync(secondActive.sessionStartPath, "utf8");
      assert.ok(finalStartup.includes(STARTUP_VARIANT));
      assert.ok(finalStartup.includes(secondActive.skillsDir));
      assert.equal(finalStartup.includes(PLACEHOLDER_PATH_MARKER), false);
      assert.equal(
        secondPayload.files.filter((file) => file.path === "session-start.md").length,
        1,
      );
      assert.equal(
        sha256File(secondActive.sessionStartPath),
        secondPayload.files.find((file) => file.path === "session-start.md").sha256,
      );
    } finally {
      cleanupFixtures();
    }
  });
});
