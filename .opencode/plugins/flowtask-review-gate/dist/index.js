import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const STAMP_PATH = ".flowtask/.review-stamp";
export default async function (input) {
    const sessionDir = input.directory;
    return {
        // Intercept bash tool executions
        "tool.execute.before": async (hookInput, hookOutput) => {
            const { tool } = hookInput;
            if (tool !== "bash")
                return;
            const command = String(hookOutput?.args?.command ?? "");
            if (!command.includes("git commit"))
                return;
            const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
            const stampPath = join(workdir, STAMP_PATH);
            // If stamp exists: consume it and allow the commit
            if (existsSync(stampPath)) {
                try {
                    unlinkSync(stampPath);
                }
                catch {
                    throw new Error([
                        "[FlowTask Review Gate] Commit bloqueado.",
                        "",
                        "Se requiere una revisión pre-commit antes de hacer commit.",
                        "Ejecuta una revisión de código primero:",
                        "  → Dile al runner: 'review pre-commit'",
                        "",
                        "El commit se desbloqueará automáticamente si no hay BLOCKER/CRITICAL.",
                    ].join("\n"));
                }
                return;
            }
            // No stamp: block the commit
            throw new Error([
                "[FlowTask Review Gate] Commit bloqueado.",
                "",
                "Se requiere una revisión pre-commit antes de hacer commit.",
                "Ejecuta una revisión de código primero:",
                "  → Dile al runner: 'review pre-commit'",
                "",
                "El commit se desbloqueará automáticamente si no hay BLOCKER/CRITICAL.",
            ].join("\n"));
        },
        dispose: async () => {
            // No persistent state to clean up
        },
    };
}
