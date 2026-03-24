import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
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
} from "./logger.js";

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

async function install(flowtaskDir) {
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

  // ── Step 5.5: Handle OpenCode adapter plugin (optional) ────────────────
  logStep(5.5, "Checking for OpenCode adapter plugin...");
  const pluginSrcDir = path.join(flowtaskDir, "plugins", "flowtask-classifier");
  const pluginDestDir = path.join(destFlowtask, "plugins", "flowtask-classifier");
  if (fileExists(pluginSrcDir)) {
    const pluginPackagePath = path.join(pluginSrcDir, "package.json");
    if (fileExists(pluginPackagePath)) {
      try {
        const pluginPackage = JSON.parse(fs.readFileSync(pluginPackagePath, "utf8"));
        const pluginName = pluginPackage.name || "flowtask-classifier";
        
        logInfo("Linking OpenCode adapter plugin: " + pluginName);
        
        // El plugin ya fue copiado a destFlowtask en Step 5
        // Ahora linkeamos desde el proyecto destino (no desde el código fuente)
        try {
          execSync("npm list " + pluginName, { stdio: "ignore", cwd: projectDir });
          logInfo("Plugin " + pluginName + " already linked in project");
        } catch (e) {
          // Linkear desde el plugin ya copiado en el proyecto destino
          logInfo("Linking " + pluginName + " from copied plugin...");
          const projectLinkResult = run("npm link " + pluginName, { cwd: pluginDestDir });
          if (projectLinkResult.status !== 0) {
            logWarn("Failed to link " + pluginName + " in project");
          } else {
            logSuccess("Linked " + pluginName + " in project");
          }
        }
        
        logSuccess("OpenCode adapter plugin " + pluginName + " linked successfully");
      } catch (err) {
        logWarn("Could not process OpenCode adapter plugin: " + err.message);
        logInfo("Core FlowTask installation continues without OpenCode adapter.");
      }
    } else {
      logWarn("OpenCode adapter plugin package.json not found");
    }
  } else {
    logInfo("OpenCode adapter plugin not found - continuing with core only");
  }

  // ── Step 6: Update documentation and persist method ─────────────────────
  logStep(6, "Updating documentation and persisting installation method...");

  // Update README.md
  const readmePath = path.join(projectDir, "README.md");
  if (fileExists(readmePath)) {
    try {
      let readmeContent = fs.readFileSync(readmePath, "utf8");
      
      // Check if we already have the unified installation section
      const unifiedSectionStart = readmeContent.indexOf("## Unified Installation with FlowTask");
      if (unifiedSectionStart === -1) {
        const installSectionMatch = readmeContent.match(/^## Installation\s*$/m);
        let insertPos = readmeContent.length;
        
        if (installSectionMatch) {
          const nextHeaderMatch = readmeContent.slice(installSectionMatch.index).match(/^##\s+/m);
          if (nextHeaderMatch) {
            insertPos = installSectionMatch.index + nextHeaderMatch.index + nextHeaderMatch[0].length;
          } else {
            insertPos = installSectionMatch.index + installSectionMatch[0].length;
          }
        }
        
        const unifiedSection = `

## Unified Installation with FlowTask

This installation method provides a unified FlowTask experience:

### What gets installed:
- FlowTask Core: Agents, skills, commands, and Engram system copied as source code (IDE-agnostic)
- OpenCode Adapter: The flowtask-classifier plugin optionally linked via npm link for OpenCode users

### How it works:
1. FlowTask core components are copied directly to your project (.flowtask/ directory)
2. Skills are made available to OpenCode via .opencode/skills/
3. The OpenCode adapter plugin (flowtask-classifier) is linked via npm link (if present)
4. This approach keeps the FlowTask business logic decoupled from any specific IDE

### Benefits:
- Core logic remains IDE-agnostic and reusable with any frontend
- OpenCode users get seamless plugin integration
- Single command installation: flowtask install
- Idempotent - safe to run multiple times
- Easy to unlink OpenCode adapter if needed: npm unlink flowtask-classifier

---
`;
        readmeContent = readmeContent.slice(0, insertPos) + unifiedSection + readmeContent.slice(insertPos);
        
        fs.writeFileSync(readmePath, readmeContent, "utf8");
        logSuccess("README.md updated with unified installation instructions");
      } else {
        logInfo("Unified installation section already exists in README.md");
      }
    } catch (err) {
      logWarn("Could not update README.md: " + err.message);
    }
  } else {
    logWarn("README.md not found - skipping documentation update");
  }

  // Persist method in Engram
  try {
    const engramMarkerPath = path.join(projectDir, ".flowtask", ".installation-method");
    const markerContent = JSON.stringify({
      method: "unified-installation-v1",
      timestamp: new Date().toISOString(),
      description: "FlowTask installed as unified application: core as source + OpenCode adapter via npm link (optional)",
      components: {
        core: ["agents", "skills", "commands"],
        openCodeAdapter: "flowtask-classifier (optional via npm link)"
      }
    }, null, 2);
    
    fs.writeFileSync(engramMarkerPath, markerContent, "utf8");
    logSuccess("Installation method persisted");
  } catch (err) {
    logWarn("Could not persist installation method: " + err.message);
  }

  // ── Step 7: Summary ──────────────────────────────────────────────────────
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
}

export { install };
