// gap: G-1 — el flujo hotfix vuelve a presentar `.sh` como vía alternativa o pierde una operación, un consentimiento o la recuperación del cierre MCP.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("the hotfix flow publishes the MCP worktree lifecycle as the only path", () => {
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

  assert.doesNotMatch(flow, /worktree\.sh/, "the hotfix flow does not offer the retired shell entrypoint");
  assert.doesNotMatch(flow, /FLOWTASK_SCRIPTS/, "the hotfix flow does not depend on the retired scripts constant");

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

  const caFlow = read(".flowtask/skills/runner-flow-ejecucion-ca/SKILL.md");
  assert.doesNotMatch(caFlow, /worktree\.sh/, "the CA flow does not offer the retired shell entrypoint");
  assert.doesNotMatch(caFlow, /FLOWTASK_SCRIPTS/, "the CA flow does not depend on the retired scripts constant");
});
