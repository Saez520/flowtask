import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADAPTER = path.join(ROOT, ".flowtask", "scripts", "worktree-adapter.sh");

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ft-adapter-fallback-"));
  const root = path.join(tmp, "root");
  const scripts = path.join(root, ".flowtask", "scripts");
  const managerDir = path.join(scripts, "worktree-manager");
  fs.mkdirSync(managerDir, { recursive: true });
  const adapterCopy = path.join(scripts, "worktree-adapter.sh");
  fs.copyFileSync(ADAPTER, adapterCopy);
  fs.chmodSync(adapterCopy, 0o755);
  const capture = path.join(tmp, "capture.txt");
  const stub = path.join(managerDir, "worktree.sh");
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n', { mode: 0o755 });
  return { tmp, adapterCopy, capture };
}

test("worktree-adapter.sh injects the spanish fallback when complete has no title", () => {
  const { adapterCopy, capture } = makeTree();
  const result = spawnSync(adapterCopy, ["complete", "alpha", "--base", "main"], {
    env: { ...process.env, CAPTURE: capture },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const captured = fs.readFileSync(capture, "utf8");
  assert.match(captured, /Cierre generico de alpha/);
  assert.match(captured, /No habia una descripcion de la entrega disponible al momento del cierre\./);
});

test("worktree-adapter.sh does not inject the fallback when --title is present", () => {
  const { adapterCopy, capture } = makeTree();
  const result = spawnSync(adapterCopy, ["complete", "beta", "--base", "main", "--title", "Mi titulo"], {
    env: { ...process.env, CAPTURE: capture },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const captured = fs.readFileSync(capture, "utf8");
  assert.match(captured, /Mi titulo/);
  assert.doesNotMatch(captured, /Cierre generico de beta/);
  assert.doesNotMatch(captured, /No habia una descripcion de la entrega disponible al momento del cierre\./);
});