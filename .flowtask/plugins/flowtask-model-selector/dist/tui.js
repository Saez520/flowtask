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
    const agent = agents[name];
    const agentModel = agent?.model;
    const current = agentModel ?? baseModel ?? "(hereda)";
    return {
      title: name,
      value: name,
      description: current
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
function buildAgentModelPatch(agentName, modelRef) {
  return {
    agent: {
      [agentName]: {
        model: modelRef
      }
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
            applySelection(agentName, item.value);
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
    const applySelection = async (agentName, value) => {
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
          const patch = buildAgentModelPatch(agentName, value);
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
