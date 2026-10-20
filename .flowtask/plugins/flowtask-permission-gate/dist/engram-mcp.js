import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
/**
 * Open a stdio MCP session. The caller owns the returned handle and must close
 * it; a failure while connecting means the server never received a request.
 */
export async function openStdioMcpSession(options) {
    const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter((entry) => typeof entry[1] === "string"));
    const transport = new StdioClientTransport({
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        env,
    });
    const client = new Client({ name: options.clientName ?? "flowtask-permission-gate", version: options.clientVersion ?? "1.0.1" }, { capabilities: {} });
    await client.connect(transport);
    const requestTimeoutMs = options.requestTimeoutMs ?? 60000;
    return { client, close: async () => { await client.close(); }, requestTimeoutMs };
}
/** Run one exchange over a stdio MCP session and always close it. */
export async function withStdioMcpSession(options, run) {
    const session = await openStdioMcpSession(options);
    try {
        return await run(session.client);
    }
    finally {
        await session.close();
    }
}
/** Connects to the Engram MCP server declared by the active OpenCode config. */
export function createConfiguredEngramInvoker(configDirectory) {
    return async (tool, args) => {
        if (!["mem_search", "mem_get_observation", "mem_save"].includes(tool))
            throw new Error("Engram method is not allowed");
        const configPath = resolve(configDirectory, "opencode.json");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        const server = config.mcp?.engram;
        if (!server || server.enabled === false || server.type !== "local" || !Array.isArray(server.command) || !server.command.length) {
            throw new Error("Engram MCP local server is not configured");
        }
        const [command, ...commandArgs] = server.command;
        return await withStdioMcpSession({ command, args: commandArgs, cwd: configDirectory, env: server.environment, clientName: "flowtask-permission-gate" }, async (client) => await client.callTool({ name: tool, arguments: args }));
    };
}
