// tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";

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
function detectAgentFamily(name) {
  const dashIdx = name.indexOf("-");
  if (dashIdx <= 0) return null;
  const prefix = name.slice(0, dashIdx).trim();
  if (prefix === "") return null;
  return prefix;
}
function buildAgentSections(config) {
  const allOptions = buildAgentOptions(config);
  const allSection = {
    id: "all",
    label: "All",
    kind: "all",
    items: allOptions
  };
  const familyMap = /* @__PURE__ */ new Map();
  for (const option of allOptions) {
    const family = detectAgentFamily(option.value);
    if (family === null) continue;
    const key = family.toLowerCase();
    const entry = familyMap.get(key);
    if (entry) {
      entry.items.push(option);
    } else {
      familyMap.set(key, { label: family, items: [option] });
    }
  }
  const familySections = [];
  for (const [, entry] of familyMap) {
    if (entry.items.length >= 2) {
      familySections.push({
        id: `family:${entry.label}`,
        label: entry.label,
        kind: "family",
        items: entry.items
      });
    }
  }
  familySections.sort((a, b) => a.label.localeCompare(b.label));
  return [allSection, ...familySections];
}
function buildModelSections(providers) {
  const allOptions = buildModelOptions(providers);
  const allSection = {
    id: "all",
    label: "All",
    kind: "all",
    items: allOptions
  };
  const providerSections = [];
  for (const provider of providers) {
    const models = provider.models ?? {};
    const modelKeys = Object.keys(models);
    if (modelKeys.length === 0) continue;
    const providerName = provider.name ?? provider.id;
    const items = modelKeys.map((modelId) => {
      const model = models[modelId];
      const modelName = model.name ?? modelId;
      return {
        title: modelName,
        value: `${provider.id}/${modelId}`,
        description: providerName
      };
    });
    providerSections.push({
      id: `provider:${provider.id}`,
      label: providerName,
      kind: "provider",
      items
    });
  }
  providerSections.sort((a, b) => a.label.localeCompare(b.label));
  return [allSection, ...providerSections];
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
    let agentSelectorState = null;
    let modelSelectorState = null;
    const filterItems = (items, query) => {
      if (!query) return items;
      const q = query.toLowerCase();
      return items.filter((item) => item.title.toLowerCase().includes(q) || item.description && item.description.toLowerCase().includes(q));
    };
    let navLayerUnregister = null;
    const moveSection = (state, delta, renderFn, onClose) => {
      if (!state) return;
      const next = Math.max(0, Math.min(state.sections.length - 1, state.idx + delta));
      if (next === state.idx) return;
      state.idx = next;
      api.ui.dialog.replace(renderFn, onClose);
    };
    const cleanupSelector = (state) => {
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
        commands: [{
          name: "flowtask.section.prev",
          title: "Secci\xF3n anterior",
          category: "FlowTask",
          namespace: "flowtask",
          run: () => {
            const s = agentSelectorState ?? modelSelectorState;
            moveSection(s, -1, s === agentSelectorState ? renderAgentDialog : renderModelDialog, () => cleanupSelector(s));
          }
        }, {
          name: "flowtask.section.next",
          title: "Secci\xF3n siguiente",
          category: "FlowTask",
          namespace: "flowtask",
          run: () => {
            const s = agentSelectorState ?? modelSelectorState;
            moveSection(s, 1, s === agentSelectorState ? renderAgentDialog : renderModelDialog, () => cleanupSelector(s));
          }
        }],
        bindings: [{
          key: "left",
          cmd: "flowtask.section.prev",
          desc: "Secci\xF3n anterior"
        }, {
          key: "right",
          cmd: "flowtask.section.next",
          desc: "Secci\xF3n siguiente"
        }]
      });
      navLayerUnregister = typeof layerResult === "function" ? layerResult : layerResult && typeof layerResult.unregister === "function" ? layerResult.unregister : null;
    };
    const renderAgentDialog = () => {
      const state = agentSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];
      const filteredItems = filterItems(section.items, state.query);
      return (() => {
        var _el$ = _$createElement("box"), _el$2 = _$createElement("input"), _el$3 = _$createElement("box");
        _$insertNode(_el$, _el$2);
        _$insertNode(_el$, _el$3);
        _$setProp(_el$, "flexDirection", "column");
        _$setProp(_el$2, "placeholder", "Buscar...");
        _$setProp(_el$2, "onInput", (value) => {
          state.query = value;
          api.ui.dialog.replace(renderAgentDialog, () => cleanupSelector(agentSelectorState));
        });
        _$insert(_el$3, () => state.sections.map((s, i) => (() => {
          var _el$4 = _$createElement("text");
          _$insert(_el$4, () => s.label, null);
          _$insert(_el$4, () => i < state.sections.length - 1 ? " \xB7 " : "", null);
          _$effect((_$p) => _$setProp(_el$4, "fg", i === state.idx ? api.theme.current.accent : api.theme.current.textMuted, _$p));
          return _el$4;
        })()));
        _$insert(_el$, (() => {
          var _c$ = _$memo(() => filteredItems.length > 0);
          return () => _c$() ? _$createComponent(api.ui.DialogSelect, {
            title: "FlowTask \u2014 Agente",
            options: filteredItems,
            skipFilter: true,
            onSelect: (item) => {
              const selectedValue = item.value;
              cleanupSelector(agentSelectorState);
              agentSelectorState = null;
              showModelDialog(selectedValue);
            }
          }) : (() => {
            var _el$5 = _$createElement("box"), _el$6 = _$createElement("text");
            _$insertNode(_el$5, _el$6);
            _$insertNode(_el$6, _$createTextNode(`Sin opciones`));
            return _el$5;
          })();
        })(), null);
        _$effect((_$p) => _$setProp(_el$2, "value", state.query, _$p));
        return _el$;
      })();
    };
    const renderModelDialog = () => {
      const state = modelSelectorState;
      if (!state) return null;
      const section = state.sections[state.idx];
      const filteredItems = filterItems(section.items, state.query);
      return (() => {
        var _el$8 = _$createElement("box"), _el$9 = _$createElement("input"), _el$0 = _$createElement("box");
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$8, _el$0);
        _$setProp(_el$8, "flexDirection", "column");
        _$setProp(_el$9, "placeholder", "Buscar...");
        _$setProp(_el$9, "onInput", (value) => {
          state.query = value;
          api.ui.dialog.replace(renderModelDialog, () => cleanupSelector(modelSelectorState));
        });
        _$insert(_el$0, () => state.sections.map((s, i) => (() => {
          var _el$1 = _$createElement("text");
          _$insert(_el$1, () => s.label, null);
          _$insert(_el$1, () => i < state.sections.length - 1 ? " \xB7 " : "", null);
          _$effect((_$p) => _$setProp(_el$1, "fg", i === state.idx ? api.theme.current.accent : api.theme.current.textMuted, _$p));
          return _el$1;
        })()));
        _$insert(_el$8, (() => {
          var _c$2 = _$memo(() => filteredItems.length > 0);
          return () => _c$2() ? _$createComponent(api.ui.DialogSelect, {
            get title() {
              return `Modelo para ${state.agentName}`;
            },
            options: filteredItems,
            skipFilter: true,
            onSelect: (item) => {
              const selectedValue = item.value;
              const agentName = state.agentName;
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
              api.ui.dialog.replace(() => _$createComponent(api.ui.DialogSelect, {
                title: `Variant para ${agentName}`,
                options: variants,
                onSelect: (variant) => {
                  applySelection(agentName, selectedValue, variant.value);
                }
              }), () => cleanupSelector(modelSelectorState));
            }
          }) : (() => {
            var _el$10 = _$createElement("box"), _el$11 = _$createElement("text");
            _$insertNode(_el$10, _el$11);
            _$insertNode(_el$11, _$createTextNode(`Sin opciones`));
            return _el$10;
          })();
        })(), null);
        _$effect((_$p) => _$setProp(_el$9, "value", state.query, _$p));
        return _el$8;
      })();
    };
    const openSelector = async () => {
      try {
        const sections = buildAgentSections(api.state.config);
        const providers = api.state.provider ?? [];
        if (sections[0].items.length === 0) {
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
        const popMode = api.mode.push("flowtask-model-selector");
        registerNavLayer();
        agentSelectorState = {
          sections,
          idx: 0,
          query: "",
          popMode
        };
        api.ui.dialog.replace(renderAgentDialog, () => cleanupSelector(agentSelectorState));
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
        const sections = buildModelSections(providers);
        const popMode = api.mode.push("flowtask-model-selector");
        registerNavLayer();
        modelSelectorState = {
          sections,
          idx: 0,
          query: "",
          popMode,
          agentName
        };
        api.ui.dialog.replace(renderModelDialog, () => cleanupSelector(modelSelectorState));
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
