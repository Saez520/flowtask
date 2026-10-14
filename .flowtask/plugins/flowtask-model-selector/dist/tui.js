// tui.tsx
import { Plugin } from "@opencode/plugin/tui";

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
  if (!variants || typeof variants !== "object") {
    return [];
  }
  const entries = Array.isArray(variants) ? variants.flatMap((variant) => {
    if (!variant || typeof variant !== "object" || typeof variant.id !== "string" || !variant.id) return [];
    return [[variant.id, variant.settings]];
  }) : Object.entries(variants);
  return entries.map(([name, details]) => {
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
function readConfig() {
  const file = resolveGlobalConfigFile();
  if (!fs2.existsSync(file)) return {};
  return JSON.parse(stripJsonBom(fs2.readFileSync(file, "utf8")));
}
function writeConfig(config) {
  atomicWriteFile(resolveGlobalConfigFile(), JSON.stringify(config, null, 2));
}
var tui_default = Plugin.define({
  id: "flowtask-model-selector",
  setup(context) {
    const location = context.location ?? context.data.location.default();
    const selectSectionItem = async (title, sections) => {
      const sectionOptions = sections.map((section) => ({
        title: section.label,
        value: section.id,
        description: `${section.items.length} opciones`
      }));
      const sectionID = sections.length === 1 ? sections[0].id : await context.ui.dialog.select({
        title: `${title}: secci\xF3n`,
        options: sectionOptions
      });
      const selectedSection = sections.find((section) => section.id === sectionID);
      if (!selectedSection) return void 0;
      return await context.ui.dialog.select({
        title: `${title} \u2014 ${selectedSection.label}`,
        options: selectedSection.items
      });
    };
    const openSelector = async () => {
      try {
        await Promise.all([context.data.location.agent.sync(location), context.data.location.provider.sync(location)]);
        const agents = context.data.location.agent.list(location) ?? [];
        const providers = context.data.location.provider.list(location) ?? [];
        const config = readConfig();
        const agentConfig = Object.fromEntries(agents.map((agent) => [agent.name ?? agent.id, agent]));
        const agentName = await selectSectionItem("Select Agent", buildAgentSections({
          ...config,
          agent: agentConfig
        }));
        if (!agentName) return;
        const modelRef = await selectSectionItem("Modelo", buildModelSections(providers));
        if (modelRef === void 0) return;
        if (modelRef === CLEAR_SENTINEL) {
          writeConfig(removeAgentModel(readConfig(), agentName));
          context.ui.toast.show({
            title: "FlowTask Model",
            message: `Override de ${agentName} eliminado`,
            variant: "success"
          });
          return;
        }
        const variants = buildVariantOptions(modelRef, providers);
        const variant = variants.length ? await context.ui.dialog.select({
          title: `Variant para ${agentName}`,
          options: variants
        }) : void 0;
        if (variants.length && variant === void 0) return;
        const current = readConfig();
        const patch = buildAgentModelPatch(agentName, modelRef, variant);
        const next = {
          ...current,
          agent: {
            ...current.agent ?? {},
            [agentName]: {
              ...current.agent?.[agentName] ?? {},
              ...patch.agent[agentName]
            }
          }
        };
        writeConfig(next);
        context.ui.toast.show({
          title: "FlowTask Model",
          message: `${agentName} \u2192 ${modelRef}`,
          variant: "success"
        });
      } catch (error) {
        context.ui.toast.show({
          title: "FlowTask Model",
          message: `Error: ${error instanceof Error ? error.message : "desconocido"}`,
          variant: "error"
        });
      }
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "flowtask.model.open",
        title: "FlowTask: Model per Agent",
        group: "FlowTask",
        bind: "alt+m",
        palette: true,
        slash: {
          name: "flowtask-model"
        },
        run: openSelector
      }],
      bindings: ["flowtask.model.open"]
    }));
  }
});
export {
  tui_default as default
};
