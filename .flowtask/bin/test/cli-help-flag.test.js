import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FLOWTASK_CLI = fileURLToPath(new URL("../flowtask.js", import.meta.url));

// gap: G1 — a trailing --help runs the command instead of printing the help.
test("--help after install, update or uninstall prints the help without running the command", () => {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-cli-help-"));
  try {
    assert.deepEqual(fs.readdirSync(isolatedRoot), []);

    for (const command of ["update", "install", "uninstall"]) {
      const result = spawnSync(process.execPath, [FLOWTASK_CLI, command, "--help"], {
        cwd: isolatedRoot,
        env: { ...process.env, HOME: isolatedRoot, XDG_CONFIG_HOME: isolatedRoot },
        encoding: "utf8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, `flowtask ${command} --help: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /FlowTask CLI/);
      assert.deepEqual(
        fs.readdirSync(isolatedRoot),
        [],
        `flowtask ${command} --help must not install or update anything`,
      );
    }
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
});
