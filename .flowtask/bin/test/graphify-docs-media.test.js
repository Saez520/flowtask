import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { spawn } from "child_process";
import {
  generateDocsMedia,
  shouldOfferDocsMedia,
  buildRunningPatch,
  buildRejectionPatch,
  buildResultPatch,
  DOCS_MEDIA_COMMAND,
  GRAPHIFY_TIMEOUT_MS,
  GRAPHIFY_TERMINATION_GRACE_MS,
  REQUIRED_ARTIFACTS,
} from "../lib/graphify-docs-media.js";
import { createProjectState } from "../lib/graphify.js";

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "hanging-graphify.mjs");

function makeTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "graphify-docs-media-test-")); }
function cleanupDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function createAllArtifacts(dir, empty = false) {
  const out = path.join(dir, "graphify-out");
  fs.mkdirSync(out, { recursive: true });
  for (const artifact of REQUIRED_ARTIFACTS) fs.writeFileSync(path.join(out, artifact), empty ? "" : "ok");
}
function fakeChild(result) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  process.nextTick(() => child.emit("close", result.status ?? 0, result.signal ?? null));
  return child;
}
function fixtureSpawn(file, args, options) {
  if (file === "graphify") return spawn(process.execPath, [FIXTURE, ...args], options);
  return spawn(file, args, options);
}
function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}
async function waitForPidsToExit(pids) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pids.some(pidExists)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(pids.filter(pidExists), [], "timed-out process group still has live PIDs");
}

describe("Constants", () => {
  it("keeps the exact command contract and timeout", () => {
    assert.equal(DOCS_MEDIA_COMMAND, "graphify extract --docs --media --output-dir graphify-out");
    assert.equal(GRAPHIFY_TIMEOUT_MS, 120_000);
    assert.deepEqual(REQUIRED_ARTIFACTS, ["graph.json", "GRAPH_REPORT.md", "graph.html"]);
  });
});

describe("offer and patches", () => {
  it("offers unless docs/media succeeded", () => {
    assert.equal(shouldOfferDocsMedia(null), false);
    assert.equal(shouldOfferDocsMedia({ docs_media_status: "pending" }), true);
    assert.equal(shouldOfferDocsMedia({ docs_media_status: "failed" }), true);
    assert.equal(shouldOfferDocsMedia({ docs_media_status: "success" }), false);
  });

  it("builds schema-v1 running and rejection patches", () => {
    assert.equal(buildRunningPatch().docs_media_attempt_status, "running");
    assert.equal(buildRejectionPatch().docs_media_attempt_status, "rejected");
    assert.equal(buildRejectionPatch().docs_media_status, undefined);
  });

  it("marks only successful results as success", () => {
    const success = buildResultPatch({ attemptStatus: "success", outputPaths: ["a"], finishedAt: "t", diagnostic: null });
    const failure = buildResultPatch({ attemptStatus: "failed", outputPaths: [], finishedAt: "t", diagnostic: "retry" });
    assert.equal(success.docs_media_status, "success");
    assert.equal(failure.docs_media_status, "failed");
    assert.deepEqual(failure.docs_media_output_paths, []);
  });
});

describe("generateDocsMedia", () => {
  let tempDir;
  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("is asynchronous and spawns structured args with shell:false", async () => {
    createAllArtifacts(tempDir);
    let captured;
    const resultPromise = generateDocsMedia(tempDir, {
      detectFn: () => true,
      spawnFn: (file, args, options) => { captured = { file, args, options }; return fakeChild({ status: 0 }); },
    });
    assert.equal(typeof resultPromise.then, "function");
    const result = await resultPromise;
    assert.equal(captured.file, "graphify");
    assert.deepEqual(captured.args, ["extract", "--docs", "--media", "--output-dir", "graphify-out"]);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.cwd, tempDir);
    assert.equal(result.attemptStatus, "success");
  });

  it("verifies all artifacts after close", async () => {
    createAllArtifacts(tempDir);
    const result = await generateDocsMedia(tempDir, { detectFn: () => true, spawnFn: () => fakeChild({ status: 0 }) });
    assert.equal(result.attemptStatus, "success");
    assert.equal(result.outputPaths.length, 3);
    assert.equal(result.terminationConfirmed, true);
  });

  it("returns failed for unavailable binary, non-zero exit, and spawn errors", async () => {
    assert.equal((await generateDocsMedia(tempDir, { detectFn: () => false })).attemptStatus, "failed");
    const badExit = await generateDocsMedia(tempDir, { detectFn: () => true, spawnFn: () => fakeChild({ status: 3 }) });
    assert.match(badExit.diagnostic, /exit code 3/);
    const errorChild = new EventEmitter(); errorChild.stdout = new EventEmitter(); errorChild.stderr = new EventEmitter(); errorChild.pid = 1;
    const error = new Error("EACCES"); error.code = "EACCES";
    process.nextTick(() => { errorChild.emit("error", error); errorChild.emit("close", -1, null); });
    const failed = await generateDocsMedia(tempDir, { detectFn: () => true, spawnFn: () => errorChild });
    assert.match(failed.diagnostic, /EACCES/);
  });

  it("returns inconclusive when outputs are missing or empty", async () => {
    const missing = await generateDocsMedia(tempDir, { detectFn: () => true, spawnFn: () => fakeChild({ status: 0 }) });
    assert.equal(missing.attemptStatus, "inconclusive");
    createAllArtifacts(tempDir, true);
    const empty = await generateDocsMedia(tempDir, { detectFn: () => true, spawnFn: () => fakeChild({ status: 0 }) });
    assert.match(empty.diagnostic, /vacío/);
  });

  it("does not declare timeout before close and confirms real POSIX group termination", { skip: process.platform === "win32" }, async () => {
    const pidFile = path.join(tempDir, "pids.json");
    const resultPromise = generateDocsMedia(tempDir, {
      detectFn: () => true,
      spawnFn: (file, args, options) => spawn(process.execPath, [FIXTURE, "--pid-file", pidFile], options),
      timeoutMs: 100,
      graceMs: GRAPHIFY_TERMINATION_GRACE_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fs.existsSync(pidFile), true);
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pids.parent && pids.child);
    const result = await resultPromise;
    assert.equal(result.attemptStatus, "failed");
    assert.equal(result.terminationConfirmed, true);
    assert.match(result.diagnostic, /terminación fue confirmada/);
    await waitForPidsToExit([pids.parent, pids.child]);
  });

  it("uses taskkill /T /F without a shell on Windows", async () => {
    const calls = [];
    let graphifyChild;
    const result = await generateDocsMedia(tempDir, {
      detectFn: () => true,
      platform: "win32",
      timeoutMs: 5,
      spawnFn: (file, args, options) => {
        calls.push({ file, args, options });
        if (file === "taskkill.exe") {
          process.nextTick(() => graphifyChild.emit("close", null, "SIGTERM"));
          return fakeChild({ status: 0 });
        }
        graphifyChild = new EventEmitter(); graphifyChild.stdout = new EventEmitter(); graphifyChild.stderr = new EventEmitter(); graphifyChild.pid = 99;
        return graphifyChild;
      },
    });
    assert.equal(result.terminationConfirmed, true, "termination is confirmed only after close");
    assert.deepEqual(calls[1].args, ["/PID", "99", "/T", "/F"]);
    assert.equal(calls[1].options.shell, false);
  });

  it("rejects worktrees without spawning", async () => {
    const worktree = path.join(tempDir, ".worktrees", "CA-test");
    fs.mkdirSync(worktree, { recursive: true });
    const result = await generateDocsMedia(worktree, { detectFn: () => true, spawnFn: () => { throw new Error("must not spawn"); } });
    assert.match(result.diagnostic, /.worktrees/);
  });
});

describe("state transitions", () => {
  it("keeps retry offer after timeout/failure and removes it after success", () => {
    const state = createProjectState(); state.docs_media_status = "pending";
    Object.assign(state, buildRunningPatch(), buildResultPatch({ attemptStatus: "failed", outputPaths: [], finishedAt: "t", diagnostic: "retry" }));
    assert.equal(shouldOfferDocsMedia(state), true);
    Object.assign(state, buildResultPatch({ attemptStatus: "success", outputPaths: ["a"], finishedAt: "t", diagnostic: null }));
    assert.equal(shouldOfferDocsMedia(state), false);
  });
});
