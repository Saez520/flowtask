import { resolve } from "node:path";
import { existsSync } from "node:fs";
export function globalWorktreeManagerDirectory(options) {
    const env = options?.env ?? process.env;
    const home = options?.home ?? (process.env.HOME || process.env.USERPROFILE || "");
    if (process.platform === "win32") {
        const appdata = env.APPDATA || (home ? `${home}/AppData/Roaming` : "");
        return resolve(appdata || "", "FlowTask", "worktree-manager");
    }
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg ? resolve(xdg) : resolve(home, ".config");
    return resolve(base, "flowtask", "worktree-manager");
}
export function isValidManagerCheckout(dir) {
    try {
        return (existsSync(resolve(dir, "worktree_manager", "__main__.py")) &&
            existsSync(resolve(dir, "worktree_manager", "mcp_transport.py")));
    }
    catch {
        return false;
    }
}
export function resolveWorktreeManagerLocation(options = {}) {
    const directory = globalWorktreeManagerDirectory({ env: options.env, home: options.home });
    return isValidManagerCheckout(directory) ? { directory, source: "global" } : null;
}
export function missingManagerCause(options = {}) {
    const globalDir = globalWorktreeManagerDirectory({ env: options.env, home: options.home });
    return `Worktree Manager is not installed at ${globalDir}. Run 'flowtask install' to install the global dependency.`;
}
