/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin";
import { createSignal, createEffect, onCleanup } from "solid-js";

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
 * Slot: `app_bottom` (cross-view, verificado en
 * references/opencode/packages/tui/src/app.tsx:1124-1125).
 *
 * Por qué NO `sidebar_title`:
 * - `sidebar_title` se renderiza únicamente dentro del `<Show when={session()}>` del
 *   sidebar de sesión, NUNCA en la vista home.
 * - `app_bottom` está fuera del `<Switch>` home/session (mismo wrapper `<Show when={ready()}>`),
 *   se renderiza en ambas vistas, lo que hace al indicador visible al abrir OpenCode sin
 *   sesión activa.
 * - El slot `app_bottom` no recibe props (verificado en TuiHostSlotMap.app_bottom = {}),
 *   por lo que la sessionID se obtiene vía `api.route.current` en vez de por props.
 *
 * Estilo: mimetiza el subagent footer (subagent-footer.tsx:65-77) usando los mismos theme
 * tokens (`border`, `backgroundPanel`, `textMuted`) y el mismo padding lateral.
 *
 * Entry point para OpenCode: default export `{ id, tui }`.
 * El server plugin y el TUI plugin son módulos separados porque PluginModule (server) y
 * TuiPluginModule (tui) son mutuamente excluyentes.
 *
 * Si OpenCode agrega un slot `subagent_footer` dedicado en el futuro, se puede reevaluar
 * la ubicación para inyectar el indicador DENTRO del bloque del subagent.
 */
const tui = async (api: TuiPluginApi) => {
  // IMPORTANTE: la forma correcta del plugin slot es `{ slots: { slot_name: handler } }`,
  // NO `{ slot_name: handler }` directamente. El `host.register` en
  // @opentui/core valida con `isHostSlotPlugin` que requiere `id` y `slots` como
  // propiedades top-level. Si no se envuelve en `{ slots: ... }`, el plugin se ignora
  // silenciosamente (el slot nunca se invoca).
  const slotPlugin: TuiSlotPlugin = {
    slots: {
      app_bottom: (_props, _context) => {
        try {
          const theme = () => api.theme.current;
          const [label, setLabel] = createSignal<string>("(idle)");

          const refresh = () => {
            const route = api.route.current;
            if (route.name !== "session") {
              setLabel("(idle)");
              return;
            }
            const sid = route.params.sessionID;
            setLabel(findClassification(sid, api) ?? "(idle)");
          };

          createEffect(() => {
            refresh();

            // NIT #1 (type-safety): `sessionID` está en `properties` directo,
            // no requiere cast (verificado en types.gen.ts:6212).
            const unsubMsg = api.event.on("message.updated", (event) => {
              const evtSid = event.properties.sessionID;
              const route = api.route.current;
              if (route.name === "session" && route.params.sessionID === evtSid) {
                refresh();
              }
            });

            const unsubCreated = api.event.on("session.created", () => refresh());

            onCleanup(() => {
              unsubMsg();
              unsubCreated();
            });
          });

          return (
            <box
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={1}
              border={["left"]}
              borderColor={theme().border}
              flexShrink={0}
              backgroundColor={theme().backgroundPanel}
            >
              <text fg={theme().textMuted}>
                Flowtask Classifier · {label()}
              </text>
            </box>
          );
        } catch {
          return (
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1}>
              <text fg="#888888">
                Flowtask Classifier · (idle)
              </text>
            </box>
          );
        }
      },
    },
  };

  api.slots.register(slotPlugin as any);
};

export default { id: "flowtask-classifier", tui };
