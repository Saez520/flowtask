import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";

const COLORS = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

function log(message, color = COLORS.reset) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function logStep(step, message) {
  console.log(`\n${COLORS.blue}[${step}]${COLORS.reset} ${message}`);
}

function logSuccess(message) {
  log(`✓ ${message}`, COLORS.green);
}

function logError(message) {
  log(`✗ ${message}`, COLORS.red);
}

function logWarn(message) {
  log(`⚠ ${message}`, COLORS.yellow);
}

function logInfo(message) {
  log(`  ${message}`, COLORS.cyan);
}

/**
 * Resolve an executable on PATH. This only checks command availability; it
 * does not prove that the command's service or runtime is operational.
 */
function findExecutable(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, [name], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim().split(/\r?\n/)[0] || null;
    if (process.platform === "win32" && name === "engram") {
      const userProfile = process.env.USERPROFILE || "";
      const manualPath = path.join(userProfile, "go", "bin", "engram.exe");
      return fs.existsSync(manualPath) ? manualPath : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isBinaryInstalled(name) {
  return findExecutable(name) !== null;
}

function getVersion(name) {
  try {
    return execSync(`${name} --version`, { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: "inherit", ...opts });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function copyFileSync(src, dest) {
  fs.copyFileSync(src, dest);
  logSuccess(`Copied: ${path.basename(src)}`);
}

function copyDirectorySync(src, dest, visited = new Set(), rootSrc = null) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Track root source directory for tree boundary checking
  if (!rootSrc) rootSrc = src;

  // Track visited directories to prevent infinite recursion from circular symlinks
  const realSrc = fs.realpathSync(src);
  if (visited.has(realSrc)) {
    return; // Skip already-visited directories (circular symlink)
  }
  visited.add(realSrc);

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Check if path escapes the source tree (security boundary)
    const realSrcPath = fs.realpathSync(srcPath);
    const realRootSrc = fs.realpathSync(rootSrc);
    if (!realSrcPath.startsWith(realRootSrc)) {
      // Symlink points outside the tree - skip for safety
      continue;
    }

    if (entry.isSymbolicLink()) {
      // Check if symlink points to a directory or file
      const stats = fs.statSync(srcPath);
      if (stats.isDirectory()) {
        // For directory symlinks, copy contents (if within tree)
        copyDirectorySync(srcPath, destPath, visited, rootSrc);
      } else {
        // For file symlinks, copy the file content
        fs.copyFileSync(srcPath, destPath);
        logSuccess(`Copied: ${entry.name}`);
      }
    } else if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath, visited, rootSrc);
    } else {
      fs.copyFileSync(srcPath, destPath);
      logSuccess(`Copied: ${entry.name}`);
    }
  }
}

export {
  COLORS,
  log,
  logStep,
  logSuccess,
  logError,
  logWarn,
  logInfo,
  findExecutable,
  isBinaryInstalled,
  getVersion,
  run,
  fileExists,
  copyFileSync,
  copyDirectorySync,
};
