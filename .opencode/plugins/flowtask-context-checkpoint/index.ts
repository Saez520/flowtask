import type { PluginInput } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────
const CHECKPOINT_THRESHOLD = 0.70;
const DEFAULT_CONTEXT_LIMIT = 128000;
const MAX_IGNORED_STEPS = 2;

// ── State ────────────────────────────────────────────────────────
/** Cache de sessionIDs que son child sessions (subagentes). */
const CHILD_SESSIONS = new Set<string>();

/**
 * Contador de steps consecutivos sin checkpoint por sessionID.
 * Se incrementa cada vez que se inyecta la instrucción y el subagente no
 * responde con [FLOWTASK_CHECKPOINT_CAPACITY: X%]. El runner lo resetea
 * al detectar el tag en la respuesta del subagente (NO implementado aquí,
 * se limpia solo si la sesión se elimina).
 */
const IGNORED_STEPS = new Map<string, number>();

// ── SQLite helpers ───────────────────────────────────────────────

/** Abre la DB de OpenCode en modo readonly. */
function openDB(): Database {
  const dbPath = join(homedir(), ".local/share/opencode/opencode.db");
  return new Database(dbPath, { readonly: true });
}

interface TokenInfo {
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
}

/** Consulta los tokens acumulados de una sesión. Retorna null si la sesión no existe. */
function getSessionTokens(db: Database, sessionID: string): TokenInfo | null {
  const row = db
    .query(
      `SELECT tokens_input, tokens_output, tokens_reasoning
       FROM session
       WHERE id = ?`
    )
    .get(sessionID) as TokenInfo | undefined;

  if (!row) return null;
  return {
    tokens_input: row.tokens_input ?? 0,
    tokens_output: row.tokens_output ?? 0,
    tokens_reasoning: row.tokens_reasoning ?? 0,
  };
}

// ── Plugin ───────────────────────────────────────────────────────

export default async function (input: PluginInput) {
  const { client } = input;

  return {
    // ── Hook: detectar child sessions ──────────────────────────
    event: async ({ event }: { event: { id: string; type: string; properties: any } }) => {
      try {
        if (event.type === "session.created") {
          const info = event.properties?.info;
          if (info?.parentID) {
            CHILD_SESSIONS.add(info.id);
            client.app.log({
              body: {
                level: "info",
                message: `[FlowTask] Subagente detectado: ${info.agent ?? "unknown"} (session: ${info.id}, parent: ${info.parentID})`,
              },
            });
          }
        }

        if (event.type === "session.deleted") {
          const info = event.properties?.info;
          if (info?.id) {
            CHILD_SESSIONS.delete(info.id);
            IGNORED_STEPS.delete(info.id);
          }
        }
      } catch (_err) {
        // Degradación silenciosa — nunca interrumpir OpenCode
      }
    },

    // ── Hook: inyectar instrucción de checkpoint si ≥70% ──────
    "experimental.chat.system.transform": async (
      hookInput: { sessionID?: string; model: any },
      output: { system: string[] }
    ) => {
      try {
        const { sessionID, model } = hookInput;

        // Solo aplica a child sessions con sessionID conocido
        if (!sessionID || !CHILD_SESSIONS.has(sessionID)) return;

        // Consultar tokens desde SQLite
        const db = openDB();
        const tokens = getSessionTokens(db, sessionID);
        db.close();

        if (!tokens) return; // Sesión no encontrada en DB (aún no persistida)

        const totalTokens =
          tokens.tokens_input + tokens.tokens_output + tokens.tokens_reasoning;

        // Obtener límite de contexto del modelo
        const contextLimit: number =
          model?.limit?.context || DEFAULT_CONTEXT_LIMIT;

        const percentage = totalTokens / contextLimit;

        // Solo actuar si se supera el umbral
        if (percentage < CHECKPOINT_THRESHOLD) return;

        const pct = Math.round(percentage * 100);

        // Construir instrucción de checkpoint
        const instruction = [
          `[FLOWTASK_CONTEXT_ALERT: ${pct}%]`,
          "",
          `El contexto de esta sesión está al ${pct}% de su capacidad máxima (${totalTokens} / ${contextLimit} tokens).`,
          "",
          "Debes realizar AHORA las siguientes acciones:",
          "1. Cargar la skill checkpoint-mixin: skill({ name: \"checkpoint-mixin\" })",
          "2. Guardar tu estado actual en Engram con cp_save(",
          "     topic_key: \"flow-state/{CA-ID}/{agente}\",",
          "     ca_id: \"{CA-ID}\",",
          "     agente: \"{tu tipo de agente}\",",
          "     flow_state: { tu estado actual },",
          "     instance_name: \"{tu instance_name}\"",
          "   )",
          `3. Incluir EXACTAMENTE esta línea en tu respuesta: [FLOWTASK_CHECKPOINT_CAPACITY: ${pct}%]`,
          "",
          "Esto permite al runner relanzarte en una nueva instancia con contexto fresco, retomando donde dejaste.",
        ].join("\n");

        // Inyectar al inicio del system prompt
        output.system.unshift(instruction);

        // Contador de steps ignorados
        const ignored = IGNORED_STEPS.get(sessionID) ?? 0;
        IGNORED_STEPS.set(sessionID, ignored + 1);

        // Warning tras MAX_IGNORED_STEPS consecutivos
        if (ignored + 1 >= MAX_IGNORED_STEPS) {
          const warnMsg =
            `[FlowTask] Subagente ${sessionID} ignoró checkpoint x${ignored + 1} steps consecutivos (${pct}% contexto)`;

          try {
            client.app.log({ body: { level: "warn", message: warnMsg } });
          } catch {
            // Fallback: console.warn si client.app.log no está disponible
            console.warn(warnMsg);
          }
        }
      } catch (_err) {
        // Degradación silenciosa — nunca interrumpir OpenCode
      }
    },

    // ── Hook: limpiar al destruir ─────────────────────────────
    dispose: async () => {
      CHILD_SESSIONS.clear();
      IGNORED_STEPS.clear();
    },
  };
}
