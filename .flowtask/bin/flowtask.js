#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const flowtaskDir = path.resolve(__dirname, "..");

/**
 * FlowTask CLI - Installs FlowTask into the current project
 */

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
    execSync(`which ${name}`, { stdio: "pipe" });
    return true;
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

// ─── Dependency installers ───────────────────────────────────────────────────

function installOpenCode() {
  log("\n  Attempting to install OpenCode...", COLORS.cyan);

  // Try npm global install
  if (isBinaryInstalled("npm")) {
    logInfo("Installing via npm: npm install -g opencode-ai ...");
    const result = run("npm install -g opencode-ai");
    if (result.status === 0 && isBinaryInstalled("opencode")) {
      logSuccess(`OpenCode installed: ${getVersion("opencode")}`);
      return true;
    }
  }

  logError("Could not install OpenCode automatically.");
  log(`
  Please install it manually:
    → https://opencode.ai/docs/
  `);
  return false;
}

function installEngram() {
  log("\n  Attempting to install Engram...", COLORS.cyan);

  const platform = process.platform;

  // ── Windows ─────────────────────────────────────────────────────────────
  if (platform === "win32") {
    logInfo("Detected Windows platform.");

    // Try WinGet first (modern Windows package manager)
    if (isBinaryInstalled("winget")) {
      logInfo("Installing via WinGet: winget install Engram ...");
      const result = run("winget install GentlemanProgramming.Engram");
      if (result.status === 0 && isBinaryInstalled("engram")) {
        logSuccess(`Engram installed: ${getVersion("engram")}`);
        return true;
      }
      logWarn("WinGet install failed. Trying npm...");
    }

    // Try npm global install
    if (isBinaryInstalled("npm")) {
      logInfo("Installing via npm: npm install -g engram-cli ...");
      const result = run("npm install -g engram-cli");
      if (result.status === 0 && isBinaryInstalled("engram")) {
        logSuccess(`Engram installed: ${getVersion("engram")}`);
        return true;
      }
      logWarn("npm install failed. Trying GitHub releases...");
    }

    // Fallback: download from GitHub releases via PowerShell
    return installEngramFromGitHub("win32", process.arch);
  }

  // ── macOS / Linux ───────────────────────────────────────────────────────

  // Try Homebrew first
  if (isBinaryInstalled("brew")) {
    logInfo("Installing via Homebrew: brew install gentleman-programming/tap/engram ...");
    const result = run("brew install gentleman-programming/tap/engram");
    if (result.status === 0 && isBinaryInstalled("engram")) {
      logSuccess(`Engram installed: ${getVersion("engram")}`);
      return true;
    }
    logWarn("Homebrew install failed. Trying GitHub releases...");
  }

  // Fallback: download from GitHub releases
  return installEngramFromGitHub(platform, process.arch);
}

function installEngramFromGitHub(platform, arch) {
  let assetName;
  if (platform === "darwin") {
    assetName = arch === "arm64" ? "engram_darwin_arm64" : "engram_darwin_amd64";
  } else if (platform === "linux") {
    assetName = arch === "arm64" ? "engram_linux_arm64" : "engram_linux_amd64";
  } else if (platform === "win32") {
    assetName = arch === "arm64" ? "engram_windows_arm64.exe" : "engram_windows_amd64.exe";
  } else {
    logError(`Automatic install not supported on platform: ${platform}`);
    log(`
  Please install Engram manually:
    → https://github.com/Gentleman-Programming/engram/releases
    `);
    return false;
  }

  const apiUrl = "https://api.github.com/repos/Gentleman-Programming/engram/releases/latest";
  const isWindows = platform === "win32";
  const installDir = isWindows ? process.env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local" : "/usr/local/bin";
  const tmpDir = isWindows ? (process.env.TEMP || "C:\\Temp") : "/tmp";
  const tmpPath = path.join(tmpDir, assetName);
  const binaryName = isWindows ? "engram.exe" : "engram";

  logInfo(`Fetching latest release info from GitHub...`);

  let downloadUrl;
  try {
    const curlCmd = isWindows ? `curl -s "${apiUrl}"` : `curl -s "${apiUrl}"`;
    const releaseJson = execSync(curlCmd, { stdio: "pipe" }).toString();
    const release = JSON.parse(releaseJson);
    const asset = release.assets?.find(
      (a) => a.name === assetName || a.name === `${assetName}.tar.gz`
    );
    if (!asset) {
      throw new Error(`Asset "${assetName}" not found in latest release`);
    }
    downloadUrl = asset.browser_download_url;
  } catch (err) {
    logError(`Could not fetch release info: ${err.message}`);
    log(`
  Please install Engram manually:
    → https://github.com/Gentleman-Programming/engram/releases
    `);
    return false;
  }

  logInfo(`Downloading: ${downloadUrl}`);

  if (isWindows) {
    // Download via PowerShell or curl
    const dlCmd = `curl -L -o "${tmpPath}" "${downloadUrl}"`;
    const dlResult = run(dlCmd);
    if (dlResult.status !== 0) {
      logError("Download failed.");
      return false;
    }

    // Add to PATH or move to known location
    const destDir = path.join(installDir, "FlowTask", "engram");
    try {
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(tmpPath, path.join(destDir, binaryName));
      logSuccess(`Engram installed to: ${destDir}`);

      // Configure PATH automatically via PowerShell
      logInfo("Configuring PATH variable...");
      try {
        const pathCmd = `powershell -Command "[Environment]::SetEnvironmentVariable('PATH', [Environment]::GetEnvironmentVariable('PATH', 'User') + ';${destDir}', 'User')"`;
        const pathResult = run(pathCmd);
        if (pathResult.status === 0) {
          logSuccess("PATH configured successfully.");
          logInfo("Restart your terminal for changes to take effect.");
        } else {
          logWarn("Could not configure PATH automatically.");
          logInfo(`Add "${destDir}" to your PATH manually.`);
          logInfo(`Or run: setx PATH "%PATH%;${destDir}"`);
        }
      } catch (pathErr) {
        logWarn("Could not configure PATH automatically.");
        logInfo(`Add "${destDir}" to your PATH manually.`);
        logInfo(`Or run: setx PATH "%PATH%;${destDir}"`);
      }

      return true;
    } catch (err) {
      logError(`Failed to copy binary: ${err.message}`);
      return false;
    }
  } else {
    // macOS / Linux
    const dlResult = run(`curl -L -o "${tmpPath}" "${downloadUrl}"`);
    if (dlResult.status !== 0) {
      logError("Download failed.");
      return false;
    }

    // Handle .tar.gz
    if (downloadUrl.endsWith(".tar.gz")) {
      run(`tar -xzf "${tmpPath}" -C /tmp`);
    }

    const binaryTmp = downloadUrl.endsWith(".tar.gz") ? `/tmp/engram` : tmpPath;
    run(`chmod +x "${binaryTmp}"`);

    logInfo(`Moving binary to ${installDir}/engram (may require sudo)...`);
    const mvResult = run(`mv "${binaryTmp}" "${installDir}/engram"`);
    if (mvResult.status !== 0) {
      logWarn("Could not move without sudo, retrying with sudo...");
      const sudoResult = run(`sudo mv "${binaryTmp}" "${installDir}/engram"`);
      if (sudoResult.status !== 0) {
        logError("Failed to install Engram binary.");
        return false;
      }
    }

    if (isBinaryInstalled("engram")) {
      logSuccess(`Engram installed: ${getVersion("engram")}`);
      return true;
    }

    logError("Engram binary not found after install attempt.");
    return false;
  }
}

// ─── Main install ────────────────────────────────────────────────────────────

async function install() {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Installation Wizard       ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  // ── Step 1: OpenCode ─────────────────────────────────────────────────────
  logStep(1, "Checking OpenCode...");

  if (isBinaryInstalled("opencode")) {
    logSuccess(`OpenCode is installed (${getVersion("opencode")})`);
  } else {
    logWarn("OpenCode is not installed. Trying to install automatically...");
    const installed = installOpenCode();
    if (!installed) {
      logError("OpenCode is required. Aborting installation.");
      process.exit(1);
    }
  }

  // ── Step 2: Engram ───────────────────────────────────────────────────────
  logStep(2, "Checking Engram...");

  if (isBinaryInstalled("engram")) {
    logSuccess(`Engram is installed (${getVersion("engram")})`);
  } else {
    logWarn("Engram is not installed. Trying to install automatically...");
    const installed = installEngram();
    if (!installed) {
      logWarn("Engram could not be installed automatically.");
      logWarn("FlowTask will be installed anyway, but Engram must be installed before use.");
    }
  }

  // ── Step 3: Detect project directory ────────────────────────────────────
  logStep(3, "Detecting project directory...");

  const projectDir = process.cwd();
  logSuccess(`Project directory: ${projectDir}`);

  // ── Step 4: Check existing installation ─────────────────────────────────
  logStep(4, "Checking existing installation...");

  const existingOpencode = path.join(projectDir, "opencode.json");
  const existingFlowtask = path.join(projectDir, ".flowtask");

  if (fileExists(existingOpencode) || fileExists(existingFlowtask)) {
    logWarn("FlowTask appears to be already installed in this project.");
    log(`
    Files found:
    - opencode.json: ${fileExists(existingOpencode) ? "Yes" : "No"}
    - .flowtask/:    ${fileExists(existingFlowtask) ? "Yes" : "No"}
    `);

    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise((resolve) => {
      rl.question(
        `    ${COLORS.yellow}Do you want to overwrite existing files? (y/N): ${COLORS.reset}`,
        resolve
      );
    });
    rl.close();

    if (answer.toLowerCase() !== "y") {
      log("\nInstallation cancelled.", COLORS.yellow);
      process.exit(0);
    }
  }

  // ── Step 5: Copy files ───────────────────────────────────────────────────
  logStep(5, "Installing FlowTask files...");

  // Copy opencode.json
  const srcOpencode = path.join(flowtaskDir, "..", "opencode.json");
  const destOpencode = path.join(projectDir, "opencode.json");
  if (fileExists(srcOpencode)) {
    copyFileSync(srcOpencode, destOpencode);
  }

  // Copy .flowtask directory
  const srcFlowtask = flowtaskDir;
  const destFlowtask = path.join(projectDir, ".flowtask");
  copyDirectorySync(srcFlowtask, destFlowtask);

  // Copy skills to .opencode/skills/ (OpenCode discovery path)
  const srcSkills = path.join(flowtaskDir, "skills");
  const destSkills = path.join(projectDir, ".opencode", "skills");
  if (fileExists(srcSkills)) {
    logInfo("Copying skills to .opencode/skills/...");
    copyDirectorySync(srcSkills, destSkills);
  }

  // ── Step 6: Summary ──────────────────────────────────────────────────────
  console.log(`
${COLORS.green}╔═══════════════════════════════════════════╗
║        Installation Complete!             ║
╚═══════════════════════════════════════════╝${COLORS.reset}

FlowTask has been installed in: ${projectDir}

Next steps:
  1. Run: opencode
  2. Initialize: /init
  3. Create CA: /new-ca CA-001
  4. Run workflow: /run CA-001

For more information, check the README.md in your project.
`);

// ─── CLI handler ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] || "install";

switch (command) {
  case "install":
    install();
    break;

  case "--help":
  case "-h":
    console.log(`
FlowTask CLI

Usage:
  flowtask install    Install FlowTask in the current project
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install    Install FlowTask in current directory
    `);
    break;

  case "--version":
  case "-v": {
    const pkgPath = path.join(flowtaskDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log(pkg.version);
    break;
  }

  default:
    logError(`Unknown command: ${command}`);
    log("Run 'flowtask --help' for usage information.");
    process.exit(1);
}
