import type { Plugin } from "@opencode-ai/plugin"
import classify from "./classifier.js"

export default (async ({ client }) => {
  let lastUserMessage = ""

  return {
    "chat.message": async (input, output) => {
      // Capturar el último mensaje del usuario desde output.message
      try {
        // output.message es UserMessage — extraer texto de los parts
        lastUserMessage = output.parts
          ?.filter((p: any) => p.type === "text")
          ?.map((p: any) => p.text)
          ?.join("") || ""
      } catch {
        // Silencioso — no romper el flujo si falla
      }
    },
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        const classification = classify(lastUserMessage)
        if (classification) {
          output.messages = output.messages || []
          // Inyectar como mensaje system para contexto del LLM
          // Nota: SDK solo acepta "user" | "assistant" en tipos,
          // pero el runtime acepta "system" durante prompt construction
          // Cast as any: tipos SDK piden id/sessionID/messageID en Part,
          // pero durante prompt construction el runtime no los requiere
          output.messages.push({
            info: { role: "system" },
            parts: [{
              type: "text",
              text: `[FLOWTASK_CLASSIFICATION: ${classification}]`
            }]
          } as any)
        }
      } catch {
        // Silencioso — si el plugin falla, el runner sigue funcionando
      }
    }
  }
}) satisfies Plugin
