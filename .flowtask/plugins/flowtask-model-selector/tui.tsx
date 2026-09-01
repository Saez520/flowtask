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
  query: string;
  popMode: () => void;
  agentName?: string;
} | null;

const tui = async (api: TuiPluginApi) => {
  try {
    // Closure state for selectors (survives api.ui.dialog.replace re-renders)
    let agentSelectorState: SelectorState = null;
    let modelSelectorState: SelectorState = null;

    const filterItems = (
      items: { title: string; value: string; description?: string }[],
      query: string
    ) => {
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          (item.description && item.description.toLowerCase().includes(q))
      );
    };

    let navLayerUnregister: (() => void) | null = null;

    const moveSection = (state: SelectorState, delta: number, renderFn: () => any, onClose?: () => void) => {
      if (!state) return;
      const next = Math.max(0, Math.min(state.sections.length - 1, state.idx + delta));
      if (next === state.idx) return;
      state.idx = next;
      api.ui.dialog.replace(renderFn, onClose);
    };

    const cleanupSelector = (state: SelectorState) => {
      if (!state) return;
      api.ui.dialog.clear();
      state.popMode();
      if (navLayerUnregister) {
        navLayerUnregister();
        navLayerUnregister = null;
      }
    };

    const registerNavLayer = () => {
      if (navLayerUnregister) return;
      const activeState = agentSelectorState ?? modelSelectorState;
      const layerResult = api.keymap.registerLayer({
        mode: "flowtask-model-selector",
        commands: [
          {
            name: "flowtask.section.prev",
            title: "Sección anterior",
            category: "FlowTask",
            namespace: "flowtask",
            run: () => {
              const s = agentSelectorState ?? modelSelectorState;
              moveSection(s, -1, s === agentSelectorState ? renderAgentDialog : renderModelDialog, () => cleanupSelector(s));
            },
          },
          {
            name: "flowtask.section.next",
            title: "Sección siguiente",
            category: "FlowTask",
            namespace: "flowtask",
            run: () => {
              const s = agentSelectorState ?? modelSelectorState;
              moveSection(s, +1, s === agentSelectorState ? renderAgentDialog : renderModelDialog, () => cleanupSelector(s));
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

    // Render function for agent dialog
    const renderAgentDialog = () => {
      const state = agentSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];
      const filteredItems = filterItems(section.items, state.query);

      return (
        <box flexDirection="column">
           <input
             value={state.query}
             placeholder="Buscar..."
             onInput={(value: string) => {
               state.query = value;
               api.ui.dialog.replace(renderAgentDialog, () => cleanupSelector(agentSelectorState));
             }}
           />
            <box>
             {state.sections.map((s, i) => (
               <text
                 fg={i === state.idx ? api.theme.current.accent : api.theme.current.textMuted}
               >
                 {s.label}{i < state.sections.length - 1 ? " · " : ""}
               </text>
             ))}
           </box>
           {filteredItems.length > 0 ? (
             <api.ui.DialogSelect
               title="FlowTask — Agente"
              options={filteredItems}
              skipFilter={true}
              onSelect={(item) => {
                const selectedValue = item.value;
                cleanupSelector(agentSelectorState);
                agentSelectorState = null;
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

    // Render function for model dialog
    const renderModelDialog = () => {
      const state = modelSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];
      const filteredItems = filterItems(section.items, state.query);

      return (
        <box flexDirection="column">
           <input
             value={state.query}
             placeholder="Buscar..."
             onInput={(value: string) => {
               state.query = value;
               api.ui.dialog.replace(renderModelDialog, () => cleanupSelector(modelSelectorState));
             }}
           />
            <box>
             {state.sections.map((s, i) => (
               <text
                 fg={i === state.idx ? api.theme.current.accent : api.theme.current.textMuted}
               >
                 {s.label}{i < state.sections.length - 1 ? " · " : ""}
               </text>
             ))}
           </box>
           {filteredItems.length > 0 ? (
             <api.ui.DialogSelect
               title={`Modelo para ${state.agentName}`}
              options={filteredItems}
              skipFilter={true}
              onSelect={(item) => {
                const selectedValue = item.value;
                const agentName = state.agentName!;
                cleanupSelector(modelSelectorState);
                modelSelectorState = null;

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
                    options={variants}
                    onSelect={(variant) => {
                      applySelection(agentName, selectedValue, variant.value);
                    }}
                  />
                ), () => cleanupSelector(modelSelectorState));
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
          query: "",
          popMode,
        };

        api.ui.dialog.replace(renderAgentDialog, () => cleanupSelector(agentSelectorState));
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
          query: "",
          popMode,
          agentName,
        };

        api.ui.dialog.replace(renderModelDialog, () => cleanupSelector(modelSelectorState));
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
