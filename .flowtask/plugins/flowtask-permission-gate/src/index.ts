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
import { resolveWorktreeManagerLocation, missingManagerCause } from "./worktree-manager-location.js";
import { buildLayerBlockMessage, readOperationalLayers } from "./layers.js";
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
 * Candidate configuration paths, tried in order within each directory.
 * Precedence: commit workdir first; sessionDir only as a fallback for
 * the other settings. The `stampPath` is ALWAYS resolved against the workdir.
 */
const CONFIG_CANDIDATES = [
  ".opencode/flowtask/config/review.json",
  ".flowtask/config/review.json",
] as const;

/** Default review-stamp TTL; overridable with `stampTtlMinutes` in review.json. */
const DEFAULT_STAMP_TTL_MINUTES = 30;

/** Triviality criterion for the --no-verify bypass: changes with ≤ TRIVIAL_CHANGE_LINES lines. */
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
 * Accumulated per runner turn (GAP-002): turn = cycle between consecutive
 * `chat.message` events of the same sessionID. `TURN_STATE` stores the sum of
 * delivered (not omitted) chars and the turn number; `TURN_SEQ` numbers the turns.
 */
const TURN_STATE = new Map<string, { sum: number; turn: number }>();
const TURN_SEQ = new Map<string, number>();

/**
 * Normalizes an agent identity to a comparable canonical form:
 * trim + lowercase, and `_` or whitespace collapsed to `-`. Covers
 * case-insensitive variants such as "FlowTask-Runner", "FLOWTASK_RUNNER", " flowtask-runner ".
 */
function normalizeAgent(agent: unknown): string {
  return String(agent).trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
}

/**
 * Is this agent the FlowTask runner? The gate validates the PERSONALITY
 * (flowtask-runner), not the model: only an exact case-insensitive match of
 * the normalized identity qualifies.
 */
function isRunner(agent: unknown): boolean {
  return typeof agent === "string" && normalizeAgent(agent) === "flowtask-runner";
}

function runnerToolAllowed(tool: string, args: Record<string, unknown>): boolean {
   if (tool === WORKTREE_CONSUMER_TOOL) return isAuthorizedWorktreeConsumer(args.agent, tool);
   if (tool === "bash") return isAuthorizedRunnerCommand(String(args.command ?? ""));
   if (tool === "read" || tool === "glob" || tool === "grep" || tool === "skill" || tool.startsWith("engram_")) return true;
   // MCP Graphify: the only MCP tool authorized for the runner (path 1 of the research chain).
   // Do not expand to other graphify tools — only the exact enumerated tool.
   if (tool === "graphify_query_graph") return true;
   if (tool === "subagent") return isAuthorizedRunnerSubagent(args.agent);
   return false;
}

function runnerBlocked(): never { throw new Error(RUNNER_DELEGATION_MESSAGE); }

function gateError(operation: string, cause: unknown, action: string): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `[FlowTask Permission Gate] Commit blocked.\n` +
      `Failed operation: ${operation}.\n` +
      `Cause: ${detail}.\n` +
      `Recommended action: ${action}`,
  );
}

function parseReviewConfig(raw: string, path: string): ReviewConfig | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn(`[FlowTask Permission Gate] invalid JSON in ${path}; continuing without blocking.`);
    return null;
  }

  if (
    !value || typeof value !== "object" ||
    typeof (value as Record<string, unknown>).enabled !== "boolean" ||
    typeof (value as Record<string, unknown>).stampPath !== "string" ||
    !(value as Record<string, unknown>).stampPath
  ) {
    console.warn(`[FlowTask Permission Gate] invalid configuration in ${path}; continuing without blocking.`);
    return null;
  }

  const config = value as Record<string, unknown>;
  let stampTtlMinutes = DEFAULT_STAMP_TTL_MINUTES;
  if (config.stampTtlMinutes !== undefined) {
    if (typeof config.stampTtlMinutes === "number" && Number.isFinite(config.stampTtlMinutes) && config.stampTtlMinutes > 0) {
      stampTtlMinutes = config.stampTtlMinutes;
    } else {
      console.warn(
        `[FlowTask Permission Gate] invalid stampTtlMinutes in ${path}; using the default (${DEFAULT_STAMP_TTL_MINUTES} min).`,
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
 * Looks for review.json in `directory` by trying the canonical paths in order.
 * Returns `undefined` if no candidate exists (allows moving to the next
 * directory) and `null` if one exists but is unreadable or invalid (observable fail-open).
 */
function findConfigIn(directory: string): ReviewConfig | null | undefined {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = resolve(directory, candidate);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
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
function readConfig(workdir: string, fallbackCwd?: string): ReviewConfig | null {
  const directories = [workdir, fallbackCwd].filter(
    (directory, index, values): directory is string => Boolean(directory) && values.indexOf(directory) === index,
  );
  for (const directory of directories) {
    const found = findConfigIn(directory);
    if (found !== undefined) return found;
  }
  console.warn(
    `[FlowTask Permission Gate] review.json not found in ${directories.join(" or ")}; continuing without blocking.`,
  );
  return null;
}

function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    throw gateError(
      "determine the current branch",
      error,
      "verify that the workdir is a valid git repository and retry",
    );
  }
}

/**
 * Structured format: {"ts":"<ISO-8601>","branch":"<branch>"}. Plain ISO
 * stamps (obsolete format) are rejected with an explicit cause. Fail-closed.
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
          'obsolete format (plain ISO-8601): generate a new stamp with the format {"ts":"<ISO-8601>","branch":"<branch>"}',
      };
    }
    return { ok: false, reason: "invalid format: the content is not parseable JSON" };
  }
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "invalid format: the stamp must be a JSON object {ts, branch}" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ts !== "string" || !record.ts || Number.isNaN(Date.parse(record.ts))) {
    return { ok: false, reason: "invalid format: the \"ts\" field is missing or invalid (ISO-8601)" };
  }
  if (typeof record.branch !== "string" || !record.branch) {
    return { ok: false, reason: "invalid format: the \"branch\" field is missing or invalid" };
  }
  return { ok: true, payload: { ts: Date.parse(record.ts), branch: record.branch } };
}

/** Validates TTL and branch binding. Returns the rejection cause or null if valid. */
function stampIssue(
  payload: StampPayload,
  now: number,
  currentBranch: string,
  ttlMinutes: number,
): string | null {
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
        throw new Error(`unrecognized git diff output: ${summary}`);
      }
      lines = (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0);
    }
  } catch (error) {
    lastError = lastError ?? error;
  }
  if (lastError) {
    throw gateError("analyze diff", lastError, "verify the repository and retry");
  }
  return { lines, files: pendingFiles };
}

function buildGateMessage(stats: { lines: number; files: number }): string {
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

function buildStampBlockMessage(
  cause: string,
  stampPath: string,
  configPath: string,
  stats: { lines: number; files: number },
): string {
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
const resolveManagerLocation = (repoRoot: string) =>
    resolveWorktreeManagerLocation({ repoRoot, sessionDir, env: process.env });

  const managerDirectoryFor = (repoRoot: string): string | null => {
    const location = resolveManagerLocation(repoRoot);
    return location ? location.directory : null;
  };
  const missingCauseFor = (repoRoot: string): string =>
    missingManagerCause({ repoRoot, sessionDir, env: process.env });
  const worktreeConsumer = createWorktreeConsumerBridge({
    invokeEngram: createConfiguredEngramInvoker(sessionDir),
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    listLocalBranches: (repoRoot) => execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: repoRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean),
detectTransport: async ({ repoRoot }) => {
      const managerDirectory = managerDirectoryFor(repoRoot);
      if (!managerDirectory) {
        const cause = missingCauseFor(repoRoot);
        return { cli: { available: false, cause }, mcp: { available: false, cause } };
      }
      const cli = await createWorktreeCliClient({ managerDirectory }).detect();
      const mcp = await createWorktreeMcpClient({ managerDirectory }).detect();
      return {
        cli: { available: cli.available, cause: cli.cause },
        mcp: { available: mcp.available, cause: mcp.cause },
      };
    },
    invokeCli: async ({ repoRoot, request }) => {
      const managerDirectory = managerDirectoryFor(repoRoot);
      if (!managerDirectory) return { sent: false, cause: missingCauseFor(repoRoot) };
      return createWorktreeCliClient({ managerDirectory }).invoke(request);
    },
    invokeMcp: async ({ repoRoot, tool, request }) => {
      const managerDirectory = managerDirectoryFor(repoRoot);
      if (!managerDirectory) return { sent: false, cause: missingCauseFor(repoRoot) };
      return createWorktreeMcpClient({ managerDirectory }).invoke(tool, request);
    },
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
          commit_title: tool.schema.string().optional(), commit_body: tool.schema.string().optional(),
          merge_strategy: tool.schema.enum(["squash", "preserve-history"]).optional(),
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
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string; agent?: string },
      hookOutput: { args: any },
    ) => {
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
        if (!runnerToolAllowed(hookInput.tool, hookOutput?.args ?? {})) runnerBlocked();
      }

      // --- context budget: cheap pre-gate (runner, closed list, no tree walk) ---
      // Degradation by levels, level 1: the first broad request of the turn is
      // announced with the way to narrow it and is not executed. The same request
      // repeated in the turn is allowed and its delivery is reduced in the post-gate.
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
        // The bypass is only legitimate for trivial changes (≤ TRIVIAL_CHANGE_LINES).
        // If the diff cannot be measured (getDiffStats throws), the error propagates and the commit is blocked (deny-by-default).
        const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
        const stats = getDiffStats(workdir);
        if (stats.lines <= TRIVIAL_CHANGE_LINES) return; // trivial → legitimate bypass
        throw new Error(buildGateMessage(stats)); // non-trivial → bypass denied, review required
      }

      const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
      const config = readConfig(workdir, sessionDir);
      if (!config) return;
      if (!config.enabled) return;
      // Unified resolution: the relative stampPath is ALWAYS resolved against
      // the commit workdir (per-flow isolation: worktrees read/write their own stamps).
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
              "missing stamp",
              stampAbsolutePath,
              config.sourcePath,
              getDiffStats(workdir),
            ),
          );
        }
        throw gateError("read stamp", error, "verify permissions and retry");
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
      // Valid stamp: NOT consumed. Validity is governed by the TTL and branch
      // binding; a later failed commit does not require regenerating the stamp.
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
        // GAP-003: if it cannot be measured, never deliver silently without control:
        // it is observed with a trace and the delivery is marked as unmeasurable. An
        // integration smoke revalidates the mutation.
        console.warn(
          `[FlowTask Context Budget] could not measure ${budgetTool} output (session ${hookInput.sessionID}); delivering without budgeting.`,
        );
        hookOutput.metadata = { ...(hookOutput.metadata ?? {}), ...buildDegradationMetadata("measurement_unavailable") };
        return;
      }

      const budget = loadContextBudgetConfig(sessionDir || process.cwd(), sessionDir);
      const threshold =
        budgetTool === "read" ? budget.readThreshold : budgetTool === "grep" ? budget.grepThreshold : budget.globThreshold;
      const actual = hookOutput.output.length;

      // Image/PDF attachments: the short text lies about the real cost; the
      // runner receives no attachments (v1) and it is delegated to the Inspector.
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
