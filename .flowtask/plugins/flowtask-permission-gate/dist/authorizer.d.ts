export declare const RUNNER_DELEGATION_MESSAGE = "Record\u00E1 que deb\u00E9s delegar esta operaci\u00F3n al subagente correspondiente.";
export declare const FLOWTASK_SUBAGENTS: Set<string>;
/** V2 `subagent` resources the runner may select; the runner itself is never a child. */
export declare function isAuthorizedRunnerSubagent(agent: unknown): boolean;
/** Tokenize the small shell grammar used by FlowTask commands. */
export declare function tokenizeCommand(command: string): string[] | null;
export declare function isAuthorizedRunnerCommand(command: string): boolean;
