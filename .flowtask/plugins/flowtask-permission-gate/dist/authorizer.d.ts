export declare const RUNNER_DELEGATION_MESSAGE = "Remember that you must delegate this operation to the corresponding subagent.";
export declare const WORKTREE_MANAGER_MCP_SERVER = "worktree_manager";
export declare const WORKTREE_MANAGER_MCP_TOOLS: readonly ["worktree_create", "worktree_complete", "worktree_cleanup", "worktree_recover", "worktree_list", "worktree_prune", "worktree_status"];
/** The runner may invoke exactly the seven capabilities the manager publishes. */
export declare function isWorktreeManagerMcpTool(tool: unknown): boolean;
export declare const FLOWTASK_SUBAGENTS: Set<string>;
/** V2 `subagent` resources the runner may select; the runner itself is never a child. */
export declare function isAuthorizedRunnerSubagent(agent: unknown): boolean;
/** Tokenize the small shell grammar used by FlowTask commands. */
export declare function tokenizeCommand(command: string): string[] | null;
/**
 * True only for a single, exact authority command. Any compound, redirect, or
 * unknown token makes the command ineligible for the layer bypass.
 */
export declare function isAuthorityCommand(command: string): boolean;
export declare function isAuthorizedRunnerCommand(command: string): boolean;
