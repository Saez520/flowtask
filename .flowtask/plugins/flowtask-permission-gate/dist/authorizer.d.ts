export declare const RUNNER_DELEGATION_MESSAGE = "Remember that you must delegate this operation to the corresponding subagent.";
export declare const WORKTREE_CONSUMER_TOOL = "flowtask_worktree_consume";
/** The worktree bridge is available only to the exact FlowTask runner identity. */
export declare function isAuthorizedWorktreeConsumer(agent: unknown, tool: unknown): boolean;
export declare const FLOWTASK_SUBAGENTS: Set<string>;
/** V2 `subagent` resources the runner may select; the runner itself is never a child. */
export declare function isAuthorizedRunnerSubagent(agent: unknown): boolean;
/** Tokenize the small shell grammar used by FlowTask commands. */
export declare function tokenizeCommand(command: string): string[] | null;
export declare function isAuthorizedRunnerCommand(command: string): boolean;
