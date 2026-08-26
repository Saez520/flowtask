import type { PluginInput } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RUNNER_DELEGATION_MESSAGE, isAuthorizedRunnerCommand } from "./authorizer.js";
import {
  buildFallback,
  isImageOrPdfOutput,
  loadContextBudgetConfig,
  shouldPreventiveBlockGlob,
  shouldPreventiveBlockGrep,
  shouldPreventiveBlockRead,
} from "./context-budget.js";

/**
 * Rutas candidatas de configuración, probadas en orden dentro de cada directorio.
 * Precedencia: workdir del commit primero; sessionDir solo como fallback para
 * los demás settings. El `stampPath` SIEMPRE se resuelve contra el workdir.
 */
const CONFIG_CANDIDATES = [
  ".opencode/flowtask/config/review.json",
  ".flowtask/config/review.json",
] as const;

/** TTL por defecto del review-stamp; overridable con `stampTtlMinutes` en review.json. */
const DEFAULT_STAMP_TTL_MINUTES = 30;

type ReviewConfig = {
  enabled: boolean;
  stampPath: string;
  stampTtlMinutes: number;
  sourcePath: string;
};

type StampPayload = { ts: number; branch: string };

type ParsedStamp = { ok: true; payload: StampPayload } | { ok: false; reason: string };

const RUNNER_TASKS = new Set([
  "flowtask-ca-writer", "flowtask-planner", "flowtask-plan-auditor", "flowtask-constructor",
  "flowtask-validator", "flowtask-initializer", "flowtask-logger", "flowtask-tester",
  "flowtask-review-orchestrator", "flowtask-inspector", "flowtask-onboarder",
  "flowtask-graphify-docs-media",
]);

const SESSION_AGENTS = new Map<string, string>();

/**
 * Acumulado por turno del runner (GAP-002): turno = ciclo entre `chat.message`
 * consecutivos del mismo sessionID. `TURN_STATE` guarda la suma de chars
 * entregados (no omitidos) y el número de turno; `TURN_SEQ` numera los turnos.
 */
const TURN_STATE = new Map<string, { sum: number; turn: number }>();
const TURN_SEQ = new Map<string, number>();

function isRunner(agent: unknown): boolean {
  return typeof agent === "string" && agent.toLowerCase().replace(/_/g, "-") === "flowtask-runner";
}

function runnerToolAllowed(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "bash") return isAuthorizedRunnerCommand(String(args.command ?? ""));
  if (tool === "read" || tool === "glob" || tool === "grep" || tool === "skill" || tool.startsWith("engram_")) return true;
  if (tool === "task") return RUNNER_TASKS.has(String(args.subagent_type ?? args.agent ?? args.name ?? ""));
  return false;
}

function runnerBlocked(): never { throw new Error(RUNNER_DELEGATION_MESSAGE); }

function gateError(operation: string, cause: unknown, action: string): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `[FlowTask Permission Gate] Commit bloqueado.\n` +
      `Operación fallida: ${operation}.\n` +
      `Causa: ${detail}.\n` +
      `Acción recomendada: ${action}`,
  );
}

function parseReviewConfig(raw: string, path: string): ReviewConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn(`[FlowTask Permission Gate] JSON inválido en ${path}; se continúa sin bloquear.`);
    return null;
  }

  if (
    !value || typeof value !== "object" ||
    typeof (value as Record<string, unknown>).enabled !== "boolean" ||
    typeof (value as Record<string, unknown>).stampPath !== "string" ||
    !(value as Record<string, unknown>).stampPath
  ) {
    console.warn(`[FlowTask Permission Gate] Configuración inválida en ${path}; se continúa sin bloquear.`);
    return null;
  }

  const config = value as Record<string, unknown>;
  let stampTtlMinutes = DEFAULT_STAMP_TTL_MINUTES;
  if (config.stampTtlMinutes !== undefined) {
    if (typeof config.stampTtlMinutes === "number" && Number.isFinite(config.stampTtlMinutes) && config.stampTtlMinutes > 0) {
      stampTtlMinutes = config.stampTtlMinutes;
    } else {
      console.warn(
        `[FlowTask Permission Gate] stampTtlMinutes inválido en ${path}; se usa el default (${DEFAULT_STAMP_TTL_MINUTES} min).`,
      );
    }
  }
  return {
    enabled: config.enabled as boolean,
    stampPath: config.stampPath as string,
    stampTtlMinutes,
    sourcePath: path,
  };
}

/**
 * Busca review.json en `directory` probando las rutas canónicas en orden.
 * Devuelve `undefined` si ninguna candidata existe (permite seguir al siguiente
 * directorio) y `null` si existe pero es ilegible o inválida (fail-open observable).
 */
function findConfigIn(directory: string): ReviewConfig | null | undefined {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(directory, candidate);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(`[FlowTask Permission Gate] No se pudo leer ${path}; se continúa sin bloquear.`);
      return null;
    }
    return parseReviewConfig(raw, path);
  }
  return undefined;
}

/**
 * Precedencia documentada: workdir-first (las dos rutas conocidas); el fallback
 * a sessionDir/main aporta únicamente los demás settings (enabled, TTL). El
 * `stampPath` resultante SIEMPRE se resuelve contra el workdir del commit.
 */
function readConfig(workdir: string, fallbackCwd?: string): ReviewConfig | null {
  const directories = [workdir, fallbackCwd].filter(
    (directory, index, values): directory is string => Boolean(directory) && values.indexOf(directory) === index,
  );
  for (const directory of directories) {
    const found = findConfigIn(directory);
    if (found !== undefined) return found;
  }
  console.warn(
    `[FlowTask Permission Gate] No se encontró review.json en ${directories.join(" ni ")}; se continúa sin bloquear.`,
  );
  return null;
}

function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    throw gateError(
      "determinar la rama actual",
      error,
      "verificá que el workdir sea un repositorio git válido y reintentá",
    );
  }
}

/**
 * Formato estructurado: {"ts":"<ISO-8601>","branch":"<rama>"}. Stamps en ISO
 * plano (formato obsoleto) se rechazan con causa explícita. Fail-closed.
 */
function parseStamp(raw: string): ParsedStamp {
  const trimmed = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    if (!Number.isNaN(Date.parse(trimmed))) {
      return {
        ok: false,
        reason:
          'formato obsoleto (ISO-8601 plano): generá un stamp nuevo con el formato {"ts":"<ISO-8601>","branch":"<rama>"}',
      };
    }
    return { ok: false, reason: "formato inválido: el contenido no es JSON parseable" };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "formato inválido: el stamp debe ser un objeto JSON {ts, branch}" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== "string" || !record.ts || Number.isNaN(Date.parse(record.ts))) {
    return { ok: false, reason: "formato inválido: falta o es inválido el campo \"ts\" (ISO-8601)" };
  }
  if (typeof record.branch !== "string" || !record.branch) {
    return { ok: false, reason: "formato inválido: falta o es inválido el campo \"branch\"" };
  }
  return { ok: true, payload: { ts: Date.parse(record.ts), branch: record.branch } };
}

/** Valida TTL y branch binding. Devuelve la causa de rechazo o null si es válido. */
function stampIssue(
  payload: StampPayload,
  now: number,
  currentBranch: string,
  ttlMinutes: number,
): string | null {
  const ageMinutes = Math.floor((now - payload.ts) / 60000);
  if (now - payload.ts > ttlMinutes * 60000) {
    return `expirado hace ${ageMinutes} min (TTL vigente: ${ttlMinutes} min)`;
  }
  if (payload.branch !== currentBranch) {
    return `branch mismatch (esperada '${payload.branch}', encontrada '${currentBranch || "detached/sin rama"}')`;
  }
  return null;
}

/**
 * Diff honesto: `git status --porcelain` cuenta archivos pendientes reales
 * (staged + unstaged); `git diff HEAD --stat` aporta las líneas +/-.
 */
function getDiffStats(cwd: string): { lines: number; files: number } {
  let pendingFiles = 0;
  let lines = 0;
  let lastError: unknown;
  try {
    const statusOutput = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    pendingFiles = statusOutput ? statusOutput.split("\n").length : 0;
  } catch (error) {
    lastError = error;
  }
  try {
    const diffOutput = execFileSync("git", ["diff", "HEAD", "--stat"], { cwd, encoding: "utf8" }).trim();
    if (diffOutput) {
      const summary = diffOutput.split("\n").pop() ?? "";
      const insertions = summary.match(/(\d+)\s+insertions?\(\+\)/);
      const deletions = summary.match(/(\d+)\s+deletions?\(-\)/);
      const files = summary.match(/(\d+)\s+files? changed/);
      if (!insertions && !deletions && !files) {
        throw new Error(`salida de git diff no reconocida: ${summary}`);
      }
      lines = (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
    }
  } catch (error) {
    lastError = lastError ?? error;
  }
  if (lastError) {
    throw gateError("analizar diff", lastError, "verificá el repositorio y reintentá");
  }
  return { lines, files: pendingFiles };
}

function buildGateMessage(stats: { lines: number; files: number }): string {
  return [
    "[FlowTask Permission Gate] Commit bloqueado.",
    "",
    `📊 Diff: ${stats.files} archivo(s), ${stats.lines} línea(s).`,
    "",
    "→ Runner: evaluá si este cambio requiere revisión pre-commit.",
    "  - Si es trivial (gitignore, docs, chore ≤ 5 líneas): re-ejecutá el commit con --no-verify.",
    "  - Si no: invocá flowtask-review-orchestrator y generá el stamp antes de reintentar.",
  ].join("\n");
}

function buildStampBlockMessage(
  cause: string,
  stampPath: string,
  configPath: string,
  stats: { lines: number; files: number },
): string {
  return [
    "[FlowTask Permission Gate] Commit bloqueado por review-stamp inválido.",
    "",
    `Causa: ${cause}.`,
    `Stamp buscado en: ${stampPath}`,
    `Config aplicada: ${configPath}`,
    "",
    `📊 Diff: ${stats.files} archivo(s), ${stats.lines} línea(s) pendientes.`,
    "",
    "→ Invocá flowtask-review-orchestrator y generá un stamp nuevo en la ruta indicada:",
    '  {"ts":"<ISO-8601>","branch":"<rama actual del repo objetivo>"}',
  ].join("\n");
}

/**
 * `stat.size` del archivo de read si existe y es un string. Devuelve undefined
 * si falla (GAP híbrido: pre-gate es ahorro barato, el post-gate decide).
 */
function readStatSizeSafe(args: Record<string, unknown>): number | undefined {
  const file = args?.file;
  if (typeof file !== "string" || !file) return undefined;
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

export default async function (input: PluginInput) {
  const sessionDir = input.directory;
  return {
    "chat.message": async (hookInput: { sessionID: string; agent?: string }) => {
      if (hookInput.agent !== undefined) {
        SESSION_AGENTS.set(hookInput.sessionID, hookInput.agent);
      }
      // Cada mensaje nuevo abre un turno: se numera y se resetea el acumulado.
      const turn = (TURN_SEQ.get(hookInput.sessionID) ?? 0) + 1;
      TURN_SEQ.set(hookInput.sessionID, turn);
      TURN_STATE.set(hookInput.sessionID, { sum: 0, turn });
    },
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string },
      hookOutput: { args: any },
    ) => {
      const command = String(hookOutput?.args?.command ?? "");
      // OpenCode 1.18.4 does not expose agent on tool.execute.before.
      // chat.message is the authoritative runtime source for the session.
      const agent = SESSION_AGENTS.get(hookInput.sessionID);
      if (isRunner(agent) && !runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {})) runnerBlocked();

      // --- context budget: pre-gate barato (runner, lista cerrada, sin recorrer árbol) ---
      if (isRunner(agent) && (hookInput.tool === "read" || hookInput.tool === "glob" || hookInput.tool === "grep")) {
        const budgetWorkdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
        const budget = loadContextBudgetConfig(budgetWorkdir, sessionDir);
        if (hookInput.tool === "read") {
          const statSize = readStatSizeSafe(hookOutput?.args ?? {});
          if (shouldPreventiveBlockRead(hookOutput?.args ?? {}, statSize)) {
            const actual = statSize ?? budget.preventiveReadStatLimit + 1;
            throw new Error(buildFallback("read", actual, budget.readThreshold));
          }
        } else if (hookInput.tool === "glob") {
          if (shouldPreventiveBlockGlob(hookOutput?.args ?? {})) {
            // Pre-gate sin tamaño real: N=threshold+1 expresa exceso potencial.
            throw new Error(buildFallback("glob", budget.globThreshold + 1, budget.globThreshold));
          }
        } else if (hookInput.tool === "grep") {
          if (shouldPreventiveBlockGrep(hookOutput?.args ?? {})) {
            throw new Error(buildFallback("grep", budget.grepThreshold + 1, budget.grepThreshold));
          }
        }
      }

      if (hookInput.tool !== "bash" || !/\bgit\s+commit\b/.test(command)) return;
      if (command.includes("--no-verify") || command.includes("--no-review")) return;

      const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
      const config = readConfig(workdir, sessionDir);
      if (!config) return;
      if (!config.enabled) return;
      // Resolución unificada: el stampPath relativo SIEMPRE se resuelve contra
      // el workdir del commit (aislamiento por flujo: worktrees leen/escriben
      // sus propios stamps).
      const stampAbsolutePath = isAbsolute(config.stampPath)
        ? config.stampPath
        : resolve(workdir, config.stampPath);

      let raw: string;
      try {
        raw = readFileSync(stampAbsolutePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            buildStampBlockMessage(
              "stamp inexistente",
              stampAbsolutePath,
              config.sourcePath,
              getDiffStats(workdir),
            ),
          );
        }
        throw gateError("leer stamp", error, "verificá permisos y reintentá");
      }

      const parsed = parseStamp(raw);
      if (!parsed.ok) {
        throw new Error(
          buildStampBlockMessage(parsed.reason, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)),
        );
      }
      const issue = stampIssue(parsed.payload, Date.now(), getCurrentBranch(workdir), config.stampTtlMinutes);
      if (issue) {
        throw new Error(
          buildStampBlockMessage(issue, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)),
        );
      }
      // Stamp válido: NO se consume. La validez la gobierna el TTL y el branch
      // binding; un commit fallido posterior no obliga a regenerar el stamp.
      return;
    },
    "tool.execute.after": async (
      hookInput: { tool: string; sessionID: string; callID: string },
      hookOutput: { title?: string; output?: unknown; metadata?: Record<string, unknown> },
    ) => {
      const agent = SESSION_AGENTS.get(hookInput.sessionID);
      if (!isRunner(agent)) return;
      if (hookInput.tool !== "read" && hookInput.tool !== "glob" && hookInput.tool !== "grep") return;
      if (hookOutput == null || typeof hookOutput.output !== "string") {
        // GAP-003: si no se puede medir, nunca entregar silencioso sin control:
        // se observa con traza. Un smoke de integración revalida la mutación.
        console.warn(
          `[FlowTask Context Budget] no se pudo medir output de ${hookInput.tool} (session ${hookInput.sessionID}); se entrega sin presupuestar.`,
        );
        return;
      }

      const budget = loadContextBudgetConfig(sessionDir || process.cwd(), sessionDir);
      const threshold =
        hookInput.tool === "read" ? budget.readThreshold : hookInput.tool === "grep" ? budget.grepThreshold : budget.globThreshold;
      const actual = hookOutput.output.length;

      // Attachments imagen/PDF: el texto corto miente sobre el costo real; el
      // runner no recibe attachments (v1) y se delega al Inspector.
      if (isImageOrPdfOutput(hookOutput)) {
        hookOutput.output =
          buildFallback(hookInput.tool as "read" | "glob" | "grep", actual, threshold) +
          " (imagen/PDF — delegá al Inspector)";
        if (hookOutput.metadata) hookOutput.metadata.attachment = undefined;
        return;
      }

      // Umbral individual: se omite (no se suma al acumulado) y se marca.
      if (actual > threshold) {
        hookOutput.output = buildFallback(hookInput.tool as "read" | "glob" | "grep", actual, threshold);
        hookOutput.metadata = { ...(hookOutput.metadata ?? {}), truncated: true };
        return;
      }

      // Umbral acumulado por turno: aunque esté bajo el individual, la suma
      // entregada del turno no puede superar el presupuesto del turno.
      const state = TURN_STATE.get(hookInput.sessionID) ?? { sum: 0, turn: TURN_SEQ.get(hookInput.sessionID) ?? 0 };
      if (state.sum + actual > budget.turnAccumulated) {
        hookOutput.output = buildFallback(hookInput.tool as "read" | "glob" | "grep", actual, budget.turnAccumulated);
        hookOutput.metadata = { ...(hookOutput.metadata ?? {}), truncated: true };
        return;
      }

      state.sum += actual;
      TURN_STATE.set(hookInput.sessionID, state);
    },
    dispose: async () => {
      SESSION_AGENTS.clear();
      TURN_STATE.clear();
      TURN_SEQ.clear();
    },
  };
}
