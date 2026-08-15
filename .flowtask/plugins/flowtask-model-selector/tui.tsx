/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin";
import {
  buildAgentOptions,
  buildModelOptions,
  buildVariantOptions,
  CLEAR_SENTINEL,
  resolveGlobalConfigFile,
  stripJsonBom,
  removeAgentModel,
  atomicWriteFile,
  buildAgentModelPatch,
} from "./lib/selector-core";
import * as fs from "fs";

const tui = async (api: TuiPluginApi) => {
  try {
    const openSelector = async () => {
      try {
        const agents = buildAgentOptions(api.state.config);
        const providers = api.state.provider ?? [];

        // Guard: no agents
        if (agents.length === 0) {
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
            message:
              "OpenCode no expone providers (¿instancia no conectada?)",
            variant: "error",
          });
          return;
        }

        // Step 1: Select agent
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title="FlowTask — Agente"
            options={agents}
            onSelect={(item) => {
              showModelDialog(item.value);
            }}
          />
        ));
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
        const models = buildModelOptions(providers);

        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title={`Modelo para ${agentName}`}
            options={models}
            onSelect={(item) => {
              if (item.value === CLEAR_SENTINEL) {
                applySelection(agentName, item.value);
                return;
              }

              const variants = buildVariantOptions(item.value, providers);
              if (variants.length === 0) {
                applySelection(agentName, item.value);
                return;
              }

              api.ui.dialog.replace(() => (
                <api.ui.DialogSelect
                  title={`Variant para ${agentName}`}
                  options={variants}
                  onSelect={(variant) => {
                    applySelection(agentName, item.value, variant.value);
                  }}
                />
              ));
            }}
          />
        ));
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
              message:
                "OpenCode no soporta config update (versión incompatible)",
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
