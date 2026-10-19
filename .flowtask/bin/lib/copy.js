import fs from "fs";
import path from "path";
import { logSuccess } from "./logger.js";
import crypto from "crypto";

const SKIP_DIRS = new Set(["node_modules", ".git", "worktree-manager"]);
const SKIP_FILES = new Set(["worktree-manager-core.sh", "worktree-manager-target-direct.sh"]);

/**
 * Copy a directory recursively with a progress bar, skipping node_modules and .git.
 * @param {string} src
 * @param {string} dest
 * @param {string} label
 * @param {object} readline - Node readline module (for progress bar rendering)
 */
export function copyWithProgress(src, dest, label, readline) {
  const files = [];
  const visited = new Set();
  const root = fs.realpathSync(src);

  const scan = (dir) => {
    const realDir = fs.realpathSync(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Keep links as links, but never allow an installer payload to point
        // outside its source tree.  Broken links are rejected rather than
        // silently producing a different mirror.
        let realTarget;
        try { realTarget = fs.realpathSync(fullPath); } catch {
          throw new Error(`Refusing broken symbolic link in ${src}: ${path.relative(src, fullPath)}`);
        }
        if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
          throw new Error(`Refusing symbolic link outside source tree: ${path.relative(src, fullPath)}`);
        }
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      } else {
        throw new Error(`Refusing special file in installer payload: ${path.relative(src, fullPath)}`);
      }
    });
  };
  scan(src);

  files.forEach((file, index) => {
    const relative = path.relative(src, file);
    const destPath = path.join(dest, relative);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const stat = fs.lstatSync(file);
    const existing = fs.lstatSync(destPath, { throwIfNoEntry: false });
    if (existing && (stat.isSymbolicLink() !== existing.isSymbolicLink() || stat.isFile() !== existing.isFile())) {
      if (!removeEntryPreserving(destPath, relative, [])) return;
    }
    if (stat.isSymbolicLink()) {
      if (fs.existsSync(destPath) || fs.lstatSync(destPath, { throwIfNoEntry: false })) fs.rmSync(destPath, { recursive: true, force: true });
      fs.symlinkSync(fs.readlinkSync(file), destPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(file, destPath);
    } else {
      throw new Error(`Refusing special file in installer payload: ${path.relative(src, file)}`);
    }
    renderProgressBar(readline, index + 1, files.length, `${label}: ${path.basename(file)}`);
  });

  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  logSuccess(`Successfully installed ${label}.`);
}

/**
 * Check if a source file differs from its destination (by size or mtime).
 */
export function isFileChanged(srcPath, destPath) {
  if (!fs.existsSync(destPath)) return true;
  const srcStat = fs.statSync(srcPath);
  const destStat = fs.statSync(destPath);
  if (srcStat.size !== destStat.size) return true;
  if (Math.abs(srcStat.mtimeMs - destStat.mtimeMs) > 1000) return true;
  return false;
}

/**
 * Copy directory with delta detection (only changed files), skipping node_modules/.git.
 * @param {string} src
 * @param {string} dest
 * @param {string[]} preservePaths - Dest path fragments to skip (never overwrite)
 * @param {Set<string>} visited
 * @param {string|null} rootSrc
 * @returns {{ copied: number, skipped: number }}
 */
export function copyDirectoryDelta(src, dest, preservePaths = [], visited = new Set(), rootSrc = null) {
  const destStat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (destStat && (!destStat.isDirectory() || destStat.isSymbolicLink())) {
    if (!removeEntryPreserving(dest, path.basename(dest), preservePaths)) return { copied: 0, skipped: 1 };
  }
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  if (!rootSrc) rootSrc = src;

  const realSrc = fs.realpathSync(src);
  if (visited.has(realSrc)) return { copied: 0, skipped: 0 };
  visited.add(realSrc);

  let copied = 0;
  let skipped = 0;

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) { skipped++; continue; }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (preservePaths.some((p) => destPath.includes(p))) { skipped++; continue; }

    const sourceStat = fs.lstatSync(srcPath);
    const destinationStat = fs.lstatSync(destPath, { throwIfNoEntry: false });
    const sourceIsDirectory = sourceStat.isDirectory() && !sourceStat.isSymbolicLink();
    const destinationIsDirectory = destinationStat?.isDirectory() && !destinationStat.isSymbolicLink();
    if (destinationStat && sourceIsDirectory !== destinationIsDirectory) {
      if (!removeEntryPreserving(destPath, path.relative(rootSrc, srcPath), preservePaths)) { skipped++; continue; }
    }

    // Security: skip symlinks that escape source tree
    let realSrcPath;
    try { realSrcPath = fs.realpathSync(srcPath); } catch { skipped++; continue; }
    const realRootSrc = fs.realpathSync(rootSrc);
    if (realSrcPath !== realRootSrc && !realSrcPath.startsWith(`${realRootSrc}${path.sep}`)) { skipped++; continue; }

    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(srcPath);
      const root = fs.realpathSync(rootSrc);
      if (!target.startsWith(`${root}${path.sep}`) && target !== root) { skipped++; continue; }
      if (fs.existsSync(destPath) && !fs.lstatSync(destPath).isSymbolicLink()) fs.rmSync(destPath, { recursive: true, force: true });
      if (!fs.existsSync(destPath) || fs.readlinkSync(destPath) !== fs.readlinkSync(srcPath)) {
        fs.symlinkSync(fs.readlinkSync(srcPath), destPath); copied++;
      } else skipped++;
    } else if (entry.isDirectory()) {
      {
        const result = copyDirectoryDelta(srcPath, destPath, preservePaths, visited, rootSrc);
        copied += result.copied;
        skipped += result.skipped;
      }
    } else if (entry.isFile()) {
      if (isFileChanged(srcPath, destPath)) { fs.copyFileSync(srcPath, destPath); copied++; }
      else skipped++;
    } else {
      // Sockets, devices and FIFOs are not portable installer payloads.
      skipped++;
    }
  }

  return { copied, skipped };
}

/** Remove an entry only when doing so cannot remove skipped or preserved data. */
function removeEntryPreserving(target, relative, preservePaths) {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return true;
  const normalize = (value) => value.split(/[\\/]/).filter(Boolean).join("/");
  const current = normalize(relative);
  const protectedPath = (candidate) => {
    const item = normalize(candidate);
    return item && (current.includes(item) || current.startsWith(`${item}/`) || item.startsWith(`${current}/`));
  };
  if (SKIP_DIRS.has(path.basename(target)) || SKIP_FILES.has(path.basename(target)) || preservePaths.some(protectedPath)) return false;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of fs.readdirSync(target)) {
      if (!removeEntryPreserving(path.join(target, child), path.join(relative, child), preservePaths)) return false;
    }
    fs.rmdirSync(target);
  } else {
    fs.rmSync(target, { force: true });
  }
  return true;
}

/** Verify an installed mirror byte-for-byte, including SHA-256 for every file. */
export function pruneDirectoryExtras(src, dest, { preservePaths = [] } = {}) {
  let removed = 0;
  const preserved = [];
  if (!fs.existsSync(src) || !fs.existsSync(dest)) return { removed, preserved };
  const normalize = (value) => value.split(path.sep).join("/");
  const isPreserved = (relative) => preservePaths.some((fragment) => {
    const normalized = normalize(fragment);
    return normalized && (normalize(relative).includes(normalized));
  });
  const removeSafely = (destPath, relative) => {
    if (removeEntryPreserving(destPath, relative, preservePaths)) removed++;
    else {
      const collectPreserved = (target, current) => {
        if (isPreserved(current)) { preserved.push(current); return; }
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (stat?.isDirectory() && !stat.isSymbolicLink()) {
          for (const name of fs.readdirSync(target)) collectPreserved(path.join(target, name), path.join(current, name));
        }
      };
      collectPreserved(destPath, relative);
    }
  };
  const prune = (sourceDir, destDir, relativeDir = "") => {
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const sourcePath = path.join(sourceDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      const sourceStat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
      if (isPreserved(relative)) { preserved.push(relative); continue; }
      const destStat = fs.lstatSync(destPath);
      const sourceDirectory = sourceStat?.isDirectory() ?? false;
      if (!sourceStat && destStat.isDirectory() && !destStat.isSymbolicLink()) {
        pruneDestinationOnly(destPath, relative);
        continue;
      }
       if (!sourceStat || sourceStat.isSymbolicLink() !== destStat.isSymbolicLink() || sourceDirectory !== destStat.isDirectory()) {
        removeSafely(destPath, relative); continue;
      }
      if (destStat.isDirectory()) prune(sourcePath, destPath, relative);
    }
  };
  const pruneDestinationOnly = (destDir, relativeDir) => {
    for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name);
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const destPath = path.join(destDir, entry.name);
      if (isPreserved(relative)) { preserved.push(relative); continue; }
      removeSafely(destPath, relative);
    }
  };
  if (fs.lstatSync(src).isDirectory() && fs.lstatSync(dest).isDirectory()) prune(src, dest);
  return { removed, preserved: [...new Set(preserved)] };
}

export function verifyDirectoryMirror(src, dest, { expectedExtraFiles = {}, ignorePaths = [] } = {}) {
  if (!fs.existsSync(src) || !fs.existsSync(dest)) return false;
  const validRelative = (value) => typeof value === "string" && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..") && value !== ".";
  if (!ignorePaths.every(validRelative)) return false;
  const ignored = (relative) => ignorePaths.some((item) => {
    const normalized = item.split(/[\\/]/).join(path.sep);
    return relative === normalized || relative.startsWith(`${normalized}${path.sep}`);
  });
  const files = [];
  const destinationFiles = [];
  const collect = (dir, root) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const source = path.join(dir, entry.name);
      const relative = path.relative(root, source);
      if (entry.isDirectory()) { if (!collect(source, root)) return false; }
       else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative);
      else return false;
    }
    return true;
  };
  if (!collect(src, src)) return false;
  const collectDestination = (dir, root) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory()) { if (!collectDestination(target, root)) return false; }
       else if (entry.isFile() || entry.isSymbolicLink()) { if (!ignored(relative)) destinationFiles.push(relative); }
      else return false;
    }
    return true;
  };
  if (!collectDestination(dest, dest)) return false;
  const extras = Object.keys(expectedExtraFiles);
  if (extras.some((relative) => path.isAbsolute(relative) || relative.split(path.sep).includes(".."))) return false;
  if (destinationFiles.length !== files.length + extras.length) return false;
  const destinationSet = new Set(destinationFiles);
  if (files.some((relative) => !destinationSet.has(relative))) return false;
  if (extras.some((relative) => files.includes(relative) || !destinationSet.has(relative))) return false;
  for (const relative of extras) {
    const target = path.join(dest, relative);
    let stat;
    try { stat = fs.lstatSync(target); } catch { return false; }
    if (!stat.isFile() || !fs.readFileSync(target).equals(Buffer.from(expectedExtraFiles[relative]))) return false;
  }
  for (const relative of files) {
    const source = path.join(src, relative);
    const target = path.join(dest, relative);
     let targetStat;
     try { targetStat = fs.lstatSync(target); } catch { return false; }
     if (!targetStat.isFile() && !targetStat.isSymbolicLink()) return false;
     if (fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(target).isSymbolicLink()) {
       if (!fs.lstatSync(source).isSymbolicLink() || !fs.lstatSync(target).isSymbolicLink()) return false;
       if (fs.readlinkSync(source) !== fs.readlinkSync(target)) return false;
       continue;
     }
    const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const targetHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (sourceHash !== targetHash || !fs.readFileSync(source).equals(fs.readFileSync(target))) return false;
  }
  return true;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function renderProgressBar(readline, current, total, label) {
  const width = 20;
  const filled = Math.round(width * Math.min(current / total, 1));
  const empty = width - filled;
  const GREEN = "\x1b[32m", DIM = "\x1b[2m", RESET = "\x1b[0m";
  const bar = GREEN + "█".repeat(filled) + RESET + DIM + "░".repeat(empty) + RESET;
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`  [${bar}] ${Math.round((current / total) * 100)}% ${label}`);
}
