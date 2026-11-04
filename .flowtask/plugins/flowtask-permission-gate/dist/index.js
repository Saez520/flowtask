import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RUNNER_DELEGATION_MESSAGE, isAuthorizedRunnerCommand, isAuthorizedRunnerSubagent, isWorktreeManagerMcpTool, } from "./authorizer.js";
import { buildLayerBlockMessage, readOperationalLayers } from "./layers.js";
import { buildAttachmentDelivery, buildDegradationMetadata, buildNarrowingNotice, buildReducedDelivery, isImageOrPdfOutput, loadContextBudgetConfig, registerNarrowingNotice, resetNarrowingNotices, shouldPreventiveBlockGlob, shouldPreventiveBlockGrep, shouldPreventiveBlockRead, } from "./context-budget.js";
/**
 * Candidate configuration paths, tried in order within each directory.
 * Precedence: commit workdir first; sessionDir only as a fallback for
 * the other settings. The `stampPath` is ALWAYS resolved against the workdir.
 */
const CONFIG_CANDIDATES = [
    ".opencode/flowtask/config/review.json",
    ".flowtask/config/review.json",
];
/** Default review-stamp TTL; overridable with `stampTtlMinutes` in review.json. */
const DEFAULT_STAMP_TTL_MINUTES = 30;
/** Triviality criterion for the --no-verify bypass: changes with ≤ TRIVIAL_CHANGE_LINES lines. */
const TRIVIAL_CHANGE_LINES = 5;
const SESSION_AGENTS = new Map();
/**
 * Accumulated per runner turn (GAP-002): turn = cycle between consecutive
 * `chat.message` events of the same sessionID. `TURN_STATE` stores the sum of
 * delivered (not omitted) chars and the turn number; `TURN_SEQ` numbers the turns.
 */
const TURN_STATE = new Map();
const TURN_SEQ = new Map();
/**
 * Normalizes an agent identity to a comparable canonical form:
 * trim + lowercase, and `_` or whitespace collapsed to `-`. Covers
 * case-insensitive variants such as "FlowTask-Runner", "FLOWTASK_RUNNER", " flowtask-runner ".
 */
function normalizeAgent(agent) {
    return String(agent).trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
}
/**
 * Is this agent the FlowTask runner? The gate validates the PERSONALITY
 * (flowtask-runner), not the model: only an exact case-insensitive match of
 * the normalized identity qualifies.
 */
function isRunner(agent) {
    return typeof agent === "string" && normalizeAgent(agent) === "flowtask-runner";
}
function runnerToolAllowed(tool, args) {
    if (isWorktreeManagerMcpTool(tool))
        return true;
    if (tool === "bash")
        return isAuthorizedRunnerCommand(String(args.command ?? ""));
    if (tool === "read" || tool === "glob" || tool === "grep" || tool === "skill" || tool.startsWith("engram_"))
        return true;
    // MCP Graphify: the only MCP tool authorized for the runner (path 1 of the research chain).
    // Do not expand to other graphify tools — only the exact enumerated tool.
    if (tool === "graphify_query_graph")
        return true;
    if (tool === "subagent")
        return isAuthorizedRunnerSubagent(args.agent);
    return false;
}
function runnerBlocked() { throw new Error(RUNNER_DELEGATION_MESSAGE); }
function gateError(operation, cause, action) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(`[FlowTask Permission Gate] Commit blocked.\n` +
        `Failed operation: ${operation}.\n` +
        `Cause: ${detail}.\n` +
        `Recommended action: ${action}`);
}
function parseReviewConfig(raw, path) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        console.warn(`[FlowTask Permission Gate] invalid JSON in ${path}; continuing without blocking.`);
        return null;
    }
    if (!value || typeof value !== "object" ||
        typeof value.enabled !== "boolean" ||
        typeof value.stampPath !== "string" ||
        !value.stampPath) {
        console.warn(`[FlowTask Permission Gate] invalid configuration in ${path}; continuing without blocking.`);
        return null;
    }
    const config = value;
    let stampTtlMinutes = DEFAULT_STAMP_TTL_MINUTES;
    if (config.stampTtlMinutes !== undefined) {
        if (typeof config.stampTtlMinutes === "number" && Number.isFinite(config.stampTtlMinutes) && config.stampTtlMinutes > 0) {
            stampTtlMinutes = config.stampTtlMinutes;
        }
        else {
            console.warn(`[FlowTask Permission Gate] invalid stampTtlMinutes in ${path}; using the default (${DEFAULT_STAMP_TTL_MINUTES} min).`);
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
 * Looks for review.json in `directory` by trying the canonical paths in order.
 * Returns `undefined` if no candidate exists (allows moving to the next
 * directory) and `null` if one exists but is unreadable or invalid (observable fail-open).
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
            console.warn(`[FlowTask Permission Gate] could not read ${path}; continuing without blocking.`);
            return null;
        }
        return parseReviewConfig(raw, path);
    }
    return undefined;
}
/**
 * Documented precedence: workdir-first (the two known paths); the fallback
 * to sessionDir/main contributes only the other settings (enabled, TTL). The
 * resulting `stampPath` is ALWAYS resolved against the commit workdir.
 */
function readConfig(workdir, fallbackCwd) {
    const directories = [workdir, fallbackCwd].filter((directory, index, values) => Boolean(directory) && values.indexOf(directory) === index);
    for (const directory of directories) {
        const found = findConfigIn(directory);
        if (found !== undefined)
            return found;
    }
    console.warn(`[FlowTask Permission Gate] review.json not found in ${directories.join(" or ")}; continuing without blocking.`);
    return null;
}
function getCurrentBranch(cwd) {
    try {
        return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
    }
    catch (error) {
        throw gateError("determine the current branch", error, "verify that the workdir is a valid git repository and retry");
    }
}
/**
 * Structured format: {"ts":"<ISO-8601>","branch":"<branch>"}. Plain ISO
 * stamps (obsolete format) are rejected with an explicit cause. Fail-closed.
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
                reason: 'obsolete format (plain ISO-8601): generate a new stamp with the format {"ts":"<ISO-8601>","branch":"<branch>"}',
            };
        }
        return { ok: false, reason: "invalid format: the content is not parseable JSON" };
    }
    if (!value || typeof value !== "object") {
        return { ok: false, reason: "invalid format: the stamp must be a JSON object {ts, branch}" };
    }
    const record = value;
    if (typeof record.ts !== "string" || !record.ts || Number.isNaN(Date.parse(record.ts))) {
        return { ok: false, reason: "invalid format: the \"ts\" field is missing or invalid (ISO-8601)" };
    }
    if (typeof record.branch !== "string" || !record.branch) {
        return { ok: false, reason: "invalid format: the \"branch\" field is missing or invalid" };
    }
    return { ok: true, payload: { ts: Date.parse(record.ts), branch: record.branch } };
}
/** Validates TTL and branch binding. Returns the rejection cause or null if valid. */
function stampIssue(payload, now, currentBranch, ttlMinutes) {
    const ageMinutes = Math.floor((now - payload.ts) / 60000);
    if (now - payload.ts > ttlMinutes * 60000) {
        return `expired ${ageMinutes} min ago (current TTL: ${ttlMinutes} min)`;
    }
    if (payload.branch !== currentBranch) {
        return `branch mismatch (expected '${payload.branch}', found '${currentBranch || "detached/no branch"}')`;
    }
    return null;
}
/**
 * Honest diff: `git status --porcelain` counts real pending files
 * (staged + unstaged); `git diff HEAD --stat` provides the +/- lines.
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
                throw new Error(`unrecognized git diff output: ${summary}`);
            }
            lines = (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
        }
    }
    catch (error) {
        lastError = lastError ?? error;
    }
    if (lastError) {
        throw gateError("analyze diff", lastError, "verify the repository and retry");
    }
    return { lines, files: pendingFiles };
}
function buildGateMessage(stats) {
    return [
        "[FlowTask Permission Gate] Commit blocked.",
        "",
        `📊 Diff: ${stats.files} file(s), ${stats.lines} line(s).`,
        "",
        "→ Runner: assess whether this change requires pre-commit review.",
        "  - If it is trivial (gitignore, docs, chore ≤ 5 lines): re-run the commit with --no-verify.",
        "  - If not: invoke flowtask-review-orchestrator and generate the stamp before retrying.",
    ].join("\n");
}
function buildStampBlockMessage(cause, stampPath, configPath, stats) {
    return [
        "[FlowTask Permission Gate] Commit blocked by an invalid review-stamp.",
        "",
        `Cause: ${cause}.`,
        `Stamp looked up at: ${stampPath}`,
        `Applied config: ${configPath}`,
        "",
        `📊 Diff: ${stats.files} file(s), ${stats.lines} line(s) pending.`,
        "",
        "→ Invoke flowtask-review-orchestrator and generate a new stamp at the indicated path:",
        '  {"ts":"<ISO-8601>","branch":"<current branch of the target repo>"}',
    ].join("\n");
}
/**
 * `stat.size` of the read file if it exists and is a string. Returns undefined
 * on failure (hybrid GAP: the pre-gate is a cheap saving, the post-gate decides).
 */
function readStatSizeSafe(args) {
    const file = args?.file;
    if (typeof file !== "string" || !file)
        return undefined;
    try {
        return statSync(file).size;
    }
    catch {
        return undefined;
    }
}
export default async function (input) {
    const sessionDir = input.directory;
    return {
        "chat.message": async (hookInput) => {
            // GATE: SESSION_AGENTS only records the flowtask-runner personality;
            // any other identity exposed as `agent` is ignored so as not to
            // contaminate the session identity or overwrite a validated runner.
            if (hookInput.agent !== undefined && isRunner(hookInput.agent)) {
                SESSION_AGENTS.set(hookInput.sessionID, hookInput.agent);
            }
            // Each new message opens a turn: it is numbered, the accumulated total is
            // reset, and the turn's narrowing notice state is reset.
            const turn = (TURN_SEQ.get(hookInput.sessionID) ?? 0) + 1;
            TURN_SEQ.set(hookInput.sessionID, turn);
            TURN_STATE.set(hookInput.sessionID, { sum: 0, turn });
            resetNarrowingNotices(hookInput.sessionID);
        },
        "tool.execute.before": async (hookInput, hookOutput) => {
            const command = String(hookOutput?.args?.command ?? "");
            // OpenCode 1.18.4 does not expose agent in tool.execute.before; chat.message
            // is the authoritative source for the session. Defensive fallback: if 1.18.15+
            // exposes the agent in the tool hook and it qualifies as runner, that
            // identity is used; if it does not qualify (or is absent), it falls back to the session.
            const hookAgent = hookInput.agent;
            const agent = hookAgent !== undefined && isRunner(hookAgent) ? hookAgent : SESSION_AGENTS.get(hookInput.sessionID);
            if (isRunner(agent)) {
                // Permissions layer: autonomy and permissions must exist and be
                // valid in the target before applying the technical allowlist. Autonomy
                // does not authorize: it only checks that the layer is healthy.
                const layerWorkdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
                const operationalLayers = readOperationalLayers([layerWorkdir, sessionDir]);
                if (!operationalLayers.ok && operationalLayers.configDir) {
                    throw new Error(buildLayerBlockMessage(operationalLayers));
                }
                if (!runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {}))
                    runnerBlocked();
            }
            // --- context budget: cheap pre-gate (runner, closed list, no tree walk) ---
            // Degradation by levels, level 1: the first broad request of the turn is
            // announced with the way to narrow it and is not executed. The same request
            // repeated in the turn is allowed and its delivery is reduced in the post-gate.
            if (isRunner(agent) && (hookInput.tool === "read" || hookInput.tool === "glob" || hookInput.tool === "grep")) {
                const budgetArgs = hookOutput?.args ?? {};
                const budgetTool = hookInput.tool;
                const broad = budgetTool === "read"
                    ? shouldPreventiveBlockRead(budgetArgs, readStatSizeSafe(budgetArgs))
                    : budgetTool === "glob"
                        ? shouldPreventiveBlockGlob(budgetArgs)
                        : shouldPreventiveBlockGrep(budgetArgs);
                if (broad && registerNarrowingNotice(hookInput.sessionID, budgetTool, budgetArgs)) {
                    throw new Error(buildNarrowingNotice(budgetTool, budgetArgs));
                }
            }
            if (hookInput.tool !== "bash" || !/\bgit\s+commit\b/.test(command))
                return;
            if (command.includes("--no-verify") || command.includes("--no-review")) {
                // The bypass is only legitimate for trivial changes (≤ TRIVIAL_CHANGE_LINES).
                // If the diff cannot be measured (getDiffStats throws), the error propagates and the commit is blocked (deny-by-default).
                const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
                const stats = getDiffStats(workdir);
                if (stats.lines <= TRIVIAL_CHANGE_LINES)
                    return; // trivial → legitimate bypass
                throw new Error(buildGateMessage(stats)); // non-trivial → bypass denied, review required
            }
            const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
            const config = readConfig(workdir, sessionDir);
            if (!config)
                return;
            if (!config.enabled)
                return;
            // Unified resolution: the relative stampPath is ALWAYS resolved against
            // the commit workdir (per-flow isolation: worktrees read/write their own stamps).
            const stampAbsolutePath = isAbsolute(config.stampPath)
                ? config.stampPath
                : resolve(workdir, config.stampPath);
            let raw;
            try {
                raw = readFileSync(stampAbsolutePath, "utf8");
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    throw new Error(buildStampBlockMessage("missing stamp", stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
                }
                throw gateError("read stamp", error, "verify permissions and retry");
            }
            const parsed = parseStamp(raw);
            if (!parsed.ok) {
                throw new Error(buildStampBlockMessage(parsed.reason, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
            }
            const issue = stampIssue(parsed.payload, Date.now(), getCurrentBranch(workdir), config.stampTtlMinutes);
            if (issue) {
                throw new Error(buildStampBlockMessage(issue, stampAbsolutePath, config.sourcePath, getDiffStats(workdir)));
            }
            // Valid stamp: NOT consumed. Validity is governed by the TTL and branch
            // binding; a later failed commit does not require regenerating the stamp.
            return;
        },
        "tool.execute.after": async (hookInput, hookOutput) => {
            const agent = SESSION_AGENTS.get(hookInput.sessionID);
            if (!isRunner(agent))
                return;
            if (hookInput.tool !== "read" && hookInput.tool !== "glob" && hookInput.tool !== "grep")
                return;
            if (hookOutput == null)
                return;
            const budgetTool = hookInput.tool;
            if (typeof hookOutput.output !== "string") {
                // GAP-003: if it cannot be measured, never deliver silently without control:
                // it is observed with a trace and the delivery is marked as unmeasurable. An
                // integration smoke revalidates the mutation.
                console.warn(`[FlowTask Context Budget] could not measure ${budgetTool} output (session ${hookInput.sessionID}); delivering without budgeting.`);
                hookOutput.metadata = { ...(hookOutput.metadata ?? {}), ...buildDegradationMetadata("measurement_unavailable") };
                return;
            }
            const budget = loadContextBudgetConfig(sessionDir || process.cwd(), sessionDir);
            const threshold = budgetTool === "read" ? budget.readThreshold : budgetTool === "grep" ? budget.grepThreshold : budget.globThreshold;
            const actual = hookOutput.output.length;
            // Image/PDF attachments: the short text lies about the real cost; the
            // runner receives no attachments (v1) and it is delegated to the Inspector.
            if (isImageOrPdfOutput(hookOutput)) {
                hookOutput.output = buildAttachmentDelivery(budgetTool, actual);
                if (hookOutput.metadata)
                    delete hookOutput.metadata.attachment;
                hookOutput.metadata = {
                    ...(hookOutput.metadata ?? {}),
                    truncated: true,
                    ...buildDegradationMetadata("attachment_delegated", { omittedChars: actual }),
                };
                return;
            }
            // Per-call budget: delivered reduced, without preview, and with the
            // explicit delegation of what was omitted.
            if (actual > threshold) {
                hookOutput.output = buildReducedDelivery(budgetTool, actual, "call");
                hookOutput.metadata = {
                    ...(hookOutput.metadata ?? {}),
                    truncated: true,
                    ...buildDegradationMetadata("reduced", { budget: "call", omittedChars: actual }),
                };
                return;
            }
            // Accumulated per-turn budget: even if under the individual threshold, the
            // turn's delivered total cannot exceed the turn budget.
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
