import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  globalWorktreeManagerDirectory,
  resolveWorktreeManagerLocation,
  missingManagerCause,
} from "../../plugins/flowtask-permission-gate/dist/worktree-manager-location.js";

function mkManager(dir) {
  fs.mkdirSync(path.join(dir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree_manager", "__main__.py"), "x");
  fs.writeFileSync(path.join(dir, "worktree_manager", "mcp_transport.py"), "x");
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * gap_ref: G4 — C5
 * defecto: The repo/session fallback could reappear or the cause could stop
 *   naming the global path.
 * why_not_detected: The previous tests asserted the retired fallbacks and had
 *   to be replaced.
 * comportamiento observable: Only a valid global copy resolves; repo/session
 *   copies are ignored; the missing cause names the global directory and
 *   `flowtask install`.
 */
test("resolves only the global installation and names it when missing", () => {
  const home = mkTmp("home-");
  const globalDir = globalWorktreeManagerDirectory({ env: {}, home });
  const repo = mkTmp("repo-");
  const session = mkTmp("sess-");
  const repoManager = path.join(repo, ".flowtask", "scripts", "worktree-manager");
  const sessionManager = path.join(session, ".flowtask", "scripts", "worktree-manager");
  mkManager(repoManager);
  mkManager(sessionManager);

  // A valid global copy wins even when repo and session copies also exist.
  mkManager(globalDir);
  assert.deepEqual(
    resolveWorktreeManagerLocation({ env: {}, home }),
    { directory: globalDir, source: "global" },
  );

  // Without the global copy, the retired repo/session candidates are ignored.
  fs.rmSync(globalDir, { recursive: true, force: true });
  assert.equal(resolveWorktreeManagerLocation({ env: {}, home }), null);
  assert.equal(resolveWorktreeManagerLocation({ env: {}, home, repoRoot: repo, sessionDir: session }), null);

  // An incomplete global copy is not a usable installation either.
  fs.mkdirSync(path.join(globalDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(globalDir, "worktree_manager", "__main__.py"), "x");
  assert.equal(resolveWorktreeManagerLocation({ env: {}, home }), null);

  const cause = missingManagerCause({ env: {}, home });
  assert.match(cause, /flowtask install/);
  assert.ok(cause.includes(globalDir));
  assert.doesNotMatch(cause, /\.flowtask\/scripts\/worktree-manager/);
});
