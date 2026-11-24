export declare const RUNNER_EXECUTE_TOOL = "execute";
/**
 * Authorizes an `execute` script only when every `tools` access is one of the
 * two contiguous literal segments followed immediately by `(`, and the resolved
 * MCP name belongs to the runner surface. Any forbidden identifier, unresolved
 * reference, or missing invocation rejects the whole script: nothing is
 * rewritten and no part of it runs.
 */
export declare function isAuthorizedRunnerScript(script: unknown): boolean;
