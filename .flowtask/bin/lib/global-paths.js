import path from "path";
import os from "os";

/**
 * Resolve the global (per-machine) config directory.
 * macOS/Linux: $XDG_CONFIG_HOME/flowtask  or  ~/.config/flowtask
 * Windows:     %APPDATA%/FlowTask
 */
export function resolveGlobalConfigDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "FlowTask");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "flowtask");
  return path.join(os.homedir(), ".config", "flowtask");
}

/** Path to the global worktree-manager installation directory. */
export function globalWorktreeManagerDir() {
  return path.join(resolveGlobalConfigDir(), "worktree-manager");
}
