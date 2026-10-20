import { createWorktreeConsumerAdapter } from "../../../bin/lib/worktree-consumer-adapter.js";
export const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
const ENGRAM_METHODS = new Set(["mem_search", "mem_get_observation", "mem_save"]);
/** Fields of the canonical request the bridge forwards to the consumer. */
const REQUEST_FIELDS = [
    "operation", "transport", "repo_root", "work_id", "base", "worktrees_dir", "branch_prefix",
    "confirm", "authorization", "transaction_id", "plan_hash", "dry_run", "target_direct",
    "parent_repo", "submodule_path", "discard_consent", "discard", "init_submodules",
    "prepare", "verify", "preserve_dirty",
];
function resultText(result) {
    if (typeof result === "string")
        return result;
    if (typeof result?.output === "string")
        return result.output;
    if (Array.isArray(result?.content))
        return result.content.map((part) => part?.text ?? "").join("\n");
    throw new Error("Engram response is unreadable");
}
/**
 * Keep only the canonical request fields. The tool arguments also carry the
 * caller identity and derived paths, and none of them reaches the manager.
 */
function sanitize(input) {
    const request = {};
    for (const field of REQUEST_FIELDS) {
        if (input?.[field] !== undefined)
            request[field] = input[field];
    }
    if (request.base === undefined && typeof input?.base_branch === "string")
        request.base = input.base_branch;
    if (request.operation === undefined)
        request.operation = "create";
    return request;
}
export function createWorktreeConsumerBridge(deps) {
    if (!deps || typeof deps.invokeEngram !== "function")
        throw new TypeError("Engram invoker required");
    const callEngram = async (tool, args) => {
        if (!ENGRAM_METHODS.has(tool))
            throw new Error("Engram method is not allowed");
        return deps.invokeEngram(tool, args);
    };
    const adapter = createWorktreeConsumerAdapter({
        isDirectory: deps.isDirectory,
        listLocalBranches: deps.listLocalBranches,
        detectTransport: deps.detectTransport,
        invokeCli: deps.invokeCli,
        invokeMcp: deps.invokeMcp,
        async findAssociation(workId) {
            const preview = await callEngram("mem_search", { query: workId, scope: "project", limit: 10 });
            const text = resultText(preview);
            if (/truncat|more results/i.test(text))
                throw new Error("Engram association search is truncated");
            const match = text.match(/#(\d+)/);
            if (!match)
                return null;
            const full = resultText(await callEngram("mem_get_observation", { id: Number(match[1]) }));
            let parsed;
            try {
                parsed = JSON.parse(full);
            }
            catch {
                throw new Error("Engram association payload is unreadable");
            }
            if (!parsed || typeof parsed !== "object" || parsed.work_id !== workId)
                throw new Error("Engram association identity mismatch");
            return parsed;
        },
        async persistAssociation(record) {
            const saved = await callEngram("mem_save", {
                type: "decision", scope: "project", topic_key: `worktree/association/${record.work_id}`,
                title: `Worktree association ${record.work_id}`, content: JSON.stringify(record),
            });
            resultText(saved);
        },
    });
    return {
        async execute(input) {
            const request = sanitize(input);
            if (request.operation !== "create")
                return adapter.execute(request);
            return adapter.createAndDispatch(request, async (record) => {
                const constructor = await deps.dispatchConstructor(record);
                const validator = await deps.dispatchValidator(record);
                return { constructor, validator };
            });
        },
    };
}
