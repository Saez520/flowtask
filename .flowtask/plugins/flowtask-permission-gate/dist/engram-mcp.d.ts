import type { EngramInvoker } from "./worktree-consumer-bridge.js";
/** Connects to the Engram MCP server declared by the active OpenCode config. */
export declare function createConfiguredEngramInvoker(configDirectory: string): EngramInvoker;
