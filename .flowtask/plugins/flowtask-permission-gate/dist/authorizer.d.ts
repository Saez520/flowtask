export declare const RUNNER_DELEGATION_MESSAGE = "Record\u00E1 que deb\u00E9s delegar esta operaci\u00F3n al subagente correspondiente.";
/** Tokenize the small shell grammar used by FlowTask commands. */
export declare function tokenizeCommand(command: string): string[] | null;
export declare function isAuthorizedRunnerCommand(command: string): boolean;
