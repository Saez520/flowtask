/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin";
import {
  buildAgentOptions,
  buildAgentSections,
  buildModelOptions,
  buildModelSections,
  buildVariantOptions,
  CLEAR_SENTINEL,
  resolveGlobalConfigFile,
  stripJsonBom,
  removeAgentModel,
  atomicWriteFile,
  buildAgentModelPatch,
} from "./lib/selector-core";
import type { Section } from "./lib/selector-core";
import * as fs from "fs";

type SelectorState = {
  sections: Section<string>[];
  idx: number;
  popMode: () => void;
  agentName?: string;
  _teardown?: boolean;
} | null;

const tui = async (api: TuiPluginApi) => {
  try {
    // Closure state for selectors (survives api.ui.dialog.replace re-renders)
    let agentSelectorState: SelectorState = null;
    let modelSelectorState: SelectorState = null;

    let navLayerUnregister: (() => void) | null = null;

    // T1: teardown sin clear — solo limpia estado/modo/layer.
    // NUNCA llama api.ui.dialog.clear() para evitar reentrada clear→onClose→clear.
    const teardownSelector = (state: SelectorState) => {
      if (!state || state._teardown) return;
      state._teardown = true;
      state.popMode();
      if (navLayerUnregister) {
        navLayerUnregister();
        navLayerUnregister = null;
      }
      // Nullify corresponding state so layer guard (agentSelectorState ?? modelSelectorState)
      // resolves to the active selector, not a stale one. Fixes T2 arrow navigation.
      if (state === agentSelectorState) agentSelectorState = null;
      if (state === modelSelectorState) modelSelectorState = null;
    };

    // T1: cierre explícito (onSelect) — teardown + clear.
    const closeSelector = (state: SelectorState) => {
      teardownSelector(state);
      api.ui.dialog.clear();
    };

    const moveSection = (state: SelectorState, delta: number, renderFn: () => any) => {
      if (!state) return;
      const next = Math.max(0, Math.min(state.sections.length - 1, state.idx + delta));
      if (next === state.idx) return;
      state.idx = next;
      // T1: navegación interna NO pasa onClose a dialog.replace.
      // OpenCode dispara onClose del dialog vigente antes de instalar el reemplazo;
      // pasar teardown aquí nulifica state y desregistra nav layer → modal vacío + flechas muertas.
      // El onClose real (ESC/backdrop/onSelect) queda registrado por el replace inicial en openSelector/showModelDialog.
      api.ui.dialog.replace(renderFn);
    };

    // T2: layer en mode "modal" (host empuja modal al abrir dialog) con ownership estricto.
    const registerNavLayer = () => {
      if (navLayerUnregister) return;
      const layerResult = api.keymap.registerLayer({
        mode: "modal",
        commands: [
          {
            name: "flowtask.section.prev",
            title: "Sección anterior",
            category: "FlowTask",
            namespace: "flowtask",
            run: () => {
              if (!agentSelectorState && !modelSelectorState) return;
              const s = agentSelectorState ?? modelSelectorState;
              moveSection(s, -1, s === agentSelectorState ? renderAgentDialog : renderModelDialog);
            },
          },
          {
            name: "flowtask.section.next",
            title: "Sección siguiente",
            category: "FlowTask",
            namespace: "flowtask",
            run: () => {
              if (!agentSelectorState && !modelSelectorState) return;
              const s = agentSelectorState ?? modelSelectorState;
              moveSection(s, +1, s === agentSelectorState ? renderAgentDialog : renderModelDialog);
            },
          },
        ],
        bindings: [
          {
            key: "left",
            cmd: "flowtask.section.prev",
            desc: "Sección anterior",
          },
          {
            key: "right",
            cmd: "flowtask.section.next",
            desc: "Sección siguiente",
          },
        ],
      });
      navLayerUnregister = typeof layerResult === "function" ? layerResult : (layerResult && typeof (layerResult as any).unregister === "function" ? (layerResult as any).unregister : null);
    };

    // T4: render sin input custom — DialogSelect nativo con filtro+focus propios.
    const renderAgentDialog = () => {
      const state = agentSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];

      return (
        <box flexDirection="column">
          {/* T3: breadcrumb en fila horizontal, alineado con título */}
          <box flexDirection="row" paddingLeft={4} gap={1}>
            {state.sections.map((s, i) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={i === state.idx ? api.theme.current.backgroundElement : undefined}
              >
                <text
                  fg={i === state.idx ? api.theme.current.accent : api.theme.current.textMuted}
                >
                  {s.label}{i < state.sections.length - 1 ? " · " : ""}
                </text>
              </box>
            ))}
          </box>
          {section.items.length > 0 ? (
            <api.ui.DialogSelect
              title="Select Agent"
              placeholder="Buscar..."
              options={section.items}
              onSelect={(item) => {
                const selectedValue = item.value;
                closeSelector(agentSelectorState);
                showModelDialog(selectedValue);
              }}
            />
          ) : (
            <box>
              <text>Sin opciones</text>
            </box>
          )}
        </box>
      );
    };

    // T4: render sin input custom — DialogSelect nativo con filtro+focus propios.
    const renderModelDialog = () => {
      const state = modelSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];

      return (
        <box flexDirection="column">
          {/* T3: breadcrumb en fila horizontal, alineado con título */}
          <box flexDirection="row" paddingLeft={4} gap={1}>
            {state.sections.map((s, i) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={i === state.idx ? api.theme.current.backgroundElement : undefined}
              >
                <text
                  fg={i === state.idx ? api.theme.current.accent : api.theme.current.textMuted}
                >
                  {s.label}{i < state.sections.length - 1 ? " · " : ""}
                </text>
              </box>
            ))}
          </box>
          {section.items.length > 0 ? (
            <api.ui.DialogSelect
              title={`Modelo para ${state.agentName}`}
              placeholder="Buscar..."
              options={section.items}
              onSelect={(item) => {
                const selectedValue = item.value;
                const agentName = state.agentName!;
                closeSelector(modelSelectorState);

                if (selectedValue === CLEAR_SENTINEL) {
                  applySelection(agentName, selectedValue);
                  return;
                }

                const providers = api.state.provider ?? [];
                const variants = buildVariantOptions(selectedValue, providers);
                if (variants.length === 0) {
                  applySelection(agentName, selectedValue);
                  return;
                }

                api.ui.dialog.replace(() => (
                  <api.ui.DialogSelect
                    title={`Variant para ${agentName}`}
                    placeholder="Buscar..."
                    options={variants}
                    onSelect={(variant) => {
                      applySelection(agentName, selectedValue, variant.value);
                    }}
                  />
                ), () => teardownSelector(modelSelectorState));
              }}
            />
          ) : (
            <box>
              <text>Sin opciones</text>
            </box>
          )}
        </box>
      );
    };

    const openSelector = async () => {
      try {
        const sections = buildAgentSections(api.state.config);
        const providers = api.state.provider ?? [];

        // Guard: no agents
        if (sections[0].items.length === 0) {
          api.ui.toast({
            title: "FlowTask Model",
            message: "No hay agentes definidos en opencode.json",
            variant: "error",
          });
          return;
        }

        // Guard: no providers
        if (providers.length === 0) {
          api.ui.toast({
            title: "FlowTask Model",
            message: "OpenCode no expone providers (¿instancia no conectada?)",
            variant: "error",
          });
          return;
        }

        // Push custom mode and register keymap layer for section navigation
        const popMode = api.mode.push("flowtask-model-selector");
        registerNavLayer();

        agentSelectorState = {
          sections,
          idx: 0,
          popMode,
        };

        // T1: onClose = teardown (sin clear) para evitar reentrada.
        api.ui.dialog.replace(renderAgentDialog, () => teardownSelector(agentSelectorState));
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error al abrir selector: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error",
        });
      }
    };

    const showModelDialog = (agentName: string) => {
      try {
        const providers = api.state.provider ?? [];
        const sections = buildModelSections(providers);

        // Push custom mode and register keymap layer for section navigation
        const popMode = api.mode.push("flowtask-model-selector");
        registerNavLayer();

        modelSelectorState = {
          sections,
          idx: 0,
          popMode,
          agentName,
        };

        // T1: onClose = teardown (sin clear) para evitar reentrada.
        api.ui.dialog.replace(renderModelDialog, () => teardownSelector(modelSelectorState));
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error al cargar modelos: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error",
        });
      }
    };

    const applySelection = async (
      agentName: string,
      value: string,
      variant?: string
    ): Promise<void> => {
      try {
        if (value === CLEAR_SENTINEL) {
          // CLEAR flow: remove override
          const file = resolveGlobalConfigFile();

          if (!fs.existsSync(file)) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "No hay override que limpiar",
              variant: "info",
            });
            api.ui.dialog.clear();
            return;
          }

          // Read raw, parse, remove, write atomically
          let rawContent: string;
          try {
            rawContent = fs.readFileSync(file, "utf-8");
          } catch (e) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "No se pudo leer opencode.json global",
              variant: "error",
            });
            return;
          }

          let cfg: any;
          try {
            const cleaned = stripJsonBom(rawContent);
            cfg = JSON.parse(cleaned);
          } catch (e) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "opencode.json global inválido",
              variant: "error",
            });
            return;
          }

          const next = removeAgentModel(cfg, agentName);

          try {
            atomicWriteFile(file, JSON.stringify(next, null, 2));
          } catch (e) {
            api.ui.toast({
              title: "FlowTask Model",
              message: `Error al escribir override: ${e instanceof Error ? e.message : "desconocido"}`,
              variant: "error",
            });
            return;
          }

          api.ui.toast({
            title: "FlowTask Model",
            message: `Override de ${agentName} eliminado — hereda del runner (aplica en la próxima recarga de instancia)`,
            variant: "success",
          });
        } else {
          // SET flow: update model
          // Guard: api.client.global.config.update exists
          if (!api.client?.global?.config?.update) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "OpenCode no soporta config update (versión incompatible)",
              variant: "error",
            });
            return;
          }

          const patch = buildAgentModelPatch(agentName, value, variant);
          const result = await api.client.global.config.update({
            config: patch,
          });

          if (result?.error) {
            api.ui.toast({
              title: "FlowTask Model",
              message: `Error al guardar: ${result.error.message || "desconocido"}`,
              variant: "error",
            });
            return;
          }

          if (variant === undefined) {
            const file = resolveGlobalConfigFile();
            if (fs.existsSync(file)) {
              try {
                const rawContent = fs.readFileSync(file, "utf-8");
                const cfg = JSON.parse(stripJsonBom(rawContent));
                const next = JSON.parse(JSON.stringify(cfg));
                if (next.agent?.[agentName]) {
                  delete next.agent[agentName].variant;
                  atomicWriteFile(file, JSON.stringify(next, null, 2));
                }
              } catch (error) {
                api.ui.toast({
                  title: "FlowTask Model",
                  message: `Error al limpiar variant anterior: ${error instanceof Error ? error.message : "desconocido"}`,
                  variant: "error",
                });
                return;
              }
            }
          }

          api.ui.toast({
            title: "FlowTask Model",
            message: `${agentName} → ${value} (aplica en la próxima invocación)`,
            variant: "success",
          });
        }

        api.ui.dialog.clear();
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error inesperado: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error",
        });
      }
    };

    // Register command and keybinds
    api.keymap.registerLayer({
      mode: "base",
      commands: [
        {
          name: "flowtask.model.open",
          title: "FlowTask: Model per Agent",
          category: "FlowTask",
          namespace: "palette",
          slashName: "flowtask-model",
          run: openSelector,
        },
      ],
      bindings: [
        {
          key: "alt+m",
          cmd: "flowtask.model.open",
          desc: "FlowTask model selector",
        },
        {
          key: "super+m",
          cmd: "flowtask.model.open",
          desc: "FlowTask model selector",
        },
      ],
    });
  } catch (error) {
    // Never break the TUI
    console.error("FlowtaskModelSelector initialization error:", error);
  }
};

export default { id: "flowtask-model-selector", tui };
