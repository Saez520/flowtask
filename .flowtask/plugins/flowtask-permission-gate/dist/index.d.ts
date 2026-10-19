import type { PluginInput } from "@opencode-ai/plugin";
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
                }>;
                repo_root: import("zod").ZodString;
                path: import("zod").ZodOptional<import("zod").ZodString>;
                branch: import("zod").ZodOptional<import("zod").ZodString>;
                base_branch: import("zod").ZodString;
                work_id: import("zod").ZodString;
                init_submodules: import("zod").ZodOptional<import("zod").ZodBoolean>;
                preserve_dirty: import("zod").ZodOptional<import("zod").ZodBoolean>;
                discard: import("zod").ZodOptional<import("zod").ZodBoolean>;
                prepare: import("zod").ZodOptional<import("zod").ZodBoolean>;
                verify: import("zod").ZodOptional<import("zod").ZodBoolean>;
            };
            execute(args: {
                agent: string;
                operation: "prune" | "list" | "recover" | "create" | "complete" | "cleanup";
                repo_root: string;
                base_branch: string;
                work_id: string;
                path?: string | undefined;
                branch?: string | undefined;
                init_submodules?: boolean | undefined;
                preserve_dirty?: boolean | undefined;
                discard?: boolean | undefined;
                prepare?: boolean | undefined;
                verify?: boolean | undefined;
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
