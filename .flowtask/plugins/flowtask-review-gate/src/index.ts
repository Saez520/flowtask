import type { PluginInput } from "@opencode-ai/plugin";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const CONFIG_PATH = ".opencode/flowtask/config/review.json";

type ReviewConfig = { enabled: boolean; stampPath: string };

function gateError(operation: string, cause: unknown, action: string): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `[FlowTask Review Gate] Commit bloqueado.\n` +
      `Operación fallida: ${operation}.\n` +
      `Causa: ${detail}.\n` +
      `Acción recomendada: ${action}`,
  );
}

function readConfig(cwd: string): ReviewConfig | null {
  const path = resolve(cwd, CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    console.warn(`[FlowTask Review Gate] No se pudo leer ${path}; se continúa sin bloquear.`);
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    console.warn(`[FlowTask Review Gate] JSON inválido en ${path}; se continúa sin bloquear.`);
    return null;
  }

  if (
    !value || typeof value !== "object" ||
    typeof (value as Record<string, unknown>).enabled !== "boolean" ||
    typeof (value as Record<string, unknown>).stampPath !== "string" ||
    !(value as Record<string, unknown>).stampPath
  ) {
    console.warn(`[FlowTask Review Gate] Configuración inválida en ${path}; se continúa sin bloquear.`);
    return null;
  }
  const config = value as ReviewConfig;
  return { enabled: config.enabled, stampPath: config.stampPath };
}

function getDiffStats(cwd: string): { lines: number; files: number } {
  let lastError: unknown;
  for (const args of [["diff", "--cached", "--stat"], ["diff", "--stat"]]) {
    try {
      const output = execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      if (!output) return { lines: 0, files: 0 };
      const summary = output.split("\n").pop() ?? "";
      const insertions = summary.match(/(\d+)\s+insertions?\(\+\)/);
      const deletions = summary.match(/(\d+)\s+deletions?\(-\)/);
      const files = summary.match(/(\d+)\s+files? changed/);
      if (!insertions && !deletions && !files) {
        throw new Error(`salida de git diff no reconocida: ${summary}`);
      }
      return {
        lines: (insertions ? Number(insertions[1]) : 0) + (deletions ? Number(deletions[1]) : 0),
        files: files ? Number(files[1]) : 0,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw gateError("analizar diff", lastError ?? "sin estadísticas", "verificá el repositorio y reintentá");
}

function buildGateMessage(stats: { lines: number; files: number }): string {
  return [
    "[FlowTask Review Gate] Commit bloqueado.",
    "",
    `📊 Diff: ${stats.files} archivo(s), ${stats.lines} línea(s).`,
    "",
    "→ Runner: evaluá si este cambio requiere revisión pre-commit.",
    "  - Si es trivial (gitignore, docs, chore ≤ 5 líneas): re-ejecutá el commit con --no-verify.",
    "  - Si no: invocá flowtask-review-orchestrator y generá el stamp antes de reintentar.",
  ].join("\n");
}

export default async function (input: PluginInput) {
  const sessionDir = input.directory;
  return {
    "tool.execute.before": async (
      hookInput: { tool: string; sessionID: string; callID: string },
      hookOutput: { args: any },
    ) => {
      if (hookInput.tool !== "bash") return;
      const command = String(hookOutput?.args?.command ?? "");
      if (!command.includes("git commit")) return;
      if (command.includes("--no-verify") || command.includes("--no-review")) return;

      const workdir = hookOutput?.args?.workdir || sessionDir || process.cwd();
      const config = readConfig(sessionDir || workdir);
      if (!config) return;
      if (!config.enabled) return;
      const stampPath = isAbsolute(config.stampPath)
        ? config.stampPath
        : resolve(sessionDir || workdir, config.stampPath);

      let stamp: string;
      try {
        stamp = readFileSync(stampPath, "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(buildGateMessage(getDiffStats(workdir)));
        }
        throw gateError("leer stamp", error, "ejecutá la revisión pre-commit y generá un stamp válido");
      }
      if (!stamp || Number.isNaN(Date.parse(stamp))) {
        throw gateError("validar stamp", "timestamp ISO-8601 inválido", "regenerá el stamp mediante la revisión");
      }
      try {
        unlinkSync(stampPath);
      } catch (error) {
        throw gateError("consumir stamp", error, "verificá permisos y reintentá");
      }
      return;
    },
    dispose: async () => {},
  };
}
