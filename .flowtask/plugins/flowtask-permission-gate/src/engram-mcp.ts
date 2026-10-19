import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { EngramInvoker } from "./worktree-consumer-bridge.js";

type ServerConfig = { type?: string; command?: string[]; enabled?: boolean; environment?: Record<string, string> };

/** Connects to the Engram MCP server declared by the active OpenCode config. */
export function createConfiguredEngramInvoker(configDirectory: string): EngramInvoker {
  return async (tool, args) => {
    if (!["mem_search", "mem_get_observation", "mem_save"].includes(tool)) throw new Error("Engram method is not allowed");
    let client: Client | undefined;
    try {
        const configPath = resolve(configDirectory, "opencode.json");
        const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcp?: Record<string, ServerConfig> };
        const server = config.mcp?.engram;
        if (!server || server.enabled === false || server.type !== "local" || !Array.isArray(server.command) || !server.command.length) {
          throw new Error("Engram MCP local server is not configured");
        }
        const [command, ...commandArgs] = server.command;
        const env = Object.fromEntries(Object.entries({ ...process.env, ...server.environment }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const transport = new StdioClientTransport({
          command,
          args: commandArgs,
          cwd: configDirectory,
          env,
        });
        client = new Client({ name: "flowtask-permission-gate", version: "1.0.1" });
        await client.connect(transport);
        return await client.callTool({ name: tool, arguments: args });
    } finally {
      await client?.close();
    }
  };
}
