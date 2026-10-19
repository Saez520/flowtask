export declare const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
export type EngramInvoker = (tool: "mem_search" | "mem_get_observation" | "mem_save", args: Record<string, unknown>) => Promise<unknown>;
export type WorktreeBridgeDependencies = {
    invokeEngram: EngramInvoker;
    isDirectory(path: string): boolean;
    listLocalBranches(repoRoot: string): string[];
    invokeManager(input: {
        repoRoot: string;
        args: string[];
    }): Promise<unknown>;
    dispatchConstructor(record: Record<string, unknown>): Promise<unknown>;
    dispatchValidator(record: Record<string, unknown>): Promise<unknown>;
};
export declare function createWorktreeConsumerBridge(deps: WorktreeBridgeDependencies): {
    execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
