import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { EngramInvoker } from "./worktree-consumer-bridge.js";

type ServerConfig = { type?: string; command?: string[]; enabled?: boolean; environment?: Record<string, string> };

/** Options of a stdio MCP session with a locally started server. */
export type StdioMcpSessionOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
};

/**
 * Open a stdio MCP session. The caller owns the returned handle and must close
 * it; a failure while connecting means the server never received a request.
 */
export async function openStdioMcpSession(options: StdioMcpSessionOptions): Promise<{ client: Client; close: () => Promise<void>; requestTimeoutMs: number }> {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env,
  });
  const client = new Client(
    { name: options.clientName ?? "flowtask-permission-gate", version: options.clientVersion ?? "1.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  const requestTimeoutMs = options.requestTimeoutMs ?? 60000;
  return { client, close: async () => { await client.close(); }, requestTimeoutMs };
}

/** Run one exchange over a stdio MCP session and always close it. */
export async function withStdioMcpSession<T>(options: StdioMcpSessionOptions, run: (client: Client) => Promise<T>): Promise<T> {
  const session = await openStdioMcpSession(options);
  try {
    return await run(session.client);
  } finally {
    await session.close();
  }
}

/** Connects to the Engram MCP server declared by the active OpenCode config. */
export function createConfiguredEngramInvoker(configDirectory: string): EngramInvoker {
  return async (tool, args) => {
    if (!["mem_search", "mem_get_observation", "mem_save"].includes(tool)) throw new Error("Engram method is not allowed");
    const configPath = resolve(configDirectory, "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { mcp?: Record<string, ServerConfig> };
    const server = config.mcp?.engram;
    if (!server || server.enabled === false || server.type !== "local" || !Array.isArray(server.command) || !server.command.length) {
      throw new Error("Engram MCP local server is not configured");
    }
    const [command, ...commandArgs] = server.command;
    return await withStdioMcpSession(
      { command, args: commandArgs, cwd: configDirectory, env: server.environment, clientName: "flowtask-permission-gate" },
      async (client) => await client.callTool({ name: tool, arguments: args }),
    );
  };
}
