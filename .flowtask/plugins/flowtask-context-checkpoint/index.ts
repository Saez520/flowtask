import type { PluginInput } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────
const CHECKPOINT_THRESHOLD = 0.70;
const DEFAULT_CONTEXT_LIMIT = 128000;
const MAX_IGNORED_STEPS = 2;
const CHECKPOINT_TAG = "[FLOWTASK_CHECKPOINT_CAPACITY:";

// ── State ────────────────────────────────────────────────────────
/** Cache de sessionIDs que son child sessions (subagentes). */
const CHILD_SESSIONS = new Set<string>();

/**
 * Contador de steps consecutivos sin checkpoint por sessionID.
 * Se resetea a 0 cuando el subagente responde con el tag
 * [FLOWTASK_CHECKPOINT_CAPACITY: ...]. Se incrementa en caso contrario.
 */
const IGNORED_STEPS = new Map<string, number>();

// ── SQLite helpers ───────────────────────────────────────────────

/** Abre la DB de OpenCode en modo readonly. */
function openDB(): Database {
  const dbPath = join(homedir(), ".local/share/opencode/opencode.db");
  return new Database(dbPath, { readonly: true });
}

interface StepTokens {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache?: { read: number; write: number };
}

/**
 * Obtiene los tokens de la ventana de contexto real.
 * Consulta el step-finish más reciente de la sesión y usa tokens.total,
 * que representa la ventana efectiva (input + output + reasoning + cache.read).
 * Retorna 0 si no hay datos (el caller debe usar fallback).
 */
function getContextWindowTokens(db: Database, sessionID: string, _contextLimit: number): number {
  try {
    const row = db.query(`
      SELECT data FROM part
      WHERE session_id = ? AND json_extract(data, '$.type') = 'step-finish'
      ORDER BY time_created DESC
      LIMIT 1
    `).get(sessionID) as { data: string } | undefined;

    if (!row) return 0;

    const parsed = JSON.parse(row.data);
    const tokens = parsed.tokens as StepTokens;

    return tokens.total || 0;
  } catch {
    return 0;
  }
}

interface SessionTokens {
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
}

/** Fallback: tokens acumulados de la sesión. */
function getSessionTokens(db: Database, sessionID: string): SessionTokens | null {
  const row = db.query(
    `SELECT tokens_input, tokens_output, tokens_reasoning
     FROM session
     WHERE id = ?`
  ).get(sessionID) as SessionTokens | undefined;

  if (!row) return null;
  return {
    tokens_input: row.tokens_input ?? 0,
    tokens_output: row.tokens_output ?? 0,
    tokens_reasoning: row.tokens_reasoning ?? 0,
  };
}

/** Verifica si un mensaje del asistente contiene el tag de checkpoint. */
function messageContainsCheckpointTag(db: Database, messageID: string): boolean {
  try {
    const rows = db.query(`
      SELECT data FROM part
      WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
    `).all(messageID) as { data: string }[];

    for (const row of rows) {
      const parsed = JSON.parse(row.data);
      if (typeof parsed.text === "string" && parsed.text.includes(CHECKPOINT_TAG)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Plugin ───────────────────────────────────────────────────────

export default async function (input: PluginInput) {
  const { client } = input;

  return {
    // ── Hook: detectar child sessions y respuestas ─────────────
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

        // T2: actualizar contador al recibir respuesta del subagente
        if (event.type === "message.updated") {
          const properties = event.properties;
          const info = properties?.info;
          const sessionID = properties?.sessionID ?? info?.sessionID;

          if (!sessionID || !CHILD_SESSIONS.has(sessionID)) return;
          if (!info || info.role !== "assistant") return;
          if (!info.time?.completed) return;

          const db = openDB();
          const hasTag = messageContainsCheckpointTag(db, info.id);
          db.close();

          if (hasTag) {
            IGNORED_STEPS.set(sessionID, 0);
          } else {
            const ignored = IGNORED_STEPS.get(sessionID) ?? 0;
            const newIgnored = ignored + 1;
            IGNORED_STEPS.set(sessionID, newIgnored);

            if (newIgnored >= MAX_IGNORED_STEPS) {
              const warnMsg =
                `[FlowTask] Subagente ${sessionID} ignoró checkpoint x${newIgnored} steps consecutivos`;
              try {
                client.app.log({ body: { level: "warn", message: warnMsg } });
              } catch {
                console.warn(warnMsg);
              }
            }
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

        const db = openDB();
        const contextLimit: number =
          model?.limit?.context || DEFAULT_CONTEXT_LIMIT;

        // T1: métrica de ventana real
        let windowTokens = getContextWindowTokens(db, sessionID, contextLimit);
        let usingFallback = false;

        if (windowTokens <= 0) {
          // Fallback: total acumulado acotado a contextLimit
          const tokens = getSessionTokens(db, sessionID);
          db.close();
          if (!tokens) return;

          const totalTokens =
            tokens.tokens_input + tokens.tokens_output + tokens.tokens_reasoning;
          windowTokens = Math.min(totalTokens, contextLimit);
          usingFallback = true;
        } else {
          db.close();
        }

        const percentage = windowTokens / contextLimit;

        // Solo actuar si se supera el umbral
        if (percentage < CHECKPOINT_THRESHOLD) return;

        const pct = Math.round(percentage * 100);

        if (usingFallback) {
          console.warn(
            `[FlowTask] Degradación: tokens acumulados para ${sessionID} (pct acotado a ${pct}%)`
          );
        }

        // Construir instrucción de checkpoint
        const instruction = [
          `[FLOWTASK_CONTEXT_ALERT: ${pct}%]`,
          "",
          `El contexto de esta sesión está al ${pct}% de su ventana actual (${windowTokens} / ${contextLimit} tokens).`,
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
