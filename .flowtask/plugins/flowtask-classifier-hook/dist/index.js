import classify from "./classifier.js";
export default (async ({ client }) => {
    return {
        // Hook `chat.message`: se invoca en prompt.ts ANTES de persistir el mensaje.
        // Solo clasifica mensajes del agente principal (runner). Subagentes no necesitan
        // clasificación de intención humana.
        //
        // Fix CA-hotfix-classifier-sessionid (2026-07-20):
        // En OpenCode 1.18.0, `output.parts.push(...)` con un part sin `id`/`sessionID`/
        // `messageID` produce `EventV2.InvalidDurableEvent: Expected string aggregate field
        // sessionID`. En lugar de crear un part nuevo, se modifica el texto del último
        // text-part existente (que ya tiene los IDs requeridos asignados).
        "chat.message": async (input, output) => {
            try {
                // Solo clasificar en el agente principal (runner).
                // Subagentes reciben prompts del runner, no del usuario.
                if (input.agent !== "Flowtask-Runner")
                    return;
                // `output.parts` ya son los parts del user message que se está admitiendo.
                const userText = (output.parts || [])
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("");
                if (!userText)
                    return;
                const classification = classify(userText);
                if (!classification)
                    return;
                // Modificar el último text-part existente en lugar de crear uno nuevo.
                // Esto evita el error de schema porque el part ya tiene id/sessionID/messageID.
                const parts = output.parts || [];
                for (let i = parts.length - 1; i >= 0; i--) {
                    if (parts[i].type === "text") {
                        parts[i].text = `[FLOWTASK_CLASSIFICATION: ${classification}]\n` + parts[i].text;
                        break;
                    }
                }
            }
            catch {
                // Silencioso — si el plugin falla, el runner sigue funcionando.
                // El TUI continúa en `(idle)` (contrato respetado).
            }
        }
    };
});
