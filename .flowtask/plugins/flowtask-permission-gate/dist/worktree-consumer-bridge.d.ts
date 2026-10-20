export declare const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
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
    detectTransport(input: {
        repoRoot: string;
    }): Promise<TransportDetection>;
    invokeCli(input: {
        repoRoot: string;
        request: Record<string, unknown>;
    }): Promise<TransportOutcome>;
    invokeMcp(input: {
        repoRoot: string;
        tool: string;
        request: Record<string, unknown>;
    }): Promise<TransportOutcome>;
    dispatchConstructor(record: Record<string, unknown>): Promise<unknown>;
    dispatchValidator(record: Record<string, unknown>): Promise<unknown>;
};
export declare function createWorktreeConsumerBridge(deps: WorktreeBridgeDependencies): {
    execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};
