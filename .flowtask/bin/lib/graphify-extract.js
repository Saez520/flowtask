import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

/**
 * Adaptador de extracción code-only para Graphify.
 *
 * Ejecuta `graphify extract --code-only` con cwd = projectDir (raíz principal).
 * Rechaza rutas bajo `.worktrees/`.
 * Devuelve resultado estructurado no lanzable.
 *
 * @param {string} projectDir - Raíz del repositorio principal
 * @param {object} [opts]
 * @param {Function} [opts.runFn] - override runner (testing): (cmd, opts) => { status, stdout, stderr }
 * @param {Function} [opts.existsSyncFn] - override fs.existsSync (testing)
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
      warning: "Graphify extract: rechazado — projectDir está bajo .worktrees/.",
    };
  }

  const cmd = "graphify extract --code-only";

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
        warning: "Graphify extract: binario no encontrado. Instala Graphify o reintenta con flowtask update.",
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
        warning: `Graphify extract: falló con exit code ${exitCode}. Reintenta con flowtask update o contacta a un administrador.`,
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
        warning: "Graphify extract: proceso completado pero graphify-out/graph.json no existe.",
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
      warning: `Graphify extract: excepción (${err.message}). Reintenta con flowtask update o contacta a un administrador.`,
    };
  }
}
