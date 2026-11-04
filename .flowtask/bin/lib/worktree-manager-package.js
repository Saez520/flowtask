import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

export const WORKTREE_MANAGER_PACKAGE = "worktree-for-agents";
export const WORKTREE_MANAGER_PACKAGE_TAG = "latest";
export const WORKTREE_MANAGER_DOWNLOAD_TIMEOUT_MS = 120000;

const WORKTREE_MANAGER_REQUIRED_ENTRIES = Object.freeze([
  "worktree.sh",
  "worktree_manager/__main__.py",
  "worktree_manager/mcp_transport.py",
]);

function downloadError(cause) {
  const error = new Error(`Worktree Manager package could not be downloaded: ${cause}`);
  error.code = "WORKTREE_MANAGER_DOWNLOAD_FAILED";
  return error;
}

function summarizeCommandFailure(error, timeoutMs) {
  if (error?.killed || error?.signal) return `npm exceeded ${timeoutMs} ms`;
  if (error?.code === "ENOENT") return "npm is not available on PATH";
  const stderr = String(error?.stderr ?? "").trim();
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/complete log of this run/i.test(line));
  const lastLine = lines.pop();
  return lastLine || String(error?.message ?? "npm failed").trim();
}

function readPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw downloadError(`the downloaded package has no readable manifest at ${manifestPath}`);
  }
  if (manifest?.name !== WORKTREE_MANAGER_PACKAGE) {
    throw downloadError(`the downloaded package is not ${WORKTREE_MANAGER_PACKAGE}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw downloadError("the downloaded package reports no version");
  }
  const missing = WORKTREE_MANAGER_REQUIRED_ENTRIES
    .filter((entry) => !fs.existsSync(path.join(packageDir, entry)));
  if (missing.length > 0) {
    throw downloadError(`the downloaded package is missing: ${missing.join(", ")}`);
  }
  return manifest;
}

/**
 * Download the published worktree manager package into an isolated prefix.
 *
 * The registry resolution, the proxy and the integrity checks are delegated to
 * npm. Package lifecycle scripts are not executed: the manager is only
 * acquired and validated here. The caller owns the returned directory through
 * `cleanup`, which removes the temporary prefix in a best-effort way.
 */
export function downloadWorktreeManagerPackage({ npmBin, timeoutMs, workDir, env } = {}) {
  const timeout = timeoutMs ?? WORKTREE_MANAGER_DOWNLOAD_TIMEOUT_MS;
  const parent = workDir ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "flowtask-worktree-manager-"));
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory never changes the installation result.
    }
  };

  try {
    const executable = npmBin ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    const args = [
      "install",
      "--prefix", root,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel=error",
      `${WORKTREE_MANAGER_PACKAGE}@${WORKTREE_MANAGER_PACKAGE_TAG}`,
    ];
    try {
      execFileSync(executable, args, {
        encoding: "utf8",
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: env ?? process.env,
      });
    } catch (error) {
      throw downloadError(summarizeCommandFailure(error, timeout));
    }

    const packageDir = path.join(root, "node_modules", WORKTREE_MANAGER_PACKAGE);
    const manifest = readPackageManifest(packageDir);
    fs.chmodSync(path.join(packageDir, "worktree.sh"), 0o755);
    return { dir: packageDir, version: manifest.version, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
