import type { TuiPluginApi, TuiSlotPlugin, TuiSlotContext } from "@opencode-ai/plugin";
// @ts-expect-error - @opentui/solid es parte del runtime de OpenCode, no está en node_modules
import { createSignal, createEffect, onCleanup } from "@opentui/solid";

/**
 * Busca la clasificación FlowTask en los mensajes de una sesión.
 * Itera de atrás hacia adelante buscando el tag [FLOWTASK_CLASSIFICATION: ...]
 * en los mensajes system.
 *
 * Patrón: los mensajes system no están tipados (Message = UserMessage | AssistantMessage),
 * pero el runtime los acepta. Usamos `as any` igual que el server plugin.
 */
function findClassification(sessionID: string, api: TuiPluginApi): string | null {
  try {
    const messages = api.state.session.messages(sessionID);

    // Iterar de atrás hacia adelante — optimiza el caso común (último mensaje)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
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

/**
 * TUI Plugin: Indicador de estado del clasificador FlowTask.
 *
 * Registra un componente en el slot `sidebar_title` que:
 * - Muestra un punto verde + categoría si hay clasificación
 * - Muestra un punto rojo + "sin clasificación" si no hay
 * - Se actualiza reactivamente al cambiar de sesión o recibir nuevos mensajes
 *
 * Entry point para OpenCode: export nombrado `tui`.
 * El server plugin y el TUI plugin son módulos separados porque
 * PluginModule (server) y TuiPluginModule (tui) son mutuamente excluyentes.
 */
export const tui = async (api: TuiPluginApi) => {
  const slotPlugin: TuiSlotPlugin = {
    sidebar_title: (
      props: { session_id: string; title: string; share_url?: string },
      context: TuiSlotContext
    ) => {
      try {
        const [classification, setClassification] =
          createSignal<string | null>(null);

        createEffect(() => {
          const sid = props.session_id;

          // Lectura inicial
          setClassification(findClassification(sid, api));

          // Suscripción a nuevos mensajes para reactividad
          const unsub = api.event.on("message.updated", (event) => {
            const evtSessionID = (event.properties.info as any).sessionID;
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

        // @ts-expect-error - Text component de OpenTUI, renderizado en slot sidebar_title
        return <text color={color()}>⬤ FlowTask · {label()}</text>;
      } catch {
        // Fallback silencioso: texto sin color si algo falla
        // @ts-expect-error - OpenTUI element
        return <text>⬤ FlowTask · sin clasificación</text>;
      }
    },
  };

  api.slots.register(slotPlugin);
};
