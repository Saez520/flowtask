/** The real tools published by the worktree manager server. */
export declare const WORKTREE_MANAGER_TOOLS: readonly ["worktree_create", "worktree_complete", "worktree_cleanup", "worktree_recover", "worktree_list", "worktree_prune", "worktree_status"];
/** Options of the client of the standalone worktree manager. */
export type WorktreeMcpOptions = {
    /** Directory of the standalone checkout; it holds the `worktree_manager` package. */
    managerDirectory: string;
    /** Interpreter used to start the server. */
    python?: string;
    /** Upper bound for one request, in milliseconds. */
    requestTimeoutMs?: number;
};
export type WorktreeMcpDetection = {
    available: boolean;
    tools: string[];
    cause?: string;
};
export type WorktreeMcpOutcome = {
    envelope?: unknown;
    sent?: boolean;
    cause?: string;
};
/**
 * Client of the standalone worktree manager.
 *
 * The server is started over stdio with the standalone checkout on the Python
 * path, so the consumer never imports the manager in process and never
 * exposes its tools to the assistant.
 */
export declare function createWorktreeMcpClient(options: WorktreeMcpOptions): {
    /** Read-only detection: the server is started and its tools are listed. */
    detect(): Promise<WorktreeMcpDetection>;
    /** Invoke one real tool and return the published envelope. */
    invoke(tool: string, args: Record<string, unknown>): Promise<WorktreeMcpOutcome>;
};
