import { createWorktreeConsumerAdapter } from "../../../bin/lib/worktree-consumer-adapter.js";

export const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
const ENGRAM_METHODS = new Set(["mem_search", "mem_get_observation", "mem_save"]);

export type EngramInvoker = (tool: "mem_search" | "mem_get_observation" | "mem_save", args: Record<string, unknown>) => Promise<unknown>;

export type WorktreeBridgeDependencies = {
  invokeEngram: EngramInvoker;
  isDirectory(path: string): boolean;
  listLocalBranches(repoRoot: string): string[];
  invokeManager(input: { repoRoot: string; args: string[] }): Promise<unknown>;
  dispatchConstructor(record: Record<string, unknown>): Promise<unknown>;
  dispatchValidator(record: Record<string, unknown>): Promise<unknown>;
};

function resultText(result: any): string {
  if (typeof result === "string") return result;
  if (typeof result?.output === "string") return result.output;
  if (Array.isArray(result?.content)) return result.content.map((part: any) => part?.text ?? "").join("\n");
  throw new Error("Engram response is unreadable");
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
    invokeCli: deps.invokeManager,
    invokeMcp: deps.invokeManager,
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
      return adapter.createAndDispatch({ ...input, transport: "cli" }, async (record: Record<string, unknown>) => {
        const constructor = await deps.dispatchConstructor(record);
        const validator = await deps.dispatchValidator(record);
        return { constructor, validator };
      });
    },
  };
}
