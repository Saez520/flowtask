import fs from "fs";
import path from "path";
import os from "os";
import {
  COLORS, log, logStep, logSuccess, logError, logWarn, logInfo,
  isBinaryInstalled, getVersion, fileExists,
} from "./logger.js";
import { copyWithProgress, copyDirectoryDelta } from "./copy.js";
import { mergeOpencodeConfig, registerPluginArrayEntry } from "./opencode.js";
import { generateClaudeAgents, generateClaudeCommands, generateClaudeMd, mergeClaudeSettings, mergeClaudeMcpConfig } from "./claude.js";
import { showInteractiveSelector } from "./ui.js";
import { coordinateGraphify } from "./graphify.js";

// ─── Asset map ────────────────────────────────────────────────────────────────
// Defines exactly what gets copied into each target directory.
// Format: { src: relative to flowtaskDir, dest: relative to TARGET_DIR | null for custom dest }
//
// opencode  → .opencode/flowtask/  : agents/
//             .opencode/skills/    : skills/  (custom dest)
//             .opencode/plugins/   : manifest-driven, handled by installManifestPlugins()
//                                    (NOT listed here — each entry's destination and kind,
//                                    server vs tui, comes from flowtask-plugins.json)
// claude    → .claude/flowtask/    : skills/  (agents & commands are generated, not copied)
// standalone → .flowtask/          : agents/, commands/, skills/, plugins/

const ASSETS = {
  opencode: [
    { src: "agents",  dest: "agents" },
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

const CLASSIFIER_PLUGIN_NAMES = [
  "flowtask-classifier-hook",
  "flowtask-classifier-tui",
];

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

async function promptFerrisSearch(flowtaskDir, readline) {
  const SUPPORTED_PLATFORMS = ["darwin", "win32"];
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    logInfo(`ferris-search MCP no está disponible en ${process.platform}. Omitiendo.`);
    return;
  }
  const binaryName = process.platform === "win32"
    ? `ferris-search-windows-${os.arch()}.exe`
    : `ferris-search-darwin-${os.arch()}`;
  const srcBinary = path.join(flowtaskDir, "bin", binaryName);
  if (!fileExists(srcBinary)) {
    logWarn(`ferris-search binary not found at ${srcBinary}. Skipping.`);
    return;
  }
  const answer = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${COLORS.cyan}?${COLORS.reset} ¿Instalar ferris-search MCP para web search? ${COLORS.dim}(Y/n):${COLORS.reset} `, (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
  if (answer === "n" || answer === "no") {
    logInfo("ferris-search installation skipped.");
    return;
  }
  const destDir = path.join(os.homedir(), ".opencode", "bin");
  const destBinary = path.join(destDir, process.platform === "win32" ? "ferris-search.exe" : "ferris-search");
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcBinary, destBinary);
    fs.chmodSync(destBinary, 0o755);
    logSuccess("ferris-search installed to ~/.opencode/bin/ferris-search");
  } catch (err) {
    logError(`Failed to install ferris-search binary: ${err.message}`);
    return;
  }
  const configDir = path.join(os.homedir(), ".config", "opencode");
  const configPath = path.join(configDir, "opencode.json");
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, "utf8").trim();
        if (content) config = JSON.parse(content);
      } catch { logWarn("Existing global opencode.json is invalid, starting fresh."); }
    }
    const mcpBlock = { "ferris-search": { type: "local", command: ["ferris-search"], env: { DEFAULT_SEARCH_ENGINE: "bing" }, enabled: true } };
    if (!config.mcp) { config.mcp = mcpBlock; }
    else { config.mcp = { ...config.mcp, ...mcpBlock }; }
    if (!config.$schema) config.$schema = "https://opencode.ai/config.json";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    logSuccess("ferris-search MCP configured in global opencode.json");
  } catch (err) { logError(`Failed to configure MCP: ${err.message}`); }
}

// ─── Persona Selection ────────────────────────────────────────────────────────

const CUSTOM_PERSONA_TEXT = `El desarrollador eligió la opción de personalidad personalizada. Antes de continuar, preguntale si quiere hacer el quiz de onboarding (\`/onboard\`) para que puedas adaptar tu estilo de comunicación a su nivel de experiencia y mejorar la experiencia de desarrollo.`;

const levelToChoice = { training: 1, junior: 1, mid: 2, senior: 3, custom: 4 };
const mapping = {
  1: { level: "training", persona: "tutor-training", file: "tutor-training.md", onboarded: true },
  2: { level: "mid", persona: "tutor-mid", file: "tutor-mid.md", onboarded: true },
  3: { level: "senior", persona: "tutor-senior", file: "tutor-senior.md", onboarded: true },
  4: { level: "custom", persona: "custom", file: null, onboarded: false },
};

async function promptPersonaSeleccion(readline, currentLevel = null) {
  if (!process.stdin.isTTY) {
    throw new Error("No hay TTY para seleccionar personalidad. Pasá --persona <training|mid|senior|custom> o creá/corregí .flowtask/config/profile.json.");
  }

  logStep("P", "Personalidad del Agente");
  logInfo("Define cómo el asistente se comunicará contigo según tu nivel de experiencia.");

  const options = [
    { label: "1. Estoy aprendiendo / Entry-level",    desc: "Si estás dando tus primeros pasos en el desarrollo de software" },
    { label: "2. Mid-level",                          desc: "Si te manejás con soltura en tu stack y tomás decisiones técnicas" },
    { label: "3. Senior",                             desc: "Si diseñás arquitecturas, mentoreás a otros y pensás en el largo plazo" },
    { label: "4. Personalizado ✦ (recomendado)",       desc: "Dejá que el asistente aprenda tu estilo con una breve auditoría guiada" },
  ];

  const initialChoice = currentLevel && levelToChoice[currentLevel] ? levelToChoice[currentLevel] : 1;
  let cursor = initialChoice - 1;
  let lastRenderLines = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  const render = () => {
    if (lastRenderLines > 0) {
      readline.moveCursor(process.stdout, 0, -lastRenderLines);
      readline.clearScreenDown(process.stdout);
    }
    const lines = [
      ...options.map((opt, i) => {
        const cursorStr = i === cursor ? COLORS.cyan + "> " + COLORS.reset : "  ";
        return `${cursorStr}${opt.label}    ${COLORS.dim}${opt.desc}${COLORS.reset}`;
      }),
      `\n${COLORS.dim}↑/↓: navegar, Enter: confirmar, Ctrl+C: cancelar${COLORS.reset}`,
    ];
    const output = lines.join("\n");
    process.stdout.write(output + "\n");
    lastRenderLines = output.split("\n").length;
  };

  const onResize = () => render();
  process.stdout.on("resize", onResize);
  render();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdout.removeListener("resize", onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
    };

    const onKeypress = (str, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        log("\nInstalación cancelada.", COLORS.yellow);
        process.exit(0);
      }
      if (key.name === "up")    { cursor = (cursor - 1 + options.length) % options.length; render(); }
      if (key.name === "down")  { cursor = (cursor + 1) % options.length; render(); }
      if (key.name === "return") {
        cleanup();
        if (lastRenderLines > 0) {
          readline.moveCursor(process.stdout, 0, -lastRenderLines);
          readline.clearScreenDown(process.stdout);
        }
        const num = cursor + 1;
        resolve(mapping[num]);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

function resolvePersonaContent(flowtaskDir, personaChoice) {
  if (personaChoice.file === null) return CUSTOM_PERSONA_TEXT;

  const personaPath = path.join(flowtaskDir, "personas", personaChoice.file);
  if (!fileExists(personaPath)) {
    logError(`Archivo de personalidad no encontrado: ${personaPath}. La instalación continuará sin personalidad.`);
    return null;
  }
  return fs.readFileSync(personaPath, "utf8");
}

export function injectPersonaIntoRunnerContent(content, personaContent) {
  if (!personaContent) return content;

  const startMarker = "<!-- FLOWTASK:PERSONA_START -->";
  const endMarker = "<!-- FLOWTASK:PERSONA_END -->";

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx + startMarker.length) {
    logWarn("Marcadores PERSONA no encontrados en runner.md. No se inyectó personalidad.");
    return content;
  }

  return (
    content.slice(0, startIdx + startMarker.length) +
    "\n" +
    personaContent +
    "\n" +
    content.slice(endIdx)
  );
}

function injectPersonaIntoRunner(targetDir, personaContent) {
  if (personaContent === null) return;

  const runnerPath = path.join(targetDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) {
    logWarn(`runner.md no encontrado en ${targetDir}. No se inyectó personalidad.`);
    return;
  }

  const content = fs.readFileSync(runnerPath, "utf8");
  fs.writeFileSync(runnerPath, injectPersonaIntoRunnerContent(content, personaContent), "utf8");
  logSuccess(`Personalidad inyectada en runner.md de ${targetDir}.`);
}

function writeProfile(flowtaskDir, level, persona, onboarded) {
  const configDir = path.join(flowtaskDir, "config");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  const profile = { level, persona, onboarded };
  fs.writeFileSync(path.join(configDir, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
  logSuccess(`Perfil guardado en ${path.join(configDir, "profile.json")}`);
}

function readProfileLevel(projectDir) {
  const profilePath = path.join(projectDir, ".flowtask", "config", "profile.json");
  if (!fileExists(profilePath)) return null;
  try {
    const level = JSON.parse(fs.readFileSync(profilePath, "utf8")).level;
    return level && levelToChoice[level] ? level : null;
  } catch {
    return null;
  }
}

export async function resolvePersonaSelection(projectDir, readline, options = {}) {
  const profileLevel = readProfileLevel(projectDir);
  if (options.persona && levelToChoice[options.persona]) {
    return mapping[levelToChoice[options.persona]];
  }
  if (profileLevel) {
    return mapping[levelToChoice[profileLevel]];
  }
  return promptPersonaSeleccion(readline);
}

// ─── Plugin Manifest Functions ────────────────────────────────────────────────

/**
 * Load plugin manifest from .flowtask/plugins/flowtask-plugins.json.
 * Each entry: { name, path, kind, destinations, entrypoint }
 * - path is relative to the manifest's own directory (i.e. flowtaskDir/plugins/<path>).
 */
export function loadPluginManifest(flowtaskDir) {
  const manifestPath = path.join(flowtaskDir, "plugins", "flowtask-plugins.json");
  try {
    if (!fileExists(manifestPath)) {
      logWarn(`Plugin manifest not found at ${manifestPath}`);
      return [];
    }
    const content = fs.readFileSync(manifestPath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    logError(`Failed to load plugin manifest: ${err.message}`);
    return [];
  }
}

/**
 * Validate a single manifest entry has all required fields.
 */
export function validateManifestEntry(entry) {
  const required = ["name", "path", "kind", "destinations", "entrypoint"];
  for (const field of required) {
    if (!entry[field]) {
      logWarn(`Plugin entry missing required field: ${field}`);
      return false;
    }
  }
  if (!Array.isArray(entry.destinations)) {
    logWarn(`Plugin entry destinations must be an array`);
    return false;
  }
  return true;
}

/**
 * Calculate relative path from a config file's directory to a plugin entrypoint.
 * OpenCode resolves relative paths from the config file's dirname, not project root.
 */
function calculatePluginRelativePath(configPath, projectDir, pluginName, entrypoint) {
  const configDir = path.dirname(configPath);
  const pluginAbsPath = path.join(projectDir, ".opencode", "plugins", pluginName, entrypoint);
  let relative = path.relative(configDir, pluginAbsPath).split(path.sep).join('/');
  if (!relative.startsWith('.') && !relative.startsWith('/')) {
    relative = './' + relative;
  }
  return relative;
}

function getClassifierEntries(manifest) {
  return CLASSIFIER_PLUGIN_NAMES.map((name) => manifest.find((entry) => entry?.name === name));
}

function isClassifierEnabled(manifest) {
  const entries = getClassifierEntries(manifest);
  return entries.length === CLASSIFIER_PLUGIN_NAMES.length && entries.every((entry) => entry?.enabled === true);
}

function extractPluginName(pluginPath) {
  if (typeof pluginPath !== "string") return null;
  const normalizedPath = pluginPath.replace(/\\/g, "/");
  return normalizedPath.match(/(?:^|\/)plugins\/([^/]+)(?:\/|$)/)?.[1] ?? null;
}

function configContainsClassifier(configPath) {
  if (!fileExists(configPath)) return false;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Array.isArray(config.plugin) && config.plugin.some((entry) => {
      const pluginPath = typeof entry === "string" ? entry : entry?.path;
      return CLASSIFIER_PLUGIN_NAMES.includes(extractPluginName(pluginPath));
    });
  } catch (err) {
    logWarn(`Could not inspect plugin config ${configPath}: ${err.message}`);
    return false;
  }
}

function removeClassifierEntries(configPath) {
  if (!fileExists(configPath)) return false;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(config.plugin)) return false;

    const originalLength = config.plugin.length;
    config.plugin = config.plugin.filter((entry) => {
      const pluginPath = typeof entry === "string" ? entry : entry?.path;
      return !CLASSIFIER_PLUGIN_NAMES.includes(extractPluginName(pluginPath));
    });

    if (config.plugin.length === originalLength) return false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return true;
  } catch (err) {
    logWarn(`Could not clean classifier entries from ${configPath}: ${err.message}`);
    return false;
  }
}

function writeJsonVerified(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
    const verified = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return JSON.stringify(verified) === JSON.stringify(value);
  } catch {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve original */ }
    return false;
  }
}

function removeClassifierDirectories(projectDir) {
  let removed = false;
  const pluginsDir = path.join(projectDir, ".opencode", "plugins");

  for (const name of CLASSIFIER_PLUGIN_NAMES) {
    const pluginDir = path.join(pluginsDir, name);
    if (!fileExists(pluginDir)) continue;
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      logWarn(`Could not remove deprecated plugin ${name}: ${err.message}`);
    }
  }
  return removed;
}

function cleanupDisabledClassifier(projectDir, manifest) {
  if (isClassifierEnabled(manifest)) return;

  const tuiConfigPath = path.join(projectDir, ".opencode", "tui.json");
  const serverConfigPath = path.join(projectDir, ".opencode", "opencode.json");
  const hasInstallation = CLASSIFIER_PLUGIN_NAMES.some((name) =>
    fileExists(path.join(projectDir, ".opencode", "plugins", name))
  ) || configContainsClassifier(tuiConfigPath) || configContainsClassifier(serverConfigPath);

  const removedDirectory = removeClassifierDirectories(projectDir);
  const removedServerEntry = removeClassifierEntries(serverConfigPath);

  if (hasInstallation || removedDirectory || removedServerEntry) {
    logWarn("el plugin de clasificación fue deprecado");
  }
}

/**
 * Install plugins from the manifest for the "opencode" destination:
 * 1. Copies each plugin's directory (filtered by `destinations`) into
 *    <projectDir>/.opencode/plugins/<name>/ — sibling of .opencode/flowtask,
 *    NOT nested inside it (TUI/server plugin paths are resolved relative to
 *    the project root / ideDir, not the flowtask subdir).
 * 2. Registers each copied plugin in the right config file:
 *    - kind "tui"    → .opencode/tui.json (via registerPluginArrayEntry)
 *    - kind "server" → .opencode/opencode.json (via registerPluginArrayEntry)
 */
export function installManifestPlugins(projectDir, manifest, flowtaskDir) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    logInfo("No plugins to install from manifest");
    return;
  }

  const opencodePluginsDir = path.join(projectDir, ".opencode", "plugins");

  const nativeTuiPath = path.join(projectDir, ".opencode", "tui.json");
  const projectTuiPath = path.join(projectDir, "tui.json");
  let legacyTui = null;
  if (fileExists(projectTuiPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(projectTuiPath, "utf8"));
      if (Array.isArray(parsed.plugin)) {
        legacyTui = { config: parsed, plugins: [...parsed.plugin] };
      }
    } catch (err) {
      logWarn(`No se pudo leer el tui.json legacy ${projectTuiPath}: ${err.message}. Se conserva sin migrar.`);
    }
  }
  const migratedLegacyIndexes = new Set();

  for (const entry of manifest) {
    if (!validateManifestEntry(entry)) continue;
    if (!entry.destinations.includes("opencode")) continue;
    if (CLASSIFIER_PLUGIN_NAMES.includes(entry.name) && !isClassifierEnabled(manifest)) continue;

    const srcDir = path.join(flowtaskDir, "plugins", entry.path);
    if (!fileExists(srcDir)) {
      logWarn(`Plugin source not found, skipping: ${srcDir}`);
      continue;
    }
    const destDir = path.join(opencodePluginsDir, entry.name);

    try {
      copyDirectoryDelta(srcDir, destDir);
      logSuccess(`Plugin ${entry.name} copied to .opencode/plugins/${entry.name}`);
    } catch (err) {
      logError(`Failed to copy plugin ${entry.name}: ${err.message}`);
      continue;
    }

    // Validate that entrypoint file exists
    const entrypointAbsPath = path.join(destDir, entry.entrypoint);
    if (!fileExists(entrypointAbsPath)) {
      logWarn(`⚠️  Plugin entrypoint not found for ${entry.name}: ${entry.entrypoint} (expected at ${entrypointAbsPath})`);
      continue;
    }

    if (entry.kind === "tui") {
      const installationRuntimePath = calculatePluginRelativePath(nativeTuiPath, projectDir, entry.name, entry.entrypoint);
      if (!registerPluginArrayEntry(nativeTuiPath, installationRuntimePath, "https://opencode.ai/tui.json")) {
        throw new Error(`No se pudo escribir el registro TUI nativo ${nativeTuiPath}`);
      }
      const installationTui = JSON.parse(fs.readFileSync(nativeTuiPath, "utf8"));
      const registered = Array.isArray(installationTui.plugin) && installationTui.plugin.some((plugin) => {
        const pluginPath = typeof plugin === "string" ? plugin : plugin?.path;
        return pluginPath === installationRuntimePath;
      });
      if (!registered) throw new Error(`No se pudo verificar la ruta TUI ${installationRuntimePath}`);
      if (legacyTui) {
        legacyTui.plugins.forEach((plugin, index) => {
          const pluginPath = typeof plugin === "string" ? plugin : plugin?.path;
          const normalizedPath = typeof pluginPath === "string" ? pluginPath.replace(/\\/g, "/") : "";
          if (extractPluginName(pluginPath) === entry.name || normalizedPath.includes(entry.name)) {
            migratedLegacyIndexes.add(index);
          }
        });
      }
    } else if (entry.kind === "server") {
      const opencodeConfigPath = path.join(projectDir, ".opencode", "opencode.json");
      const pluginRuntimePath = calculatePluginRelativePath(opencodeConfigPath, projectDir, entry.name, entry.entrypoint);
      if (!registerPluginArrayEntry(opencodeConfigPath, pluginRuntimePath, "https://opencode.ai/config.json")) {
        throw new Error(`No se pudo actualizar ${opencodeConfigPath}`);
      }
    } else {
      logWarn(`Unknown plugin kind "${entry.kind}" for ${entry.name}, skipping registration.`);
    }
  }

  // A legacy consumer manifest is cleaned only after installation manifest writes succeeded.
  if (legacyTui && migratedLegacyIndexes.size > 0) {
    try {
      const remaining = legacyTui.plugins.filter((_, index) => !migratedLegacyIndexes.has(index));
      if (remaining.length !== legacyTui.plugins.length) {
        const cleaned = { ...legacyTui.config, plugin: remaining };
        if (!writeJsonVerified(projectTuiPath, cleaned)) throw new Error("la verificación del destino falló");
      }
    } catch (err) {
      logWarn(`No se pudo limpiar el tui.json legacy ${projectTuiPath}: ${err.message}. Se conserva la configuración; reintenta con flowtask update.`);
    }
  }

  cleanupDisabledClassifier(projectDir, manifest);
}

// ─── Migration & Cleanup ──────────────────────────────────────────────────────

export function migrateProfileLocation(projectDir, flowtaskDir) {
  const destination = path.join(flowtaskDir, "config", "profile.json");
  const legacyPaths = [
    path.join(projectDir, ".flowtask", "config", "profile.json"),
    path.join(projectDir, ".flowtask", "profile.json"),
  ];
  if (legacyPaths.some((source) => path.resolve(source) === path.resolve(destination))) return true;
  if (fs.existsSync(destination)) return true;
  const source = legacyPaths.find((candidate) => fs.existsSync(candidate));
  if (!source) return true;
  try {
    const profile = JSON.parse(fs.readFileSync(source, "utf8"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(profile, null, 2), "utf8");
    const verified = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (JSON.stringify(verified) !== JSON.stringify(profile)) throw new Error("la verificación del destino falló");
    fs.rmSync(source);
    logSuccess(`Perfil migrado de ${source} a ${destination}`);
    return true;
  } catch (err) {
    logError(`No se pudo migrar profile.json de ${source} a ${destination}: ${err.message}. Verifica permisos/espacio y reintenta con flowtask update.`);
    return false;
  }
}

function cleanupOrphanedClaudeAssets(projectDir) {
  const orphanDirs = [
    path.join(projectDir, ".claude", "flowtask", "agents"),
    path.join(projectDir, ".claude", "flowtask", "commands"),
  ];
  for (const dir of orphanDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      logSuccess(`Carpeta obsoleta eliminada: ${path.relative(projectDir, dir)}`);
    } catch (err) {
      logError(`No se pudo eliminar carpeta obsoleta ${path.relative(projectDir, dir)}: ${err.message}`);
    }
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

export async function install(flowtaskDir, options = {}) {
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

  // ── Step P: Personalidad del Agente ─────────────────────────────────
  const personaChoice = await promptPersonaSeleccion(readline);
  const personaContent = resolvePersonaContent(flowtaskDir, personaChoice);

  const projectDir = process.cwd();
  if (!migrateProfileLocation(projectDir, flowtaskDir)) {
    throw new Error("No se pudo migrar profile.json; se conserva el origen. Verifica permisos/espacio y reintenta con flowtask update.");
  }
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

      // ── Ferris Search MCP ──────────────────────────────────────────────
      logStep("+", "ferris-search MCP…");
      await promptFerrisSearch(flowtaskDir, readline);

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

      // ── Inject persona into runner.md ───────────────────────────────
      if (personaContent && id !== "claude") {
        injectPersonaIntoRunner(TARGET_DIR, personaContent);
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
        mergeClaudeMcpConfig(path.join(projectDir, ".mcp.json"), flowtaskDir);
        cleanupOrphanedClaudeAssets(projectDir);
        if (personaContent) {
          const sourceRunnerPath = path.join(flowtaskDir, "agents", "runner.md");
          const sourceRunner = fs.readFileSync(sourceRunnerPath, "utf8");
          const runnerBody = injectPersonaIntoRunnerContent(sourceRunner, personaContent);
          generateClaudeMd(flowtaskDir, projectDir, runnerBody);
        } else {
          generateClaudeMd(flowtaskDir, projectDir);
        }
      }

      // ── Step 5: Install plugins from manifest (OpenCode only) ────────────
      // Copies each manifest entry (filtered by destinations) into
      // .opencode/plugins/<name>/ and registers it in tui.json (kind tui)
      // or .opencode/opencode.json (kind server).
      if (id === "opencode") {
        logStep(5, "Installing plugins from manifest...");
        const manifest = loadPluginManifest(flowtaskDir);
        installManifestPlugins(projectDir, manifest, flowtaskDir);
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

  // ── Graphify coordination (once, after all targets) ─────────────────────
  try {
    const selectedCliIds = targets.map((t) => t.id);
    await coordinateGraphify({ projectDir, flowtaskDir, selectedClis: selectedCliIds, readline });
  } catch (err) {
    logWarn(`Graphify: coordinación falló (${err.message}). Reintenta con flowtask update o contacta a un administrador.`);
  }

  // ── Write profile ──────────────────────────────────────────────────
  writeProfile(flowtaskDir, personaChoice.level, personaChoice.persona, personaChoice.onboarded);

  // Cleanup empty root .flowtask if it was migrated (skip if it's the source dir)
  const rootFT = path.join(projectDir, ".flowtask");
  const isSrcDir = path.resolve(rootFT) === path.resolve(flowtaskDir);
  if (!isSrcDir && fileExists(rootFT) && targets.some((t) => t.id !== "standalone")) {
    try { if (fs.readdirSync(rootFT).length === 0) fs.rmdirSync(rootFT); } catch (_) {}
  }

  printSummary("Installation Summary", results);
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function update(flowtaskDir, options = {}) {
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Update Wizard (Delta)     ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const readline = await import("readline");
  const projectDir = process.cwd();
  if (!migrateProfileLocation(projectDir, flowtaskDir)) {
    throw new Error("No se pudo migrar profile.json; se conserva el origen. Verifica permisos/espacio y reintenta con flowtask update.");
  }

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

  // ── Step 1.5: Personalidad del Agente ──────────────────────────────
  let currentLevel = null;
  const profilePath = path.join(flowtaskDir, "config", "profile.json");
  if (fileExists(profilePath)) {
    try {
      const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
      currentLevel = profile.level || null;
    } catch { /* ignore invalid profile.json */ }
  }

  let personaChoice;
  if (currentLevel && levelToChoice[currentLevel]) {
    personaChoice = mapping[levelToChoice[currentLevel]];
    logInfo(`Conservando personalidad existente: ${personaChoice.persona}`);
  } else {
    personaChoice = await promptPersonaSeleccion(readline, currentLevel);
  }
  const personaContent = resolvePersonaContent(flowtaskDir, personaChoice);

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
        mergeOpencodeConfig(path.join(projectDir, ideDir, "opencode.json"), flowtaskDir, ideDir);
      }

      logSuccess(`Updated ${totalCopied} files, ${totalSkipped} unchanged`);

      // ── Re-install plugins from manifest (OpenCode only) ─────────────────
      if (id === "opencode") {
        const manifest = loadPluginManifest(flowtaskDir);
        installManifestPlugins(projectDir, manifest, flowtaskDir);
      }

      // ── Inject persona into runner.md ───────────────────────────────
      if (personaContent && id !== "claude") {
        injectPersonaIntoRunner(TARGET_DIR, personaContent);
      }

      // Claude: regenerate derived files
      if (id === "claude") {
        const agentResult = generateClaudeAgents(flowtaskDir, projectDir);
        logSuccess(`Claude agents: ${agentResult.generated} regenerated`);
        const cmdResult = generateClaudeCommands(flowtaskDir, projectDir);
        logSuccess(`Claude commands: ${cmdResult.generated} regenerated`);
        mergeClaudeSettings(path.join(projectDir, ".claude", "settings.json"), flowtaskDir);
        mergeClaudeMcpConfig(path.join(projectDir, ".mcp.json"), flowtaskDir);
        cleanupOrphanedClaudeAssets(projectDir);
        if (personaContent) {
          const sourceRunnerPath = path.join(flowtaskDir, "agents", "runner.md");
          const sourceRunner = fs.readFileSync(sourceRunnerPath, "utf8");
          const runnerBody = injectPersonaIntoRunnerContent(sourceRunner, personaContent);
          generateClaudeMd(flowtaskDir, projectDir, runnerBody);
        } else {
          generateClaudeMd(flowtaskDir, projectDir);
        }
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

  // ── Graphify coordination (once, after all targets) ─────────────────────
  try {
    const selectedCliIds = targets.map((t) => t.id);
    await coordinateGraphify({ projectDir, flowtaskDir, selectedClis: selectedCliIds, readline });
  } catch (err) {
    logWarn(`Graphify: coordinación falló (${err.message}). Reintenta con flowtask update o contacta a un administrador.`);
  }

  // ── Write profile ──────────────────────────────────────────────────
  if (!currentLevel || personaChoice.level !== currentLevel) {
    writeProfile(flowtaskDir, personaChoice.level, personaChoice.persona, personaChoice.onboarded);
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
