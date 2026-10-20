/**
 * Automatic verification of the evidence of the phase.
 *
 * The test observes the published evidence against the repository it
 * describes: the digests, the verdict of the entry gate, the gitlink, the
 * local tag, the absence of absolute paths, the compatibility scenarios, the
 * result of the rebaselined suite and the integrity of the previous phases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EVIDENCE = path.join(ROOT, "docs", "operations", "worktree-phase-9");
const SUBMODULE = path.join(ROOT, ".flowtask", "scripts", "worktree-manager");
const BASE = "bd3eab24c6687a7fbed69be7f807c169ba01d34b";

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: "pipe" });
}

function gitIn(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
}

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(EVIDENCE, name), "utf8"));
}

test("the six digests of the phase verify", () => {
  const manifest = fs.readFileSync(path.join(EVIDENCE, "SHA256SUMS"), "utf8");
  const entries = manifest.trim().split("\n").map((line) => line.trim().split(/\s+/));
  assert.equal(entries.length, 6);
  for (const [digest, name] of entries) {
    const content = fs.readFileSync(path.join(EVIDENCE, name));
    assert.equal(crypto.createHash("sha256").update(content).digest("hex"), digest, name);
  }
});

test("the entry gate publishes a passing verdict", () => {
  const entry = read("entry-integrity.json");
  assert.equal(entry.phase, 9);
  assert.equal(entry.verdict, "PASS");
  assert.equal(entry.source.f8_evidence_sha256.verified, 6);
  assert.equal(entry.source.f8_evidence_sha256.total, 6);
  assert.equal(entry.source.gitlink_matches_checkout, true);
  assert.equal(entry.reconstruction.standalone_cli_version, "1.0.0");
  assert.equal(entry.reconstruction.standalone_mcp_tool_count, 7);
  assert.equal(entry.reconstruction.scratch_removed, true);
});

test("the snapshot keeps the delivery pending", () => {
  const snapshot = read("final-snapshot.json");
  assert.equal(snapshot.delivery.main_sync, "pending");
  assert.equal(snapshot.delivery.pushed, false);
  assert.equal(snapshot.delivery.release_approved, false);
  assert.equal(snapshot.standalone.published, false);
  assert.equal(snapshot.standalone.tag, "phase-9");
  assert.equal(snapshot.consumer.gitmodules_unchanged, true);
  assert.equal(snapshot.consumer.version, "1.25.0");
});

test("the registered gitlink matches the materialised checkout and the local tag", () => {
  const snapshot = read("final-snapshot.json");
  const registered = git("ls-tree", "HEAD", "--", ".flowtask/scripts/worktree-manager").trim();
  const head = gitIn(SUBMODULE, "rev-parse", "HEAD").trim();
  assert.match(registered, /160000 commit [0-9a-f]{40}/);
  assert.equal(registered.split(/\s+/)[2], snapshot.consumer.gitlink_after);
  assert.equal(head, snapshot.consumer.gitlink_after);
  assert.match(gitIn(SUBMODULE, "tag", "--points-at", head), /phase-9/);
});

test("the evidence of the phase contains no absolute path of the machine", () => {
  for (const name of fs.readdirSync(EVIDENCE)) {
    const content = fs.readFileSync(path.join(EVIDENCE, name), "utf8");
    assert.doesNotMatch(content, /\/private\/tmp/, name);
    assert.doesNotMatch(content, /\/Users\//, name);
    assert.doesNotMatch(content, /\/home\//, name);
  }
});

test("the compatibility evidence publishes the eight scenarios and the suite results", () => {
  const compatibility = read("compatibility-evidence.json");
  assert.equal(compatibility.phase, 9);
  assert.deepEqual(compatibility.scenarios.map((scenario) => scenario.id), ["A", "B", "C", "D", "E", "F", "G", "H"]);
  assert.ok(compatibility.scenarios.every((scenario) => scenario.result === "pass"));
  assert.equal(compatibility.legacy_suite.fail, 0);
  assert.equal(compatibility.legacy_suite.sentinel_cases, 15);
  assert.equal(compatibility.legacy_suite.sentinel_observed, 15);
  assert.ok(compatibility.legacy_suite.deleted_tests.length > 0);
  assert.ok(compatibility.legacy_suite.deleted_tests.every((entry) => entry.name && entry.reason));
  assert.equal(compatibility.standalone_isolation.mcp_tool_count, 7);
  assert.equal(compatibility.standalone_isolation.flowtask_or_engram_required, false);
});

test("the recorded suites match the published results and register the known failures", () => {
  const snapshot = read("final-snapshot.json");
  const suites = [...snapshot.suites.standalone, ...snapshot.suites.consumer];
  const byName = new Map(suites.map((suite) => [suite.name, suite]));
  assert.equal(byName.get("worktree_hotfix").fail, 0);
  assert.equal(byName.get("worktree_consumer_adapter").pass, 25);
  assert.equal(byName.get("worktree_consumer_matrix").pass, 58);
  assert.equal(byName.get("worktree_adapter_compat").pass, 8);
  assert.equal(byName.get("permission_gate_plugin").pass, 60);
  assert.ok(byName.get("installer").known_failure, "the known installer failure is registered");
  assert.equal(byName.get("installer").fail, 1);
  assert.ok(byName.get("opencode").known_failure, "the known OpenCode failure is registered");
});

test("the previous phases are unchanged", () => {
  assert.equal(git("diff", `${BASE}..HEAD`, "--", "docs/operations/worktree-phase-8").trim(), "");
  assert.equal(git("diff", `${BASE}..HEAD`, "--", "docs/worktree-manager").trim(), "");
  assert.equal(git("diff", `${BASE}..HEAD`, "--", ".gitmodules").trim(), "");
  assert.equal(git("rev-parse", "refs/heads/worktree/CA-worktree-manager-phase-8").trim(), BASE);
});
