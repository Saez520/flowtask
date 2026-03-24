declare const _default: ({ client }: import("@opencode-ai/plugin").PluginInput) => Promise<{
    "chat.message": (input: {
        sessionID: string;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        messageID?: string;
        variant?: string;
    }, output: {
        message: import("@opencode-ai/sdk").UserMessage;
        parts: import("@opencode-ai/sdk").Part[];
    }) => Promise<void>;
    "experimental.chat.messages.transform": (input: {}, output: {
        messages: {
            info: import("@opencode-ai/sdk").Message;
            parts: import("@opencode-ai/sdk").Part[];
        }[];
    }) => Promise<void>;
}>;
export default _default;
