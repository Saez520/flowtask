import path from "node:path";
import { normalizeWorktreeResult, validateWorktreeRequest } from "./worktree-consumer-contract.js";

const REQUIRED = ["isDirectory", "listLocalBranches", "invokeCli", "invokeMcp", "persistAssociation"];

export function createWorktreeConsumerAdapter(deps) {
  for (const key of REQUIRED) if (typeof deps?.[key] !== "function") throw new TypeError(`missing dependency: ${key}`);

  async function invoke(request, args) {
    return request.transport === "cli"
      ? deps.invokeCli({ repoRoot: request.repo_root, args })
      : deps.invokeMcp({ repoRoot: request.repo_root, tool: "worktree_manager", args });
  }

  return {
    async execute(input) {
      const request = validateWorktreeRequest(input, deps);
      if (!(["create", "complete", "cleanup", "recover", "list", "prune"].includes(input.operation))) throw new TypeError("unsupported operation");
      const existing = await deps.findAssociation?.(request.work_id);
      if (existing) {
        if (existing.repo_root !== request.repo_root || existing.path !== request.path || existing.branch !== request.branch || existing.base_branch !== request.base) return { status: "blocked", reason: "persisted worktree identity mismatch", transport: request.transport };
        if (input.operation === "create") return { status: "success", ...existing, transport: request.transport, resumed: true };
      }
      const intendedAssociation = {
        repo_root: request.repo_root, path: request.path, branch: request.branch,
        base_branch: request.base, work_id: request.work_id,
        transport: request.transport, state: "pending",
        init_submodules: request.init_submodules,
      };
      if (input.operation === "create") {
        try { await deps.persistAssociation(intendedAssociation); }
        catch (error) {
          return { status: "blocked", reason: "Engram could not durably register the intended worktree; no mutation attempted", error: String(error?.message ?? error), transport: request.transport };
        }
      }
      const args = [input.operation, request.work_id, "--base", request.base];
      if (request.init_submodules) args.push("--init-submodules");
      if (request.preserve_dirty) args.push("--preserve-dirty");
      if (request.discard) args.push("--discard");
      if (request.prepare) args.push("--prepare");
      if (request.verify) args.push("--verify");
      let raw;
      try { raw = await invoke(request, args); }
      catch (error) { return { status: "uncertain", reason: "transport outcome is unknown; reconcile before retry", error: String(error?.message ?? error), work_id: request.work_id, path: request.path, branch: request.branch, transport: request.transport }; }
      const result = normalizeWorktreeResult({ request, response: raw, transactionId: raw?.transaction_id });
      if (result.status === "uncertain") return { ...result, reason: "transport outcome is unknown; reconcile before retry" };
      if (result.status === "success" && input.operation === "create") {
        const association = { repo_root: request.repo_root, path: result.path ? path.resolve(request.repo_root, result.path) : request.path, branch: result.branch ?? request.branch, base_branch: result.base_branch ?? request.base, work_id: request.work_id, transport: request.transport, init_submodules: request.init_submodules, init_submodules_result: result.raw_fields?.init_submodules_result };
        try { await deps.persistAssociation({ ...association, state: "confirmed" }); }
        catch (error) { return { status: "blocked", effect_confirmed: true, association, reason: "worktree created but association persistence failed; preserve resources and reconcile before dispatch", error: String(error?.message ?? error), transport: request.transport }; }
        return { ...result, ...association };
      }
      return result;
    },

    async createAndDispatch(input, dispatch) {
      if (typeof dispatch !== "function") throw new TypeError("dispatch callback required");
      const result = await this.execute({ ...input, operation: "create" });
      if (result.status !== "success") return result;
      if (!result.resumed && !result.repo_root) return { status: "blocked", reason: "association was not confirmed", transport: input.transport };
      return { ...result, dispatch_result: await dispatch({ ...result }) };
    },
  };
}
