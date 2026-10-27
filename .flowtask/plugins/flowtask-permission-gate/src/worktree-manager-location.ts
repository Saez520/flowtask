import { resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";

export type WorktreeManagerSource = "global" | "repo" | "session";

export function globalWorktreeManagerDirectory(options?: { env?: Record<string, string | undefined>; home?: string }): string {
  const env = options?.env ?? process.env;
  const home = options?.home ?? (process.env.HOME || process.env.USERPROFILE || "");
  if (process.platform === "win32") {
    const appdata = env.APPDATA || (home ? `${home}/AppData/Roaming` : "");
    return resolve(appdata || "", "FlowTask", "worktree-manager");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg ? resolve(xdg) : resolve(home, ".config");
  return resolve(base, "flowtask", "worktree-manager");
}

export function isValidManagerCheckout(dir: string): boolean {
  try {
    return (
      existsSync(resolve(dir, "worktree_manager", "__main__.py")) &&
      existsSync(resolve(dir, "worktree_manager", "mcp_transport.py"))
    );
  } catch {
    return false;
  }
}

export function resolveWorktreeManagerLocation(options: {
  repoRoot: string;
  sessionDir: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): { directory: string; source: WorktreeManagerSource } | null {
  const candidates: Array<{ directory: string; source: WorktreeManagerSource }> = [
    { directory: globalWorktreeManagerDirectory({ env: options.env, home: options.home }), source: "global" },
    { directory: resolve(options.repoRoot, ".flowtask", "scripts", "worktree-manager"), source: "repo" },
    { directory: resolve(options.sessionDir, ".flowtask", "scripts", "worktree-manager"), source: "session" },
  ];
  for (const candidate of candidates) {
    if (isValidManagerCheckout(candidate.directory)) return candidate;
  }
  return null;
}

export function missingManagerCause(options: { repoRoot: string; sessionDir: string; env?: Record<string, string | undefined>; home?: string }): string {
  const globalDir = globalWorktreeManagerDirectory({ env: options.env, home: options.home });
  return `Worktree Manager is not installed at ${globalDir}. Run 'flowtask install' to install the global dependency.`;
}
