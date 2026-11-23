import { Plugin } from "@opencode/plugin";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { RUNNER_DELEGATION_MESSAGE, isAuthorizedRunnerCommand, isAuthorizedRunnerSubagent, isAuthorityCommand, isWorktreeManagerMcpTool, } from "./authorizer.js";
import { buildLayerBlockMessage, readOperationalLayers, readOperationalLayersAt } from "./layers.js";
import { evaluateOpencodeActivation, findOpencodeRegistration, } from "./registration.js";
import { applyReducedDelivery, buildAttachmentDelivery, buildDegradationMetadata, buildNarrowingNotice, buildReducedDelivery, isImageOrPdfOutput, loadContextBudgetConfig, readDeliveredText, readRequestedPath, registerNarrowingNotice, resetNarrowingNotices, shouldPreventiveBlockGlob, shouldPreventiveBlockGrep, shouldPreventiveBlockRead, } from "./context-budget.js";
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
 * Accumulated per runner turn (GAP-002): turn = cycle opened by each `prompt`
 * event of the same sessionID. `TURN_STATE` stores the sum of delivered (not
 * omitted) chars and the turn number; `TURN_SEQ` numbers the turns.
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
/**
 * Resolves the identity exposed by the V2 event. An explicit non-empty agent
 * wins as-is: only the runner is registered per session for later phases that
 * arrive without an identity. The session fallback applies only when the event
 * carries no agent, so a non-runner cannot inherit the recorded runner.
 */
function resolveSessionAgent(sessionID, eventAgent) {
    if (typeof eventAgent === "string" && eventAgent.trim()) {
        if (isRunner(eventAgent))
            SESSION_AGENTS.set(sessionID, eventAgent);
        return eventAgent;
    }
    return SESSION_AGENTS.get(sessionID);
}
/** Commit workdir precedence: explicit workdir, explicit cwd, then the session directory. */
function readWorkdir(args, fallback) {
    const candidate = args.workdir ?? args.cwd;
    return typeof candidate === "string" && candidate ? candidate : fallback;
}
/** Global git options that consume the next token as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
]);
/** Global git options written with `=<value>`. */
const GIT_GLOBAL_OPTIONS_WITH_EQUALS = ["--git-dir=", "--work-tree=", "--namespace=", "--exec-path="];
/** Splits a command on `&&` without breaking quoted segments. */
function splitCommandSegments(command) {
    const segments = [];
    let current = "";
    let quote = null;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote) {
            current += char;
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === "&" && command[index + 1] === "&") {
            segments.push(current);
            current = "";
            index += 1;
            continue;
        }
        current += char;
    }
    segments.push(current);
    return segments;
}
/** Whitespace tokenization that keeps a quoted value in one token. */
function tokenizeSegment(segment) {
    const tokens = [];
    let current = "";
    let quote = null;
    for (const char of segment) {
        if (quote) {
            current += char;
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (current)
        tokens.push(current);
    return tokens;
}
/**
 * Detects a commit in any `&&` segment, including the global git options that
 * precede the subcommand (`-C`, `-c`, `--git-dir`, and their value forms).
 * A leading `cd` belongs to its own segment, so `cd ... && git commit` is seen.
 */
function isGitCommitCommand(command) {
    for (const segment of splitCommandSegments(command)) {
        const tokens = tokenizeSegment(segment);
        for (let start = 0; start < tokens.length; start += 1) {
            if (tokens[start] !== "git")
                continue;
            let index = start + 1;
            while (index < tokens.length) {
                const token = tokens[index];
                if (token === "commit")
                    return true;
                if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
                    index += 2;
                    continue;
                }
                if (GIT_GLOBAL_OPTIONS_WITH_EQUALS.some((prefix) => token.startsWith(prefix))) {
                    index += 1;
                    continue;
                }
                if (token.startsWith("-")) {
                    index += 1;
                    continue;
                }
                break;
            }
        }
    }
    return false;
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
/** A V2 content part that carries an attachment payload instead of text. */
function isFilePart(part) {
    return Boolean(part) && typeof part === "object" && part.type === "file";
}
function gateError(operation, cause, action) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(`[FlowTask Permission Gate] Commit blocked.\n` +
        `Failed operation: ${operation}.\n` +
        `Cause: ${detail}.\n` +
        `Recommended action: ${action}`);
}
/** Structural validation: an unusable file is reported, never silently ignored. */
function parseReviewConfig(raw, path) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { ok: false, cause: "the file is not parseable JSON" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, cause: "the file does not contain a JSON object" };
    }
    const config = value;
    if (typeof config.enabled !== "boolean") {
        return { ok: false, cause: 'the "enabled" field is missing or is not boolean' };
    }
    if (typeof config.stampPath !== "string" || !config.stampPath) {
        return { ok: false, cause: 'the "stampPath" field is missing or empty' };
    }
    let stampTtlMinutes = DEFAULT_STAMP_TTL_MINUTES;
    if (config.stampTtlMinutes !== undefined) {
        if (typeof config.stampTtlMinutes === "number" && Number.isFinite(config.stampTtlMinutes) && config.stampTtlMinutes > 0) {
            stampTtlMinutes = config.stampTtlMinutes;
        }
        else {
            return { ok: false, cause: 'the "stampTtlMinutes" field is not a positive number' };
        }
    }
    return {
        ok: true,
        config: {
            enabled: config.enabled,
            stampPath: config.stampPath,
            stampTtlMinutes,
            sourcePath: path,
        },
    };
}
/**
 * Looks for review.json in `directory` by trying the canonical paths in order.
 * Missing lets the caller continue to the next directory; an existing but
 * unreadable or invalid file is returned as such so the gate can fail closed.
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
            return { status: "invalid", path, cause: "the file could not be read" };
        }
        const parsed = parseReviewConfig(raw, path);
        if (!parsed.ok)
            return { status: "invalid", path, cause: parsed.cause };
        return { status: "found", config: parsed.config };
    }
    return { status: "missing" };
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
        if (found.status !== "missing")
            return found;
    }
    return { status: "missing" };
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
function buildMissingConfigMessage(workdir, fallbackCwd, registrationPath, stats) {
    const directories = [workdir, fallbackCwd].filter((directory, index, values) => Boolean(directory) && values.indexOf(directory) === index);
    const searched = directories
        .flatMap((directory) => CONFIG_CANDIDATES.map((candidate) => resolve(directory, candidate)))
        .join(" or ");
    return [
        "[FlowTask Permission Gate] Commit blocked.",
        "",
        "Cause: review config missing; run flowtask update.",
        `Searched: ${searched}`,
        ...(registrationPath ? [`Registration: ${registrationPath}`] : []),
        "",
        `📊 Diff: ${stats.files} file(s), ${stats.lines} line(s) pending.`,
        "",
        "→ The project is registered, so the gate fails closed instead of allowing an unreviewed commit.",
    ].join("\n");
}
function buildInvalidConfigMessage(path, cause, stats) {
    return [
        "[FlowTask Permission Gate] Commit blocked.",
        "",
        `Cause: invalid review config at ${path}: ${cause}.`,
        "Recommended action: fix the file or run flowtask update.",
        "",
        `📊 Diff: ${stats.files} file(s), ${stats.lines} line(s) pending.`,
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
 * `stat.size` of the read target resolved against the commit workdir/session.
 * Accepts the V2 `path` field with the legacy `file` fallback. Returns undefined
 * on failure (hybrid GAP: the pre-gate is a cheap saving, the post-gate decides).
 */
function readStatSizeSafe(args, baseDir) {
    const file = readRequestedPath(args);
    if (!file)
        return undefined;
    const absolute = isAbsolute(file) ? file : resolve(baseDir, file);
    try {
        return statSync(absolute).size;
    }
    catch {
        return undefined;
    }
}
export default Plugin.define({
    id: "flowtask-permission-gate",
    async setup(ctx) {
        const sessionDir = ctx.location.directory || process.cwd();
        const registered = [];
        const runtimeRoot = typeof ctx.options?.runtimeRoot === "string" && ctx.options.runtimeRoot
            ? ctx.options.runtimeRoot
            : null;
        // Registration gate: without a registered project, FlowTask agents and
        // skills are not exposed. A broken or unsupported registration is reported
        // through the context hook; an inactive project is removed silently.
        if (runtimeRoot) {
            const activation = evaluateOpencodeActivation({ directory: sessionDir, runtimeRoot });
            if (activation.status !== "active") {
                registered.push(await ctx.agent.transform(async (editor) => {
                    for (const agent of editor.list()) {
                        const id = String(agent.id ?? "");
                        const name = String(agent.name ?? "");
                        if (id.startsWith("flowtask-") || name.startsWith("flowtask-"))
                            editor.remove(String(agent.id));
                    }
                }));
                const normalizedRoot = runtimeRoot.replaceAll("\\", "/");
                registered.push(await ctx.skill.transform(async (editor) => {
                    for (const skill of editor.list()) {
                        const skillPath = String(skill.path ?? "").replaceAll("\\", "/");
                        if (skillPath.startsWith(`${normalizedRoot}/versions/`))
                            editor.remove(String(skill.id));
                    }
                }));
                if (activation.message) {
                    const message = activation.message;
                    registered.push(await ctx.session.hook("context", async (event) => {
                        event.system.push({ type: "text", text: message });
                    }));
                }
            }
        }
        const beforeHook = await ctx.tool.hook("execute.before", async (event) => {
            const input = event.input && typeof event.input === "object"
                ? event.input
                : {};
            const command = String(input.command ?? "");
            const workdir = readWorkdir(input, sessionDir);
            const agent = resolveSessionAgent(event.sessionID, event.agent);
            if (isRunner(agent)) {
                // Permissions layer: autonomy and permissions must exist and be
                // valid in the target before applying the technical allowlist. Autonomy
                // does not authorize: it only checks that the layer is healthy. An
                // absent configuration is also a denial, not a pass.
                const operationalLayers = typeof ctx.options?.configDir === "string" && ctx.options.configDir
                    ? readOperationalLayersAt(ctx.options.configDir)
                    : readOperationalLayers([workdir, sessionDir]);
                if (!operationalLayers.ok) {
                    const authorityBypass = event.tool === "bash" && isAuthorityCommand(command);
                    if (!authorityBypass)
                        throw new Error(buildLayerBlockMessage(operationalLayers));
                }
                if (!runnerToolAllowed(event.tool, input))
                    runnerBlocked();
            }
            // --- context budget: cheap pre-gate (runner, closed list, no tree walk) ---
            // Degradation by levels, level 1: the first broad request of the turn is
            // announced with the way to narrow it and is not executed. The same request
            // repeated in the turn is allowed and its delivery is reduced in the post-gate.
            if (isRunner(agent) && (event.tool === "read" || event.tool === "glob" || event.tool === "grep")) {
                const budgetTool = event.tool;
                const budget = loadContextBudgetConfig(workdir, sessionDir);
                const broad = budgetTool === "read"
                    ? shouldPreventiveBlockRead(input, readStatSizeSafe(input, workdir), budget.preventiveReadStatLimit)
                    : budgetTool === "glob"
                        ? shouldPreventiveBlockGlob(input, budget.preventiveGlobPatterns, budget.blockedPaths)
                        : shouldPreventiveBlockGrep(input, budget.blockedPaths);
                if (broad && registerNarrowingNotice(event.sessionID, budgetTool, input)) {
                    throw new Error(buildNarrowingNotice(budgetTool, input));
                }
            }
            if (event.tool !== "bash" || !isGitCommitCommand(command))
                return;
            if (command.includes("--no-verify") || command.includes("--no-review")) {
                // The bypass is only legitimate for trivial changes (≤ TRIVIAL_CHANGE_LINES).
                // If the diff cannot be measured (getDiffStats throws), the error propagates and the commit is blocked (deny-by-default).
                const stats = getDiffStats(workdir);
                if (stats.lines <= TRIVIAL_CHANGE_LINES)
                    return; // trivial → legitimate bypass
                throw new Error(buildGateMessage(stats)); // non-trivial → bypass denied, review required
            }
            const configLookup = readConfig(workdir, sessionDir);
            if (configLookup.status === "invalid") {
                throw new Error(buildInvalidConfigMessage(configLookup.path, configLookup.cause, getDiffStats(workdir)));
            }
            if (configLookup.status === "missing") {
                const registration = findOpencodeRegistration(workdir);
                if (registration.status === "active") {
                    throw new Error(buildMissingConfigMessage(workdir, sessionDir, registration.path, getDiffStats(workdir)));
                }
                return;
            }
            const config = configLookup.config;
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
        });
        const afterHook = await ctx.tool.hook("execute.after", async (event) => {
            if (event.status !== "completed")
                return;
            const agent = resolveSessionAgent(event.sessionID, event.agent);
            if (!isRunner(agent))
                return;
            if (event.tool !== "read" && event.tool !== "glob" && event.tool !== "grep")
                return;
            const result = event.result;
            if (result == null)
                return;
            const budgetTool = event.tool;
            const deliveredText = readDeliveredText(result);
            // Image/PDF attachments: the short text lies about the real cost; the
            // runner receives no attachments (v1) and it is delegated to the Inspector.
            if (isImageOrPdfOutput(result)) {
                const actual = deliveredText?.length ?? 0;
                const metadata = { ...(result.metadata ?? {}) };
                delete metadata.attachment;
                result.metadata = metadata;
                const delivery = buildAttachmentDelivery(budgetTool, actual);
                if (Array.isArray(result.content)) {
                    const kept = result.content.filter((part) => !isFilePart(part));
                    kept.push({ type: "text", text: delivery });
                    result.content = kept;
                }
                applyReducedDelivery(result, delivery, "attachment_delegated", {
                    omittedChars: actual,
                });
                return;
            }
            // GAP-003: if it cannot be measured, never deliver silently without control:
            // it is observed with a trace and the delivery is marked as unmeasurable. An
            // integration smoke revalidates the mutation.
            if (deliveredText === undefined) {
                console.warn(`[FlowTask Context Budget] could not measure ${budgetTool} output (session ${event.sessionID}); delivering without budgeting.`);
                result.metadata = {
                    ...(result.metadata ?? {}),
                    ...buildDegradationMetadata("measurement_unavailable"),
                };
                return;
            }
            const budget = loadContextBudgetConfig(sessionDir || process.cwd(), sessionDir);
            const actual = deliveredText.length;
            // Per-call budget: delivered reduced, without preview, and with the
            // explicit delegation of what was omitted.
            if (actual > (budgetTool === "read" ? budget.readThreshold : budgetTool === "grep" ? budget.grepThreshold : budget.globThreshold)) {
                applyReducedDelivery(result, buildReducedDelivery(budgetTool, actual, "call"), "reduced", {
                    budget: "call",
                    omittedChars: actual,
                });
                return;
            }
            // Accumulated per-turn budget: even if under the individual threshold, the
            // turn's delivered total cannot exceed the turn budget.
            const state = TURN_STATE.get(event.sessionID) ?? { sum: 0, turn: TURN_SEQ.get(event.sessionID) ?? 0 };
            if (state.sum + actual > budget.turnAccumulated) {
                applyReducedDelivery(result, buildReducedDelivery(budgetTool, actual, "turn"), "turn_omitted", {
                    budget: "turn",
                    omittedChars: actual,
                });
                return;
            }
            state.sum += actual;
            TURN_STATE.set(event.sessionID, state);
        });
        const promptHook = await ctx.session.hook("prompt", (event) => {
            // Each new prompt opens a turn: it is numbered, the accumulated total is
            // reset, and the turn's narrowing notice state is reset.
            const turn = (TURN_SEQ.get(event.sessionID) ?? 0) + 1;
            TURN_SEQ.set(event.sessionID, turn);
            TURN_STATE.set(event.sessionID, { sum: 0, turn });
            resetNarrowingNotices(event.sessionID);
        });
        return async () => {
            SESSION_AGENTS.clear();
            TURN_STATE.clear();
            TURN_SEQ.clear();
            resetNarrowingNotices();
            await Promise.all([
                promptHook.dispose(),
                beforeHook.dispose(),
                afterHook.dispose(),
                ...registered.map((entry) => entry.dispose()),
            ]);
        };
    },
});
