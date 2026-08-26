import type { PluginInput } from "@opencode-ai/plugin";
export default function (input: PluginInput): Promise<{
    "chat.message": (hookInput: {
        sessionID: string;
        agent?: string;
    }) => Promise<void>;
    "tool.execute.before": (hookInput: {
        tool: string;
        sessionID: string;
        callID: string;
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
