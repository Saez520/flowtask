import type { PluginInput } from "@opencode-ai/plugin";
import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STAMP_PATH = ".flowtask/.review-stamp";

function getDiffStats(cwd: string): { lines: number; files: number } | null {
  for (const args of [["diff", "--cached", "--stat"], ["diff", "--stat"]]) {
    try {
      const out = execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8" }).trim();
      if (!out) continue;
      const last = out.split("\n").pop() ?? "";
      const m = last.match(/(\d+)\s+insertions?\(\+\)/);
      const d = last.match(/(\d+)\s+deletions?\(-\)/);
      const f = last.match(/(\d+)\s+files?\s+changed/);
      return {
        lines: (m ? +m[1] : 0) + (d ? +d[1] : 0),
        files: f ? +f[1] : 0,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function buildGateMessage(stats: { lines: number; files: number } | null): string {
  const lines: string[] = [
    "[FlowTask Review Gate] Commit bloqueado.",
    "",
  ];

  if (stats) {
    lines.push(
      `📊 Diff: ${stats.files} archivo(s), ${stats.lines} línea(s).`,
      "",
    );
  }

  lines.push(
    "→ Runner: evaluá si este cambio requiere revisión pre-commit.",
    "  - Si es trivial (gitignore, docs, chore ≤ 5 líneas): re-ejecutá el commit con --no-verify.",
    "  - Si no: invocá flowtask-review-orchestrator. En caso de BLOCKER/CRITICAL, reportar y esperar que el desarrollador corrija.",
  );

  return lines.join("\n");
}

export default async function (input: PluginInput) {
  const sessionDir = input.directory;
  return {
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string },
      hookOutput: { args: any }
    ) => {
      const { tool } = hookInput;
      if (tool !== "bash") return;
      const command = String(hookOutput?.args?.command ?? "");
      if (!command.includes("git commit")) return;

      // Bypass flags — skip the gate entirely
      if (command.includes("--no-verify") || command.includes("--no-review")) return;

      const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
      const stampPath = join(workdir, STAMP_PATH);

      // Stamp exists: consume it and allow the commit
      if (existsSync(stampPath)) {
        try {
          unlinkSync(stampPath);
        } catch {
          throw new Error(buildGateMessage(null));
        }
        return;
      }

      // No stamp: measure diff and ask runner to evaluate
      const stats = getDiffStats(workdir);
      throw new Error(buildGateMessage(stats));
    },

    dispose: async () => {},
  };
}
