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
 * Finds the FlowTask opencode.json config file in multiple possible locations
 * @param {string} flowtaskDir - The FlowTask installation directory
 * @returns {string|null} - Path to the config file or null if not found
 */
function findOpencodeConfig(flowtaskDir) {
  // Possible locations for the FlowTask opencode.json config
  const possiblePaths = [
    // 1. Inside FlowTask directory (flowtaskDir/opencode.json)
    path.join(flowtaskDir, "opencode.json"),
    // 2. Inside FlowTask config subdirectory (flowtaskDir/config/opencode.json)
    path.join(flowtaskDir, "config", "opencode.json"),
    // 3. One level up from FlowTask directory (original location for dev)
    path.join(flowtaskDir, "..", "opencode.json"),
    // 4. In .opencode/ at the same level as flowtask (flowtaskDir/../.opencode/opencode.json)
    path.join(flowtaskDir, "..", ".opencode", "opencode.json"),
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      logInfo(`Found FlowTask config at: ${configPath}`);
      return configPath;
    }
  }

  logWarn("Could not find FlowTask opencode.json configuration file");
  return null;
}

/**
 * Deep merge two objects, with source values taking precedence
 * @param {Object} target - Target object
 * @param {Object} source - Source object to merge in
 * @returns {Object} - Merged result
 */
function deepMergeObjects(target, source) {
  const result = { ...target };
  
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];
    
    if (sourceValue === undefined) continue;
    
    if (
      typeof sourceValue === "object" && 
      sourceValue !== null && 
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" && 
      targetValue !== null && 
      !Array.isArray(targetValue)
    ) {
      // Both are objects, recursively merge
      result[key] = deepMergeObjects(targetValue, sourceValue);
    } else {
      // Otherwise use source value (overwrites)
      result[key] = sourceValue;
    }
  }
  
  return result;
}

/**
 * Adjusts file paths in config to point to the correct location after installation
 * @param {any} config - The config object to adjust
 * @param {string} flowtaskDir - Source flowtask directory
 * @param {string} targetSubDir - Target subdirectory (e.g., .opencode/flowtask)
 */
function adjustConfigPaths(config, flowtaskDir, targetSubDir) {
  if (!config || typeof config !== "object") return config;

  // Normalize targetSubDir to use forward slashes for consistency
  const normalizedTarget = targetSubDir.replace(/\\/g, "/");

  const adjustString = (str) => {
    if (typeof str !== "string") return str;
    // Skip if already contains targetSubDir (avoid double nesting)
    if (str.includes(normalizedTarget)) return str;
    // Adjust {file:.flowtask/...} paths to {file:flowtask/...} (relative to .opencode/)
    // Example: {file:.flowtask/agents/runner.md} -> {file:flowtask/agents/runner.md}
    return str.replace(/\{file:\.flowtask\//g, "{file:flowtask/");
  };

  const adjustValue = (value) => {
    if (typeof value === "string") {
      return adjustString(value);
    } else if (Array.isArray(value)) {
      return value.map(adjustValue);
    } else if (typeof value === "object" && value !== null) {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = adjustValue(v);
      }
      return result;
    }
    return value;
  };

  return adjustValue(config);
}

/**
 * Merges FlowTask config into IDE opencode.json
 */
function mergeOpencodeConfig(ideConfigPath, flowtaskDir, ideDir) {
  const flowtaskOpencodePath = findOpencodeConfig(flowtaskDir);
  if (!flowtaskOpencodePath) return;

  logInfo(`Merging FlowTask configuration into ${ideConfigPath}...`);

  try {
    const ftConfig = JSON.parse(fs.readFileSync(flowtaskOpencodePath, "utf8"));
    let ideConfig = {};

    if (fs.existsSync(ideConfigPath)) {
      const existingContent = fs.readFileSync(ideConfigPath, "utf8").trim();
      if (existingContent) {
        try {
          ideConfig = JSON.parse(existingContent);
        } catch (e) {
          logWarn(`Existing opencode.json is invalid, starting fresh.`);
          ideConfig = {};
        }
      }
    }

    // Determine target subdirectory for path adjustments
    // e.g., flowtaskDir = ".opencode/flowtask", ideDir = ".opencode"
    // targetSubDir = ".opencode/flowtask"
    const targetSubDir = path.join(ideDir, "flowtask");

    // Deep merge: mcp, agent, command, plugin from FlowTask config
    // These are the main sections we want to merge
    const sectionsToMerge = ["mcp", "agent", "command", "plugin"];
    
    for (const section of sectionsToMerge) {
      if (ftConfig[section]) {
        // Adjust paths in the section before merging
        const adjustedSection = adjustConfigPaths(ftConfig[section], flowtaskDir, targetSubDir);
        
        if (!ideConfig[section]) {
          ideConfig[section] = adjustedSection;
        } else if (section === "plugin") {
          // For plugins, merge arrays and avoid duplicates
          const existingPlugins = Array.isArray(ideConfig[section]) ? ideConfig[section] : [];
          const newPlugins = Array.isArray(adjustedSection) ? adjustedSection : [];
          ideConfig[section] = [...existingPlugins, ...newPlugins];
        } else {
          // For other sections (mcp, agent, command), deep merge objects
          ideConfig[section] = deepMergeObjects(ideConfig[section], adjustedSection);
        }
      }
    }

    // Add $schema if missing
    if (!ideConfig.$schema) {
      ideConfig.$schema = "https://opencode.ai/config.json";
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
        const ideConfigPath = path.join(projectDir, ideDir, "opencode.json");
        mergeOpencodeConfig(ideConfigPath, flowtaskDir, ideDir);
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

/**
 * Check if a file has changed compared to destination
 * @param {string} srcPath - Source file path
 * @param {string} destPath - Destination file path
 * @returns {boolean} - True if file has changed or doesn't exist at destination
 */
function isFileChanged(srcPath, destPath) {
  if (!fs.existsSync(destPath)) {
    return true; // Destination doesn't exist, needs copy
  }

  const srcStat = fs.statSync(srcPath);
  const destStat = fs.statSync(destPath);

  // Compare size and modification time
  if (srcStat.size !== destStat.size) {
    return true;
  }

  // Allow 1-second difference for filesystem precision
  if (Math.abs(srcStat.mtimeMs - destStat.mtimeMs) > 1000) {
    return true;
  }

  return false;
}

/**
 * Copy directory with delta detection (only changed files)
 * @param {string} src - Source directory
 * @param {string} dest - Destination directory
 * @param {Array<string>} preservePaths - Paths to preserve (not overwrite)
 * @param {Set<string>} visited - Track visited paths to avoid circular symlinks
 * @param {string} rootSrc - Root source directory for tree boundary checking
 * @returns {Object} - Stats { copied, skipped }
 */
function copyDirectoryDelta(src, dest, preservePaths = [], visited = new Set(), rootSrc = null) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  // Track root source directory for tree boundary checking
  if (!rootSrc) rootSrc = src;

  // Track visited directories to prevent infinite recursion from circular symlinks
  const realSrc = fs.realpathSync(src);
  if (visited.has(realSrc)) {
    return { copied: 0, skipped: 0 }; // Skip already-visited directories
  }
  visited.add(realSrc);

  let copied = 0;
  let skipped = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Check if this path should be preserved
    if (preservePaths.some(p => destPath.includes(p))) {
      skipped++;
      continue;
    }

    // Check if path escapes the source tree (security boundary)
    const realSrcPath = fs.realpathSync(srcPath);
    const realRootSrc = fs.realpathSync(rootSrc);
    if (!realSrcPath.startsWith(realRootSrc)) {
      // Symlink points outside the tree - skip for safety
      skipped++;
      continue;
    }

    if (entry.isSymbolicLink()) {
      // Handle symlinks: copy the target content
      const stats = fs.statSync(srcPath);
      if (stats.isDirectory()) {
        const result = copyDirectoryDelta(srcPath, destPath, preservePaths, visited, rootSrc);
        copied += result.copied;
        skipped += result.skipped;
      } else {
        if (isFileChanged(srcPath, destPath)) {
          fs.copyFileSync(srcPath, destPath);
          copied++;
        } else {
          skipped++;
        }
      }
    } else if (entry.isDirectory()) {
      const result = copyDirectoryDelta(srcPath, destPath, preservePaths, visited, rootSrc);
      copied += result.copied;
      skipped += result.skipped;
    } else {
      if (isFileChanged(srcPath, destPath)) {
        fs.copyFileSync(srcPath, destPath);
        copied++;
      } else {
        skipped++;
      }
    }
  }

  return { copied, skipped };
}

/**
 * Update FlowTask installation (delta-only sync)
 * @param {string} flowtaskDir - The FlowTask source directory
 */
async function update(flowtaskDir) {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Update Wizard (Delta)     ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const projectDir = process.cwd();
  
  // ── Step 1: Detect installed targets ────────────────────────────────────
  logStep(1, "Detecting installed targets...");
  
  const targets = [];
  const possibleTargets = [
    { id: "standalone", marker: ".flowtask/.installation-method", subDir: ".flowtask" },
    { id: "opencode", marker: ".opencode/flowtask/.installation-method", subDir: ".opencode/flowtask" },
    { id: "vscode", marker: ".vscode/flowtask/.installation-method", subDir: ".vscode/flowtask" },
  ];

  for (const target of possibleTargets) {
    const markerPath = path.join(projectDir, target.marker);
    if (fs.existsSync(markerPath)) {
      try {
        const method = JSON.parse(fs.readFileSync(markerPath, "utf8"));
        targets.push({ 
          id: target.id, 
          subDir: target.subDir,
          previousMethod: method 
        });
        logSuccess(`Found ${target.id} installation`);
      } catch (err) {
        logWarn(`Could not read installation marker for ${target.id}`);
      }
    }
  }

  if (targets.length === 0) {
    logError("No FlowTask installation found. Run 'flowtask install' first.");
    return;
  }

  // ── Step 2: Update each target (delta sync) ─────────────────────────────
  const results = [];
  const preservePaths = ["CA-", "workspace", ".workspace", ".installation-method"];

  for (const target of targets) {
    const { id, subDir } = target;
    const TARGET_DIR = path.join(projectDir, subDir);
    
    logStep(2, `Updating ${id}...`);
    
    try {
      if (!fs.existsSync(TARGET_DIR)) {
        throw new Error(`Target directory not found: ${subDir}`);
      }

      // Copy with delta detection
      const stats = copyDirectoryDelta(flowtaskDir, TARGET_DIR, preservePaths);
      
      logSuccess(`Updated ${stats.copied} files, ${stats.skipped} unchanged`);

      // Update installation method marker
      const markerPath = path.join(TARGET_DIR, ".installation-method");
      fs.writeFileSync(markerPath, JSON.stringify({
        method: "unified-installation-v2",
        target: id,
        updatedAt: new Date().toISOString(),
        previousUpdate: target.previousMethod?.updatedAt || target.previousMethod?.timestamp || null,
        filesUpdated: stats.copied,
        filesSkipped: stats.skipped
      }, null, 2));

      results.push({ target: id, status: "Success", stats });
    } catch (err) {
      logError(`Failed to update ${id}: ${err.message}`);
      results.push({ target: id, status: "Error", message: err.message });
    }
  }

  // ── Final Report ─────────────────────────────────────────────────────────
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║            Update Summary                 ║
╚═══════════════════════════════════════════╝${COLORS.reset}`);
  results.forEach(res => {
    const color = res.status === "Success" ? COLORS.green : COLORS.red;
    const stats = res.stats ? `(${res.stats.copied} updated, ${res.stats.skipped} preserved)` : "";
    console.log(`  - ${res.target.toUpperCase()}: ${color}${res.status}${COLORS.reset}${stats}${res.message ? ` (${res.message})` : ""}`);
  });

  if (results.some(r => r.status === "Success")) {
    logSuccess("\nFlowTask update completed successfully!");
  } else {
    logError("\nFlowTask update failed.");
  }
}

export { install, update };
