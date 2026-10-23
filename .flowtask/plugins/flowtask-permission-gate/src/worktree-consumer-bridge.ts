import { createWorktreeConsumerAdapter } from "../../../bin/lib/worktree-consumer-adapter.js";

export const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
const ENGRAM_METHODS = new Set(["mem_search", "mem_get_observation", "mem_save"]);

export type EngramInvoker = (tool: "mem_search" | "mem_get_observation" | "mem_save", args: Record<string, unknown>) => Promise<unknown>;

/** Availability of one transport, as observed by a read-only detection. */
export type TransportAvailability = {
  available: boolean;
  cause?: string;
};

/** Report published by the read-only detection of the available transports. */
export type TransportDetection = {
  mcp?: boolean | TransportAvailability;
  cli?: boolean | TransportAvailability;
};

/** Outcome of one transport call. `sent` tells whether the request was delivered. */
export type TransportOutcome = {
  envelope?: unknown;
  sent?: boolean;
  cause?: string;
};

export type WorktreeBridgeDependencies = {
  invokeEngram: EngramInvoker;
  isDirectory(path: string): boolean;
  listLocalBranches(repoRoot: string): string[];
  detectTransport(input: { repoRoot: string }): Promise<TransportDetection>;
  invokeCli(input: { repoRoot: string; request: Record<string, unknown> }): Promise<TransportOutcome>;
  invokeMcp(input: { repoRoot: string; tool: string; request: Record<string, unknown> }): Promise<TransportOutcome>;
  dispatchConstructor(record: Record<string, unknown>): Promise<unknown>;
  dispatchValidator(record: Record<string, unknown>): Promise<unknown>;
};

/** Fields of the canonical request the bridge forwards to the consumer. */
const REQUEST_FIELDS = [
  "operation", "transport", "repo_root", "work_id", "base", "worktrees_dir", "branch_prefix",
  "confirm", "authorization", "transaction_id", "plan_hash", "dry_run", "target_direct",
  "parent_repo", "submodule_path", "discard_consent", "discard", "init_submodules",
  "prepare", "verify", "preserve_dirty", "commit_title", "commit_body",
] as const;

function resultText(result: any): string {
  if (typeof result === "string") return result;
  if (typeof result?.output === "string") return result.output;
  if (Array.isArray(result?.content)) return result.content.map((part: any) => part?.text ?? "").join("\n");
  throw new Error("Engram response is unreadable");
}

/**
 * Keep only the canonical request fields. The tool arguments also carry the
 * caller identity and derived paths, and none of them reaches the manager.
 */
function sanitize(input: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  for (const field of REQUEST_FIELDS) {
    if (input?.[field] !== undefined) request[field] = input[field];
  }
  if (request.base === undefined && typeof input?.base_branch === "string") request.base = input.base_branch;
  if (request.operation === undefined) request.operation = "create";
  return request;
}

export function createWorktreeConsumerBridge(deps: WorktreeBridgeDependencies) {
  if (!deps || typeof deps.invokeEngram !== "function") throw new TypeError("Engram invoker required");
  const callEngram = async (tool: string, args: Record<string, unknown>) => {
    if (!ENGRAM_METHODS.has(tool)) throw new Error("Engram method is not allowed");
    return deps.invokeEngram(tool as "mem_search" | "mem_get_observation" | "mem_save", args);
  };

  const adapter = createWorktreeConsumerAdapter({
    isDirectory: deps.isDirectory,
    listLocalBranches: deps.listLocalBranches,
    detectTransport: deps.detectTransport,
    invokeCli: deps.invokeCli,
    invokeMcp: deps.invokeMcp,
    async findAssociation(workId: string) {
      const preview = await callEngram("mem_search", { query: workId, scope: "project", limit: 10 });
      const text = resultText(preview);
      if (/truncat|more results/i.test(text)) throw new Error("Engram association search is truncated");
      const match = text.match(/#(\d+)/);
      if (!match) return null;
      const full = resultText(await callEngram("mem_get_observation", { id: Number(match[1]) }));
      let parsed: any;
      try { parsed = JSON.parse(full); } catch { throw new Error("Engram association payload is unreadable"); }
      if (!parsed || typeof parsed !== "object" || parsed.work_id !== workId) throw new Error("Engram association identity mismatch");
      return parsed;
    },
    async persistAssociation(record: Record<string, unknown>) {
      const saved = await callEngram("mem_save", {
        type: "decision", scope: "project", topic_key: `worktree/association/${record.work_id}`,
        title: `Worktree association ${record.work_id}`, content: JSON.stringify(record),
      });
      resultText(saved);
    },
  });

  return {
    async execute(input: Record<string, unknown>) {
      const request = sanitize(input);
      if (request.operation !== "create") return adapter.execute(request);
      return adapter.createAndDispatch(request, async (record: Record<string, unknown>) => {
        const constructor = await deps.dispatchConstructor(record);
        const validator = await deps.dispatchValidator(record);
        return { constructor, validator };
      });
    },
  };
}
