import type { PluginInput } from "@opencode-ai/plugin";
export type WorktreeCliOutcome = {
    envelope?: unknown;
    sent?: boolean;
    cause?: string;
};
export type WorktreeCliClient = {
    detect(): Promise<{
        available: boolean;
        cause?: string;
    }>;
    invoke(request: Record<string, unknown>): Promise<WorktreeCliOutcome>;
};
/**
 * Client of the worktree manager command line.
 *
 * The request travels as one canonical document over `--request-json`; the
 * legacy argument form is never used, and the manager always answers with the
 * same envelope, accepted or rejected.
 */
export declare function createWorktreeCliClient(options: {
    managerDirectory: string;
    python?: string;
    timeoutMs?: number;
}): WorktreeCliClient;
export default function (input: PluginInput): any;
