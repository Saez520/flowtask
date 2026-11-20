import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ensureUserEngram, ensureUserEngramOrWarn } from "./claude-mcp.js";

// gap: G-1 — a failing user-scope registration used to abort the whole update; it must degrade to a warning and keep the Claude surfaces usable

const fixtures = [];

afterEach(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
  fixtures.length = 0;
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-test-"));
  fixtures.push(dir);
  return dir;
}

test("G-1: a failed user-scope registration warns with the error and the manual command", () => {
  const failure = {
    ok: false,
    action: "failed",
    managed: false,
    error:
      "The Claude Code CLI is unavailable (spawnSync claude ENOENT). " +
      "Run manually: claude mcp add --scope user engram -- engram mcp",
    command: "claude mcp add --scope user engram -- engram mcp",
  };
  const warnings = [];
  const calls = [];

  const result = ensureUserEngramOrWarn({
    claudeUserDir: path.join(makeTempDir(), ".claude"),
    ensure: (input) => {
      calls.push(input);
      return failure;
    },
    warn: (message) => warnings.push(message),
  });

  assert.equal(result, failure, "the caller receives the original result");
  assert.equal(calls.length, 1, "the registration is attempted exactly once");
  assert.equal(warnings.length, 1, "a degraded registration emits a single warning");
  assert.match(warnings[0], /Could not register Engram in the Claude user scope/);
  assert.ok(warnings[0].includes(failure.error), "the warning keeps the original error");
  assert.ok(
    warnings[0].includes("claude mcp add --scope user engram -- engram mcp"),
    "the warning keeps the exact manual command",
  );
});

test("G-1: a successful user-scope registration does not warn", () => {
  const success = { ok: true, action: "present", managed: false, error: null, command: "claude mcp add --scope user engram -- engram mcp" };
  const warnings = [];

  const result = ensureUserEngramOrWarn({
    claudeUserDir: path.join(makeTempDir(), ".claude"),
    ensure: () => success,
    warn: (message) => warnings.push(message),
  });

  assert.equal(result, success);
  assert.equal(warnings.length, 0, "an available registration stays silent");
});

test("G-1: an unavailable CLI reports the manual command instead of editing the user state", () => {
  const claudeUserDir = path.join(makeTempDir(), ".claude");

  const result = ensureUserEngram({
    claudeUserDir,
    claudeBin: "claude",
    spawn: () => ({ error: new Error("spawnSync claude ENOENT"), status: null }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "failed");
  assert.match(result.error, /claude mcp add --scope user engram -- engram mcp/);
  assert.equal(
    fs.existsSync(path.join(claudeUserDir, ".claude.json")),
    false,
    "the manual fallback never writes the user state",
  );
});
