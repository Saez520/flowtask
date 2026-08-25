import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RUNNER_DELEGATION_MESSAGE, isAuthorizedRunnerCommand } from "./authorizer.js";
const CONFIG_PATH = ".opencode/flowtask/config/review.json";
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
function readConfig(cwd, fallbackCwd) {
    const directories = [cwd, fallbackCwd].filter((directory, index, values) => Boolean(directory) && values.indexOf(directory) === index);
    let raw;
    let path = resolve(cwd, CONFIG_PATH);
    for (const directory of directories) {
        path = resolve(directory, CONFIG_PATH);
        try {
            raw = readFileSync(path, "utf8");
            break;
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                console.warn(`[FlowTask Permission Gate] No se pudo leer ${path}; se continúa sin bloquear.`);
                return null;
            }
        }
    }
    if (raw === undefined) {
        console.warn(`[FlowTask Permission Gate] No se pudo leer ${path}; se continúa sin bloquear.`);
        return null;
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch (error) {
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
    return { enabled: config.enabled, stampPath: config.stampPath };
}
function getDiffStats(cwd) {
    let lastError;
    for (const args of [["diff", "--cached", "--stat"], ["diff", "--stat"]]) {
        try {
            const output = execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
            if (!output)
                return { lines: 0, files: 0 };
            const summary = output.split("\n").pop() ?? "";
            const insertions = summary.match(/(\d+)\s+insertions?\(\+\)/);
            const deletions = summary.match(/(\d+)\s+deletions?\(-\)/);
            const files = summary.match(/(\d+)\s+files? changed/);
            if (!insertions && !deletions && !files) {
                throw new Error(`salida de git diff no reconocida: ${summary}`);
            }
            return {
                lines: (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0),
                files: files ? Number(files[1]) : 0,
            };
        }
        catch (error) {
            lastError = error;
        }
    }
    throw gateError("analizar diff", lastError ?? "sin estadísticas", "verificá el repositorio y reintentá");
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
            const stampPath = isAbsolute(config.stampPath)
                ? config.stampPath
                : resolve(workdir, config.stampPath);
            let stamp;
            try {
                stamp = readFileSync(stampPath, "utf8").trim();
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    throw new Error(buildGateMessage(getDiffStats(workdir)));
                }
                throw gateError("leer stamp", error, "ejecutá la revisión pre-commit y generá un stamp válido");
            }
            if (!stamp || Number.isNaN(Date.parse(stamp))) {
                throw gateError("validar stamp", "timestamp ISO-8601 inválido", "regenerá el stamp mediante la revisión");
            }
            try {
                unlinkSync(stampPath);
            }
            catch (error) {
                throw gateError("consumir stamp", error, "verificá permisos y reintentá");
            }
            return;
        },
        dispose: async () => {
            SESSION_AGENTS.clear();
        },
    };
}
