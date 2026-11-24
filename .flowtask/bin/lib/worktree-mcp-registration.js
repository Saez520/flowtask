import fs from "fs";
import path from "path";

export const WORKTREE_MANAGER_MCP_SERVER = "worktree_manager";
export const WORKTREE_MANAGER_MCP_MODULE = "worktree_manager.mcp_transport";
export const DEFAULT_PYTHON_BIN = "python3";

const SECTION_BY_FORMAT = Object.freeze({ opencode: "mcp", claude: "mcpServers" });
const PYTHON_COMMAND_PATTERN = /^(?:python|python3(?:\.\d+)*|py)(?:\.exe)?$/i;
const PYTHON_PATH_BASENAME_PATTERN = /^(?:python|python3(?:\.\d+)*)(?:\.exe)?$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isAbsoluteCommand(command) {
  return path.isAbsolute(command) || /^[a-zA-Z]:[\\/]/.test(command) || /^\\\\/.test(command);
}

/**
 * Whether a command names a Python interpreter FlowTask may manage. Both the
 * command names the installer historically wrote and the absolute path of a
 * resolved interpreter are managed; any other command belongs to the user.
 */
function isManagedPythonCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (PYTHON_COMMAND_PATTERN.test(command)) return true;
  if (!isAbsoluteCommand(command)) return false;
  const basename = command.split(/[\\/]/).pop() ?? "";
  return PYTHON_PATH_BASENAME_PATTERN.test(basename);
}

/** Canonical server entry for one destination configuration format. */
export function buildWorktreeManagerMcpEntry(format, managerDir, pythonBin = DEFAULT_PYTHON_BIN) {
  if (format === "opencode") {
    return {
      type: "local",
      command: [pythonBin, "-m", WORKTREE_MANAGER_MCP_MODULE],
      environment: { PYTHONPATH: managerDir },
      enabled: true,
    };
  }
  if (format === "claude") {
    return {
      type: "stdio",
      command: pythonBin,
      args: ["-m", WORKTREE_MANAGER_MCP_MODULE],
      env: { PYTHONPATH: managerDir },
    };
  }
  throw new Error(`unsupported MCP configuration format: ${format}`);
}

/**
 * Whether an existing entry has the shape FlowTask writes, so its managed
 * PYTHONPATH may be refreshed. Any other shape belongs to the user.
 */
export function isFlowTaskWorktreeManagerEntry(entry, format) {
  if (!isPlainObject(entry)) return false;
  if (format === "opencode") {
    return entry.type === "local"
      && Array.isArray(entry.command)
      && entry.command.length === 3
      && isManagedPythonCommand(entry.command[0])
      && entry.command[1] === "-m"
      && entry.command[2] === WORKTREE_MANAGER_MCP_MODULE
      && isPlainObject(entry.environment)
      && entry.enabled === true;
  }
  if (format === "claude") {
    return entry.type === "stdio"
      && isManagedPythonCommand(entry.command)
      && Array.isArray(entry.args)
      && entry.args.length === 2
      && entry.args[0] === "-m"
      && entry.args[1] === WORKTREE_MANAGER_MCP_MODULE
      && isPlainObject(entry.env);
  }
  return false;
}

/** Write with a temporary file, rename, re-read and deep comparison. */
function writeJsonVerified(configPath, value) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
  const tempPath = `${configPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, configPath);
    const verified = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!sameJson(verified, value)) throw new Error("destination verification failed");
  } catch (error) {
    try {
      if (original) fs.writeFileSync(configPath, original);
      else fs.rmSync(configPath, { force: true });
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original error; the recovery is best-effort.
    }
    throw error;
  }
}

/**
 * Remove only the managed `worktree_manager` entry from one project
 * configuration. A foreign entry, an unreadable document or a non-object
 * section is preserved. Repeating the call is safe.
 */
export function removeWorktreeManagerMcp({ configPath, format }) {
  const sectionKey = SECTION_BY_FORMAT[format];
  if (!sectionKey) {
    return { status: "failed", cause: `unsupported MCP configuration format: ${format}` };
  }
  if (typeof configPath !== "string" || !configPath) {
    return { status: "failed", cause: "the configuration path is missing" };
  }
  if (!fs.existsSync(configPath)) return { status: "absent", configPath };

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return { status: "preserved", cause: `the existing configuration is unreadable: ${error.message}` };
  }
  if (!raw.trim()) return { status: "absent", configPath };

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    return { status: "preserved", cause: `the existing configuration is not valid JSON: ${error.message}` };
  }
  if (!isPlainObject(config)) {
    return { status: "preserved", cause: "the existing configuration is not a JSON object" };
  }
  const section = config[sectionKey];
  if (section === undefined) return { status: "absent", configPath };
  if (!isPlainObject(section)) {
    return { status: "preserved", cause: `the existing ${sectionKey} section is not a JSON object` };
  }
  const current = section[WORKTREE_MANAGER_MCP_SERVER];
  if (current === undefined) return { status: "absent", configPath };
  if (!isFlowTaskWorktreeManagerEntry(current, format)) {
    return { status: "preserved", cause: `the existing ${WORKTREE_MANAGER_MCP_SERVER} entry belongs to the user` };
  }

  const nextSection = { ...section };
  delete nextSection[WORKTREE_MANAGER_MCP_SERVER];
  const next = { ...config };
  if (Object.keys(nextSection).length > 0) next[sectionKey] = nextSection;
  else delete next[sectionKey];

  try {
    writeJsonVerified(configPath, next);
  } catch (error) {
    return { status: "failed", cause: error.message };
  }
  return { status: "removed", configPath };
}
