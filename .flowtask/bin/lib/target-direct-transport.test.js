import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  dispatchTargetDirectDescriptor,
  persistTargetDirectDescriptor,
  rehydrateTargetDirectDescriptor,
  serializeTargetDirectDescriptor,
} from "./target-direct-transport.js";
import { dispatchRunnerTargetDirect, receiveConstructorTargetDirect } from "./runner-constructor-target-direct.js";

function descriptor() {
  const root = path.resolve("/tmp/flowtask-target-direct");
  return {
    descriptor_version: "1", operation: "link-parent", target_kind: "submodule",
    target_repo: `${root}/target`, target_common_dir: `${root}/target/.git`,
    parent_repo: `${root}/parent`, parent_common_dir: `${root}/parent/.git`,
    submodule_path: "sub", gitlink_sha: "0123456789012345678901234567890123456789",
    target_head: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", base: "main",
    base_sha: "fedcbafedcbafedcbafedcbafedcbafedcbafedc", branch: "worktree/CA2",
    worktree_path: `${root}/target/.worktrees/CA2`, link_parent: "staged-only",
    namespace: "CA-worktree-submodule-target-direct", owner: "123", phase: "verified",
    tx_id: "td-CA2", index_snapshot_ref: `${root}/snapshot`,
  };
}

test("descriptor transport validates, persists, rehydrates, and dispatches", () => {
  const input = descriptor();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-td-"));
  const file = path.join(root, "descriptor");
  const record = serializeTargetDirectDescriptor(input);
  assert.equal(persistTargetDirectDescriptor(file, input), record);
  assert.deepEqual({ ...rehydrateTargetDirectDescriptor(record) }, input);
  assert.deepEqual({ ...rehydrateTargetDirectDescriptor(fs.readFileSync(file)) }, input);
  const dispatched = dispatchTargetDirectDescriptor(input, (value) => value);
  assert.deepEqual({ ...dispatched }, input);
  assert.notEqual(dispatched, input);
  const constructorInput = dispatchRunnerTargetDirect(input, (value) => receiveConstructorTargetDirect(serializeTargetDirectDescriptor(value)));
  assert.deepEqual({ ...constructorInput }, input);
  assert.notEqual(constructorInput, input);
  const cliResult = requireCli(file);
  assert.equal(cliResult, record);
  assert.throws(() => rehydrateTargetDirectDescriptor(record.replace("phase=verified", "unknown=x\nphase=verified")), /Invalid/);
  assert.throws(() => serializeTargetDirectDescriptor({ ...input, extra: "no" }), /unknown|missing/);
  fs.rmSync(root, { recursive: true, force: true });
});

function requireCli(file) {
  const entry = new URL("./runner-constructor-target-direct.js", import.meta.url);
  return execFileSync(process.execPath, [fileURLToPath(entry), file], { encoding: "utf8" });
}

test("descriptor validation matrix fails closed for operations, phases, fields, and truncation", () => {
  const input = descriptor();
  for (const operation of ["create", "link-parent", "abort", "complete"]) {
    for (const phase of ["initial", "validated", "verified", "complete_validated", "remove_started", "removed", "closed", "aborted", "blocked"]) {
      assert.doesNotThrow(() => serializeTargetDirectDescriptor({ ...input, operation, phase }));
    }
  }
  const invalid = [["phase", "unknown"], ["submodule_path", "../sub"], ["submodule_path", "./sub"], ["branch", "worktree/other"], ["target_repo", `${path.dirname(input.target_repo)}/target/../target`], ["base_sha", input.base_sha.slice(0, -1)], ["gitlink_sha", "not-a-sha"], ["operation", "recover"], ["owner", "1\n2"]];
  for (const [key, value] of invalid) assert.throws(() => serializeTargetDirectDescriptor({ ...input, [key]: value }), /Invalid/);
  for (const key of Object.keys(input)) {
    const missing = { ...input };
    delete missing[key];
    assert.throws(() => serializeTargetDirectDescriptor(missing), /Invalid/);
  }
  const record = serializeTargetDirectDescriptor(input);
  assert.throws(() => rehydrateTargetDirectDescriptor(record.slice(0, -1)), /Invalid/);
  assert.throws(() => rehydrateTargetDirectDescriptor(record.replace("phase=verified", "phase=verified\nphase=verified")), /Invalid/);
  assert.throws(() => rehydrateTargetDirectDescriptor(record.replace("owner=123", "unknown=123\nowner=123")), /Invalid/);
});
