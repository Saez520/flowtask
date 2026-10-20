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
export default function (input: PluginInput): Promise<{
    tool: {
        flowtask_worktree_consume: {
            description: string;
            args: {
                agent: import("zod").ZodString;
                operation: import("zod").ZodEnum<{
                    prune: "prune";
                    list: "list";
                    recover: "recover";
                    create: "create";
                    complete: "complete";
                    cleanup: "cleanup";
                    status: "status";
                }>;
                transport: import("zod").ZodOptional<import("zod").ZodEnum<{
                    mcp: "mcp";
                    cli: "cli";
                }>>;
                repo_root: import("zod").ZodString;
                path: import("zod").ZodOptional<import("zod").ZodString>;
                branch: import("zod").ZodOptional<import("zod").ZodString>;
                base_branch: import("zod").ZodOptional<import("zod").ZodString>;
                work_id: import("zod").ZodOptional<import("zod").ZodString>;
                init_submodules: import("zod").ZodOptional<import("zod").ZodBoolean>;
                preserve_dirty: import("zod").ZodOptional<import("zod").ZodBoolean>;
                discard: import("zod").ZodOptional<import("zod").ZodBoolean>;
                discard_consent: import("zod").ZodOptional<import("zod").ZodBoolean>;
                prepare: import("zod").ZodOptional<import("zod").ZodBoolean>;
                verify: import("zod").ZodOptional<import("zod").ZodBoolean>;
                confirm: import("zod").ZodOptional<import("zod").ZodBoolean>;
                transaction_id: import("zod").ZodOptional<import("zod").ZodString>;
                plan_hash: import("zod").ZodOptional<import("zod").ZodString>;
                dry_run: import("zod").ZodOptional<import("zod").ZodBoolean>;
                target_direct: import("zod").ZodOptional<import("zod").ZodBoolean>;
                parent_repo: import("zod").ZodOptional<import("zod").ZodString>;
                submodule_path: import("zod").ZodOptional<import("zod").ZodString>;
            };
            execute(args: {
                agent: string;
                operation: "prune" | "list" | "recover" | "create" | "complete" | "cleanup" | "status";
                repo_root: string;
                transport?: "mcp" | "cli" | undefined;
                path?: string | undefined;
                branch?: string | undefined;
                base_branch?: string | undefined;
                work_id?: string | undefined;
                init_submodules?: boolean | undefined;
                preserve_dirty?: boolean | undefined;
                discard?: boolean | undefined;
                discard_consent?: boolean | undefined;
                prepare?: boolean | undefined;
                verify?: boolean | undefined;
                confirm?: boolean | undefined;
                transaction_id?: string | undefined;
                plan_hash?: string | undefined;
                dry_run?: boolean | undefined;
                target_direct?: boolean | undefined;
                parent_repo?: string | undefined;
                submodule_path?: string | undefined;
            }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
        };
    };
    "chat.message": (hookInput: {
        sessionID: string;
        agent?: string;
    }) => Promise<void>;
    "tool.execute.before": (hookInput: {
        tool: string;
        sessionID: string;
        callID: string;
        agent?: string;
    }, hookOutput: {
        args: any;
    }) => Promise<void>;
    "tool.execute.after": (hookInput: {
        tool: string;
        sessionID: string;
        callID: string;
    }, hookOutput: {
        title?: string;
        output?: unknown;
        metadata?: Record<string, unknown>;
    }) => Promise<void>;
    dispose: () => Promise<void>;
}>;
