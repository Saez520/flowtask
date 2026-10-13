import fs from "fs";
import path from "path";
import { logSuccess } from "./logger.js";
import crypto from "crypto";

const SKIP_DIRS = new Set(["node_modules", ".git"]);

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
      if (SKIP_DIRS.has(entry.name)) return;
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
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  if (!rootSrc) rootSrc = src;

  const realSrc = fs.realpathSync(src);
  if (visited.has(realSrc)) return { copied: 0, skipped: 0 };
  visited.add(realSrc);

  let copied = 0;
  let skipped = 0;

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) { skipped++; continue; }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (preservePaths.some((p) => destPath.includes(p))) { skipped++; continue; }

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

/** Verify an installed mirror byte-for-byte, including SHA-256 for every file. */
export function verifyDirectoryMirror(src, dest) {
  if (!fs.existsSync(src) || !fs.existsSync(dest)) return false;
  const files = [];
  const destinationFiles = [];
  const collect = (dir, root) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
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
      if (SKIP_DIRS.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(root, target);
      if (entry.isDirectory()) { if (!collectDestination(target, root)) return false; }
       else if (entry.isFile() || entry.isSymbolicLink()) destinationFiles.push(relative);
      else return false;
    }
    return true;
  };
  if (!collectDestination(dest, dest) || files.length !== destinationFiles.length) return false;
  const destinationSet = new Set(destinationFiles);
  if (files.some((relative) => !destinationSet.has(relative))) return false;
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
