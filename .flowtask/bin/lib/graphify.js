import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import {
  COLORS, logStep, logSuccess, logError, logWarn, logInfo,
  isBinaryInstalled, getVersion,
} from "./logger.js";
import { extractCodeOnly } from "./graphify-extract.js";
import { configureMcpForTargets, resolveGraphifyPython } from "./graphify-query.js";

// ─── Schema v1 ────────────────────────────────────────────────────────────────
// Single source of truth for the Graphify state shape.
// plan-habilitar owns the base fields; plan-grafo, plan-consumo and
// plan-docs-media consume the same schema without creating parallel storage.

/**
 * Create a fresh project-state object with all schema v1 fields initialised
 * to safe defaults (null, [], "pending", etc.).
 */
export function createProjectState() {
  return {
    schema: 1,
    enabled: false,
    selectedClis: [],
    initialized: false,
    graphPath: null,
    hooksInstalled: false,
    ignoredOutput: "graphify-out/",
    lastInitializationResult: null,   // null | "success" | "skipped" | "failed"
    lastWarning: null,
    updatedAt: null,
    // ── plan-grafo fields (owner: plan-grafo, initialised by plan-habilitar) ──
    extract_status: "pending",        // pending | success | failed | skipped
    extract_last_attempt: null,
    query_status: "pending",          // pending | success | failed | degraded | unsupported | skipped
    query_last_attempt: null,
    query_diagnostic: null,
    // ── plan-docs-media fields (owner: plan-docs-media) ───────────────────────
    docs_media_status: "pending",     // pending | success | failed
    docs_media_last_attempt: null,
    docs_media_attempt_status: null,  // accepted | running | success | failed | inconclusive | rejected
    docs_media_output_paths: [],
    docs_media_finished_at: null,
    docs_media_diagnostic: null,
  };
}

/**
 * Create a fresh global-state object (per-machine, not per-project).
 */
export function createGlobalState() {
  return {
    schema: 1,
    available: false,
    version: null,
    lastCheckedAt: null,
    lastInstallResult: null,  // null | "success" | "failed"
    lastWarning: null,
    lastInstallMethod: null,
    lastInstallCommand: null,
    lastInstallExitCode: null,
    lastInstallStderr: null,
  };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * Resolve the global (per-machine) config directory.
 * macOS/Linux: $XDG_CONFIG_HOME/flowtask  or  ~/.config/flowtask
 * Windows:     %APPDATA%/FlowTask
 */
export function resolveGlobalConfigDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "FlowTask");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "flowtask");
  return path.join(os.homedir(), ".config", "flowtask");
}

/** Path to the global state file. */
export function globalStatePath() {
  return path.join(resolveGlobalConfigDir(), "graphify.json");
}

/** Path to the project-level state file. */
export function projectStatePath(projectDir, targetDir = path.join(projectDir, ".flowtask")) {
  return path.join(targetDir, "config", "graphify.json");
}

// ─── Atomic read / write ──────────────────────────────────────────────────────

/**
 * Read and parse a JSON file. Returns `fallback` when the file does not exist
 * or contains invalid JSON.
 */
export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically: write to a temp file in the same directory, then
 * rename over the target.  If the write fails the target is untouched and
 * no orphan temp file is left behind.
 *
 * @returns {boolean} true on success
 */
export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    // Best-effort cleanup of the temp file
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

/**
 * Load global state, creating a fresh one if missing or invalid.
 */
export function loadGlobalState() {
  const existing = readJsonSafe(globalStatePath());
  if (existing && existing.schema === 1) return existing;
  return createGlobalState();
}

/**
 * Persist global state atomically.
 * @returns {boolean}
 */
export function saveGlobalState(state) {
  return writeJsonAtomic(globalStatePath(), state);
}

/**
 * Load project state, creating a fresh one if missing or invalid.
 */
export function loadProjectState(projectDir, targetDir) {
  const existing = readJsonSafe(projectStatePath(projectDir, targetDir));
  if (existing && existing.schema === 1) return existing;
  return createProjectState();
}

/**
 * Persist project state atomically.
 * @returns {boolean}
 */
export function saveProjectState(projectDir, state, targetDir) {
  return writeJsonAtomic(projectStatePath(projectDir, targetDir), state);
}

export function migrateProjectState(projectDir, targetDirs) {
  const legacy = path.join(projectDir, ".flowtask", "config", "graphify.json");
  const destinations = (Array.isArray(targetDirs) ? targetDirs : [targetDirs ?? path.join(projectDir, ".flowtask")])
    .map((targetDir) => projectStatePath(projectDir, targetDir));
  if (!fs.existsSync(legacy) || destinations.every((destination) => path.resolve(destination) === path.resolve(legacy) || fs.existsSync(destination))) return true;
  try {
    const state = readJsonSafe(legacy);
    if (!state || state.schema !== 1) throw new Error("JSON inválido");
    for (const destination of destinations) {
      if (path.resolve(destination) === path.resolve(legacy) || fs.existsSync(destination)) continue;
      if (!writeJsonAtomic(destination, state) || !fs.existsSync(destination)) throw new Error(`no se pudo verificar ${destination}`);
    }
    for (const destination of destinations) {
      if (path.resolve(destination) === path.resolve(legacy)) continue;
      const verified = readJsonSafe(destination);
      if (JSON.stringify(verified) !== JSON.stringify(state)) throw new Error(`la verificación de ${destination} falló`);
    }
    fs.rmSync(legacy);
    logSuccess(`Graphify: estado migrado a ${destinations.join(", ")}`);
    return true;
  } catch (err) {
    logWarn(`Graphify: no se pudo migrar ${legacy} a ${destinations.join(", ")}: ${err.message}. Verifica permisos/espacio y reintenta con flowtask update.`);
    return false;
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Detect whether the `graphify` binary is available and refresh global state.
 * Mutates and persists global state.
 *
 * @param {object} [opts]
 * @param {Function} [opts.detectFn]  - override for isBinaryInstalled (testing)
 * @param {Function} [opts.versionFn] - override for getVersion (testing)
 * @returns {object} updated global state
 */
export function detectGraphify(globalState, opts = {}) {
  const detect = opts.detectFn ?? isBinaryInstalled;
  const ver    = opts.versionFn ?? getVersion;

  globalState.available = detect("graphify");
  globalState.version = globalState.available ? ver("graphify") : null;
  globalState.lastCheckedAt = new Date().toISOString();

  if (!saveGlobalState(globalState)) {
    logWarn("Graphify: no se pudo persistir estado global. Reintenta con flowtask update o contacta a un administrador.");
  }
  return globalState;
}

// ─── Prompts (opt-in) ─────────────────────────────────────────────────────────

/**
 * Ask the developer whether to install Graphify.
 * @param {object} readline - Node readline module
 * @returns {Promise<boolean>}
 */
export async function promptInstallGraphify(readline) {
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `${COLORS.cyan}?${COLORS.reset} Graphify no está instalado. ¿Instalarlo ahora? ${COLORS.dim}(Y/n):${COLORS.reset} `,
      (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); },
    );
  });
  return answer !== "n" && answer !== "no";
}

/**
 * Ask the developer whether to enable Graphify for this project.
 * @param {object} readline - Node readline module
 * @returns {Promise<boolean>}
 */
export async function promptEnableGraphify(readline) {
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `${COLORS.cyan}?${COLORS.reset} ¿Habilitar Graphify para este proyecto? ${COLORS.dim}(Y/n):${COLORS.reset} `,
      (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); },
    );
  });
  return answer !== "n" && answer !== "no";
}

/**
 * Ask the developer whether to install Git hooks via Graphify.
 * @param {object} readline - Node readline module
 * @returns {Promise<boolean>}
 */
export async function promptInstallHooks(readline) {
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      `${COLORS.cyan}?${COLORS.reset} ¿Instalar hooks Git de Graphify? ${COLORS.dim}(Y/n):${COLORS.reset} `,
      (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); },
    );
  });
  return answer !== "n" && answer !== "no";
}

// ─── Installation adapter ─────────────────────────────────────────────────────

/**
 * Default install command resolver.
 * Honours FLOWTASK_GRAPHIFY_INSTALL_COMMAND env var, then detects pipx/uv.
 */
export function defaultInstallCommand(opts = {}) {
  const detect = opts.detectFn ?? isBinaryInstalled;
  const override = process.env.FLOWTASK_GRAPHIFY_INSTALL_COMMAND;
  if (override && override.trim()) {
    return { method: "override", command: override };
  }
  if (detect("pipx")) return { method: "pipx", command: "pipx install 'graphifyy[mcp]'" };
  if (detect("uv")) return { method: "uv", command: "uv tool install 'graphifyy[mcp]'" };
  return { method: "none", command: null };
}

const MAX_INSTALL_STDERR = 2048;
const NO_INSTALLER_DIAGNOSTIC = "No hay instalador disponible: instala pipx o uv y reintenta con flowtask update o contacta a un administrador.";
const MCP_PREFLIGHT_TIMEOUT_MS = 5000;

function truncateStderr(stderr) {
  if (stderr == null) return "";
  return String(stderr).slice(0, MAX_INSTALL_STDERR);
}

/**
 * Run the Graphify installation command.
 *
 * @param {object} [opts]
 * @param {Function} [opts.runFn]    - override runner (testing): (cmd, opts) => { status, stderr }
 * @param {string}   [opts.command]  - override install command
 * @returns {{ success: boolean, warning: string|null, method: string, command: string|null, exitCode: number|null, stderr: string }}
 */
export function installGraphify(opts = {}) {
  const resolution = opts.command != null
    ? { method: "override", command: opts.command }
    : defaultInstallCommand({ detectFn: opts.detectFn });
  const { method, command: cmd } = resolution;
  const runner = opts.runFn;

  if (method === "none") {
    return {
      success: false,
      warning: `Graphify: ${NO_INSTALLER_DIAGNOSTIC}`,
      method,
      command: null,
      exitCode: null,
      stderr: NO_INSTALLER_DIAGNOSTIC,
    };
  }

  try {
    let result;
    if (runner) {
      result = runner(cmd, { shell: true, stdio: ["inherit", "inherit", "pipe"] });
    } else {
      result = spawnSync(cmd, { shell: true, stdio: ["inherit", "inherit", "pipe"] });
    }

    const exitCode = typeof result.status === "number" ? result.status : null;
    const stderr = truncateStderr(result.stderr);
    if (exitCode === 0) {
      return { success: true, warning: null, method, command: cmd, exitCode: 0, stderr };
    }
    return {
      success: false,
      warning: `Graphify: instalación falló (exit ${exitCode}). Reintenta con flowtask update o contacta a un administrador.`,
      method,
      command: cmd,
      exitCode,
      stderr,
    };
  } catch (err) {
    return {
      success: false,
      warning: `Graphify: instalación falló (${err.message}). Reintenta con flowtask update o contacta a un administrador.`,
      method,
      command: cmd,
      exitCode: null,
      stderr: truncateStderr(err.message),
    };
  }
}

/**
 * Verify the MCP package in the interpreter used by Graphify.
 * This is an import preflight, not a claim that a long-running MCP server is
 * currently serving requests.
 *
 * @param {object} [opts]
 * @param {Function} [opts.detectFn] - executable availability override
 * @param {string} [opts.python] - interpreter override for testing
 * @returns {{ ok: boolean, python: string|null, error: string|null }}
 */
export function verifyGraphifyMcp(opts = {}) {
  const python = opts.python ?? resolveGraphifyPython(opts.detectFn);
  if (!python) {
    return {
      ok: false,
      python: null,
      error: "no se encontró un intérprete Python para el entorno Graphify",
    };
  }

  try {
    const result = spawnSync(python, ["-c", "import mcp"], {
      timeout: MCP_PREFLIGHT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) return { ok: true, python, error: null };

    const cause = result.error?.message || truncateStderr(result.stderr) || `exit ${result.status}`;
    return { ok: false, python, error: cause };
  } catch (err) {
    return { ok: false, python, error: err.message };
  }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Check whether projectDir belongs to a Git repository.
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {Function} [opts.runFnPreflight] - override runner (testing): (cmd, opts) => { status }
 * @param {Function} [opts.runFn] - backwards-compatible runner override
 * @returns {boolean} true when Git resolves a repository root
 */
export function hasGitRepo(projectDir, opts = {}) {
  const runner = opts.runFnPreflight ?? opts.runFn;

  try {
    const result = runner
      ? runner("git", {
        args: ["rev-parse", "--show-toplevel"],
        cwd: projectDir,
        shell: false,
        stdio: "pipe",
      })
      : spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: projectDir,
        shell: false,
        stdio: "pipe",
      });
    return result?.status === 0;
  } catch {
    return false;
  }
}

/**
 * Install Git hooks via `graphify hook install` in the project root.
 *
 * @param {string} projectDir
 * @param {object} [opts]
 * @param {Function} [opts.runFn] - override runner (testing): (cmd, opts) => { status }
 * @returns {{ success: boolean, warning: string|null }}
 */
export function installHooks(projectDir, opts = {}) {
  const cmd = "graphify hook install";
  const runner = opts.runFn;

  try {
    let result;
    if (runner) {
      result = runner(cmd, { shell: true, stdio: "inherit", cwd: projectDir });
    } else {
      result = spawnSync(cmd, { shell: true, stdio: "inherit", cwd: projectDir });
    }

    if (result.status === 0) {
      return { success: true, warning: null };
    }
    return {
      success: false,
      warning: `Graphify: hooks fallaron (exit ${result.status}). Reintenta con flowtask update o contacta a un administrador.`,
    };
  } catch (err) {
    return {
      success: false,
      warning: `Graphify: hooks fallaron (${err.message}). Reintenta con flowtask update o contacta a un administrador.`,
    };
  }
}

// ─── .gitignore management ────────────────────────────────────────────────────

const GITIGNORE_ENTRIES = [
  "graphify-out/",
];

/**
 * Ensure `.gitignore` contains the Graphify output and state entries.
 * Idempotent: does not duplicate existing entries.
 *
 * @param {string} projectDir
 * @returns {boolean} true if entries are present after the call
 */
export function ensureGitignoreEntries(projectDir) {
  const gitignorePath = path.join(projectDir, ".gitignore");
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split("\n");
  let modified = false;

  for (const entry of GITIGNORE_ENTRIES) {
    // Check if entry already exists (exact match or with trailing comment)
    const exists = lines.some((l) => l.trim() === entry || l.trim().startsWith(entry + " "));
    if (!exists) {
      lines.push(entry);
      modified = true;
    }
  }

  if (modified) {
    // Add a section comment if not already present
    if (!content.includes("# Graphify")) {
      const insertIdx = lines.length - GITIGNORE_ENTRIES.length;
      lines.splice(insertIdx, 0, "", "# Graphify outputs and local state");
    }
    fs.writeFileSync(gitignorePath, lines.join("\n"), "utf8");
  }

  return true;
}

// ─── Extension registry (handoff to plan-grafo) ──────────────────────────────

/** @type {Map<string, Function>} */
const _extensions = new Map();

/**
 * Register a named extension phase (e.g. "extract", "query").
 * The handler receives `{ projectDir, selectedClis, state, run, logger }`
 * and must return `{ status, warning?, graphPath?, diagnostic? }`.
 *
 * @param {string} phaseName
 * @param {Function} handler
 */
export function registerExtension(phaseName, handler) {
  if (typeof phaseName !== "string" || !phaseName) {
    throw new Error("registerExtension: phaseName must be a non-empty string");
  }
  if (typeof handler !== "function") {
    throw new Error("registerExtension: handler must be a function");
  }
  _extensions.set(phaseName, handler);
}

/**
 * Run a registered extension phase.
 * Returns null if no extension is registered for the phase.
 *
 * @param {string} phaseName
 * @param {object} context - { projectDir, selectedClis, state, run, logger }
 * @returns {Promise<object|null>} extension result or null
 */
export async function runExtension(phaseName, context) {
  const handler = _extensions.get(phaseName);
  if (!handler) return null;

  try {
    const result = await handler(context);
    // Validate: graphPath can only be written if status is "success"
    if (result && result.graphPath && result.status !== "success") {
      logWarn(`Graphify: extensión "${phaseName}" devolvió graphPath sin status=success; se ignora graphPath.`);
      result.graphPath = null;
    }
    return result || null;
  } catch (err) {
    return {
      status: "failed",
      warning: `Graphify: extensión "${phaseName}" falló (${err.message}). Reintenta con flowtask update o contacta a un administrador.`,
      diagnostic: err.message,
    };
  }
}

/**
 * Clear all registered extensions (testing only).
 */
export function clearExtensions() {
  _extensions.clear();
}

// ─── Grafo extensions (plan-grafo) ───────────────────────────────────────────

/**
 * Register the extract and query extension handlers for plan-grafo.
 * Called once per coordinateGraphify invocation.
 *
 * @param {object} [opts] - injection for testing
 * @param {Function} [opts.extractFn] - override extractCodeOnly
 * @param {Function} [opts.configureMcpFn] - override configureMcpForTargets
 * @param {Function} [opts.mcpPreflightFn] - override MCP import preflight
 */
export function registerGrafoExtensions(opts = {}) {
  const extractFn = opts.extractFn ?? extractCodeOnly;
  const configureMcpFn = opts.configureMcpFn ?? configureMcpForTargets;
  const mcpPreflightFn = opts.mcpPreflightFn ?? verifyGraphifyMcp;

  // Only register if no extension is already registered for the phase
  // (allows tests to pre-register custom handlers)
  if (!_extensions.has("extract")) {
    registerExtension("extract", (context) => {
      const { projectDir, run, logger } = context;
      logger.logStep("+", "Graphify extract --code-only…");

      const result = extractFn(projectDir, { runFn: run });

      if (result.ok) {
        logger.logSuccess(`Graphify extract: grafo generado en ${result.graphPath}`);
      } else if (result.warning) {
        logger.logWarn(result.warning);
      }

      return {
        status: result.ok ? "success" : result.status,
        graphPath: result.ok ? result.graphPath : null,
        warning: result.warning,
      };
    });
  }

  if (!_extensions.has("query")) {
    registerExtension("query", (context) => {
      const { projectDir, selectedClis, state, logger, detectFn } = context;

      // Only configure MCP if extract succeeded and graphPath is available
      if (!state.graphPath) {
        logger.logWarn("Graphify query: sin graphPath disponible; se omite configuración MCP.");
        return {
          status: "skipped",
          diagnostic: "graphPath no disponible — extract no ejecutado o fallido.",
          warning: "Graphify query: MCP omitido por falta de graphPath.",
        };
      }

      logger.logStep("+", "Graphify MCP configuration…");
      const mcpResult = configureMcpFn({
        projectDir,
        selectedClis,
        graphPath: state.graphPath,
        detectFn,
      });

      if (mcpResult.status === "success") {
        const preflight = mcpPreflightFn({ detectFn });
        if (!preflight.ok) {
          const warning = `Graphify MCP: configuración aplicada, pero el entorno no pasó la verificación de importación de mcp (${preflight.error}).`;
          logger.logWarn(warning);
          return {
            status: "degraded",
            diagnostic: warning,
            warning,
          };
        }
        logger.logSuccess("Graphify MCP: configuración aplicada; entorno de importación MCP verificado.");
      } else if (mcpResult.warning) {
        logger.logWarn(mcpResult.warning);
       }

      return {
        status: mcpResult.status,
        diagnostic: mcpResult.warning,
        warning: mcpResult.warning,
      };
    });
  }
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

/**
 * Main coordination entry point.  Called once per install/update, after
 * target selection/detection and asset/plugin processing.
 *
 * Never throws — all errors are captured and surfaced as warnings.
 *
 * @param {object} params
 * @param {string} params.projectDir
 * @param {string} [params.targetDir] - project-state target; flowtaskDir remains the CLI source
 * @param {string[]} params.selectedClis - CLI targets chosen/detected
 * @param {object} params.readline       - Node readline module
 * @param {object} [params.opts]         - injection points for testing
 * @param {Function} [params.opts.detectFn]
 * @param {Function} [params.opts.versionFn]
 * @param {Function} [params.opts.runFn]       - runner for install/hooks
 * @param {Function} [params.opts.runFnPreflight] - runner for Git preflight
 * @param {Function} [params.opts.installCmdFn] - override install command
 * @returns {Promise<object>} { projectState, globalState, warnings: string[] }
 */
export async function coordinateGraphify({ projectDir, targetDir = path.join(projectDir, ".flowtask"), flowtaskDir = path.join(projectDir, ".flowtask"), selectedClis, readline, opts = {} }) {
  const warnings = [];

  // ── 1. Load / detect ────────────────────────────────────────────────────
  let globalState = loadGlobalState();
  globalState = detectGraphify(globalState, opts);

  const migrated = migrateProjectState(projectDir, targetDir);
  if (!migrated) {
    const warning = `Graphify: no se pudo migrar el estado a ${projectStatePath(projectDir, targetDir)}. Se conserva el legacy; verifica permisos/espacio y reintenta con flowtask update.`;
    logWarn(warning);
    return { projectState: createProjectState(), globalState, warnings: [warning] };
  }
  let projectState = loadProjectState(projectDir, targetDir);

  // ── 2. Install Graphify if not available ────────────────────────────────
  if (!globalState.available) {
    const wantsInstall = await promptInstallGraphify(readline);
    if (!wantsInstall) {
      projectState.enabled = false;
      projectState.lastInitializationResult = "skipped";
      projectState.selectedClis = selectedClis;
      projectState.updatedAt = new Date().toISOString();
      saveProjectState(projectDir, projectState, targetDir);
      return { projectState, globalState, warnings: ["Graphify: instalación rechazada por el desarrollador."] };
    }

    const installResult = installGraphify({
      runFn: opts.runFn,
      command: opts.installCmdFn ? opts.installCmdFn() : undefined,
      detectFn: opts.detectFn,
    });

    globalState.lastInstallMethod = installResult.method;
    globalState.lastInstallCommand = installResult.command;
    globalState.lastInstallExitCode = installResult.exitCode;
    globalState.lastInstallStderr = installResult.stderr;
    globalState.lastInstallResult = installResult.success ? "success" : "failed";
    globalState.lastWarning = installResult.warning;
    if (!saveGlobalState(globalState)) {
      const persistWarning = "Graphify: no se pudo persistir el diagnóstico de instalación. Reintenta con flowtask update o contacta a un administrador.";
      logWarn(persistWarning);
      warnings.push(persistWarning);
    }

    if (!installResult.success) {
      projectState.enabled = false;
      projectState.lastInitializationResult = "failed";
      projectState.lastWarning = installResult.warning;
      projectState.selectedClis = selectedClis;
      projectState.updatedAt = new Date().toISOString();
      saveProjectState(projectDir, projectState, targetDir);

      warnings.push(installResult.warning);
      return { projectState, globalState, warnings };
    }

    // Re-detect after install
    globalState = detectGraphify(globalState, opts);
  }

  // ── 3. Enable opt-in ────────────────────────────────────────────────────
  if (projectState.enabled === true) {
    logInfo("Graphify ya habilitado para este proyecto; se conserva la habilitación.");
  } else {
    const wantsEnable = await promptEnableGraphify(readline);
    if (!wantsEnable) {
      projectState.enabled = false;
      projectState.lastInitializationResult = "skipped";
      projectState.selectedClis = selectedClis;
      projectState.updatedAt = new Date().toISOString();
      saveProjectState(projectDir, projectState, targetDir);
      return { projectState, globalState, warnings: ["Graphify: habilitación rechazada por el desarrollador."] };
    }

    projectState.enabled = true;
  }

  projectState.selectedClis = selectedClis;

  // ── 4. Warn about later phases ──────────────────────────────────────────
  logInfo("Graphify: la extracción code-only, consulta MCP y docs/media son fases posteriores (plan-grafo / plan-docs-media). Este coordinador no ejecuta --code-only.");

  // ── 5. .gitignore ───────────────────────────────────────────────────────
  ensureGitignoreEntries(projectDir);

  // ── 6. Hooks ────────────────────────────────────────────────────────────
  if (projectState.hooksInstalled === true) {
    projectState.hooksInstalled = true;
  } else {
    if (!hasGitRepo(projectDir, {
      runFnPreflight: opts.runFnPreflight,
      runFn: opts.runFn,
    })) {
      projectState.hooksInstalled = false;
      const warning = "Graphify: proyecto sin repositorio git; hooks omitidos.";
      logWarn(warning);
      warnings.push(warning);
    } else {
      const wantsHooks = await promptInstallHooks(readline);
      if (wantsHooks) {
        const hookResult = installHooks(projectDir, { runFn: opts.runFn });
        if (hookResult.success) {
          projectState.hooksInstalled = true;
        } else {
          projectState.hooksInstalled = false;
          projectState.lastWarning = hookResult.warning;
          warnings.push(hookResult.warning);
        }
      } else {
        projectState.hooksInstalled = false;
      }
    }
  }

  // ── 7. Run registered extensions (plan-grafo extract/query) ─────────────
  if (opts.grafoExtensions !== false) {
    registerGrafoExtensions(opts);
  }

  const extContext = {
    projectDir,
    selectedClis,
    state: projectState,
    run: opts.runFn,
    detectFn: opts.detectFn,
    logger: { logStep, logSuccess, logError, logWarn, logInfo },
  };

  const extractResult = await runExtension("extract", extContext);
  if (extractResult) {
    projectState.extract_status = extractResult.status || "failed";
    projectState.extract_last_attempt = new Date().toISOString();
    if (extractResult.graphPath) projectState.graphPath = extractResult.graphPath;
    if (extractResult.warning) warnings.push(extractResult.warning);
  }

  const queryResult = await runExtension("query", extContext);
  if (queryResult) {
    projectState.query_status = queryResult.status || "failed";
    projectState.query_last_attempt = new Date().toISOString();
    projectState.query_diagnostic = queryResult.diagnostic ?? null;
    if (queryResult.warning) warnings.push(queryResult.warning);
  }

  // ── 8. Finalise ─────────────────────────────────────────────────────────
  projectState.initialized = true;
  projectState.lastInitializationResult = warnings.length > 0 ? "failed" : "success";
  projectState.lastWarning = warnings.length > 0 ? warnings[warnings.length - 1] : null;
  projectState.updatedAt = new Date().toISOString();

  if (!saveProjectState(projectDir, projectState, targetDir)) {
    const w = "Graphify: no se pudo persistir estado de proyecto. Reintenta con flowtask update o contacta a un administrador.";
    warnings.push(w);
    logWarn(w);
  }

  return { projectState, globalState, warnings };
}
