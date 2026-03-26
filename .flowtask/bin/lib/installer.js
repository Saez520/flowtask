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
  log("\n  Checking OpenCode installation...", COLORS.cyan);

  if (isBinaryInstalled("opencode")) {
    logSuccess(`OpenCode is already installed: ${getVersion("opencode")}`);
    return true;
  }

  logWarn("OpenCode is not installed.");
  log(`
  Please download and install it manually from:
    → https://opencode.ai/download
  `);
  return false;
}

// ─── Main install ────────────────────────────────────────────────────────────

/**
 * Deep merge of two objects.
 * @param {Object} target
 * @param {Object} source
 * @returns {Object}
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  Object.assign(target || {}, source);
  return target;
}

/**
 * Merges FlowTask config into IDE opencode.json
 */
function mergeOpencodeConfig(ideConfigPath, flowtaskOpencodePath, ideDir) {
  if (!fs.existsSync(flowtaskOpencodePath)) return;

  logInfo(`Merging FlowTask configuration into ${ideConfigPath}...`);

  try {
    const ftConfig = JSON.parse(fs.readFileSync(flowtaskOpencodePath, "utf8"));
    let ideConfig = { commands: [], plugins: [] };

    if (fs.existsSync(ideConfigPath)) {
      ideConfig = JSON.parse(fs.readFileSync(ideConfigPath, "utf8"));
    }

    // Adjust paths in ftConfig to be relative to ideDir
    // ftConfig paths are currently relative to the root where flowtask install was run
    // We need them relative to ideDir (e.g., .opencode/)
    const adjustPath = (p) => {
      if (p.startsWith("./")) {
        // If it's already relative, we assume it's relative to project root.
        // We need it relative to ideDir.
        // Example: p = "./flowtask/bin/flowtask.js", ideDir = ".opencode/"
        // Result should be "./flowtask/bin/flowtask.js" if flowtask/ is inside .opencode/
        return p;
      }
      return p;
    };

    if (ftConfig.commands) {
      ftConfig.commands = ftConfig.commands.map(cmd => {
        if (cmd.bin) cmd.bin = adjustPath(cmd.bin);
        return cmd;
      });

      if (!ideConfig.commands) ideConfig.commands = [];
      
      ftConfig.commands.forEach(ftCmd => {
        const existingIdx = ideConfig.commands.findIndex(c => c.name === ftCmd.name);
        if (existingIdx !== -1) {
          const alias = `ft-${ftCmd.name}`;
          logWarn(`Command conflict: '${ftCmd.name}' already exists. Using alias '${alias}'.`);
          ftCmd.name = alias;
        }
        ideConfig.commands.push(ftCmd);
      });
    }

    if (ftConfig.plugins) {
      if (!ideConfig.plugins) ideConfig.plugins = [];
      ftConfig.plugins.forEach(ftPlug => {
        const existingIdx = ideConfig.plugins.findIndex(p => p.name === ftPlug.name);
        if (existingIdx === -1) {
          ideConfig.plugins.push(ftPlug);
        }
      });
    }

    fs.writeFileSync(ideConfigPath, JSON.stringify(ideConfig, null, 2), "utf8");
    logSuccess(`Configuration merged successfully.`);
  } catch (err) {
    logError(`Failed to merge config: ${err.message}`);
  }
}

async function showInteractiveSelector(readline) {
  const options = [
    { name: "OpenCode (.opencode/flowtask/)", value: "opencode", selected: false },
    { name: "VS Code (.vscode/flowtask/)", value: "vscode", selected: false },
  ];
  let cursor = 0;
  let lastRenderLines = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  const render = () => {
    if (lastRenderLines > 0) {
      readline.moveCursor(process.stdout, 0, -lastRenderLines);
      readline.clearScreenDown(process.stdout);
    }

    const lines = [];
    lines.push(COLORS.cyan + "  Select target IDEs (Space to mark, Enter to confirm):" + COLORS.reset);
    options.forEach((opt, i) => {
      const cursorStr = i === cursor ? COLORS.cyan + "> " + COLORS.reset : "  ";
      const checkStr = opt.selected ? COLORS.green + "[*]" + COLORS.reset : "[ ]";
      lines.push(`${cursorStr}${checkStr} ${opt.name}`);
    });
    lines.push(`\n${COLORS.dim}↑/↓: navegar, Espacio: marcar, Enter: confirmar, Ctrl+C: cancelar${COLORS.reset}`);
    
    const output = lines.join("\n");
    process.stdout.write(output + "\n");
    lastRenderLines = output.split("\n").length;
  };

  const onResize = () => render();
  process.stdout.on("resize", onResize);

  render();

  return new Promise((resolve, reject) => {
    const onKeypress = (str, key) => {
      if (key.ctrl && key.name === "c") {
        process.stdout.removeListener("resize", onResize);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKeypress);
        log("\nInstallation cancelled.", COLORS.yellow);
        process.exit(0);
      }

      if (key.name === "up") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "space") {
        options[cursor].selected = !options[cursor].selected;
        render();
      } else if (key.name === "return") {
        process.stdout.removeListener("resize", onResize);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKeypress);
        
        // Clean up selector before returning
        if (lastRenderLines > 0) {
          readline.moveCursor(process.stdout, 0, -lastRenderLines);
          readline.clearScreenDown(process.stdout);
        }
        
        resolve(options.filter(o => o.selected).map(o => o.value));
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

function renderProgressBar(readline, current, total, label) {
  const width = 20;
  const progress = Math.min(Math.max(current / total, 0), 1);
  const filled = Math.round(width * progress);
  const empty = width - filled;
  
  const bar = COLORS.green + "█".repeat(filled) + COLORS.reset + COLORS.dim + "░".repeat(empty) + COLORS.reset;
  const percentage = Math.round(progress * 100);
  
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`  [${bar}] ${percentage}% ${label}`);
}

async function install(flowtaskDir) {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Installation Wizard       ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const readline = await import("readline");
  
  // ── Step 0: IDE Selection ────────────────────────────────────────────────
  logStep(0, "Select Target Environment");
  
  const selectedOptions = await showInteractiveSelector(readline);
  
  const targets = [];
  if (selectedOptions.length === 0) {
    targets.push({ id: "standalone", ideDir: "", targetSubDir: ".flowtask" });
  } else {
    if (selectedOptions.includes("opencode")) {
      targets.push({ id: "opencode", ideDir: ".opencode", targetSubDir: path.join(".opencode", "flowtask") });
    }
    if (selectedOptions.includes("vscode")) {
      targets.push({ id: "vscode", ideDir: ".vscode", targetSubDir: path.join(".vscode", "flowtask") });
    }
  }

  const projectDir = process.cwd();
  const results = [];

  for (const target of targets) {
    const { id, ideDir, targetSubDir } = target;
    const TARGET_DIR = path.join(projectDir, targetSubDir);
    const isStandalone = id === "standalone";
    
    logInfo(`\nProcessing target: ${id.toUpperCase()} (${targetSubDir})...`);

    try {
      // ── Step 1: OpenCode (Only if OpenCode target) ───────────────────────
      if (id === "opencode") {
        logStep(1, "Checking OpenCode...");
        if (!isBinaryInstalled("opencode")) {
          logWarn("OpenCode is not installed. Trying to install automatically...");
          const installed = installOpenCode();
          if (!installed) {
            throw new Error("OpenCode is required for this target.");
          }
        } else {
          logSuccess(`OpenCode is installed (${getVersion("opencode")})`);
        }
      }

      // ── Step 2: Engram ───────────────────────────────────────────────────
      logStep(2, "Checking Engram...");
      if (isBinaryInstalled("engram")) {
        logSuccess(`Engram is installed (${getVersion("engram")})`);
      } else {
        logWarn("Engram is not installed.");
        logInfo("Please install it manually: https://github.com/Gentleman-Programming/engram/blob/main/docs/INSTALLATION.md");
      }

      // ── Step 3: Check existing installation & Migrate ─────────────────────
      logStep(3, "Checking existing installation...");
      const rootFlowtask = path.join(projectDir, ".flowtask");

      if (fileExists(rootFlowtask) && !isStandalone) {
        logWarn(`Found existing root .flowtask/ directory. Moving to ${targetSubDir}...`);
        if (!fs.existsSync(TARGET_DIR)) {
          fs.mkdirSync(TARGET_DIR, { recursive: true });
        }
        fs.readdirSync(rootFlowtask).forEach(file => {
          const oldPath = path.join(rootFlowtask, file);
          const newPath = path.join(TARGET_DIR, file);
          if (fs.existsSync(newPath)) fs.rmSync(newPath, { recursive: true, force: true });
          fs.renameSync(oldPath, newPath);
        });
        // We don't delete rootFlowtask yet in case other targets need it or if it's multiple targets
        // but for simplicity in this TTY version, we just move.
      }

      // ── Step 4: Copy files ─────────────────────────────────────────────────
      logStep(4, `Installing FlowTask files into ${targetSubDir}...`);
      if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
      }

      // Helper to copy with progress bar
      const copyWithProgress = (src, dest, label) => {
        const files = [];
        const scan = (dir) => {
          fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(fullPath);
            else files.push(fullPath);
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
        
        // Clean up progress bar line
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        logSuccess(`Successfully installed ${label}.`);
      };

      copyWithProgress(flowtaskDir, TARGET_DIR, "FlowTask files");

      if (id === "opencode") {
        const srcSkills = path.join(flowtaskDir, "skills");
        const destSkills = path.join(projectDir, ".opencode", "skills");
        if (fileExists(srcSkills)) {
          copyWithProgress(srcSkills, destSkills, "Skills");
        }
        const srcOpencodeJson = path.join(flowtaskDir, "..", "opencode.json");
        const ideConfigPath = path.join(projectDir, ideDir, "opencode.json");
        mergeOpencodeConfig(ideConfigPath, srcOpencodeJson, ideDir);
      }

      // ── Step 5: Adapter Plugin ─────────────────────────────────────────────
      logStep(5, "Linking OpenCode adapter plugin...");
      const pluginDestDir = path.join(TARGET_DIR, "plugins", "flowtask-classifier");
      if (fileExists(pluginDestDir)) {
        const pluginPackagePath = path.join(pluginDestDir, "package.json");
        if (fileExists(pluginPackagePath)) {
          const pluginPackage = JSON.parse(fs.readFileSync(pluginPackagePath, "utf8"));
          const pluginName = pluginPackage.name;
          run(`npm link ${pluginName}`, { cwd: pluginDestDir });
          logSuccess(`Plugin ${pluginName} linked.`);
        }
      }

      // ── Step 6: Persist method ─────────────────────────────────────────────
      const engramMarkerPath = path.join(TARGET_DIR, ".installation-method");
      fs.writeFileSync(engramMarkerPath, JSON.stringify({
        method: "unified-installation-v2",
        target: id,
        timestamp: new Date().toISOString()
      }, null, 2));

      results.push({ target: id, status: "Success" });
    } catch (err) {
      logError(`Failed to install in ${id}: ${err.message}`);
      results.push({ target: id, status: "Error", message: err.message });
    }
  }

  // Cleanup old .flowtask if it was migrated and is now empty
  const rootFT = path.join(projectDir, ".flowtask");
  if (fileExists(rootFT) && targets.some(t => t.id !== "standalone")) {
     try { if (fs.readdirSync(rootFT).length === 0) fs.rmdirSync(rootFT); } catch(e) {}
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  console.log(`\n${COLORS.blue}╔═══════════════════════════════════════════╗
║           Installation Summary            ║
╚═══════════════════════════════════════════╝${COLORS.reset}`);
  results.forEach(res => {
    const color = res.status === "Success" ? COLORS.green : COLORS.red;
    console.log(`  - ${res.target.toUpperCase()}: ${color}${res.status}${COLORS.reset}${res.message ? ` (${res.message})` : ""}`);
  });

  if (results.some(r => r.status === "Success")) {
    logSuccess("\nFlowTask installation completed successfully!");
  } else {
    logError("\nFlowTask installation failed.");
  }
}

export { install };
