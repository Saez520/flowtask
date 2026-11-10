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

test("flowtask install continues without Python 3.9 and without a stack trace", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-cli-gate-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(xdg, { recursive: true });
    const fakePython = path.join(bin, "python3");
    fs.writeFileSync(fakePython, "#!/bin/sh\nprintf '3.8.0\\n'\n", { mode: 0o755 });
    fs.copyFileSync(fakePython, path.join(bin, "python"));
    // Only the 3.8 fixture is discoverable: the resolver must reject it and the
    // installation must continue instead of aborting on an optional capability.
    const realWhich = spawnSync("which", ["which"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
    fs.writeFileSync(path.join(bin, "which"), `#!/bin/sh
if [ "$1" = "-a" ]; then name="$2"; else name="$1"; fi
case "$name" in
  python3|python) echo "$FAKE_PYTHON"; exit 0;;
  *) exec ${realWhich} "$@";;
esac
`, { mode: 0o755 });

    const result = spawnSync(process.execPath, [FLOWTASK_CLI, "install", "--target", "vscode", "--persona", "senior"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        FAKE_PYTHON: fakePython,
      },
      encoding: "utf8",
      timeout: 180000,
      input: "n\n",
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /FlowTask continues without worktree support/i);
    assert.match(result.stdout, /Install Python 3\.9\+/i);
    assert.match(result.stdout, /python 3\.8\.0/);
    assert.match(result.stdout, /older than the required 3\.9/i);
    assert.doesNotMatch(result.stderr, /^\s+at /m, "the CLI must not print a stack trace");
    assert.equal(fs.existsSync(path.join(xdg, "flowtask", "worktree-manager")), false);
    assert.equal(fs.existsSync(path.join(root, ".vscode", "flowtask", ".installation-method")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
