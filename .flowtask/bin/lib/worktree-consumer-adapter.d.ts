export type WorktreeConsumerDependencies = {
  isDirectory(path: string): boolean;
  listLocalBranches(repoRoot: string): string[];
  invokeCli(input: { repoRoot: string; args: string[] }): Promise<unknown>;
  invokeMcp(input: { repoRoot: string; tool: string; args: string[] }): Promise<unknown>;
  findAssociation?(workId: string): Promise<Record<string, unknown> | null>;
  persistAssociation(record: Record<string, unknown>): Promise<void>;
};

export function createWorktreeConsumerAdapter(dependencies: WorktreeConsumerDependencies): {
  execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createAndDispatch(input: Record<string, unknown>, dispatch: (record: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>>;
};
