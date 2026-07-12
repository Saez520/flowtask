declare const _default: ({ client }: import("@opencode-ai/plugin").PluginInput) => Promise<{
    "experimental.chat.messages.transform": (input: {}, output: {
        messages: {
            info: import("@opencode-ai/sdk").Message;
            parts: import("@opencode-ai/sdk").Part[];
        }[];
    }) => Promise<void>;
}>;
export default _default;
