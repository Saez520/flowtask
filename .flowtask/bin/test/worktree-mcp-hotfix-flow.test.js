// gap: G-1 — el flujo hotfix vuelve a presentar `.sh` como vía principal o pierde una operación, un consentimiento o la recuperación del cierre MCP.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("the hotfix flow publishes the MCP worktree lifecycle as the primary path", () => {
  const flow = read(".flowtask/skills/runner-flow-hotfix/SKILL.md");

  for (const operation of [
    "worktree_create",
    "worktree_complete",
    "worktree_recover",
    "worktree_list",
    "worktree_prune",
  ]) {
    assert.ok(flow.includes(operation), `the hotfix flow declares ${operation}`);
  }

  const primaryCreate = flow.indexOf("worktree_create");
  const alternativeCreate = flow.indexOf("worktree.sh create hotfix");
  assert.notEqual(alternativeCreate, -1, "the hotfix flow keeps the declared .sh alternative");
  assert.ok(
    primaryCreate < alternativeCreate,
    "worktree_create precedes the declared .sh alternative",
  );

  const closingStart = flow.indexOf("### Paso 3 — Validator y cierre");
  const closingEnd = flow.indexOf("#### Estrategia de cierre dual");
  assert.notEqual(closingStart, -1, "the hotfix flow publishes the closing step");
  const closing = flow.slice(closingStart, closingEnd === -1 ? undefined : closingEnd);
  for (const field of [
    "plan_hash",
    "transaction_id",
    "authorization",
    "confirm",
    "preserve_dirty",
    "merge_strategy",
  ]) {
    assert.ok(closing.includes(field), `the closing block declares ${field}`);
  }

  const handshake = read(".flowtask/skills/handshake-protocol/SKILL.md");
  assert.ok(handshake.includes("worktree_create"), "the handshake names the MCP creation");
  assert.doesNotMatch(handshake, /worktree\.sh create/, "the handshake does not instruct the .sh creation");
});
