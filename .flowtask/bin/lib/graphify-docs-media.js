import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { isBinaryInstalled } from "./logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Exact command defined by plan-docs-media — never deviate. */
export const DOCS_MEDIA_COMMAND = "graphify extract --docs --media --output-dir graphify-out";

/** Maximum time allowed for the Graphify docs/media process. */
export const GRAPHIFY_TIMEOUT_MS = 120_000;

/** Grace period between SIGTERM and the process-group SIGKILL escalation. */
export const GRAPHIFY_TERMINATION_GRACE_MS = 250;

/** Required output artifacts (relative to graphify-out/). */
export const REQUIRED_ARTIFACTS = ["graph.json", "GRAPH_REPORT.md", "graph.html"];

// ─── Offer logic ──────────────────────────────────────────────────────────────

/**
 * Determine whether the runner should offer docs/media generation.
 * Only `docs_media_status === "success"` suppresses the offer.
 *
 * @param {object} projectState - schema v1 project state
 * @returns {boolean}
 */
export function shouldOfferDocsMedia(projectState) {
  if (!projectState) return false;
  return projectState.docs_media_status !== "success";
}

// ─── Patch builders (schema v1 fields only) ───────────────────────────────────

/**
 * Build a state patch to persist BEFORE launching the background task.
 * Sets `docs_media_last_attempt` and `docs_media_attempt_status=running`.
 *
 * @returns {object} partial project state patch
 */
export function buildRunningPatch() {
  return {
    docs_media_last_attempt: new Date().toISOString(),
    docs_media_attempt_status: "running",
  };
}

/**
 * Build a state patch for user rejection.
 * Preserves existing `docs_media_status` (does NOT set it to success).
 *
 * @returns {object} partial project state patch
 */
export function buildRejectionPatch() {
  return {
    docs_media_attempt_status: "rejected",
    docs_media_finished_at: new Date().toISOString(),
  };
}

/**
 * Build a state patch from a generation result.
 * Only `attemptStatus === "success"` sets `docs_media_status = "success"`.
 * All other outcomes set `docs_media_status = "failed"` to preserve the offer.
 *
 * @param {object} result - from generateDocsMedia()
 * @returns {object} partial project state patch
 */
export function buildResultPatch(result) {
  const isSuccess = result.attemptStatus === "success";
  return {
    docs_media_attempt_status: result.attemptStatus,
    docs_media_status: isSuccess ? "success" : "failed",
    docs_media_output_paths: isSuccess ? result.outputPaths : [],
    docs_media_finished_at: result.finishedAt || new Date().toISOString(),
    docs_media_diagnostic: result.diagnostic || null,
  };
}

// ─── Generation ───────────────────────────────────────────────────────────────

/**
 * Execute the docs/media generation command and verify outputs.
 *
 * - Rejects worktree paths.
 * - Checks graphify binary availability.
 * - Runs exact command with cwd = projectDir.
 * - Verifies all three required artifacts exist, are readable and non-empty.
 *
 * @param {string} projectDir - main repository root (NOT a worktree)
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn]   - override spawn (testing): (file, args, opts) => ChildProcess
 * @param {Function} [opts.detectFn]  - override isBinaryInstalled (testing)
 * @returns {Promise<{ attemptStatus: string, outputPaths: string[], finishedAt: string, diagnostic: string|null, terminationConfirmed?: boolean }>}
 */
export async function generateDocsMedia(projectDir, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const detect = opts.detectFn ?? isBinaryInstalled;
  const finishedAt = () => new Date().toISOString();

  // ── Reject worktree paths ──────────────────────────────────────────────
  const normalized = projectDir.replace(/\\/g, "/");
  if (normalized.includes("/.worktrees/") || normalized.includes("\\.worktrees\\")) {
    return Promise.resolve({
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: "projectDir está bajo .worktrees/ — docs/media requiere el repositorio principal.",
    });
  }

  // ── Check binary availability ──────────────────────────────────────────
  if (!detect("graphify")) {
    return Promise.resolve({
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: "Graphify no está instalado. Instala Graphify antes de reintentar docs/media.",
    });
  }

  // ── Execute command ────────────────────────────────────────────────────
  let execution;
  try {
    execution = await runGraphifyProcess(projectDir, {
      spawnFn,
      timeoutMs: opts.timeoutMs ?? GRAPHIFY_TIMEOUT_MS,
      graceMs: opts.graceMs ?? GRAPHIFY_TERMINATION_GRACE_MS,
      platform: opts.platform ?? process.platform,
      killFn: opts.killFn,
    });
  } catch (err) {
    return {
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: `Excepción durante generación: ${err.message}`,
      terminationConfirmed: false,
    };
  }

  if (execution.timedOut) {
    return {
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: execution.terminationConfirmed
        ? `Graphify excedió el timeout de ${execution.timeoutMs} ms y su terminación fue confirmada. Reintenta docs/media en otra conversación.`
        : `Graphify excedió el timeout de ${execution.timeoutMs} ms, pero su terminación no pudo confirmarse. Reintenta docs/media en otra conversación.`,
      terminationConfirmed: execution.terminationConfirmed,
    };
  }

  const exitCode = execution.exitCode;

  // Binary not found (ENOENT / null status)
  if (execution.error?.code === "ENOENT") {
    return {
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: "Graphify binario no encontrado durante ejecución. Instala Graphify antes de reintentar.",
      terminationConfirmed: true,
    };
  }

  if (execution.error) {
    return {
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: `Excepción durante generación: ${execution.error.message}`,
      terminationConfirmed: true,
    };
  }

  // Non-zero exit code
  if (exitCode !== 0) {
    return {
      attemptStatus: "failed",
      outputPaths: [],
      finishedAt: finishedAt(),
      diagnostic: `graphify extract falló con exit code ${exitCode}.`,
      terminationConfirmed: true,
    };
  }

    // ── Verify required artifacts ──────────────────────────────────────
    const outputDir = path.join(projectDir, "graphify-out");
    const verifiedPaths = [];

    for (const artifact of REQUIRED_ARTIFACTS) {
      const fullPath = path.join(outputDir, artifact);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size === 0) {
           return {
            attemptStatus: "inconclusive",
            outputPaths: [],
            finishedAt: finishedAt(),
            diagnostic: `Output incompleto: ${artifact} está vacío o no es un archivo.`,
          };
        }
        fs.accessSync(fullPath, fs.constants.R_OK);
        verifiedPaths.push(`graphify-out/${artifact}`);
      } catch {
        return {
          attemptStatus: "inconclusive",
          outputPaths: [],
          finishedAt: finishedAt(),
          diagnostic: `Output incompleto: ${artifact} no existe o no es legible.`,
        };
      }
    }

    // All artifacts verified
    return {
      attemptStatus: "success",
      outputPaths: verifiedPaths,
      finishedAt: finishedAt(),
      diagnostic: null,
      terminationConfirmed: true,
    };
}

/**
 * Run Graphify without a shell and enforce a real process-group timeout.
 * The result is resolved only after the child emits `close`.
 */
export function runGraphifyProcess(projectDir, opts = {}) {
  const {
    spawnFn = spawn,
    timeoutMs = GRAPHIFY_TIMEOUT_MS,
    graceMs = GRAPHIFY_TERMINATION_GRACE_MS,
    platform = process.platform,
    killFn = process.kill,
  } = opts;
  const args = ["extract", "--docs", "--media", "--output-dir", "graphify-out"];
  const isWindows = platform === "win32";

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn("graphify", args, {
        cwd: projectDir,
        shell: false,
        detached: !isWindows,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let terminationConfirmed = false;
    let timeoutHandle;
    let killHandle;
    let spawnError;
    let settled = false;

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (err) => { spawnError = err; });
    child.once("close", (code, signal) => {
      terminationConfirmed = timedOut;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killHandle);
      resolve({
        exitCode: code,
        signal,
        error: spawnError,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        terminationConfirmed,
      });
    });

    const terminate = () => {
      if (settled) return;
      timedOut = true;
      if (isWindows) {
        // taskkill is invoked directly: no shell and /T includes descendants.
        try {
          spawnFn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            stdio: "ignore",
          });
        } catch { /* close remains the source of truth for confirmation */ }
      } else {
        try { killFn(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* best effort */ } }
        killHandle = setTimeout(() => {
          if (settled) return;
          try { killFn(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* best effort */ } }
        }, graceMs);
      }
    };

    timeoutHandle = setTimeout(terminate, timeoutMs);
  });
}
