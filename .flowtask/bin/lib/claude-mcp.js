import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  DEFAULT_PYTHON_BIN,
  WORKTREE_MANAGER_MCP_MODULE,
  WORKTREE_MANAGER_MCP_SERVER,
  buildWorktreeManagerMcpEntry,
  isFlowTaskWorktreeManagerEntry,
} from "./worktree-mcp-registration.js";

const MCP_GET_TIMEOUT_MS = 15000;
const ENGRAM_COMMAND = "engram";
const ENGRAM_ARGS = ["mcp"];
const STATE_BACKUP_SUFFIX = ".flowtask-backup";

function isAmbientConfigDir(claudeUserDir) {
  const ambient = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.resolve(claudeUserDir) === path.resolve(ambient);
}

function cliEnv(claudeUserDir) {
  const env = { ...process.env };
  if (isAmbientConfigDir(claudeUserDir)) return env;
  return { ...env, CLAUDE_CONFIG_DIR: claudeUserDir };
}

/**
 * Resolve the state file the Claude Code CLI reads for user-scope MCP servers.
 * Without `CLAUDE_CONFIG_DIR`, a session reads `$HOME/.claude.json`; with it,
 * the session reads `$CLAUDE_CONFIG_DIR/.claude.json`.
 */
function resolveStateFile(claudeUserDir) {
  if (process.env.CLAUDE_CONFIG_DIR !== undefined || !isAmbientConfigDir(claudeUserDir)) {
    return path.join(claudeUserDir, ".claude.json");
  }
  return path.join(os.homedir(), ".claude.json");
}

function runClaude(claudeBin, args, { claudeUserDir, spawn }) {
  return spawn(claudeBin, args, {
    encoding: "utf8",
    timeout: MCP_GET_TIMEOUT_MS,
    env: cliEnv(claudeUserDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function failure(command, error) {
  return { ok: false, action: "failed", managed: false, error, command };
}

function userScopePresent(result) {
  if (!result || result.status !== 0) return false;
  return /scope\s*:\s*user/i.test(String(result.stdout ?? ""));
}

function stateHasUserEngram(claudeUserDir) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(resolveStateFile(claudeUserDir), "utf8"));
  } catch {
    return false;
  }
  const entry = state && typeof state === "object" ? state.mcpServers?.engram : null;
  if (!entry || entry.command !== ENGRAM_COMMAND) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.length === ENGRAM_ARGS.length && args.every((value, index) => value === ENGRAM_ARGS[index]);
}

/**
 * Classify the user-scope worktree manager entry in the Claude state file.
 * `absent` means there is no entry to preserve; `managed` means FlowTask owns
 * the entry shape; `foreign` means the entry belongs to the user.
 */
function readUserWorktreeManagerState(claudeUserDir) {
  const read = readStateObject(resolveStateFile(claudeUserDir));
  if (!read.ok) return read;
  const state = read.value;
  if (!isPlainObject(state) || (state.mcpServers !== undefined && !isPlainObject(state.mcpServers))) {
    return { ok: true, kind: "absent" };
  }
  const current = state.mcpServers?.[WORKTREE_MANAGER_MCP_SERVER];
  if (current === undefined) return { ok: true, kind: "absent" };
  return { ok: true, kind: isFlowTaskWorktreeManagerEntry(current, "claude") ? "managed" : "foreign" };
}

/**
 * Ensure Engram is registered in the user scope through the official CLI.
 * A missing or failing CLI never edits `~/.claude.json`: the exact command is
 * returned instead.
 */
export function ensureUserEngram({
  claudeUserDir,
  runtimeManifest = null,
  claudeBin = "claude",
  spawn = spawnSync,
} = {}) {
  const command = `${claudeBin} mcp add --scope user engram -- ${ENGRAM_COMMAND} ${ENGRAM_ARGS.join(" ")}`;
  if (!claudeUserDir) return failure(command, "claudeUserDir is required.");

  let getResult;
  try {
    getResult = runClaude(claudeBin, ["mcp", "get", "engram"], { claudeUserDir, spawn });
  } catch (error) {
    getResult = { status: null, error };
  }

  if (getResult?.error || getResult?.status === null || getResult?.status === undefined) {
    if (stateHasUserEngram(claudeUserDir)) {
      return { ok: true, action: "present", managed: false, error: null, command };
    }
    return failure(
      command,
      `The Claude Code CLI is unavailable (${getResult?.error?.message ?? "command not found"}). ` +
        `Run manually: ${command}`,
    );
  }

  if (userScopePresent(getResult)) {
    return { ok: true, action: "present", managed: false, error: null, command };
  }

  let addResult;
  try {
    addResult = runClaude(
      claudeBin,
      ["mcp", "add", "--scope", "user", "engram", "--", ENGRAM_COMMAND, ...ENGRAM_ARGS],
      { claudeUserDir, spawn },
    );
  } catch (error) {
    addResult = { status: null, error };
  }

  if (addResult?.error || addResult?.status !== 0) {
    return failure(
      command,
      `Could not add Engram to the user scope: ${String(addResult?.stderr ?? addResult?.error?.message ?? "unknown error").trim()}. ` +
        `Run manually: ${command}`,
    );
  }

  const verify = runClaude(claudeBin, ["mcp", "get", "engram"], { claudeUserDir, spawn });
  if (!userScopePresent(verify)) {
    return failure(
      command,
      `Engram was added but the user scope could not be verified. Run manually: ${command}`,
    );
  }

  const managed = runtimeManifest?.mcp?.engram?.managed !== false;
  return { ok: true, action: "added", managed, error: null, command };
}

/**
 * Remove the Engram registration only when FlowTask added it. A pre-existing
 * user-scope registration is preserved.
 */
export function removeUserEngram({
  claudeUserDir,
  runtimeManifest = null,
  claudeBin = "claude",
  spawn = spawnSync,
} = {}) {
  const command = `${claudeBin} mcp remove --scope user engram`;
  if (runtimeManifest?.mcp?.engram?.managed !== true) {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  let getResult;
  try {
    getResult = runClaude(claudeBin, ["mcp", "get", "engram"], { claudeUserDir, spawn });
  } catch (error) {
    getResult = { status: null, error };
  }

  if (getResult?.error || getResult?.status === null || getResult?.status === undefined) {
    return failure(
      command,
      `The Claude Code CLI is unavailable. Run manually: ${command}`,
    );
  }
  if (getResult.status !== 0) {
    return { ok: true, action: "absent", managed: false, error: null, command };
  }
  if (!userScopePresent(getResult)) {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  let removeResult;
  try {
    removeResult = runClaude(claudeBin, ["mcp", "remove", "--scope", "user", "engram"], { claudeUserDir, spawn });
  } catch (error) {
    removeResult = { status: null, error };
  }
  if (removeResult?.error || removeResult?.status !== 0) {
    return failure(
      command,
      `Could not remove Engram from the user scope: ${String(removeResult?.stderr ?? removeResult?.error?.message ?? "unknown error").trim()}. ` +
        `Run manually: ${command}`,
    );
  }

  return { ok: true, action: "removed", managed: true, error: null, command };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readStateObject(stateFile) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, value: {} };
    return { ok: false, error: error.message };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Write the Claude state file with a one-time backup of the original bytes and
 * a read-back verification. The recovery is best-effort; the original error is
 * always preserved.
 */
function writeStateVerified(stateFile, value) {
  const original = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  const backupPath = `${stateFile}${STATE_BACKUP_SUFFIX}`;
  const tempPath = `${stateFile}.${process.pid}.tmp`;
  try {
    if (original && !fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original, { mode: 0o600 });
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, stateFile);
    const verified = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!sameJson(verified, value)) throw new Error("state verification failed");
  } catch (error) {
    try {
      if (original) fs.writeFileSync(stateFile, original);
      else fs.rmSync(stateFile, { force: true });
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original error; the recovery is best-effort.
    }
    throw error;
  }
}

function managerDirectoryCause(managerDir) {
  if (typeof managerDir !== "string" || managerDir.length === 0) {
    return "the managed Worktree Manager directory is missing";
  }
  if (!path.isAbsolute(managerDir)) return "the managed Worktree Manager directory is not an absolute path";
  if (!fs.existsSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"))) {
    return `the MCP entrypoint is missing from ${managerDir}`;
  }
  return null;
}

function worktreeManagerCommand(claudeBin, managerDir, pythonBin) {
  return `${claudeBin} mcp add --scope user ${WORKTREE_MANAGER_MCP_SERVER} ` +
    `-e PYTHONPATH=${managerDir} -- ${pythonBin} -m ${WORKTREE_MANAGER_MCP_MODULE}`;
}

/**
 * Merge the managed server directly into the Claude state file. It is the
 * fallback used when the CLI is unavailable; the original bytes stay in
 * `.flowtask-backup` and the write is verified by reading it back.
 */
function mergeWorktreeManagerState({ claudeUserDir, managerDir, pythonBin }) {
  const stateFile = resolveStateFile(claudeUserDir);
  const read = readStateObject(stateFile);
  if (!read.ok) return failure(worktreeManagerCommand("claude", managerDir, pythonBin), `the Claude state file is unreadable: ${read.error}`);
  const state = read.value;
  if (!isPlainObject(state)) {
    return failure(worktreeManagerCommand("claude", managerDir, pythonBin), "the Claude state file is not a JSON object");
  }
  if (state.mcpServers !== undefined && !isPlainObject(state.mcpServers)) {
    return {
      ok: true,
      action: "preserved",
      managed: false,
      error: null,
      command: worktreeManagerCommand("claude", managerDir, pythonBin),
    };
  }
  const servers = { ...(state.mcpServers ?? {}) };
  const current = servers[WORKTREE_MANAGER_MCP_SERVER];
  if (current !== undefined && !isFlowTaskWorktreeManagerEntry(current, "claude")) {
    return {
      ok: true,
      action: "preserved",
      managed: false,
      error: null,
      command: worktreeManagerCommand("claude", managerDir, pythonBin),
    };
  }
  const entry = buildWorktreeManagerMcpEntry("claude", managerDir, pythonBin);
  if (current !== undefined && sameJson(current, entry)) {
    return {
      ok: true,
      action: "present",
      managed: false,
      error: null,
      command: worktreeManagerCommand("claude", managerDir, pythonBin),
    };
  }
  try {
    writeStateVerified(stateFile, { ...state, mcpServers: { ...servers, [WORKTREE_MANAGER_MCP_SERVER]: entry } });
  } catch (error) {
    return failure(worktreeManagerCommand("claude", managerDir, pythonBin), `the Claude state file could not be updated: ${error.message}`);
  }
  return {
    ok: true,
    action: "added",
    managed: true,
    error: null,
    command: worktreeManagerCommand("claude", managerDir, pythonBin),
    transport: "state-file",
  };
}

function removeWorktreeManagerState({ claudeUserDir, managerDir, pythonBin }) {
  const command = `claude mcp remove --scope user ${WORKTREE_MANAGER_MCP_SERVER}`;
  const stateFile = resolveStateFile(claudeUserDir);
  const read = readStateObject(stateFile);
  if (!read.ok) return failure(command, `the Claude state file is unreadable: ${read.error}`);
  const state = read.value;
  if (!isPlainObject(state) || !isPlainObject(state.mcpServers)) {
    return { ok: true, action: "absent", managed: false, error: null, command, transport: "state-file" };
  }
  const current = state.mcpServers[WORKTREE_MANAGER_MCP_SERVER];
  if (current === undefined) return { ok: true, action: "absent", managed: false, error: null, command, transport: "state-file" };
  if (!isFlowTaskWorktreeManagerEntry(current, "claude")) {
    return { ok: true, action: "preserved", managed: false, error: null, command, transport: "state-file" };
  }
  const servers = { ...state.mcpServers };
  delete servers[WORKTREE_MANAGER_MCP_SERVER];
  const next = { ...state };
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  try {
    writeStateVerified(stateFile, next);
  } catch (error) {
    return failure(command, `the Claude state file could not be updated: ${error.message}`);
  }
  return { ok: true, action: "removed", managed: true, error: null, command, transport: "state-file" };
}

/**
 * Ensure the worktree manager is registered in the user scope through the
 * official CLI. When the CLI is unavailable, the managed entry is merged into
 * the state file with a backup and a read-back verification.
 */
export function ensureUserWorktreeManager({
  claudeUserDir,
  managerDir,
  pythonBin = DEFAULT_PYTHON_BIN,
  runtimeManifest = null,
  claudeBin = "claude",
  spawn = spawnSync,
} = {}) {
  const command = worktreeManagerCommand(claudeBin, managerDir, pythonBin);
  if (!claudeUserDir) return failure(command, "claudeUserDir is required.");
  const managerCause = managerDirectoryCause(managerDir);
  if (managerCause) return { ok: false, action: "unavailable", managed: false, error: managerCause, command };

  const stateBefore = readUserWorktreeManagerState(claudeUserDir);
  if (stateBefore.ok && stateBefore.kind === "managed") {
    return { ok: true, action: "present", managed: false, error: null, command };
  }
  if (stateBefore.ok && stateBefore.kind === "foreign") {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  let getResult;
  try {
    getResult = runClaude(claudeBin, ["mcp", "get", WORKTREE_MANAGER_MCP_SERVER], { claudeUserDir, spawn });
  } catch (error) {
    getResult = { status: null, error };
  }

  if (getResult?.error || getResult?.status === null || getResult?.status === undefined) {
    const merged = mergeWorktreeManagerState({ claudeUserDir, managerDir, pythonBin });
    if (!merged.ok) return merged;
    if (merged.action === "added") {
      const managed = runtimeManifest?.mcp?.worktree_manager?.managed !== false;
      return { ...merged, managed };
    }
    return merged;
  }

  if (userScopePresent(getResult)) {
    return { ok: true, action: "present", managed: false, error: null, command };
  }

  let addResult;
  try {
    addResult = runClaude(
      claudeBin,
      [
        "mcp", "add", "--scope", "user", WORKTREE_MANAGER_MCP_SERVER,
        "-e", `PYTHONPATH=${managerDir}`,
        "--", pythonBin, "-m", WORKTREE_MANAGER_MCP_MODULE,
      ],
      { claudeUserDir, spawn },
    );
  } catch (error) {
    addResult = { status: null, error };
  }

  if (addResult?.error || addResult?.status !== 0) {
    return failure(
      command,
      `Could not add the Worktree Manager to the user scope: ${String(addResult?.stderr ?? addResult?.error?.message ?? "unknown error").trim()}. ` +
        `Run manually: ${command}`,
    );
  }

  const stateAfterAdd = readUserWorktreeManagerState(claudeUserDir);
  if (stateAfterAdd.ok && stateAfterAdd.kind === "managed") {
    const managed = runtimeManifest?.mcp?.worktree_manager?.managed !== false;
    return { ok: true, action: "added", managed, error: null, command };
  }
  if (stateAfterAdd.ok && stateAfterAdd.kind === "foreign") {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  const verify = runClaude(claudeBin, ["mcp", "get", WORKTREE_MANAGER_MCP_SERVER], { claudeUserDir, spawn });
  if (!userScopePresent(verify)) {
    return failure(
      command,
      `The Worktree Manager was added but the user scope could not be verified. Run manually: ${command}`,
    );
  }

  const managed = runtimeManifest?.mcp?.worktree_manager?.managed !== false;
  return { ok: true, action: "added", managed, error: null, command };
}

/**
 * Remove the worktree manager from the user scope only when FlowTask added it.
 * A pre-existing registration is preserved.
 */
export function removeUserWorktreeManager({
  claudeUserDir,
  managerDir = "",
  pythonBin = DEFAULT_PYTHON_BIN,
  runtimeManifest = null,
  claudeBin = "claude",
  spawn = spawnSync,
} = {}) {
  const command = `claude mcp remove --scope user ${WORKTREE_MANAGER_MCP_SERVER}`;
  if (runtimeManifest?.mcp?.worktree_manager?.managed !== true) {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  let getResult;
  try {
    getResult = runClaude(claudeBin, ["mcp", "get", WORKTREE_MANAGER_MCP_SERVER], { claudeUserDir, spawn });
  } catch (error) {
    getResult = { status: null, error };
  }

  if (getResult?.error || getResult?.status === null || getResult?.status === undefined) {
    return removeWorktreeManagerState({ claudeUserDir, managerDir, pythonBin });
  }
  if (getResult.status !== 0) {
    return { ok: true, action: "absent", managed: false, error: null, command };
  }
  if (!userScopePresent(getResult)) {
    return { ok: true, action: "preserved", managed: false, error: null, command };
  }

  let removeResult;
  try {
    removeResult = runClaude(claudeBin, ["mcp", "remove", "--scope", "user", WORKTREE_MANAGER_MCP_SERVER], { claudeUserDir, spawn });
  } catch (error) {
    removeResult = { status: null, error };
  }
  if (removeResult?.error || removeResult?.status !== 0) {
    return failure(
      command,
      `Could not remove the Worktree Manager from the user scope: ${String(removeResult?.stderr ?? removeResult?.error?.message ?? "unknown error").trim()}. ` +
        `Run manually: ${command}`,
    );
  }

  return { ok: true, action: "removed", managed: true, error: null, command };
}
