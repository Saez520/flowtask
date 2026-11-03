import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

/**
 * Code-only extraction adapter for Graphify.
 *
 * Runs `graphify update <projectDir> --no-cluster` with cwd = projectDir (main root).
 * Rejects paths under `.worktrees/`.
 * Returns a structured, non-throwing result.
 *
 * @param {string} projectDir - Main repository root
 * @param {object} [opts]
 * @param {Function} [opts.runFn] - runner override (testing): (cmd, opts) => { status, stdout, stderr }
 * @param {Function} [opts.existsSyncFn] - fs.existsSync override (testing)
 * @returns {{ ok: boolean, graphPath: string|null, status: string, stdout: string, stderr: string, warning: string|null }}
 */
export function extractCodeOnly(projectDir, opts = {}) {
  const runner = opts.runFn;
  const existsSync = opts.existsSyncFn ?? fs.existsSync;

  // ── Reject worktree paths ──────────────────────────────────────────────
  const normalized = projectDir.replace(/\\/g, "/");
  if (normalized.includes("/.worktrees/") || normalized.includes("\\.worktrees\\")) {
    return {
      ok: false,
      graphPath: null,
      status: "skipped",
      stdout: "",
      stderr: "",
      warning: "Graphify extract: rejected — projectDir is under .worktrees/.",
    };
  }

  const cmd = `graphify update "${projectDir}" --no-cluster`;

  try {
    let result;
    if (runner) {
      result = runner(cmd, { shell: true, cwd: projectDir, stdio: "pipe" });
    } else {
      result = spawnSync(cmd, { shell: true, cwd: projectDir, stdio: "pipe" });
    }

    const stdout = result.stdout ? result.stdout.toString() : "";
    const stderr = result.stderr ? result.stderr.toString() : "";
    const exitCode = result.status;

    // ── Binary not found (ENOENT / null status) ─────────────────────────
    if (exitCode === null || (result.error && result.error.code === "ENOENT")) {
      return {
        ok: false,
        graphPath: null,
        status: "failed",
        stdout,
        stderr,
        warning: "Graphify extract: binary not found. Install Graphify or retry with flowtask update.",
      };
    }

    // ── Non-zero exit code ──────────────────────────────────────────────
    if (exitCode !== 0) {
      return {
        ok: false,
        graphPath: null,
        status: "failed",
        stdout,
        stderr,
        warning: `Graphify extract: failed with exit code ${exitCode}. Retry with flowtask update or contact an administrator.`,
      };
    }

    // ── Check output file exists ────────────────────────────────────────
    const expectedOutput = path.join(projectDir, "graphify-out", "graph.json");
    const fsCheck = existsSync(expectedOutput);

    if (!fsCheck) {
      return {
        ok: false,
        graphPath: null,
        status: "failed",
        stdout,
        stderr,
        warning: "Graphify extract: process completed but graphify-out/graph.json does not exist.",
      };
    }

    return {
      ok: true,
      graphPath: "graphify-out/graph.json",
      status: "success",
      stdout,
      stderr,
      warning: null,
    };
  } catch (err) {
    return {
      ok: false,
      graphPath: null,
      status: "failed",
      stdout: "",
      stderr: err.message,
      warning: `Graphify extract: exception (${err.message}). Retry with flowtask update or contact an administrator.`,
    };
  }
}
