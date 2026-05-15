import fs from "fs";
import path from "path";
import {
  COLORS, log, logStep, logSuccess, logError, logWarn, logInfo,
  isBinaryInstalled, getVersion, run, fileExists,
} from "./logger.js";
import { copyWithProgress, copyDirectoryDelta } from "./copy.js";
import { mergeOpencodeConfig } from "./opencode.js";
import { generateClaudeAgents, generateClaudeCommands, generateClaudeMd, mergeClaudeSettings } from "./claude.js";
import { showInteractiveSelector } from "./ui.js";

// ─── Asset map ────────────────────────────────────────────────────────────────
// Defines exactly what gets copied into each target directory.
// Format: { src: relative to flowtaskDir, dest: relative to TARGET_DIR | null for custom dest }
//
// opencode  → .opencode/flowtask/  : agents/, plugins/
//             .opencode/skills/    : skills/  (custom dest)
// claude    → .claude/flowtask/    : skills/  (agents & commands are generated, not copied)
// standalone → .flowtask/          : agents/, commands/, skills/, plugins/

const ASSETS = {
  opencode: [
    { src: "agents",  dest: "agents" },
    { src: "plugins", dest: "plugins" },
  ],
  claude: [
    { src: "skills",  dest: "skills" },
  ],
  standalone: [
    { src: "agents",   dest: "agents" },
    { src: "commands", dest: "commands" },
    { src: "skills",   dest: "skills" },
    { src: "plugins",  dest: "plugins" },
  ],
  // vscode mirrors standalone for now
  vscode: [
    { src: "agents",   dest: "agents" },
    { src: "commands", dest: "commands" },
    { src: "skills",   dest: "skills" },
    { src: "plugins",  dest: "plugins" },
  ],
};

// ─── Dependency checks ────────────────────────────────────────────────────────

function checkOpenCode() {
  if (isBinaryInstalled("opencode")) {
    logSuccess(`OpenCode is installed (${getVersion("opencode")})`);
    return true;
  }
  logWarn("OpenCode is not installed.");
  log(`\n  Please download and install it manually from:\n    → https://opencode.ai/download\n`);
  return false;
}

function checkClaudeCode() {
  if (!isBinaryInstalled("claude")) {
    logWarn("Claude Code CLI is not installed.");
    log(`\n  Please install it from:\n    → https://claude.ai/code\n`);
  } else {
    logSuccess(`Claude Code is installed (${getVersion("claude")})`);
  }
}

function checkEngram() {
  if (isBinaryInstalled("engram")) {
    logSuccess(`Engram is installed (${getVersion("engram")})`);
  } else {
    logWarn("Engram is not installed.");
    logInfo("Install it: https://github.com/Gentleman-Programming/engram/blob/main/docs/INSTALLATION.md");
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

export async function install(flowtaskDir) {
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
    if (selectedOptions.includes("opencode")) targets.push({ id: "opencode", ideDir: ".opencode", targetSubDir: path.join(".opencode", "flowtask") });
    if (selectedOptions.includes("vscode"))   targets.push({ id: "vscode",   ideDir: ".vscode",   targetSubDir: path.join(".vscode",   "flowtask") });
    if (selectedOptions.includes("claude"))   targets.push({ id: "claude",   ideDir: ".claude",   targetSubDir: path.join(".claude",   "flowtask") });
  }

  const projectDir = process.cwd();
  const results = [];

  for (const { id, ideDir, targetSubDir } of targets) {
    const TARGET_DIR = path.join(projectDir, targetSubDir);
    logInfo(`\nProcessing target: ${id.toUpperCase()} (${targetSubDir})...`);

    try {
      // ── Step 1: IDE check ────────────────────────────────────────────────
      logStep(1, `Checking ${id}...`);
      if (id === "opencode" && !checkOpenCode()) throw new Error("OpenCode is required for this target.");
      if (id === "claude") checkClaudeCode();

      // ── Step 2: Engram ───────────────────────────────────────────────────
      logStep(2, "Checking Engram...");
      checkEngram();

      // ── Step 3: Migrate legacy root .flowtask/ if present ────────────────
      logStep(3, "Checking existing installation...");
      const rootFlowtask = path.join(projectDir, ".flowtask");
      const isSourceDir = path.resolve(rootFlowtask) === path.resolve(flowtaskDir);
      if (id !== "standalone" && !isSourceDir && fileExists(rootFlowtask)) {
        logWarn(`Found root .flowtask/ — moving contents to ${targetSubDir}...`);
        if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });
        fs.readdirSync(rootFlowtask).forEach((file) => {
          const src = path.join(rootFlowtask, file);
          const dst = path.join(TARGET_DIR, file);
          if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
          fs.renameSync(src, dst);
        });
      }

      // ── Step 4: Copy only the required assets ────────────────────────────
      logStep(4, `Installing assets into ${targetSubDir}...`);
      if (!fs.existsSync(TARGET_DIR)) fs.mkdirSync(TARGET_DIR, { recursive: true });

      for (const { src, dest } of ASSETS[id] ?? []) {
        const srcDir = path.join(flowtaskDir, src);
        if (!fileExists(srcDir)) { logWarn(`Source not found, skipping: ${src}`); continue; }
        const destDir = path.join(TARGET_DIR, dest);
        copyWithProgress(srcDir, destDir, src, readline);
      }

      // OpenCode: skills go to .opencode/skills/ (outside flowtask subdir)
      if (id === "opencode") {
        const srcSkills = path.join(flowtaskDir, "skills");
        if (fileExists(srcSkills)) copyWithProgress(srcSkills, path.join(projectDir, ".opencode", "skills"), "skills (opencode)", readline);
        mergeOpencodeConfig(path.join(projectDir, ideDir, "opencode.json"), flowtaskDir, ideDir);
      }

      // Claude: generate agents/commands/CLAUDE.md/settings from source
      if (id === "claude") {
        logStep(5, "Generating Claude Code files...");
        const agentResult = generateClaudeAgents(flowtaskDir, projectDir);
        logSuccess(`${agentResult.generated} agents → .claude/agents/`);
        const cmdResult = generateClaudeCommands(flowtaskDir, projectDir);
        logSuccess(`${cmdResult.generated} commands → .claude/commands/`);
        mergeClaudeSettings(path.join(projectDir, ".claude", "settings.json"), flowtaskDir);
        generateClaudeMd(flowtaskDir, projectDir);
      }

      // ── Step 5: Adapter Plugin (OpenCode only) ───────────────────────────
      if (id === "opencode") {
        logStep(5, "Linking OpenCode adapter plugin...");
        const pluginDir = path.join(TARGET_DIR, "plugins", "flowtask-classifier");
        if (fileExists(pluginDir)) {
          const pkgPath = path.join(pluginDir, "package.json");
          if (fileExists(pkgPath)) {
            const { name: pluginName } = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
            run(`npm link ${pluginName}`, { cwd: pluginDir });
            logSuccess(`Plugin ${pluginName} linked.`);
          }
        }
      }

      // ── Step 6: Write installation marker ───────────────────────────────
      fs.writeFileSync(
        path.join(TARGET_DIR, ".installation-method"),
        JSON.stringify({ method: "unified-installation-v2", target: id, timestamp: new Date().toISOString() }, null, 2)
      );

      results.push({ target: id, status: "Success" });
    } catch (err) {
      logError(`Failed to install in ${id}: ${err.message}`);
      results.push({ target: id, status: "Error", message: err.message });
    }
  }

  // Cleanup empty root .flowtask if it was migrated (skip if it's the source dir)
  const rootFT = path.join(projectDir, ".flowtask");
  const isSrcDir = path.resolve(rootFT) === path.resolve(flowtaskDir);
  if (!isSrcDir && fileExists(rootFT) && targets.some((t) => t.id !== "standalone")) {
    try { if (fs.readdirSync(rootFT).length === 0) fs.rmdirSync(rootFT); } catch (_) {}
  }

  printSummary("Installation Summary", results);
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function update(flowtaskDir) {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Update Wizard (Delta)     ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const projectDir = process.cwd();

  // ── Step 1: Detect installed targets ────────────────────────────────────
  logStep(1, "Detecting installed targets...");
  const possibleTargets = [
    { id: "standalone", marker: ".flowtask/.installation-method",         subDir: ".flowtask",         ideDir: "" },
    { id: "opencode",   marker: ".opencode/flowtask/.installation-method", subDir: ".opencode/flowtask", ideDir: ".opencode" },
    { id: "vscode",     marker: ".vscode/flowtask/.installation-method",   subDir: ".vscode/flowtask",   ideDir: ".vscode" },
    { id: "claude",     marker: ".claude/flowtask/.installation-method",   subDir: ".claude/flowtask",   ideDir: ".claude" },
  ];

  const targets = [];
  for (const t of possibleTargets) {
    const markerPath = path.join(projectDir, t.marker);
    if (!fs.existsSync(markerPath)) continue;
    try {
      targets.push({ ...t, previousMethod: JSON.parse(fs.readFileSync(markerPath, "utf8")) });
      logSuccess(`Found ${t.id} installation`);
    } catch {
      logWarn(`Could not read installation marker for ${t.id}`);
    }
  }

  if (targets.length === 0) {
    logError("No FlowTask installation found. Run 'flowtask install' first.");
    return;
  }

  // ── Step 2: Delta sync each target ──────────────────────────────────────
  const preservePaths = ["CA-", "workspace", ".workspace", ".installation-method"];
  const results = [];

  for (const { id, subDir, ideDir, previousMethod } of targets) {
    const TARGET_DIR = path.join(projectDir, subDir);
    logStep(2, `Updating ${id}...`);

    try {
      if (!fs.existsSync(TARGET_DIR)) throw new Error(`Target directory not found: ${subDir}`);

      let totalCopied = 0;
      let totalSkipped = 0;

      // Delta sync only the relevant assets
      for (const { src, dest } of ASSETS[id] ?? []) {
        const srcDir = path.join(flowtaskDir, src);
        if (!fileExists(srcDir)) continue;
        const destDir = path.join(TARGET_DIR, dest);
        const stats = copyDirectoryDelta(srcDir, destDir, preservePaths);
        totalCopied += stats.copied;
        totalSkipped += stats.skipped;
      }

      // OpenCode: skills delta
      if (id === "opencode") {
        const srcSkills = path.join(flowtaskDir, "skills");
        if (fileExists(srcSkills)) {
          const stats = copyDirectoryDelta(srcSkills, path.join(projectDir, ".opencode", "skills"), preservePaths);
          totalCopied += stats.copied;
          totalSkipped += stats.skipped;
        }
      }

      logSuccess(`Updated ${totalCopied} files, ${totalSkipped} unchanged`);

      // Claude: regenerate derived files
      if (id === "claude") {
        const agentResult = generateClaudeAgents(flowtaskDir, projectDir);
        logSuccess(`Claude agents: ${agentResult.generated} regenerated`);
        const cmdResult = generateClaudeCommands(flowtaskDir, projectDir);
        logSuccess(`Claude commands: ${cmdResult.generated} regenerated`);
        mergeClaudeSettings(path.join(projectDir, ".claude", "settings.json"), flowtaskDir);
        generateClaudeMd(flowtaskDir, projectDir);
      }

      fs.writeFileSync(
        path.join(TARGET_DIR, ".installation-method"),
        JSON.stringify({
          method: "unified-installation-v2",
          target: id,
          updatedAt: new Date().toISOString(),
          previousUpdate: previousMethod?.updatedAt || previousMethod?.timestamp || null,
          filesUpdated: totalCopied,
          filesSkipped: totalSkipped,
        }, null, 2)
      );

      results.push({ target: id, status: "Success", stats: { copied: totalCopied, skipped: totalSkipped } });
    } catch (err) {
      logError(`Failed to update ${id}: ${err.message}`);
      results.push({ target: id, status: "Error", message: err.message });
    }
  }

  printSummary("Update Summary", results, (res) =>
    res.stats ? ` (${res.stats.copied} updated, ${res.stats.skipped} preserved)` : ""
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printSummary(title, results, extraFn = () => "") {
  console.log(`\n${COLORS.blue}╔═══════════════════════════════════════════╗
║  ${title.padEnd(41)}║
╚═══════════════════════════════════════════╝${COLORS.reset}`);
  results.forEach((res) => {
    const color = res.status === "Success" ? COLORS.green : COLORS.red;
    console.log(`  - ${res.target.toUpperCase()}: ${color}${res.status}${COLORS.reset}${extraFn(res)}${res.message ? ` (${res.message})` : ""}`);
  });
  if (results.some((r) => r.status === "Success")) {
    logSuccess(`\nFlowTask ${title.toLowerCase()} completed successfully!`);
  } else {
    logError(`\nFlowTask ${title.toLowerCase()} failed.`);
  }
}
