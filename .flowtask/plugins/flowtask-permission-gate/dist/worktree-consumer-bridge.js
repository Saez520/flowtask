import { createWorktreeConsumerAdapter } from "../../../bin/lib/worktree-consumer-adapter.js";
export const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
const ENGRAM_METHODS = new Set(["mem_search", "mem_get_observation", "mem_save"]);
function resultText(result) {
    if (typeof result === "string")
        return result;
    if (typeof result?.output === "string")
        return result.output;
    if (Array.isArray(result?.content))
        return result.content.map((part) => part?.text ?? "").join("\n");
    throw new Error("Engram response is unreadable");
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
        invokeCli: deps.invokeManager,
        invokeMcp: deps.invokeManager,
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
            return adapter.createAndDispatch({ ...input, transport: "cli" }, async (record) => {
                const constructor = await deps.dispatchConstructor(record);
                const validator = await deps.dispatchValidator(record);
                return { constructor, validator };
            });
        },
    };
}
