// TUI plugin: Indicador de estado del clasificador FlowTask
// Compiled from tui.tsx — JSX transform via @opentui/solid
import { createSignal, createEffect, onCleanup } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";

/**
 * Busca la clasificación FlowTask en los mensajes de una sesión.
 * Itera de atrás hacia adelante buscando el tag [FLOWTASK_CLASSIFICATION: ...]
 * en los mensajes system.
 */
function findClassification(sessionID, api) {
  try {
    const messages = api.state.session.messages(sessionID);

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const parts = api.state.part(msg.id);

      for (const part of parts) {
        if (part.type === "text") {
          const match = part.text.match(/\[FLOWTASK_CLASSIFICATION:\s*([^\]]+)\]/);
          if (match) {
            return match[1];
          }
        }
      }
    }
  } catch {
    // Silencioso — no interrumpir la TUI de OpenCode
  }
  return null;
}

export const tui = async (api) => {
  const slotPlugin = {
    sidebar_title: (props, context) => {
      try {
        const [classification, setClassification] = createSignal(null);

        createEffect(() => {
          const sid = props.session_id;

          // Lectura inicial
          setClassification(findClassification(sid, api));

          // Suscripción a nuevos mensajes para reactividad
          const unsub = api.event.on("message.updated", (event) => {
            const evtSessionID = event.properties.info.sessionID;
            if (evtSessionID === sid) {
              setClassification(findClassification(sid, api));
            }
          });

          onCleanup(unsub);
        });

        // Derivar color y label de la señal
        const color = () =>
          classification()
            ? context.theme.current.success
            : context.theme.current.error;
        const label = () => classification() || "sin clasificación";

        return jsx("text", {
          color: color(),
          children: ["⬤ FlowTask · ", label()],
        });
      } catch {
        // Fallback silencioso: texto sin color si algo falla
        return jsx("text", {
          children: "⬤ FlowTask · sin clasificación",
        });
      }
    },
  };

  api.slots.register(slotPlugin);
};
