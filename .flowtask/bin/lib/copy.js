import fs from "fs";
import path from "path";
import { logSuccess } from "./logger.js";

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

  const scan = (dir) => {
    const realDir = fs.realpathSync(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (SKIP_DIRS.has(entry.name)) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) scan(fullPath);
          else files.push(fullPath);
        } catch (e) {
          // broken symlink, skip
        }
      } else if (entry.isDirectory()) {
        scan(fullPath);
      } else {
        files.push(fullPath);
      }
    });
  };
  scan(src);

  files.forEach((file, index) => {
    const relative = path.relative(src, file);
    const destPath = path.join(dest, relative);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(file, destPath);
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
    const realSrcPath = fs.realpathSync(srcPath);
    const realRootSrc = fs.realpathSync(rootSrc);
    if (!realSrcPath.startsWith(realRootSrc)) { skipped++; continue; }

    if (entry.isSymbolicLink() || entry.isDirectory()) {
      const stats = fs.statSync(srcPath);
      if (stats.isDirectory()) {
        const result = copyDirectoryDelta(srcPath, destPath, preservePaths, visited, rootSrc);
        copied += result.copied;
        skipped += result.skipped;
      } else {
        if (isFileChanged(srcPath, destPath)) { fs.copyFileSync(srcPath, destPath); copied++; }
        else skipped++;
      }
    } else {
      if (isFileChanged(srcPath, destPath)) { fs.copyFileSync(srcPath, destPath); copied++; }
      else skipped++;
    }
  }

  return { copied, skipped };
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
