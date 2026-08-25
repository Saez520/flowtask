import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RUNNER_DELEGATION_MESSAGE, isAuthorizedRunnerCommand } from "./authorizer.js";
/**
 * Rutas candidatas de configuración, probadas en orden dentro de cada directorio.
 * Precedencia: workdir del commit primero; sessionDir solo como fallback para
 * los demás settings. El `stampPath` SIEMPRE se resuelve contra el workdir.
 */
const CONFIG_CANDIDATES = [
    ".opencode/flowtask/config/review.json",
    ".flowtask/config/review.json",
];
/** TTL por defecto del review-stamp; overridable con `stampTtlMinutes` en review.json. */
const DEFAULT_STAMP_TTL_MINUTES = 30;
const RUNNER_TASKS = new Set([
    "flowtask-ca-writer", "flowtask-planner", "flowtask-plan-auditor", "flowtask-constructor",
    "flowtask-validator", "flowtask-initializer", "flowtask-logger", "flowtask-tester",
    "flowtask-review-orchestrator", "flowtask-inspector", "flowtask-onboarder",
    "flowtask-graphify-docs-media",
]);
const SESSION_AGENTS = new Map();
function isRunner(agent) {
    return typeof agent === "string" && agent.toLowerCase().replace(/_/g, "-") === "flowtask-runner";
}
function runnerToolAllowed(tool, args) {
    if (tool === "bash")
        return isAuthorizedRunnerCommand(String(args.command ?? ""));
    if (tool === "read" || tool === "glob" || tool === "grep" || tool === "skill" || tool.startsWith("engram_"))
        return true;
    if (tool === "task")
        return RUNNER_TASKS.has(String(args.subagent_type ?? args.agent ?? args.name ?? ""));
    return false;
}
function runnerBlocked() { throw new Error(RUNNER_DELEGATION_MESSAGE); }
function gateError(operation, cause, action) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(`[FlowTask Permission Gate] Commit bloqueado.\n` +
        `Operación fallida: ${operation}.\n` +
        `Causa: ${detail}.\n` +
        `Acción recomendada: ${action}`);
}
function parseReviewConfig(raw, path) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        console.warn(`[FlowTask Permission Gate] JSON inválido en ${path}; se continúa sin bloquear.`);
        return null;
    }
    if (!value || typeof value !== "object" ||
        typeof value.enabled !== "boolean" ||
        typeof value.stampPath !== "string" ||
        !value.stampPath) {
        console.warn(`[FlowTask Permission Gate] Configuración inválida en ${path}; se continúa sin bloquear.`);
        return null;
    }
    const config = value;
    let stampTtlMinutes = DEFAULT_STAMP_TTL_MINUTES;
    if (config.stampTtlMinutes !== undefined) {
        if (typeof config.stampTtlMinutes === "number" && Number.isFinite(config.stampTtlMinutes) && config.stampTtlMinutes > 0) {
            stampTtlMinutes = config.stampTtlMinutes;
        }
        else {
            console.warn(`[FlowTask Permission Gate] stampTtlMinutes inválido en ${path}; se usa el default (${DEFAULT_STAMP_TTL_MINUTES} min).`);
        }
    }
    return {
        enabled: config.enabled,
        stampPath: config.stampPath,
        stampTtlMinutes,
        sourcePath: path,
    };
}
/**
 * Busca review.json en `directory` probando las rutas canónicas en orden.
 * Devuelve `undefined` si ninguna candidata existe (permite seguir al siguiente
 * directorio) y `null` si existe pero es ilegible o inválida (fail-open observable).
 */
function findConfigIn(directory) {
    for (const candidate of CONFIG_CANDIDATES) {
        const path = resolve(directory, candidate);
        let raw;
        try {
            raw = readFileSync(path, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
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
function readConfig(workdir, fallbackCwd) {
    const directories = [workdir, fallbackCwd].filter((directory, index, values) => Boolean(directory) && values.indexOf(directory) === index);
    for (const directory of directories) {
        const found = findConfigIn(directory);
        if (found !== undefined)
            return found;
    }
    console.warn(`[FlowTask Permission Gate] No se encontró review.json en ${directories.join(" ni ")}; se continúa sin bloquear.`);
    return null;
}
function getCurrentBranch(cwd) {
    try {
        return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
    }
    catch (error) {
        throw gateError("determinar la rama actual", error, "verificá que el workdir sea un repositorio git válido y reintentá");
    }
}
/**
 * Formato estructurado: {"ts":"<ISO-8601>","branch":"<rama>"}. Stamps en ISO
 * plano (formato obsoleto) se rechazan con causa explícita. Fail-closed.
 */
function parseStamp(raw) {
    const trimmed = raw.trim();
    let value;
    try {
        value = JSON.parse(trimmed);
    }
    catch {
        if (!Number.isNaN(Date.parse(trimmed))) {
            return {
                ok: false,
                reason: 'formato obsoleto (ISO-8601 plano): generá un stamp nuevo con el formato {"ts":"<ISO-8601>","branch":"<rama>"}',
            };
        }
        return { ok: false, reason: "formato inválido: el contenido no es JSON parseable" };
    }
    if (!value || typeof value !== "object") {
        return { ok: false, reason: "formato inválido: el stamp debe ser un objeto JSON {ts, branch}" };
    }
    const record = value;
    if (typeof record.ts !== "string" || !record.ts || Number.isNaN(Date.parse(record.ts))) {
        return { ok: false, reason: "formato inválido: falta o es inválido el campo \"ts\" (ISO-8601)" };
    }
    if (typeof record.branch !== "string" || !record.branch) {
        return { ok: false, reason: "formato inválido: falta o es inválido el campo \"branch\"" };
    }
    return { ok: true, payload: { ts: Date.parse(record.ts), branch: record.branch } };
}
/** Valida TTL y branch binding. Devuelve la causa de rechazo o null si es válido. */
function stampIssue(payload, now, currentBranch, ttlMinutes) {
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
function getDiffStats(cwd) {
    let pendingFiles = 0;
    let lines = 0;
    let lastError;
    try {
        const statusOutput = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
        pendingFiles = statusOutput ? statusOutput.split("\n").length : 0;
    }
    catch (error) {
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
    }
    catch (error) {
        lastError = lastError ?? error;
    }
    if (lastError) {
        throw gateError("analizar diff", lastError, "verificá el repositorio y reintentá");
    }
    return { lines, files: pendingFiles };
}
function buildGateMessage(stats) {
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
function buildStampBlockMessage(cause, stampPath, configPath, stats) {
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
export default async function (input) {
    const sessionDir = input.directory;
    return {
        "chat.message": async (hookInput) => {
            if (hookInput.agent !== undefined) {
                SESSION_AGENTS.set(hookInput.sessionID, hookInput.agent);
            }
        },
        "tool.execute.before": async (hookInput, hookOutput) => {
            const command = String(hookOutput?.args?.command ?? "");
            // OpenCode 1.18.4 does not expose agent on tool.execute.before.
            // chat.message is the authoritative runtime source for the session.
            const agent = SESSION_AGENTS.get(hookInput.sessionID);
            if (isRunner(agent) && !runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {}))
                runnerBlocked();
            if (hookInput.tool !== "bash" || !/\bgit\s+commit\b/.test(command))
                return;
            if (command.includes("--no-verify") || command.includes("--no-review"))
                return;
            const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
            const config = readConfig(workdir, sessionDir);
            if (!config)
                return;
            if (!config.enabled)
                return;
            // Resolución unificada: el stampPath relativo SIEMPRE se resuelve contra
            // el workdir del commit (aislamiento por flujo: worktrees leen/escriben
            // sus propios stamps).
            const stampAbsolutePath = isAbsolute(config.stampPath)
                ? config.stampPath
                : resolve(workdir, config.stampPath);
            let raw;
            try {
                raw = readFileSync(stampAbsolutePath, "utf8");
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    throw new Error(buildStampBlockMessage("stamp inexistente", stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
                }
                throw gateError("leer stamp", error, "verificá permisos y reintentá");
            }
            const parsed = parseStamp(raw);
            if (!parsed.ok) {
                throw new Error(buildStampBlockMessage(parsed.reason, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
            }
            const issue = stampIssue(parsed.payload, Date.now(), getCurrentBranch(workdir), config.stampTtlMinutes);
            if (issue) {
                throw new Error(buildStampBlockMessage(issue, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
            }
            // Stamp válido: NO se consume. La validez la gobierna el TTL y el branch
            // binding; un commit fallido posterior no obliga a regenerar el stamp.
            return;
        },
        dispose: async () => {
            SESSION_AGENTS.clear();
        },
    };
}
