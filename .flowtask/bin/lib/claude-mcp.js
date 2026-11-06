import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const MCP_GET_TIMEOUT_MS = 15000;
const ENGRAM_COMMAND = "engram";
const ENGRAM_ARGS = ["mcp"];

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
