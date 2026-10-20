import { openStdioMcpSession, withStdioMcpSession } from "./engram-mcp.js";

/** The real tools published by the worktree manager server. */
export const WORKTREE_MANAGER_TOOLS = [
  "worktree_create",
  "worktree_complete",
  "worktree_cleanup",
  "worktree_recover",
  "worktree_list",
  "worktree_prune",
  "worktree_status",
] as const;

/** Options of the client of the standalone worktree manager. */
export type WorktreeMcpOptions = {
  /** Directory of the standalone checkout; it holds the `worktree_manager` package. */
  managerDirectory: string;
  /** Interpreter used to start the server. */
  python?: string;
  /** Upper bound for one request, in milliseconds. */
  requestTimeoutMs?: number;
};

export type WorktreeMcpDetection = {
  available: boolean;
  tools: string[];
  cause?: string;
};

export type WorktreeMcpOutcome = {
  envelope?: unknown;
  sent?: boolean;
  cause?: string;
};

function envelopeFrom(result: unknown): unknown {
  const structured = (result as { structuredContent?: unknown })?.structuredContent;
  if (structured && typeof structured === "object") return structured;
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content) && typeof (content[0] as { text?: unknown })?.text === "string") {
    try { return JSON.parse((content[0] as { text: string }).text); } catch { return null; }
  }
  return null;
}

/**
 * Client of the standalone worktree manager.
 *
 * The server is started over stdio with the standalone checkout on the Python
 * path, so the consumer never imports the manager in process and never
 * exposes its tools to the assistant.
 */
export function createWorktreeMcpClient(options: WorktreeMcpOptions) {
  if (!options?.managerDirectory) throw new TypeError("manager directory required");
  const python = options.python ?? "python3";
  const managerDirectory = options.managerDirectory;
  const env = {
    PYTHONPATH: [managerDirectory, process.env.PYTHONPATH].filter(Boolean).join(":"),
  };
  const session = {
    command: python,
    args: ["-m", "worktree_manager.mcp_transport"],
    cwd: managerDirectory,
    env,
    clientName: "flowtask-worktree-consumer",
    requestTimeoutMs: options.requestTimeoutMs ?? 60000,
  };

  return {
    /** Read-only detection: the server is started and its tools are listed. */
    async detect(): Promise<WorktreeMcpDetection> {
      let tools: string[];
      try {
        tools = await withStdioMcpSession(session, async (client) => {
          const listed = await client.listTools({}, { timeout: session.requestTimeoutMs });
          return listed.tools.map((tool) => tool.name);
        });
      } catch (error) {
        return { available: false, tools: [], cause: String((error as Error)?.message ?? error) };
      }
      const missing = WORKTREE_MANAGER_TOOLS.filter((name) => !tools.includes(name));
      if (missing.length > 0) {
        return { available: false, tools, cause: `the worktree manager does not publish: ${missing.join(", ")}` };
      }
      return { available: true, tools };
    },

    /** Invoke one real tool and return the published envelope. */
    async invoke(tool: string, args: Record<string, unknown>): Promise<WorktreeMcpOutcome> {
      let opened: Awaited<ReturnType<typeof openStdioMcpSession>>;
      try {
        opened = await openStdioMcpSession(session);
      } catch (error) {
        // The server never started, so the request was never delivered.
        return { sent: false, cause: String((error as Error)?.message ?? error) };
      }
      try {
        const envelope = envelopeFrom(await opened.client.callTool({ name: tool, arguments: args }, undefined, { timeout: opened.requestTimeoutMs }));
        if (!envelope) return { sent: true, cause: "the worktree manager returned no envelope" };
        return { envelope, sent: true };
      } catch (error) {
        // The request reached the server, so the outcome of the call is unknown.
        return { sent: true, cause: String((error as Error)?.message ?? error) };
      } finally {
        await opened.close().catch(() => undefined);
      }
    },
  };
}
