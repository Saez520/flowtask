import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  publishGlobalWorktreeManager,
  renameWithRetry,
  ensureGlobalWorktreeManager,
  classifyGlobalManagerOwnership,
  readManagerVersion,
  formatWorktreeManagerVersionNotice,
  WORKTREE_MANAGER_OWNER_FILE,
} from "../lib/worktree-manager-runtime.js";

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "wm-")); }

function makeSource(dir) {
  fs.mkdirSync(path.join(dir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "worktree_manager", "__init__.py"), '__version__ = "1.0.0"\n');
  fs.writeFileSync(path.join(dir, "worktree_manager", "__main__.py"), "print('ok')\n");
  fs.writeFileSync(path.join(dir, "worktree_manager", "mcp_transport.py"), "print('ok')\n");
}

test("clean publish creates runtime and marker", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  const res = publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, sourceCommit: "abc", version: "1.0.0" });
  assert.equal(res.version, "1.0.0");
  assert.equal(fs.existsSync(path.join(dest, "worktree.sh")), false, "the shell entrypoint is not published");
  assert.ok(fs.existsSync(path.join(dest, "worktree_manager", "__init__.py")));
  assert.equal(readManagerVersion(dest), "1.0.0");
  const marker = JSON.parse(fs.readFileSync(path.join(dest, ".flowtask-worktree-manager-owner.json"), "utf8"));
  assert.equal(marker.version, "1.0.0");
  assert.ok(Array.isArray(marker.files) && marker.files.length > 0);
});

test("external destination is not modified", () => {
  const src = mkTmp();
  const dest = mkTmp();
  fs.writeFileSync(path.join(dest, "loose.txt"), "keep");
  makeSource(src);
  assert.throws(() => publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0" }), /ownership-external/);
  assert.equal(fs.readFileSync(path.join(dest, "loose.txt"), "utf8"), "keep");
});

test("ambiguous marker is not modified", () => {
  const src = mkTmp();
  const dest = mkTmp();
  fs.writeFileSync(path.join(dest, ".flowtask-worktree-manager-owner.json"), "{bad json");
  makeSource(src);
  assert.throws(() => publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0" }), /ownership-ambiguous/);
});

test("preserves non-managed file on update", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0" });
  fs.writeFileSync(path.join(dest, "custom.txt"), "preserve-me");
  // bump version
  fs.writeFileSync(path.join(src, "worktree_manager", "__init__.py"), '__version__ = "2.0.0"\n');
  const updated = publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "2.0.0" });
  assert.equal(fs.readFileSync(path.join(dest, "custom.txt"), "utf8"), "preserve-me");
  assert.equal(readManagerVersion(dest), "2.0.0");
  assert.equal(updated.previousVersion, "1.0.0");
  assert.equal(updated.versionChanged, true);
});

test("version notice", () => {
  assert.equal(formatWorktreeManagerVersionNotice({ previousVersion: "1.0.0", version: "1.0.0" }), null);
  assert.match(formatWorktreeManagerVersionNotice({ previousVersion: "1.0.0", version: "2.0.0" }), /1\.0\.0/);
});

test("rollback on fault injector", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", sourceCommit: "abc" });
  fs.writeFileSync(path.join(src, "worktree_manager", "__init__.py"), '__version__ = "2.0.0"\n');
  assert.throws(() => publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "2.0.0", sourceCommit: "abc", faultInjector: (p) => { if (p === "STAGE-PUBLISH") throw new Error("boom"); } }), /boom/);
  assert.equal(readManagerVersion(dest), "1.0.0");
});

test("rollback after the swap restores the previous managed copy", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", sourceCommit: "abc" });
  fs.writeFileSync(path.join(src, "worktree_manager", "__init__.py"), '__version__ = "2.0.0"\n');

  assert.throws(
    () => publishGlobalWorktreeManager({
      sourceDir: src,
      destinationDir: dest,
      version: "2.0.0",
      sourceCommit: "abc",
      faultInjector: (phase) => { if (phase === "CONFIG") throw new Error("config-boom"); },
    }),
    /config-boom/,
  );
  assert.equal(readManagerVersion(dest), "1.0.0");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), "utf8")).version, "1.0.0");
});

test("same version is idempotent and reports no change", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", sourceCommit: "abc" });
  const second = publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", sourceCommit: "abc" });
  assert.equal(second.previousVersion, "1.0.0");
  assert.equal(second.version, "1.0.0");
  assert.equal(second.versionChanged, false);
  assert.equal(formatWorktreeManagerVersionNotice({ previousVersion: second.previousVersion, version: second.version }), null);
});

test("a managed file removed from the source disappears from the destination", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  fs.writeFileSync(path.join(src, "worktree_manager", "legacy_feature.py"), "def legacy():\n    return 1\n");
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", sourceCommit: "abc" });
  assert.ok(fs.existsSync(path.join(dest, "worktree_manager", "legacy_feature.py")));

  fs.rmSync(path.join(src, "worktree_manager", "legacy_feature.py"));
  fs.writeFileSync(path.join(src, "worktree_manager", "__init__.py"), '__version__ = "2.0.0"\n');
  publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "2.0.0", sourceCommit: "abc" });

  assert.equal(fs.existsSync(path.join(dest, "worktree_manager", "legacy_feature.py")), false);
  const marker = JSON.parse(fs.readFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), "utf8"));
  assert.equal(marker.files.includes("worktree_manager/legacy_feature.py"), false);
});

test("ownership classification distinguishes absent, managed, external and ambiguous", () => {
  const dest = path.join(mkTmp(), "worktree-manager");
  assert.equal(classifyGlobalManagerOwnership(dest).state, "ABSENT");

  makeSource(dest);
  assert.equal(classifyGlobalManagerOwnership(dest).state, "EXTERNAL");

  fs.writeFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), JSON.stringify({
    schema: 1,
    managedBy: "flowtask",
    component: "worktree-manager",
    source: "submodule",
    sourceCommit: null,
    version: "1.0.0",
    files: ["worktree_manager/__main__.py"],
  }));
  assert.equal(classifyGlobalManagerOwnership(dest).state, "MANAGED");

  fs.writeFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), JSON.stringify({
    schema: 1,
    managedBy: "someone-else",
    component: "worktree-manager",
    source: "submodule",
    sourceCommit: null,
    version: "1.0.0",
    files: ["worktree_manager/__main__.py"],
  }));
  assert.equal(classifyGlobalManagerOwnership(dest).state, "AMBIGUOUS");
});

test("a missing source runtime entry fails before the destination is created", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  fs.writeFileSync(path.join(src, "worktree.sh"), "#!/bin/sh\n");
  assert.throws(
    () => publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0" }),
    /source runtime entry missing: worktree_manager/,
  );
  assert.equal(fs.existsSync(dest), false);
});

/**
 * gap_ref: G3 — C2
 * defecto: A `submodule` marker could be rejected or keep its old origin after
 *   update.
 * why_not_detected: The runtime tests created markers but never asserted the
 *   origin migration.
 * comportamiento observable: A MANAGED submodule marker is accepted, the
 *   updated marker reports `source: "npm"` and `sourceCommit: null`, and
 *   non-managed files survive.
 */
test("a managed submodule marker becomes npm on update and keeps non-managed files", () => {
  const src = mkTmp();
  makeSource(src);
  fs.writeFileSync(path.join(src, "worktree_manager", "__init__.py"), '__version__ = "2.0.0"\n');
  const dest = path.join(mkTmp(), "worktree-manager");
  fs.mkdirSync(path.join(dest, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(dest, "worktree.sh"), "old entrypoint");
  fs.writeFileSync(path.join(dest, "worktree_manager", "__main__.py"), "old main");
  fs.writeFileSync(path.join(dest, "worktree_manager", "mcp_transport.py"), "old transport");
  fs.writeFileSync(path.join(dest, "custom.txt"), "preserve-me");
  fs.writeFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), JSON.stringify({
    schema: 1,
    managedBy: "flowtask",
    component: "worktree-manager",
    source: "submodule",
    sourceCommit: "584e909",
    version: "1.0.1",
    files: ["worktree.sh", "worktree_manager/__main__.py", "worktree_manager/mcp_transport.py"],
  }));

  assert.equal(classifyGlobalManagerOwnership(dest).state, "MANAGED", "the previous submodule copy is accepted");

  const report = ensureGlobalWorktreeManager({
    sourceDir: src,
    destinationDir: dest,
    source: "npm",
    version: "2.0.0",
    detectCapabilities: () => ({
      transports: ["cli"],
      cli: { available: true, version: "2.0.0" },
      mcp: { available: false, cause: "fixture" },
    }),
  });

  const marker = JSON.parse(fs.readFileSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE), "utf8"));
  assert.equal(marker.source, "npm");
  assert.equal(marker.sourceCommit, null, "an npm copy has no source commit");
  assert.equal(marker.version, "2.0.0");
  assert.equal(report.sourceKind, "npm");
  assert.equal(report.previousVersion, "1.0.1");
  assert.equal(report.versionChanged, true);
  assert.equal(fs.readFileSync(path.join(dest, "custom.txt"), "utf8"), "preserve-me");
  assert.equal(fs.existsSync(path.join(dest, "worktree.sh")), false, "the obsolete managed entrypoint is dropped");
});

test("readManagerVersion returns null without a readable package", () => {
  assert.equal(readManagerVersion(path.join(mkTmp(), "missing")), null);
  const dir = mkTmp();
  fs.mkdirSync(path.join(dir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree_manager", "__init__.py"), '"""No version here."""\n');
  assert.equal(readManagerVersion(dir), null);
});


function transient(code) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

test("renameWithRetry succeeds on the third attempt after transient errors", () => {
  const delays = [];
  let calls = 0;
  const renameSync = () => {
    calls += 1;
    if (calls < 3) throw transient(calls === 1 ? "EPERM" : "EBUSY");
  };
  renameWithRetry("a", "b", { renameSync, sleep: (ms) => delays.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("renameWithRetry gives up after six attempts and tells how to unblock", () => {
  let calls = 0;
  const renameSync = () => { calls += 1; throw transient("EACCES"); };
  assert.throws(
    () => renameWithRetry("a", "b", { renameSync, sleep: () => {} }),
    (error) => error.code === "EACCES" && /Close OpenCode/.test(error.message) && /Python/.test(error.message),
  );
  assert.equal(calls, 6);
});

test("renameWithRetry does not retry a non transient error", () => {
  let calls = 0;
  const renameSync = () => { calls += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  assert.throws(() => renameWithRetry("a", "b", { renameSync, sleep: () => {} }), /missing/);
  assert.equal(calls, 1);
});

test("publish survives a transient lock on the stage rename", () => {
  const src = mkTmp();
  const dest = path.join(mkTmp(), "worktree-manager");
  makeSource(src);
  let failures = 2;
  const renameSync = (from, to) => {
    if (failures > 0) { failures -= 1; throw transient("EPERM"); }
    fs.renameSync(from, to);
  };
  const res = publishGlobalWorktreeManager({ sourceDir: src, destinationDir: dest, version: "1.0.0", renameSync, sleep: () => {} });
  assert.equal(res.version, "1.0.0");
  assert.ok(fs.existsSync(path.join(dest, WORKTREE_MANAGER_OWNER_FILE)));
});
