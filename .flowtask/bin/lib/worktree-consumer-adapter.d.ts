export type WorktreeConsumerTransportOutcome = {
  envelope?: unknown;
  sent?: boolean;
  cause?: string;
};

export type WorktreeConsumerTransportAvailability = {
  available: boolean;
  cause?: string;
};

export type WorktreeConsumerTransportDetection = {
  mcp?: boolean | WorktreeConsumerTransportAvailability;
  cli?: boolean | WorktreeConsumerTransportAvailability;
};

export type WorktreeConsumerDependencies = {
  isDirectory(path: string): boolean;
  listLocalBranches(repoRoot: string): string[];
  detectTransport(input: { repoRoot: string }): Promise<WorktreeConsumerTransportDetection>;
  invokeCli(input: { repoRoot: string; request: Record<string, unknown> }): Promise<WorktreeConsumerTransportOutcome>;
  invokeMcp(input: { repoRoot: string; tool: string; request: Record<string, unknown> }): Promise<WorktreeConsumerTransportOutcome>;
  findAssociation?(workId: string): Promise<Record<string, unknown> | null>;
  persistAssociation(record: Record<string, unknown>): Promise<void>;
};

export function createWorktreeConsumerAdapter(dependencies: WorktreeConsumerDependencies): {
  execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAndDispatch(input: Record<string, unknown>, dispatch: (record: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>>;
};
