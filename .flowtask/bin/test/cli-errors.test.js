import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCliAction } from "../lib/cli-errors.js";

const FLOWTASK_CLI = fileURLToPath(new URL("../flowtask.js", import.meta.url));

function capturingStderr() {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += String(chunk);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

test("runCliAction reports the failure on stderr and sets a non-zero exit code", async () => {
  const previousExitCode = process.exitCode;
  const stderr = capturingStderr();
  try {
    await runCliAction(async () => { throw new Error("gate failed"); }, { stderr: stderr.stream });
    assert.equal(stderr.read(), "[FlowTask] gate failed\n");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("runCliAction leaves the exit code untouched when the action succeeds", async () => {
  const previousExitCode = process.exitCode;
  const stderr = capturingStderr();
  process.exitCode = undefined;
  try {
    await runCliAction(async () => {}, { stderr: stderr.stream });
    assert.equal(stderr.read(), "");
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("runCliAction can report a failure without changing the exit code", async () => {
  const previousExitCode = process.exitCode;
  const stderr = capturingStderr();
  process.exitCode = undefined;
  try {
    await runCliAction(async () => { throw new Error("reported only"); }, { stderr: stderr.stream, setExitCode: false });
    assert.equal(stderr.read(), "[FlowTask] reported only\n");
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("flowtask install fails closed without Python 3.9 and without a stack trace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-cli-gate-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(xdg, { recursive: true });
    const fakePython = path.join(bin, "python3");
    fs.writeFileSync(fakePython, '#!/bin/sh\nprintf \'Python 3.8.0\\n\'\n', { mode: 0o755 });

    const result = spawnSync(process.execPath, [FLOWTASK_CLI, "install"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
      },
      encoding: "utf8",
      timeout: 120000,
      input: "",
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /\[FlowTask\]/);
    assert.match(result.stderr, /no usable transport/i);
    assert.match(result.stderr, /python 3\.8\.0 is older than the required 3\.9/i);
    assert.doesNotMatch(result.stderr, /^\s+at /m, "the CLI must not print a stack trace");
    assert.equal(fs.existsSync(path.join(xdg, "flowtask", "worktree-manager")), false);
    assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
    assert.equal(fs.existsSync(path.join(root, ".flowtask")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
