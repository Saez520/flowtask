import type { PluginInput } from "@opencode-ai/plugin";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STAMP_PATH = ".flowtask/.review-stamp";

export default async function (input: PluginInput) {
  return {
    // Intercept bash tool executions
    "tool.execute.before": async (hookInput: {
      tool: string;
      input: Record<string, unknown>;
    }) => {
      try {
        const { tool, input: toolInput } = hookInput;

        // Only intercept bash tool calls
        if (tool !== "bash") return;

        const command = String(toolInput?.command ?? "");

        // Only block git commit commands
        if (!command.includes("git commit")) return;

        // Resolve stamp path relative to cwd
        const stampPath = join(process.cwd(), STAMP_PATH);

        // If stamp exists: consume it and allow the commit
        if (existsSync(stampPath)) {
          unlinkSync(stampPath);
          return;
        }

        // No stamp: block the commit
        return {
          prevent: true,
          message: [
            "[FlowTask Review Gate] Commit bloqueado.",
            "",
            "Se requiere una revisión pre-commit antes de hacer commit.",
            "Ejecuta una revisión de código primero:",
            "  → Dile al runner: 'review pre-commit'",
            "",
            "El commit se desbloqueará automáticamente si no hay BLOCKER/CRITICAL.",
          ].join("\n"),
          exit_code: 1,
        };
      } catch (_err) {
        // Silent degradation — never interrupt OpenCode
        return;
      }
    },

    dispose: async () => {
      // No persistent state to clean up
    },
  };
}
