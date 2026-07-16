import classify from "./classifier.js";
export default (async ({ client }) => {
    return {
        // Hook `chat.message`: se invoca en prompt.ts:999-1009 ANTES de
        // sessions.updateMessage(info) / sessions.updatePart(part) (prompt.ts:1046-1047),
        // por lo que mutar `output.parts` (push de un text-part) se persiste al
        // store de la sesión y dispara el event `message.updated` que el TUI ya
        // escucha. Esto reemplaza al hook efímero `experimental.chat.messages.transform`
        // que solo mutaba el array en memoria durante la construcción del prompt.
        "chat.message": async (input, output) => {
            try {
                // `output.parts` ya son los parts del user message que se está admitiendo.
                // No hay que iterar un array de mensajes buscando el último user (como
                // en el hook viejo). Concatenar los text-parts actuales como input del classifier.
                const userText = (output.parts || [])
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("");
                if (!userText)
                    return;
                const classification = classify(userText);
                if (!classification)
                    return;
                // Inyectar el tag como text-part del user message admitido. Viaja dentro
                // del user message y se hace durable (se persiste en DB vía sessions.updatePart).
                // Cast as any: el tipo `Part` del runtime requiere `id`/`messageID` que
                // opencode asigna posteriormente en assign() antes de persistir.
                output.parts.push({
                    type: "text",
                    text: `[FLOWTASK_CLASSIFICATION: ${classification}]`,
                });
            }
            catch {
                // Silencioso — si el plugin falla, el runner sigue funcionando.
                // El TUI continúa en `(idle)` (contrato respetado).
            }
        }
    };
});
