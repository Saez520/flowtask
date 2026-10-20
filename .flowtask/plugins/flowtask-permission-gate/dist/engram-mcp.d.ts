import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { EngramInvoker } from "./worktree-consumer-bridge.js";
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
export declare function openStdioMcpSession(options: StdioMcpSessionOptions): Promise<{
    client: Client;
    close: () => Promise<void>;
    requestTimeoutMs: number;
}>;
/** Run one exchange over a stdio MCP session and always close it. */
export declare function withStdioMcpSession<T>(options: StdioMcpSessionOptions, run: (client: Client) => Promise<T>): Promise<T>;
/** Connects to the Engram MCP server declared by the active OpenCode config. */
export declare function createConfiguredEngramInvoker(configDirectory: string): EngramInvoker;
