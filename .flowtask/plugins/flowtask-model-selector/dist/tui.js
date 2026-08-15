// tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";

// lib/selector-core.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
var CLEAR_SENTINEL = "__flowtask_clear__";
function buildAgentOptions(config) {
  const agents = config.agent ?? {};
  const baseModel = config.model;
  const options = Object.keys(agents).sort().map((name) => {
    const override = readAgentModel(config, name);
    const current = override.model ?? baseModel ?? "(hereda)";
    const description = override.variant ? `${current} (${override.variant})` : current;
    return {
      title: name,
      value: name,
      description
    };
  });
  return options;
}
function buildModelOptions(providers) {
  const options = [
    {
      title: "(hereda del runner \u2014 sin override)",
      value: CLEAR_SENTINEL,
      description: "elimina agent.{name}.model"
    }
  ];
  for (const provider of providers) {
    const providerName = provider.name ?? provider.id;
    const models = provider.models ?? {};
    for (const modelId of Object.keys(models)) {
      const model = models[modelId];
      const modelName = model.name ?? modelId;
      options.push({
        title: modelName,
        value: `${provider.id}/${modelId}`,
        description: providerName
      });
    }
  }
  return options;
}
function buildVariantOptions(modelRef, providers) {
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) return [];
  const providerId = modelRef.slice(0, separator);
  const modelId = modelRef.slice(separator + 1);
  const provider = providers.find((item) => item?.id === providerId);
  const variants = provider?.models?.[modelId]?.variants;
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) {
    return [];
  }
  return Object.keys(variants).map((name) => {
    const details = variants[name];
    const description = details && typeof details === "object" ? Object.entries(details).map(([key, value]) => `${key}: ${String(value)}`).join(", ") : "";
    return { title: name, value: name, description };
  });
}
function readAgentModel(config, agentName) {
  const agent = config?.agent?.[agentName];
  const result = {};
  if (typeof agent?.model === "string") result.model = agent.model;
  if (typeof agent?.variant === "string") result.variant = agent.variant;
  return result;
}
function resolveGlobalConfigFile() {
  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const configDir = path.join(xdgConfig, "opencode");
  const candidates = [
    path.join(configDir, "opencode.jsonc"),
    path.join(configDir, "opencode.json"),
    path.join(configDir, "config.json")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(configDir, "opencode.json");
}
function stripJsonBom(text) {
  if (text.charCodeAt(0) === 65279) {
    return text.slice(1);
  }
  return text;
}
function removeAgentModel(config, agentName) {
  const cloned = JSON.parse(JSON.stringify(config));
  if (cloned.agent && cloned.agent[agentName]) {
    delete cloned.agent[agentName].model;
    delete cloned.agent[agentName].variant;
  }
  return cloned;
}
function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${Math.random().toString(16).slice(2)}`;
  let tempFd;
  let dirFd;
  let renameCompleted = false;
  try {
    fs.writeFileSync(tmpPath, content);
    tempFd = fs.openSync(tmpPath, "r+");
    try {
      fs.fsyncSync(tempFd);
    } catch (e) {
      if (e.code !== "EPERM") throw e;
    }
    fs.closeSync(tempFd);
    tempFd = void 0;
    fs.renameSync(tmpPath, filePath);
    renameCompleted = true;
    dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } catch (e) {
      if (e.code !== "EPERM") throw e;
    }
  } finally {
    if (typeof tempFd === "number") {
      try {
        fs.closeSync(tempFd);
      } catch {
      }
    }
    if (typeof dirFd === "number") {
      try {
        fs.closeSync(dirFd);
      } catch {
      }
    }
    if (!renameCompleted) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
      }
    }
  }
}
function buildAgentModelPatch(agentName, modelRef, variant) {
  const agent = { model: modelRef };
  if (variant !== void 0) agent.variant = variant;
  return {
    agent: {
      [agentName]: agent
    }
  };
}

// tui.tsx
import * as fs2 from "fs";
var tui = async (api) => {
  try {
    const openSelector = async () => {
      try {
        const agents = buildAgentOptions(api.state.config);
        const providers = api.state.provider ?? [];
        if (agents.length === 0) {
          api.ui.toast({
            title: "FlowTask Model",
            message: "No hay agentes definidos en opencode.json",
            variant: "error"
          });
          return;
        }
        if (providers.length === 0) {
          api.ui.toast({
            title: "FlowTask Model",
            message: "OpenCode no expone providers (\xBFinstancia no conectada?)",
            variant: "error"
          });
          return;
        }
        api.ui.dialog.replace(() => _$createComponent(api.ui.DialogSelect, {
          title: "FlowTask \u2014 Agente",
          options: agents,
          onSelect: (item) => {
            showModelDialog(item.value);
          }
        }));
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error al abrir selector: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error"
        });
      }
    };
    const showModelDialog = (agentName) => {
      try {
        const providers = api.state.provider ?? [];
        const models = buildModelOptions(providers);
        api.ui.dialog.replace(() => _$createComponent(api.ui.DialogSelect, {
          title: `Modelo para ${agentName}`,
          options: models,
          onSelect: (item) => {
            if (item.value === CLEAR_SENTINEL) {
              applySelection(agentName, item.value);
              return;
            }
            const variants = buildVariantOptions(item.value, providers);
            if (variants.length === 0) {
              applySelection(agentName, item.value);
              return;
            }
            api.ui.dialog.replace(() => _$createComponent(api.ui.DialogSelect, {
              title: `Variant para ${agentName}`,
              options: variants,
              onSelect: (variant) => {
                applySelection(agentName, item.value, variant.value);
              }
            }));
          }
        }));
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error al cargar modelos: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error"
        });
      }
    };
    const applySelection = async (agentName, value, variant) => {
      try {
        if (value === CLEAR_SENTINEL) {
          const file = resolveGlobalConfigFile();
          if (!fs2.existsSync(file)) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "No hay override que limpiar",
              variant: "info"
            });
            api.ui.dialog.clear();
            return;
          }
          let rawContent;
          try {
            rawContent = fs2.readFileSync(file, "utf-8");
          } catch (e) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "No se pudo leer opencode.json global",
              variant: "error"
            });
            return;
          }
          let cfg;
          try {
            const cleaned = stripJsonBom(rawContent);
            cfg = JSON.parse(cleaned);
          } catch (e) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "opencode.json global inv\xE1lido",
              variant: "error"
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
              variant: "error"
            });
            return;
          }
          api.ui.toast({
            title: "FlowTask Model",
            message: `Override de ${agentName} eliminado \u2014 hereda del runner (aplica en la pr\xF3xima recarga de instancia)`,
            variant: "success"
          });
        } else {
          if (!api.client?.global?.config?.update) {
            api.ui.toast({
              title: "FlowTask Model",
              message: "OpenCode no soporta config update (versi\xF3n incompatible)",
              variant: "error"
            });
            return;
          }
          const patch = buildAgentModelPatch(agentName, value, variant);
          const result = await api.client.global.config.update({
            config: patch
          });
          if (result?.error) {
            api.ui.toast({
              title: "FlowTask Model",
              message: `Error al guardar: ${result.error.message || "desconocido"}`,
              variant: "error"
            });
            return;
          }
          if (variant === void 0) {
            const file = resolveGlobalConfigFile();
            if (fs2.existsSync(file)) {
              try {
                const rawContent = fs2.readFileSync(file, "utf-8");
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
                  variant: "error"
                });
                return;
              }
            }
          }
          api.ui.toast({
            title: "FlowTask Model",
            message: `${agentName} \u2192 ${value} (aplica en la pr\xF3xima invocaci\xF3n)`,
            variant: "success"
          });
        }
        api.ui.dialog.clear();
      } catch (error) {
        api.ui.toast({
          title: "FlowTask Model",
          message: `Error inesperado: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error"
        });
      }
    };
    api.keymap.registerLayer({
      mode: "base",
      commands: [{
        name: "flowtask.model.open",
        title: "FlowTask: Model per Agent",
        category: "FlowTask",
        namespace: "palette",
        slashName: "flowtask-model",
        run: openSelector
      }],
      bindings: [{
        key: "alt+m",
        cmd: "flowtask.model.open",
        desc: "FlowTask model selector"
      }, {
        key: "super+m",
        cmd: "flowtask.model.open",
        desc: "FlowTask model selector"
      }]
    });
  } catch (error) {
    console.error("FlowtaskModelSelector initialization error:", error);
  }
};
var tui_default = {
  id: "flowtask-model-selector",
  tui
};
export {
  tui_default as default
};
