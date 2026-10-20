import path from "node:path";
import {
  buildToolRequest,
  normalizeEnvelope,
  READ_ONLY_OPERATIONS,
  statusForErrorCode,
  validateWorktreeRequest,
} from "./worktree-consumer-contract.js";

const REQUIRED = ["isDirectory", "listLocalBranches", "detectTransport", "invokeCli", "invokeMcp", "persistAssociation"];

/** The safe continuation the operator has to take after each failed phase. */
const NEXT_ACTION = Object.freeze({
  uncertain: "reconcile the operation before any retry",
  rejected: "resolve the reported cause and plan the request again",
  unavailable: "make a transport available and plan the request again",
});

/** Normalize the detection report published by the host of the consumer. */
function normalizeDetection(detected) {
  const read = (value) => {
    if (value === true) return { available: true, cause: undefined };
    if (!value) return { available: false, cause: "transport is unavailable" };
    if (typeof value === "object") return { available: value.available === true, cause: value.cause };
    return { available: false, cause: "transport is unavailable" };
  };
  return { mcp: read(detected?.mcp), cli: read(detected?.cli) };
}

export function createWorktreeConsumerAdapter(deps) {
  for (const key of REQUIRED) if (typeof deps?.[key] !== "function") throw new TypeError(`missing dependency: ${key}`);

  async function detect(repoRoot) {
    try {
      return normalizeDetection(await deps.detectTransport({ repoRoot }));
    } catch (error) {
      const cause = String(error?.message ?? error);
      return { mcp: { available: false, cause }, cli: { available: false, cause } };
    }
  }

  /**
   * Send one canonical request over one transport.
   *
   * The outcome is classified so that only a transport that never received
   * the request can be replaced: a rejection, a lost answer or an unknown
   * outcome are never retried over the other transport.
   */
  async function callTransport(transport, request, overrides) {
    const wire = buildToolRequest(request, overrides);
    try {
      const result = transport === "mcp"
        ? await deps.invokeMcp({ repoRoot: request.repo_root, tool: wire.tool, request: wire.args })
        : await deps.invokeCli({ repoRoot: request.repo_root, request: { operation: wire.tool, ...wire.args } });
      const envelope = normalizeEnvelope(result?.envelope);
      if (!envelope) {
        const sent = result?.sent !== false;
        return { status: sent ? "uncertain" : "unavailable", sent, cause: result?.cause ?? "transport returned no parseable envelope", wire };
      }
      return { status: envelope.accepted ? "accepted" : "rejected", sent: true, envelope, wire };
    } catch (error) {
      const sent = error?.sent !== false;
      return { status: sent ? "uncertain" : "unavailable", sent, cause: String(error?.message ?? error), wire };
    }
  }

  function summarize(transport, phase, attempt) {
    const entry = { transport, phase, outcome: attempt.status };
    if (attempt.cause) entry.cause = attempt.cause;
    if (attempt.envelope?.error?.code) entry.error_code = attempt.envelope.error.code;
    return entry;
  }

  /**
   * Run one operation over one transport.
   *
   * A mutation is planned first and executed afterwards with the planned
   * digest and transaction identifier, so the manager can reject a request
   * whose repository state changed in between. Read-only operations use a
   * single call, and a target-direct operation is never simulated because
   * the manager refuses a dry run for it.
   */
  async function runOperation(transport, request) {
    const attempts = [];
    const planOnly = request.dry_run === true;
    const single = request.target_direct === true || READ_ONLY_OPERATIONS.includes(request.operation);
    if (planOnly || single) {
      const attempt = await callTransport(transport, request, { dry_run: planOnly });
      attempts.push(summarize(transport, planOnly ? "preflight" : "execute", attempt));
      return { attempt, attempts };
    }
    const first = await callTransport(transport, request, { dry_run: true });
    attempts.push(summarize(transport, "preflight", first));
    if (first.status !== "accepted") return { attempt: first, attempts };

    const planHash = first.envelope?.data?.plan_hash;
    const transactionId = first.envelope?.data?.transaction_id ?? first.envelope?.transaction_id ?? undefined;
    const second = await callTransport(transport, request, { dry_run: false, plan_hash: planHash, transaction_id: transactionId });
    attempts.push(summarize(transport, "execute", second));
    return { attempt: second, attempts };
  }

  /** Transport precedence: an explicit choice, then the persisted one, then detection. */
  async function resolveTransport(request, persisted) {
    if (request.transport) return { primary: request.transport, source: "explicit", detection: null };
    if (persisted && (persisted.transport === "cli" || persisted.transport === "mcp")) {
      return { primary: persisted.transport, source: "persisted", detection: null };
    }
    const detection = await detect(request.repo_root);
    const primary = detection.mcp.available ? "mcp" : detection.cli.available ? "cli" : null;
    return { primary, source: "detected", detection };
  }

  async function resolveSecondary(request, primary, detection) {
    const other = primary === "mcp" ? "cli" : "mcp";
    const observed = detection ?? await detect(request.repo_root);
    return { secondary: observed[other].available ? other : null, detection: observed };
  }

  /**
   * Try the preferred transport and, only when it never received the request,
   * try the other one exactly once.
   */
  async function attemptWithFallback(request, selection) {
    const primary = selection.primary;
    if (!primary) {
      const detection = selection.detection ?? await detect(request.repo_root);
      return { attempt: null, attempts: [], transport: null, detection };
    }
    const first = await runOperation(primary, request);
    if (first.attempt.status !== "unavailable") return { ...first, transport: primary };
    const { secondary, detection } = await resolveSecondary(request, primary, selection.detection);
    if (!secondary) return { ...first, transport: primary, detection };
    const second = await runOperation(secondary, request);
    return {
      attempt: second.attempt,
      attempts: [...first.attempts, ...second.attempts],
      transport: secondary,
      fallback_reason: first.attempt.cause ?? "transport is unavailable",
      fallback_from: primary,
    };
  }

  return {
    async execute(input) {
      const request = validateWorktreeRequest(input, deps);
      const existing = request.work_id === undefined ? null : (await deps.findAssociation?.(request.work_id)) ?? null;
      if (existing) {
        if (existing.repo_root !== request.repo_root || existing.path !== request.path || existing.branch !== request.branch || existing.base_branch !== request.base) {
          return { status: "blocked", reason: "persisted worktree identity mismatch", operation: request.operation, work_id: request.work_id, repo_root: request.repo_root };
        }
        // A pending association records an intent that was never confirmed, so
        // the operation is planned again instead of being reported as done.
        if (request.operation === "create" && existing.state !== "pending") {
          const transport = request.transport ?? existing.transport ?? null;
          return { status: "success", ...existing, transport, effective_transport: transport, resumed: true };
        }
      }

      const selection = await resolveTransport(request, existing && existing.state !== "pending" ? existing : null);
      const identity = {
        operation: request.operation,
        work_id: request.work_id,
        repo_root: request.repo_root,
        path: request.path,
        branch: request.branch,
        base_branch: request.base,
        transport: selection.primary ?? undefined,
        effective_transport: selection.primary ?? undefined,
        transport_source: selection.source,
      };
      if (selection.detection) identity.detection = selection.detection;

      if (request.operation === "create") {
        const intendedAssociation = {
          repo_root: request.repo_root, path: request.path, branch: request.branch,
          base_branch: request.base, work_id: request.work_id,
          transport: selection.primary ?? null, state: "pending",
          init_submodules: request.init_submodules,
        };
        try { await deps.persistAssociation(intendedAssociation); }
        catch (error) {
          return { ...identity, status: "blocked", reason: "Engram could not durably register the intended worktree; no mutation attempted", error: String(error?.message ?? error) };
        }
      }

      const outcome = await attemptWithFallback(request, selection);
      const summary = {
        ...identity,
        transport: outcome.transport ?? selection.primary ?? undefined,
        effective_transport: outcome.transport ?? selection.primary ?? undefined,
        attempts: outcome.attempts,
      };
      if (outcome.detection) summary.detection = outcome.detection;
      if (outcome.fallback_reason) {
        summary.fallback_reason = outcome.fallback_reason;
        summary.fallback_from = outcome.fallback_from;
      }

      const attempt = outcome.attempt;
      if (!attempt) {
        return { ...summary, status: "blocked", reason: "no worktree transport is available", next_action: NEXT_ACTION.unavailable };
      }
      if (attempt.status === "unavailable") {
        return {
          ...summary,
          status: "blocked",
          reason: `worktree transport is unavailable: ${attempt.cause ?? "unknown cause"}`,
          next_action: NEXT_ACTION.unavailable,
        };
      }
      if (attempt.status === "uncertain") {
        return {
          ...summary,
          status: "uncertain",
          reason: "transport outcome is unknown; reconcile before retry",
          next_action: NEXT_ACTION.uncertain,
          error: attempt.cause,
        };
      }
      if (attempt.status === "rejected") {
        const error = attempt.envelope.error ?? {};
        return {
          ...summary,
          status: statusForErrorCode(error.code),
          reason: error.message,
          next_action: NEXT_ACTION.rejected,
          error,
        };
      }

      const envelope = attempt.envelope;
      const status = envelope.result === "no_pending_work" ? "no_pending_work" : "success";
      const result = {
        ...summary,
        status,
        result: envelope.result,
        tool: envelope.operation,
        repository: envelope.repository,
        data: envelope.data,
        warnings: envelope.warnings,
        transaction_id: envelope.transaction_id,
        plan_hash: envelope.data.plan_hash ?? request.plan_hash ?? undefined,
      };

      if (request.operation === "create" && status === "success") {
        const association = {
          repo_root: request.repo_root,
          path: result.data.path ? path.resolve(request.repo_root, result.data.path) : request.path,
          branch: result.data.branch ?? request.branch,
          base_branch: result.data.base_branch ?? request.base,
          work_id: request.work_id,
          transport: summary.effective_transport ?? null,
          init_submodules: request.init_submodules,
          init_submodules_result: result.data.init_submodules_result,
          state: "confirmed",
        };
        try { await deps.persistAssociation(association); }
        catch (error) {
          return { ...result, status: "blocked", effect_confirmed: true, association, reason: "worktree created but association persistence failed; preserve resources and reconcile before dispatch", error: String(error?.message ?? error) };
        }
        return { ...result, ...association };
      }
      return result;
    },

    async createAndDispatch(input, dispatch) {
      if (typeof dispatch !== "function") throw new TypeError("dispatch callback required");
      const result = await this.execute({ ...input, operation: "create" });
      if (result.status !== "success") return result;
      if (!result.resumed && !result.repo_root) return { ...result, status: "blocked", reason: "association was not confirmed" };
      return { ...result, dispatch_result: await dispatch({ ...result }) };
    },
  };
}
