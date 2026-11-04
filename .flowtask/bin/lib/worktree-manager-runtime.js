import fs from "fs";
import path from "path";
import crypto from "crypto";
import { verifyDirectoryMirror } from "./copy.js";

export const WORKTREE_MANAGER_OWNER_FILE = ".flowtask-worktree-manager-owner.json";
export const WORKTREE_MANAGER_OWNER = "flowtask";
export const WORKTREE_MANAGER_SOURCES = Object.freeze(["submodule", "npm"]);
export const GLOBAL_MANAGER_OWNERSHIP = Object.freeze({
  schema: 1,
  managedBy: "flowtask",
  component: "worktree-manager",
  source: "npm",
});
export const WORKTREE_MANAGER_RUNTIME_ENTRIES = Object.freeze(["worktree.sh", "worktree_manager"]);

export const OWNERSHIP = Object.freeze({
  ABSENT: "ABSENT",
  MANAGED: "MANAGED",
  EXTERNAL: "EXTERNAL",
  AMBIGUOUS: "AMBIGUOUS",
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isValidMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.schema !== 1) return false;
  if (marker.managedBy !== "flowtask") return false;
  if (marker.component !== "worktree-manager") return false;
  if (!WORKTREE_MANAGER_SOURCES.includes(marker.source)) return false;
  if (marker.sourceCommit !== null && typeof marker.sourceCommit !== "string") return false;
  if (typeof marker.version !== "string") return false;
  if (!Array.isArray(marker.files)) return false;
  return true;
}

export function readManagerVersion(managerDir) {
  try {
    const initPath = path.join(managerDir, "worktree_manager", "__init__.py");
    const content = fs.readFileSync(initPath, "utf8");
    const match = content.match(/__version__\s*=\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function classifyGlobalManagerOwnership(managerDir) {
  if (!fs.existsSync(managerDir)) {
    return { state: OWNERSHIP.ABSENT, path: managerDir, marker: null, reason: null };
  }
  let stat;
  try { stat = fs.lstatSync(managerDir); } catch {
    return { state: OWNERSHIP.AMBIGUOUS, path: managerDir, marker: null, reason: "unreadable" };
  }
  if (stat.isSymbolicLink()) {
    return { state: OWNERSHIP.AMBIGUOUS, path: managerDir, marker: null, reason: "symlink" };
  }
  if (!stat.isDirectory()) {
    return { state: OWNERSHIP.AMBIGUOUS, path: managerDir, marker: null, reason: "not-a-directory" };
  }
  const markerPath = path.join(managerDir, WORKTREE_MANAGER_OWNER_FILE);
  if (!fs.existsSync(markerPath)) {
    return { state: OWNERSHIP.EXTERNAL, path: managerDir, marker: null, reason: "no-flowtask-ownership-evidence" };
  }
  const marker = readJson(markerPath);
  if (!isValidMarker(marker)) {
    return { state: OWNERSHIP.AMBIGUOUS, path: managerDir, marker, reason: "invalid-owner-marker" };
  }
  return { state: OWNERSHIP.MANAGED, path: managerDir, marker, reason: null };
}

function walkDir(dir, cb, base = dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, cb, base);
    } else if (entry.isFile()) {
      cb(path.relative(base, full).split(path.sep).join("/"), full);
    }
  }
}

function copyRuntimeEntry(src, dest, relative, fileSet) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      if (entry.name.endsWith(".pyc")) continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      copyRuntimeEntry(srcPath, destPath, rel, fileSet);
    }
  } else if (stat.isFile()) {
    if (path.basename(src).endsWith(".pyc")) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    if (relative) fileSet.add(relative.split(path.sep).join("/"));
  }
}

export function publishGlobalWorktreeManager({ sourceDir, destinationDir, sourceCommit, version, source = "submodule", faultInjector } = {}) {
  if (!sourceDir || !destinationDir) throw new Error("sourceDir and destinationDir are required");
  if (!WORKTREE_MANAGER_SOURCES.includes(source)) {
    const err = new Error(`invalid Worktree Manager source: ${source}`);
    err.code = "WORKTREE_MANAGER_SOURCE_INVALID";
    throw err;
  }

  const ownership = classifyGlobalManagerOwnership(destinationDir);
  if (ownership.state === OWNERSHIP.EXTERNAL) {
    const err = new Error(`ownership-external: refusing to publish ${destinationDir}`);
    err.code = "OWNERSHIP_EXTERNAL";
    throw err;
  }
  if (ownership.state === OWNERSHIP.AMBIGUOUS) {
    const err = new Error(`ownership-ambiguous: refusing to publish ${destinationDir}`);
    err.code = "OWNERSHIP_AMBIGUOUS";
    throw err;
  }

  const previousVersion = ownership.state === OWNERSHIP.MANAGED ? (ownership.marker?.version ?? null) : null;
  const previousFiles = ownership.state === OWNERSHIP.MANAGED && Array.isArray(ownership.marker?.files)
    ? new Set(ownership.marker.files) : new Set();

  const parent = path.dirname(destinationDir);
  fs.mkdirSync(parent, { recursive: true });
  const tx = `worktree-manager.flowtask-${process.pid}-${crypto.randomUUID()}`;
  const stage = path.join(parent, `.stage-${tx}`);
  const backup = path.join(parent, `.backup-${tx}`);

  const resolvedVersion = (version != null) ? version : readManagerVersion(sourceDir);

  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });

    const newFiles = new Set();
    for (const entry of WORKTREE_MANAGER_RUNTIME_ENTRIES) {
      const srcEntry = path.join(sourceDir, entry);
      if (!fs.existsSync(srcEntry)) throw new Error(`source runtime entry missing: ${entry}`);
      const destEntry = path.join(stage, entry);
      copyRuntimeEntry(srcEntry, destEntry, entry, newFiles);
    }

    // Preserve non-managed files from existing destination (managed update).
    if (ownership.state === OWNERSHIP.MANAGED && fs.existsSync(destinationDir)) {
      walkDir(destinationDir, (relPath, fullPath) => {
        if (relPath === WORKTREE_MANAGER_OWNER_FILE) return;
        if (newFiles.has(relPath)) return; // new wins
        if (previousFiles.has(relPath)) return; // obsolete managed, drop
        // non-managed: preserve
        const targetPath = path.join(stage, relPath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const stat = fs.lstatSync(fullPath);
        if (stat.isFile()) fs.copyFileSync(fullPath, targetPath);
      });
    }

    const managedFiles = [...newFiles].sort();

    const marker = {
      schema: 1,
      managedBy: "flowtask",
      component: "worktree-manager",
      source,
      sourceCommit: source === "submodule" ? (sourceCommit ?? null) : null,
      version: resolvedVersion,
      files: managedFiles,
    };
    fs.writeFileSync(path.join(stage, WORKTREE_MANAGER_OWNER_FILE), `${JSON.stringify(marker, null, 2)}\n`, "utf8");

    const worktreeSh = path.join(stage, "worktree.sh");
    if (fs.existsSync(worktreeSh)) fs.chmodSync(worktreeSh, 0o755);

    if (faultInjector) faultInjector("STAGE-PUBLISH");

    if (fs.existsSync(destinationDir)) fs.renameSync(destinationDir, backup);
    fs.renameSync(stage, destinationDir);

    if (faultInjector) faultInjector("CONFIG");

    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(stage) || fs.existsSync(backup)) throw new Error("transaction cleanup failed");

    const versionChanged = previousVersion !== null && previousVersion !== resolvedVersion;

    return {
      ownership: ownership.state,
      previousVersion,
      version: resolvedVersion,
      versionChanged,
      files: managedFiles,
      destinationDir,
    };
  } catch (error) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
      if (fs.existsSync(backup)) {
        fs.rmSync(destinationDir, { recursive: true, force: true });
        fs.renameSync(backup, destinationDir);
      }
    } catch (rollbackError) {
      error.message += `; rollback failed: ${rollbackError.message}`;
    }
    throw error;
  }
}

export function ensureGlobalWorktreeManager({ sourceDir, destinationDir, source = "submodule", version, pythonBin, timeoutMs, faultInjector, detectCapabilities } = {}) {
  if (!sourceDir || !destinationDir) throw new Error("sourceDir and destinationDir are required");
  const detect = typeof detectCapabilities === "function"
    ? detectCapabilities
    : () => ({ transports: [], cli: { available: false, cause: "no detector" }, mcp: { available: false, cause: "no detector" } });
  const capabilities = detect(sourceDir, { pythonBin, timeoutMs });
  const transports = capabilities?.transports ?? [];
  if (transports.length === 0) {
    const causes = [capabilities?.cli?.cause, capabilities?.mcp?.cause].filter(Boolean).join("; ");
    const error = new Error(`Worktree Manager has no usable transport: ${causes || "no transport was detected"}`);
    error.code = "WORKTREE_MANAGER_UNUSABLE";
    throw error;
  }
  const resolvedVersion = version ?? readManagerVersion(sourceDir);
  const publishResult = publishGlobalWorktreeManager({ sourceDir, destinationDir, version: resolvedVersion, source, faultInjector });
  return {
    managerDir: destinationDir,
    version: publishResult.version,
    previousVersion: publishResult.previousVersion,
    versionChanged: publishResult.versionChanged,
    capabilities,
    source: "global",
    sourceKind: source,
  };
}

export function formatWorktreeManagerVersionNotice({ previousVersion, version } = {}) {
  if (previousVersion == null) return null;
  if (previousVersion === version) return null;
  return `Worktree Manager updated: ${previousVersion} -> ${version}`;
}
