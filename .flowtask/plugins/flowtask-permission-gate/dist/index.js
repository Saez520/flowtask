import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
const CONFIG_PATH = ".opencode/flowtask/config/review.json";
export const RUNNER_DELEGATION_MESSAGE = "Recordá que debés delegar esta operación al subagente correspondiente.";
const RUNNER_TASKS = new Set([
    "flowtask-ca-writer", "flowtask-planner", "flowtask-plan-auditor", "flowtask-constructor",
    "flowtask-validator", "flowtask-initializer", "flowtask-logger", "flowtask-tester",
    "flowtask-review-orchestrator", "flowtask-inspector", "flowtask-onboarder",
    "flowtask-graphify-docs-media",
]);
function isRunner(agent) {
    return typeof agent === "string" && agent.toLowerCase().replace(/_/g, "-") === "flowtask-runner";
}
/** Tokenize the small shell grammar used by FlowTask commands. */
export function tokenizeCommand(command) {
    if (/[;&|`<>]|\$\(/.test(command))
        return null;
    const tokens = [];
    let token = "";
    let quote = "";
    let escaped = false;
    for (const char of command.trim()) {
        if (escaped) {
            token += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote)
                quote = "";
            else
                token += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (token) {
                tokens.push(token);
                token = "";
            }
            continue;
        }
        token += char;
    }
    if (escaped || quote)
        return null;
    if (token)
        tokens.push(token);
    return tokens;
}
function hasOnlyFlags(tokens) { return tokens.every((token) => token.startsWith("-")); }
function hasPaths(tokens) { return tokens.length > 0 && tokens.every((token) => !token.startsWith("-")); }
export function isAuthorizedRunnerCommand(command) {
    const tokens = tokenizeCommand(command);
    if (!tokens?.length)
        return false;
    if (tokens[0] === "node" && tokens[1] === ".flowtask/bin/flowtask.js" && tokens[2] === "graphify")
        return tokens.length > 3;
    if (tokens[0] === "./.flowtask/scripts/worktree.sh") {
        if (tokens.length === 2 && tokens[1] === "list")
            return true;
        return tokens.length === 5 && ["create", "complete"].includes(tokens[1]) && Boolean(tokens[2]) && tokens[3] === "--base" && Boolean(tokens[4]);
    }
    if (tokens[0] !== "git")
        return false;
    if (tokens[1] === "status")
        return hasOnlyFlags(tokens.slice(2));
    if (tokens[1] === "add")
        return hasPaths(tokens.slice(2));
    if (tokens[1] === "restore" && tokens[2] === "--staged")
        return hasPaths(tokens.slice(3));
    if (tokens[1] === "commit")
        return tokens.length === 4 && tokens[2] === "-m" && Boolean(tokens[3]);
    if (tokens[1] === "push" || tokens[1] === "merge")
        return tokens.length >= 2;
    return false;
}
function runnerToolAllowed(tool, args) {
    if (tool === "bash")
        return isAuthorizedRunnerCommand(String(args.command ?? ""));
    if (tool === "skill" || tool.startsWith("engram_"))
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
function readConfig(cwd) {
    const path = resolve(cwd, CONFIG_PATH);
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (error) {
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
        "tool.execute.before": async (hookInput, hookOutput) => {
            const command = String(hookOutput?.args?.command ?? "");
            const agent = hookInput.agent ?? input.agent;
            if (isRunner(agent) && !runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {}))
                runnerBlocked();
            if (hookInput.tool !== "bash" || !/\bgit\s+commit\b/.test(command))
                return;
            if (command.includes("--no-verify") || command.includes("--no-review"))
                return;
            const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
            const config = readConfig(sessionDir || workdir);
            if (!config)
                return;
            if (!config.enabled)
                return;
            const stampPath = isAbsolute(config.stampPath)
                ? config.stampPath
                : resolve(sessionDir || workdir, config.stampPath);
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
        dispose: async () => { },
    };
}
