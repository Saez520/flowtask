import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const CLEAR_SENTINEL = "__flowtask_clear__";

/**
 * Kind of section in a grouped selector.
 */
export type SectionKind = "all" | "family" | "provider";

/**
 * A section of options for the grouped selector.
 * `V` is the value type of the options (string for agents, string for models).
 */
export interface Section<V = unknown> {
  id: string;
  label: string;
  kind: SectionKind;
  items: { title: string; value: V; description?: string }[];
}

/**
 * Build agent options sorted alphabetically with current model description.
 */
export function buildAgentOptions(
  config: any
): { title: string; value: string; description: string }[] {
  const agents = config.agent ?? {};
  const baseModel = config.model;

  const options = Object.keys(agents)
    .sort()
    .map((name) => {
      const override = readAgentModel(config, name);
      const current = override.model ?? baseModel ?? "(hereda)";
      const description = override.variant
        ? `${current} (${override.variant})`
        : current;
      return {
        title: name,
        value: name,
        description,
      };
    });

  return options;
}

/**
 * Build model options from providers (flattened) + prepend CLEAR_SENTINEL option.
 */
export function buildModelOptions(
  providers: any[]
): { title: string; value: string; description: string }[] {
  const options: { title: string; value: string; description: string }[] = [
    {
      title: "(hereda del runner — sin override)",
      value: CLEAR_SENTINEL,
      description: "elimina agent.{name}.model",
    },
  ];

  // Flatten providers → models
  for (const provider of providers) {
    const providerName = provider.name ?? provider.id;
    const models = provider.models ?? {};

    for (const modelId of Object.keys(models)) {
      const model = models[modelId];
      const modelName = model.name ?? modelId;
      options.push({
        title: modelName,
        value: `${provider.id}/${modelId}`,
        description: providerName,
      });
    }
  }

  return options;
}

/**
 * Detect the family prefix of an agent name (segment before the first dash).
 * Returns null if the name has no dash or the prefix is empty/whitespace.
 * Case-preserving: returns the prefix exactly as it appears.
 */
function detectAgentFamily(name: string): string | null {
  const dashIdx = name.indexOf("-");
  if (dashIdx <= 0) return null;
  const prefix = name.slice(0, dashIdx).trim();
  if (prefix === "") return null;
  return prefix;
}

/**
 * Build grouped sections for agent selection.
 * Always returns an "all" section first, followed by family sections
 * (only families with >= 2 agents), sorted alphabetically by label.
 */
export function buildAgentSections(config: any): Section<string>[] {
  const allOptions = buildAgentOptions(config);

  const allSection: Section<string> = {
    id: "all",
    label: "All",
    kind: "all",
    items: allOptions,
  };

  // Group agents by family (case-insensitive key, preserve original label)
  const familyMap = new Map<
    string,
    { label: string; items: { title: string; value: string; description?: string }[] }
  >();

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

  // Build family sections (only families with >= 2 members), sorted by label
  const familySections: Section<string>[] = [];
  for (const [, entry] of familyMap) {
    if (entry.items.length >= 2) {
      familySections.push({
        id: `family:${entry.label}`,
        label: entry.label,
        kind: "family",
        items: entry.items,
      });
    }
  }

  familySections.sort((a, b) => a.label.localeCompare(b.label));

  return [allSection, ...familySections];
}

/**
 * Build grouped sections for model selection.
 * Always returns an "all" section first (includes CLEAR_SENTINEL),
 * followed by provider sections sorted alphabetically by provider name.
 */
export function buildModelSections(providers: any[]): Section<string>[] {
  const allOptions = buildModelOptions(providers);

  const allSection: Section<string> = {
    id: "all",
    label: "All",
    kind: "all",
    items: allOptions,
  };

  const providerSections: Section<string>[] = [];

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
        description: providerName,
      };
    });

    providerSections.push({
      id: `provider:${provider.id}`,
      label: providerName,
      kind: "provider",
      items,
    });
  }

  providerSections.sort((a, b) => a.label.localeCompare(b.label));

  return [allSection, ...providerSections];
}

/**
 * Build variant options for a provider/model reference.
 */
export function buildVariantOptions(
  modelRef: string,
  providers: any[]
): { title: string; value: string; description: string }[] {
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
    const description =
      details && typeof details === "object"
        ? Object.entries(details)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(", ")
        : "";
    return { title: name, value: name, description };
  });
}

/**
 * Read the explicit model and variant override for an agent.
 */
export function readAgentModel(
  config: any,
  agentName: string
): { model?: string; variant?: string } {
  const agent = config?.agent?.[agentName];
  const result: { model?: string; variant?: string } = {};
  if (typeof agent?.model === "string") result.model = agent.model;
  if (typeof agent?.variant === "string") result.variant = agent.variant;
  return result;
}

/**
 * Resolve global OpenCode config file path using XDG conventions.
 * Returns the first existing file among opencode.jsonc, opencode.json, config.json,
 * or defaults to opencode.json if none exist.
 */
export function resolveGlobalConfigFile(): string {
  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const configDir = path.join(xdgConfig, "opencode");

  // Candidates (in order)
  const candidates = [
    path.join(configDir, "opencode.jsonc"),
    path.join(configDir, "opencode.json"),
    path.join(configDir, "config.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to opencode.json if none exist
  return path.join(configDir, "opencode.json");
}

/**
 * Strip UTF-8 BOM from JSON text.
 */
export function stripJsonBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

/**
 * Deep clone config and remove agent[agentName].model and variant fields.
 * Does not mutate the original config.
 * If agent[agentName] becomes empty after removal, it is preserved (not deleted).
 */
export function removeAgentModel(config: any, agentName: string): any {
  const cloned = JSON.parse(JSON.stringify(config));
  if (cloned.agent && cloned.agent[agentName]) {
    delete cloned.agent[agentName].model;
    delete cloned.agent[agentName].variant;
  }
  return cloned;
}

/**
 * Atomic write to file: write to tmp, fsync tmp, rename to target, fsync dir.
 * Throws on error; on failure, no partial writes remain.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${Math.random().toString(16).slice(2)}`;
  let tempFd: number | undefined;
  let dirFd: number | undefined;
  let renameCompleted = false;

  try {
    fs.writeFileSync(tmpPath, content);

    tempFd = fs.openSync(tmpPath, "r+");
    try {
      fs.fsyncSync(tempFd);
    } catch (e: any) {
      // Permit EPERM (permission denied on certain systems)
      if (e.code !== "EPERM") throw e;
    }
    fs.closeSync(tempFd);
    tempFd = undefined;

    fs.renameSync(tmpPath, filePath);
    renameCompleted = true;

    // Fsync directory (best-effort)
    dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } catch (e: any) {
      if (e.code !== "EPERM") throw e;
    }
  } finally {
    if (typeof tempFd === "number") {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Ignore
      }
    }
    if (typeof dirFd === "number") {
      try {
        fs.closeSync(dirFd);
      } catch {
        // Ignore
      }
    }

    // Cleanup tmp if rename didn't complete
    if (!renameCompleted) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Build the config patch for setting an agent's model.
 */
export function buildAgentModelPatch(
  agentName: string,
  modelRef: string,
  variant?: string
): object {
  const agent: { model: string; variant?: string } = { model: modelRef };
  if (variant !== undefined) agent.variant = variant;
  return {
    agent: {
      [agentName]: agent,
    },
  };
}
