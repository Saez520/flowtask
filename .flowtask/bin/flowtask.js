#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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

function verifyOpenCode() {
  try {
    execSync("which opencode", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function verifyEngram() {
  try {
    execSync("which engram", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
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

function install() {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Installation Wizard         ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  // Step 1: Verify dependencies
  logStep(1, "Verifying dependencies...");

  const opencodeInstalled = verifyOpenCode();
  if (!opencodeInstalled) {
    logError("OpenCode is not installed.");
    log(`
    Please install OpenCode first:
    Visit: https://opencode.ai/docs/
    `);
    process.exit(1);
  }
  logSuccess("OpenCode is installed");

  const engramInstalled = verifyEngram();
  if (!engramInstalled) {
    logWarn("Engram is not installed.");
    log(`
    Install Engram with:
    brew install gentleman-programming/tap/engram
    
    Or download from:
    https://github.com/Gentleman-Programming/engram/releases
    `);
  } else {
    logSuccess("Engram is installed");
  }

  // Step 2: Detect project directory
  logStep(2, "Detecting project directory...");

  const projectDir = process.cwd();
  logSuccess(`Project directory: ${projectDir}`);

  // Step 3: Check if already installed
  logStep(3, "Checking existing installation...");

  const existingOpencode = path.join(projectDir, "opencode.json");
  const existingFlowtask = path.join(projectDir, ".flowtask");

  if (fileExists(existingOpencode) || fileExists(existingFlowtask)) {
    logWarn("FlowTask appears to be already installed in this project.");
    log(`
    Files found:
    - opencode.json: ${fileExists(existingOpencode) ? "Yes" : "No"}
    - .flowtask/: ${fileExists(existingFlowtask) ? "Yes" : "No"}
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

  // Step 4: Copy files
  logStep(4, "Installing FlowTask files...");

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

  // Step 5: Summary
  console.log(`
${COLORS.green}╔═══════════════════════════════════════════╗
║        Installation Complete!              ║
╚═══════════════════════════════════════════╝${COLORS.reset}

FlowTask has been installed in: ${projectDir}

Next steps:
  1. Run: opencode
  2. Initialize: /init
  3. Create CA: /new-ca CA-001
  4. Run workflow: /run CA-001

For more information, check the README.md in your project.
`);
}

// Main CLI handler
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
  flowtask --help    Show this help message
  flowtask --version Show version

Examples:
  flowtask install    Install FlowTask in current directory
    `);
    break;

  case "--version":
  case "-v":
    const pkg = JSON.parse(
      fs.readFileSync(path.join(flowtaskDir, "package.json"), "utf8")
    );
    console.log(pkg.version);
    break;

  default:
    logError(`Unknown command: ${command}`);
    log("Run 'flowtask --help' for usage information.");
    process.exit(1);
}
