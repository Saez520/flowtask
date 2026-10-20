import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  RUNNER_DELEGATION_MESSAGE,
  isAuthorizedRunnerCommand,
  isAuthorizedRunnerSubagent,
  isAuthorizedWorktreeConsumer,
  WORKTREE_CONSUMER_TOOL,
} from "./authorizer.js";
import { createWorktreeConsumerBridge } from "./worktree-consumer-bridge.js";
import { createConfiguredEngramInvoker } from "./engram-mcp.js";
import { createWorktreeMcpClient } from "./worktree-mcp.js";
import {
  buildAttachmentDelivery,
  buildDegradationMetadata,
  buildNarrowingNotice,
  buildReducedDelivery,
  isImageOrPdfOutput,
  loadContextBudgetConfig,
  registerNarrowingNotice,
  resetNarrowingNotices,
  shouldPreventiveBlockGlob,
  shouldPreventiveBlockGrep,
  shouldPreventiveBlockRead,
} from "./context-budget.js";

/** The nine keys published by the worktree manager for every accepted and rejected request. */
const PROTOCOL_KEYS = [
  "contract_version", "tool_version", "operation", "repository",
  "result", "data", "warnings", "error", "transaction_id",
] as const;

/** A document is a protocol envelope only when it publishes every key of the contract. */
function isProtocolEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value as Record<string, unknown>);
  return PROTOCOL_KEYS.every((key) => keys.includes(key));
}

export type WorktreeCliOutcome = { envelope?: unknown; sent?: boolean; cause?: string };

export type WorktreeCliClient = {
  detect(): Promise<{ available: boolean; cause?: string }>;
  invoke(request: Record<string, unknown>): Promise<WorktreeCliOutcome>;
};

/**
 * Client of the worktree manager command line.
 *
 * The request travels as one canonical document over `--request-json`; the
 * legacy argument form is never used, and the manager always answers with the
 * same envelope, accepted or rejected.
 */
export function createWorktreeCliClient(options: { managerDirectory: string; python?: string; timeoutMs?: number }): WorktreeCliClient {
  const python = options.python ?? "python3";
  const managerDirectory = options.managerDirectory;
  const env = { ...process.env, PYTHONPATH: [managerDirectory, process.env.PYTHONPATH].filter(Boolean).join(":") };

  function run(request: Record<string, unknown>): WorktreeCliOutcome {
    const result = spawnSync(python, ["-m", "worktree_manager", "--request-json", "-"], {
      cwd: managerDirectory,
      input: JSON.stringify(request),
      encoding: "utf8",
      env,
      timeout: options.timeoutMs ?? 60000,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      // A timeout means the request was delivered but the answer was lost.
      return { sent: code === "ETIMEDOUT", cause: result.error.message };
    }
    let parsed: unknown = null;
    const stdout = (result.stdout ?? "").trim();
    if (stdout) {
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
    }
    if (!isProtocolEnvelope(parsed)) {
      const stderr = (result.stderr ?? "").trim().split("\n").slice(-2).join(" ").trim();
      return { sent: false, cause: stderr || "the worktree manager does not publish the request protocol" };
    }
    return { envelope: parsed, sent: true };
  }

  return {
    async detect() {
      // The probe is rejected by the protocol itself and never touches the
      // repository, so the detection stays read-only.
      const outcome = run({ operation: "worktree_list" });
      if (outcome.sent && outcome.envelope) return { available: true };
      return { available: false, cause: outcome.cause };
    },
    async invoke(request) {
      return run(request);
    },
  };
}


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

/** Criterio de trivialidad para el bypass --no-verify: cambios con ≤ TRIVIAL_CHANGE_LINES líneas. */
const TRIVIAL_CHANGE_LINES = 5;

type ReviewConfig = {
  enabled: boolean;
  stampPath: string;
  stampTtlMinutes: number;
  sourcePath: string;
};

type StampPayload = { ts: number; branch: string };

type ParsedStamp = { ok: true; payload: StampPayload } | { ok: false; reason: string };

const SESSION_AGENTS = new Map<string, string>();

/**
 * Acumulado por turno del runner (GAP-002): turno = ciclo entre `chat.message`
 * consecutivos del mismo sessionID. `TURN_STATE` guarda la suma de chars
 * entregados (no omitidos) y el número de turno; `TURN_SEQ` numera los turnos.
 */
const TURN_STATE = new Map<string, { sum: number; turn: number }>();
const TURN_SEQ = new Map<string, number>();

/**
 * Normaliza una identidad de agente a forma canónica comparable:
 * trim + lowercase, y `_` o whitespace colapsados a `-`. Cubre variantes
 * case-insensitive como "FlowTask-Runner", "FLOWTASK_RUNNER", " flowtask-runner ".
 */
function normalizeAgent(agent: unknown): string {
  return String(agent).trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
}

/**
 * ¿Este agente es el runner de FlowTask? El gate valida la PERSONALIDAD
 * (flowtask-runner), no el modelo: solo califica un match case-insensitive
 * exacto de la identidad normalizada.
 */
function isRunner(agent: unknown): boolean {
  return typeof agent === "string" && normalizeAgent(agent) === "flowtask-runner";
}

function runnerToolAllowed(tool: string, args: Record<string, unknown>): boolean {
   if (tool === WORKTREE_CONSUMER_TOOL) return isAuthorizedWorktreeConsumer(args.agent, tool);
   if (tool === "bash") return isAuthorizedRunnerCommand(String(args.command ?? ""));
   if (tool === "read" || tool === "glob" || tool === "grep" || tool === "skill" || tool.startsWith("engram_")) return true;
   // MCP Graphify: única herramienta MCP autorizada para el runner (vía 1 de la cadena de investigación).
   // No ampliar a otros tools graphify — solo el tool enumerado exacto.
   if (tool === "graphify_query_graph") return true;
   if (tool === "subagent") return isAuthorizedRunnerSubagent(args.agent);
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
  let dispatchSessionID = "";
  /**
   * The standalone checkout that serves the target repository. The target
   * repository owns its own copy; the session copy is the fallback for a
   * repository that does not carry the manager.
   */
  const managerDirectoryFor = (repoRoot: string): string => {
    const local = resolve(repoRoot, ".flowtask/scripts/worktree-manager");
    if (existsSync(local)) return local;
    return resolve(sessionDir, ".flowtask/scripts/worktree-manager");
  };
  const worktreeConsumer = createWorktreeConsumerBridge({
    invokeEngram: createConfiguredEngramInvoker(sessionDir),
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    listLocalBranches: (repoRoot) => execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: repoRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean),
    detectTransport: async ({ repoRoot }) => {
      const managerDirectory = managerDirectoryFor(repoRoot);
      const cli = await createWorktreeCliClient({ managerDirectory }).detect();
      const mcp = await createWorktreeMcpClient({ managerDirectory }).detect();
      return {
        cli: { available: cli.available, cause: cli.cause },
        mcp: { available: mcp.available, cause: mcp.cause },
      };
    },
    invokeCli: async ({ repoRoot, request }) => createWorktreeCliClient({ managerDirectory: managerDirectoryFor(repoRoot) }).invoke(request),
    invokeMcp: async ({ repoRoot, tool, request }) => createWorktreeMcpClient({ managerDirectory: managerDirectoryFor(repoRoot) }).invoke(tool, request),
    dispatchConstructor: async (record) => input.client.session.prompt({
      path: { id: dispatchSessionID },
      body: { agent: "flowtask-constructor", parts: [{ type: "text", text: `Implement the confirmed worktree association: ${JSON.stringify(record)}` }] },
      query: { directory: sessionDir },
    }),
    dispatchValidator: async (record) => input.client.session.prompt({
      path: { id: dispatchSessionID },
      body: { agent: "flowtask-validator", parts: [{ type: "text", text: `Validate the confirmed worktree association: ${JSON.stringify(record)}` }] },
      query: { directory: sessionDir },
    }),
  });
  return {
    tool: {
      [WORKTREE_CONSUMER_TOOL]: tool({
        description: "Create and dispatch a worktree consumer operation for the authorized FlowTask runner.",
        args: {
          agent: tool.schema.string(), operation: tool.schema.enum(["create", "complete", "cleanup", "recover", "list", "prune", "status"]),
          transport: tool.schema.enum(["cli", "mcp"]).optional(),
          repo_root: tool.schema.string(), path: tool.schema.string().optional(), branch: tool.schema.string().optional(),
          base_branch: tool.schema.string().optional(), work_id: tool.schema.string().optional(), init_submodules: tool.schema.boolean().optional(),
          preserve_dirty: tool.schema.boolean().optional(), discard: tool.schema.boolean().optional(), discard_consent: tool.schema.boolean().optional(),
          prepare: tool.schema.boolean().optional(), verify: tool.schema.boolean().optional(),
          confirm: tool.schema.boolean().optional(), transaction_id: tool.schema.string().optional(), plan_hash: tool.schema.string().optional(),
          dry_run: tool.schema.boolean().optional(), target_direct: tool.schema.boolean().optional(),
          parent_repo: tool.schema.string().optional(), submodule_path: tool.schema.string().optional(),
        },
        async execute(args, context) {
          if (!isAuthorizedWorktreeConsumer(args.agent, WORKTREE_CONSUMER_TOOL)) throw new Error("worktree consumer denied");
          if (context.agent !== "flowtask-runner") throw new Error("worktree consumer denied");
          dispatchSessionID = context.sessionID;
          return JSON.stringify(await worktreeConsumer.execute(args));
        },
      }),
    },
    "chat.message": async (hookInput: { sessionID: string; agent?: string }) => {
      // GATE: SESSION_AGENTS solo registra la personalidad flowtask-runner;
      // cualquier otra identidad expuesta como `agent` se ignora para no
      // contaminar la identidad de la sesión ni sobrescribir un runner validado.
      if (hookInput.agent !== undefined && isRunner(hookInput.agent)) {
        SESSION_AGENTS.set(hookInput.sessionID, hookInput.agent);
      }
      // Cada mensaje nuevo abre un turno: se numera, se resetea el acumulado y
      // se reinicia el estado de avisos de acotación del turno.
      const turn = (TURN_SEQ.get(hookInput.sessionID) ?? 0) + 1;
      TURN_SEQ.set(hookInput.sessionID, turn);
      TURN_STATE.set(hookInput.sessionID, { sum: 0, turn });
      resetNarrowingNotices(hookInput.sessionID);
    },
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string; agent?: string },
      hookOutput: { args: any },
    ) => {
      const command = String(hookOutput?.args?.command ?? "");
      // OpenCode 1.18.4 no expone agent en tool.execute.before; chat.message es
      // la fuente autoritativa de la sesión. Fallback defensivo: si 1.18.15+
      // expone el agent en el hook de tool y califica como runner, se usa esa
      // identidad; si no califica (o está ausente), se cae a la sesión.
      const hookAgent = hookInput.agent;
      const agent = hookAgent !== undefined && isRunner(hookAgent) ? hookAgent : SESSION_AGENTS.get(hookInput.sessionID);
      if (isRunner(agent) && !runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {})) runnerBlocked();

      // --- context budget: pre-gate barato (runner, lista cerrada, sin recorrer árbol) ---
      // Degradación por niveles, nivel 1: el primer pedido amplio del turno se
      // anuncia con la forma de acotar y no se ejecuta. El mismo pedido
      // repetido en el turno se permite y su entrega se reduce en el post-gate.
      if (isRunner(agent) && (hookInput.tool === "read" || hookInput.tool === "glob" || hookInput.tool === "grep")) {
        const budgetArgs = hookOutput?.args ?? {};
        const budgetTool = hookInput.tool as "read" | "glob" | "grep";
        const broad =
          budgetTool === "read"
            ? shouldPreventiveBlockRead(budgetArgs, readStatSizeSafe(budgetArgs))
            : budgetTool === "glob"
              ? shouldPreventiveBlockGlob(budgetArgs)
              : shouldPreventiveBlockGrep(budgetArgs);
        if (broad && registerNarrowingNotice(hookInput.sessionID, budgetTool, budgetArgs)) {
          throw new Error(buildNarrowingNotice(budgetTool, budgetArgs));
        }
      }

      if (hookInput.tool !== "bash" || !/\bgit\s+commit\b/.test(command)) return;
      if (command.includes("--no-verify") || command.includes("--no-review")) {
        // El bypass solo es legítimo para cambios triviales (≤ TRIVIAL_CHANGE_LINES).
        // Si no se puede medir el diff (getDiffStats lanza), el error se propaga y el commit se bloquea (deny-by-default).
        const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
        const stats = getDiffStats(workdir);
        if (stats.lines <= TRIVIAL_CHANGE_LINES) return; // trivial → bypass legítimo
        throw new Error(buildGateMessage(stats)); // no trivial → bypass denegado, review obligatorio
      }

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
      if (hookOutput == null) return;
      const budgetTool = hookInput.tool as "read" | "glob" | "grep";
      if (typeof hookOutput.output !== "string") {
        // GAP-003: si no se puede medir, nunca entregar silencioso sin control:
        // se observa con traza y se marca la entrega como no medible. Un smoke
        // de integración revalida la mutación.
        console.warn(
          `[FlowTask Context Budget] no se pudo medir output de ${budgetTool} (session ${hookInput.sessionID}); se entrega sin presupuestar.`,
        );
        hookOutput.metadata = { ...(hookOutput.metadata ?? {}), ...buildDegradationMetadata("measurement_unavailable") };
        return;
      }

      const budget = loadContextBudgetConfig(sessionDir || process.cwd(), sessionDir);
      const threshold =
        budgetTool === "read" ? budget.readThreshold : budgetTool === "grep" ? budget.grepThreshold : budget.globThreshold;
      const actual = hookOutput.output.length;

      // Attachments imagen/PDF: el texto corto miente sobre el costo real; el
      // runner no recibe attachments (v1) y se delega al Inspector.
      if (isImageOrPdfOutput(hookOutput)) {
        hookOutput.output = buildAttachmentDelivery(budgetTool, actual);
        if (hookOutput.metadata) delete hookOutput.metadata.attachment;
        hookOutput.metadata = {
          ...(hookOutput.metadata ?? {}),
          truncated: true,
          ...buildDegradationMetadata("attachment_delegated", { omittedChars: actual }),
        };
        return;
      }

      // Presupuesto por llamada: se entrega reducido, sin preview y con la
      // delegación explícita de lo omitido.
      if (actual > threshold) {
        hookOutput.output = buildReducedDelivery(budgetTool, actual, "call");
        hookOutput.metadata = {
          ...(hookOutput.metadata ?? {}),
          truncated: true,
          ...buildDegradationMetadata("reduced", { budget: "call", omittedChars: actual }),
        };
        return;
      }

      // Presupuesto acumulado por turno: aunque esté bajo el individual, la suma
      // entregada del turno no puede superar el presupuesto del turno.
      const state = TURN_STATE.get(hookInput.sessionID) ?? { sum: 0, turn: TURN_SEQ.get(hookInput.sessionID) ?? 0 };
      if (state.sum + actual > budget.turnAccumulated) {
        hookOutput.output = buildReducedDelivery(budgetTool, actual, "turn");
        hookOutput.metadata = {
          ...(hookOutput.metadata ?? {}),
          truncated: true,
          ...buildDegradationMetadata("turn_omitted", { budget: "turn", omittedChars: actual }),
        };
        return;
      }

      state.sum += actual;
      TURN_STATE.set(hookInput.sessionID, state);
    },
    dispose: async () => {
      SESSION_AGENTS.clear();
      TURN_STATE.clear();
      TURN_SEQ.clear();
      resetNarrowingNotices();
    },
  };
}
