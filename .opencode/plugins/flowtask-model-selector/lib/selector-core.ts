import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const CLEAR_SENTINEL = "__flowtask_clear__";

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
      const agent = agents[name];
      const agentModel = agent?.model;
      const current = agentModel ?? baseModel ?? "(hereda)";
      return {
        title: name,
        value: name,
        description: current,
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
 * Deep clone config and remove agent[agentName].model field.
 * Does not mutate the original config.
 * If agent[agentName] becomes empty after removal, it is preserved (not deleted).
 */
export function removeAgentModel(config: any, agentName: string): any {
  const cloned = JSON.parse(JSON.stringify(config));
  if (cloned.agent && cloned.agent[agentName]) {
    delete cloned.agent[agentName].model;
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
  modelRef: string
): object {
  return {
    agent: {
      [agentName]: {
        model: modelRef,
      },
    },
  };
}
