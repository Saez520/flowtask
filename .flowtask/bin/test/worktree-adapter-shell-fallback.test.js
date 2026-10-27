import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADAPTER = path.join(ROOT, ".flowtask", "scripts", "worktree-adapter.sh");
const ENTRYPOINT = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");

function makeTree({ localManager = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ft-adapter-fallback-"));
  const root = path.join(tmp, "root");
  const scripts = path.join(root, ".flowtask", "scripts");
  const managerDir = path.join(scripts, "worktree-manager");
  fs.mkdirSync(scripts, { recursive: true });
  const adapterCopy = path.join(scripts, "worktree-adapter.sh");
  fs.copyFileSync(ADAPTER, adapterCopy);
  fs.chmodSync(adapterCopy, 0o755);
  const entryCopy = path.join(scripts, "worktree.sh");
  fs.copyFileSync(ENTRYPOINT, entryCopy);
  fs.chmodSync(entryCopy, 0o755);
  const locateSrc = path.join(ROOT, ".flowtask", "scripts", "worktree-locate.sh");
  const locateCopy = path.join(scripts, "worktree-locate.sh");
  fs.copyFileSync(locateSrc, locateCopy);
  fs.chmodSync(locateCopy, 0o755);
  const capture = path.join(tmp, "capture.txt");
  if (localManager) {
    fs.mkdirSync(managerDir, { recursive: true });
    const stub = path.join(managerDir, "worktree.sh");
    fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n', { mode: 0o755 });
  }
  return { tmp, adapterCopy, entryCopy, capture };
}

function installGlobalManager(home, capture) {
  const globalDir = path.join(home, ".config", "flowtask", "worktree-manager");
  fs.mkdirSync(globalDir, { recursive: true });
  const stub = path.join(globalDir, "worktree.sh");
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CAPTURE"\n', { mode: 0o755 });
  return globalDir;
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

test("worktree-adapter.sh uses the global manager when the local copy is absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ft-adapter-home-"));
  const { adapterCopy, capture } = makeTree({ localManager: false });
  installGlobalManager(home, capture);
  const result = spawnSync(adapterCopy, ["complete", "gamma", "--base", "main"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", CAPTURE: capture },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(capture, "utf8"), /Cierre generico de gamma/);
});

test("worktree-adapter.sh fails with an actionable message when no manager exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ft-adapter-empty-home-"));
  const { adapterCopy } = makeTree({ localManager: false });
  const result = spawnSync(adapterCopy, ["list"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Worktree Manager is not installed/);
  assert.match(result.stderr, /flowtask install/);
});

test("worktree.sh uses the global manager when the local copy is absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ft-entry-home-"));
  const { entryCopy, capture } = makeTree({ localManager: false });
  installGlobalManager(home, capture);
  const result = spawnSync(entryCopy, ["list"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", CAPTURE: capture },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(capture, "utf8"), /list/);
});

test("worktree.sh fails with an actionable message when no manager exists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ft-entry-empty-home-"));
  const { entryCopy } = makeTree({ localManager: false });
  const result = spawnSync(entryCopy, ["list"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Worktree Manager is not installed/);
  assert.match(result.stderr, /flowtask install/);
});