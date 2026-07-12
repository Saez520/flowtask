import type { Plugin } from "@opencode-ai/plugin"
import classify from "./classifier.js"

export default (async ({ client }) => {
  return {
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        const messages = output.messages || []

        // Iterar de atrás hacia adelante buscando el último mensaje user
        let userText = ""
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg.info.role === "user") {
            userText = msg.parts
              ?.filter((p: any) => p.type === "text")
              ?.map((p: any) => p.text)
              ?.join("") || ""
            break
          }
        }

        if (!userText) return

        const classification = classify(userText)
        if (classification) {
          // Inyectar mensaje system con la clasificación
          // Cast as any: Message = UserMessage | AssistantMessage no incluye "system",
          // pero el runtime acepta "system" durante prompt construction
          messages.push({
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
