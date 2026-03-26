import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";

const COLORS = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
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

function isBinaryInstalled(name) {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    try {
      execSync(`${cmd} ${name}`, { stdio: "pipe" });
      return true;
    } catch (e) {
      if (process.platform === "win32" && name === "engram") {
        const userProfile = process.env.USERPROFILE || "";
        const manualPath = path.join(userProfile, "go", "bin", "engram.exe");
        return fs.existsSync(manualPath);
      }
      throw e;
    }
  } catch {
    return false;
  }
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

function copyDirectorySync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
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
  isBinaryInstalled,
  getVersion,
  run,
  fileExists,
  copyFileSync,
  copyDirectorySync,
};
