import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import {
  COLORS, log, logStep, logSuccess, logError, logWarn, logInfo,
  isBinaryInstalled, getVersion, fileExists,
} from "./logger.js";
import { copyWithProgress, copyDirectoryDelta, pruneDirectoryExtras, verifyDirectoryMirror } from "./copy.js";
import { mergeOpencodeConfig, registerPluginArrayEntry } from "./opencode.js";
import { installClaudeTarget, updateClaudeTarget } from "./claude-install.js";
import { resolveClaudePaths } from "./claude.js";
import {
  CUSTOM_PERSONA_TEXT,
  configureRunnerScriptsContent,
  injectAutonomyIntoRunnerContent,
  injectPersonaIntoRunnerContent,
} from "./runner-content.js";
export {
  configureRunnerScriptsContent,
  injectAutonomyIntoRunnerContent,
  injectPersonaIntoRunnerContent,
} from "./runner-content.js";
import { showInteractiveSelector } from "./ui.js";
import { coordinateGraphify } from "./graphify.js";
import { CONTEXT_CHECKPOINT_NAME, CONTEXT_CHECKPOINT_SHA, classifyOwnership, replaceManagedPackage } from "./ownership.js";
import { resolveGlobalConfigDir } from "./global-paths.js";
import { globalWorktreeManagerDir } from "./global-paths.js";
import { ensureGlobalWorktreeManager, formatWorktreeManagerVersionNotice } from "./worktree-manager-runtime.js";
import { downloadWorktreeManagerPackage } from "./worktree-manager-package.js";
import { ensureCanonicalSubmodule } from "./submodule-publication.js";
import {
  AUTONOMY_PROFILES,
  LAYER_FILES,
  LAYER_SOURCES,
  MIGRATION_DEFAULTS,
  describeOperationalFailure,
  readLayerSources,
  resolveLayers,
} from "./layers.js";

export const INSTALLER_WRITERS = Object.freeze([
  "W01 removeLegacyConsumerFiles", "W02 migrateProfileLocation", "W03 promptFerrisSearch",
  "W04 root migration", "W05 target creation", "W06 asset copy/mirror", "W07 OpenCode skills/config",
  "W08 plugin copy/register", "W09 markers", "W10 runner/persona/sync config", "W11 Claude outputs",
  "W12 TUI canonical/legacy", "W13 classifier cleanup", "W14 legacy scripts/consumers",
  "W15 root cleanup", "W16 Graphify", "W17 JSON/file primitives",
]);

// ─── Worktree Manager ────────────────────────────────────────────────────────
// The manager is acquired from the published npm package and published as a
// single managed copy in the user's global directory. It is never copied into a
// target and it is never registered as a consumer server: the capabilities
// below describe what the downloaded package can actually do, not what a
// configuration claims.

const WORKTREE_MANAGER_PROBE_TIMEOUT_MS = 5000;
const WORKTREE_MANAGER_MIN_PYTHON = "3.9";
const WORKTREE_MANAGER_MCP_ENTRYPOINTS = Object.freeze([
  "worktree_manager/mcp_transport.py",
  "worktree_manager/mcp_server.py",
  "worktree_manager/mcp_contract.py",
  "worktree_manager/mcp_operations.py",
]);
const WORKTREE_MANAGER_MCP_TOOLS = Object.freeze([
  "worktree_create", "worktree_complete", "worktree_cleanup",
  "worktree_recover", "worktree_list", "worktree_prune", "worktree_status",
]);

function comparePythonVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Run one read-only python probe. The probe never writes and never installs anything. */
function runPythonProbe(pythonBin, args, { managerDir, timeoutMs, input = "" }) {
  const env = { ...process.env };
  if (managerDir) {
    // The manager directory is the working directory of the probe, so the
    // package under test is the one that is imported and not a namesake.
    env.PYTHONPATH = managerDir;
  } else {
    delete env.PYTHONPATH;
  }
  try {
    const stdout = execFileSync(pythonBin, args, {
      encoding: "utf8",
      input,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      cwd: managerDir || undefined,
      env,
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const lastLine = stderr.split("\n").map((line) => line.trim()).filter(Boolean).pop();
    const cause = error?.killed || error?.signal
      ? `probe exceeded ${timeoutMs} ms`
      : (lastLine || String(error?.message ?? "probe failed").trim());
    return { ok: false, cause };
  }
}

function probePythonVersion(pythonBin, timeoutMs) {
  const result = runPythonProbe(pythonBin, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], {
    managerDir: "", timeoutMs,
  });
  if (!result.ok) return { ok: false, cause: result.cause };
  const version = result.stdout.trim().split("\n").filter(Boolean).pop()?.trim();
  if (!version) return { ok: false, cause: "python did not report a version" };
  return { ok: true, version };
}

/** Probe the CLI entrypoint: `python3 -m worktree_manager --version`. */
function probeManagerCli(managerDir, pythonBin, timeoutMs) {
  const result = runPythonProbe(pythonBin, ["-m", "worktree_manager", "--version"], { managerDir, timeoutMs });
  if (!result.ok) return { ok: false, cause: result.cause };
  const version = result.stdout.trim().split("\n").filter(Boolean).pop()?.trim();
  if (!version) return { ok: false, cause: "the CLI entrypoint reported no version" };
  return { ok: true, version };
}

/**
 * Probe the MCP entrypoint over stdio: initialize handshake plus tools/list.
 * The probe closes the transport as soon as both answers are read.
 */
function probeManagerMcp(managerDir, pythonBin, timeoutMs) {
  const requests = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "flowtask-installer", version: "1.0.0" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = runPythonProbe(pythonBin, ["-m", "worktree_manager.mcp_transport"], {
    managerDir, timeoutMs, input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  });
  if (!result.ok) return { ok: false, cause: result.cause };
  const responses = new Map();
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.id === "number") responses.set(parsed.id, parsed);
    } catch { /* a diagnostic line is not a protocol answer */ }
  }
  const initialized = responses.get(1)?.result;
  if (!initialized?.serverInfo) return { ok: false, cause: "the MCP handshake returned no server information" };
  const tools = responses.get(2)?.result?.tools;
  if (!Array.isArray(tools)) return { ok: false, cause: "the MCP transport returned no tool list" };
  const names = tools.map((tool) => tool?.name).filter(Boolean).sort();
  const missing = WORKTREE_MANAGER_MCP_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) return { ok: false, cause: `the MCP tool list is missing: ${missing.join(", ")}` };
  return { ok: true, version: initialized.serverInfo?.version ?? null, tools: names };
}

/**
 * Detect what the manager checkout can really do.
 *
 * A transport is reported as available only when it answered a read-only
 * probe, never because a configuration declares it.
 */
export function detectWorktreeManagerCapabilities(managerDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? WORKTREE_MANAGER_PROBE_TIMEOUT_MS;
  const pythonBin = options.pythonBin ?? "python3";
  const report = {
    managerDir,
    python: { available: false, version: null, cause: null },
    cli: { available: false, version: null, cause: null },
    mcp: { available: false, version: null, tools: [], cause: null },
    transports: [],
  };

  const python = probePythonVersion(pythonBin, timeoutMs);
  if (!python.ok) {
    const cause = `python is not usable: ${python.cause}`;
    report.python = { available: false, version: null, cause };
    report.cli = { available: false, version: null, cause };
    report.mcp = { available: false, version: null, tools: [], cause };
    return report;
  }
  report.python = { available: true, version: python.version, cause: null };
  if (comparePythonVersions(python.version, WORKTREE_MANAGER_MIN_PYTHON) < 0) {
    const cause = `python ${python.version} is older than the required ${WORKTREE_MANAGER_MIN_PYTHON}`;
    report.python = { available: false, version: python.version, cause };
    report.cli = { available: false, version: null, cause };
    report.mcp = { available: false, version: null, tools: [], cause };
    return report;
  }

  const missingMcpEntrypoints = WORKTREE_MANAGER_MCP_ENTRYPOINTS
    .filter((entry) => !fs.existsSync(path.join(managerDir, entry)));
  if (missingMcpEntrypoints.length > 0) {
    report.mcp = {
      available: false, version: null, tools: [],
      cause: `missing MCP entrypoints: ${missingMcpEntrypoints.join(", ")}`,
    };
  } else {
    const mcp = probeManagerMcp(managerDir, pythonBin, timeoutMs);
    report.mcp = mcp.ok
      ? { available: true, version: mcp.version, tools: mcp.tools, cause: null }
      : { available: false, version: null, tools: [], cause: mcp.cause };
  }

  const cli = probeManagerCli(managerDir, pythonBin, timeoutMs);
  report.cli = cli.ok
    ? { available: true, version: cli.version, cause: null }
    : { available: false, version: null, cause: cli.cause };
  report.transports = [
    ...(report.cli.available ? ["cli"] : []),
    ...(report.mcp.available ? ["mcp"] : []),
  ];
  return report;
}

/**
 * Acquire the manager from npm, gate the installation on a usable package and
 * publish the single managed global copy. The temporary download is removed in
 * every outcome.
 */
export function prepareGlobalWorktreeManager(options = {}) {
  const destinationDir = options.globalManagerDir ?? globalWorktreeManagerDir();
  const pkg = downloadWorktreeManagerPackage({
    npmBin: options.npmBin,
    timeoutMs: options.downloadTimeoutMs,
    workDir: options.workDir,
    env: options.env,
  });
  try {
    return ensureGlobalWorktreeManager({
      sourceDir: pkg.dir,
      destinationDir,
      version: pkg.version,
      source: "npm",
      pythonBin: options.pythonBin,
      timeoutMs: options.timeoutMs,
      faultInjector: options.faultInjector,
      detectCapabilities: (dir, opts) => detectWorktreeManagerCapabilities(dir, opts),
    });
  } finally {
    pkg.cleanup();
  }
}

/**
 * Install or update the global manager without turning a download failure into
 * a failed installation. Any other failure keeps its fail-closed behavior.
 */
export function prepareWorktreeManagerForRun(options = {}, { mode = "install" } = {}) {
  try {
    const report = prepareGlobalWorktreeManager(options);
    reportWorktreeManagerCapabilities(report, { quiet: mode === "update" ? !report.versionChanged : false });
    return report;
  } catch (error) {
    if (error?.code === "WORKTREE_MANAGER_DOWNLOAD_FAILED") {
      reportWorktreeManagerUnavailable(error, { mode });
      return null;
    }
    throw error;
  }
}

/** Publish the visible degradation when the package could not be downloaded. */
export function reportWorktreeManagerUnavailable(error, { mode = "install" } = {}) {
  const action = mode === "update" ? "updated" : "installed";
  logWarn(`Worktree Manager could not be ${action}: ${error.message}`);
  const intact = mode === "update" ? " The previous copy, if any, was left unchanged." : "";
  logWarn(`Worktrees are not available from this ${mode}. Run 'flowtask update' when the registry is reachable.${intact}`);
}
export function reportWorktreeManagerCapabilities(report, { quiet } = {}) {
  const capabilities = report?.capabilities ?? report;
  const { cli, mcp } = capabilities ?? {};
  const bothAvailable = Boolean(cli?.available && mcp?.available);
  if (quiet && bothAvailable) return;
  if (bothAvailable) {
    logSuccess(`Worktree Manager ready: CLI ${cli.version} and MCP ${mcp.tools.length} tools are operational.`);
    return;
  }
  if (cli?.available) {
    logWarn(`Worktree Manager partially installed: only the CLI is operational (${cli.version}); MCP is not: ${mcp?.cause ?? "unknown cause"}`);
    return;
  }
  if (mcp?.available) {
    logWarn(`Worktree Manager partially installed: only the MCP is operational (${mcp.tools.length} tools); the CLI is not: ${cli?.cause ?? "unknown cause"}`);
    return;
  }
  logError(`Worktree Manager is not operational: ${[cli?.cause, mcp?.cause].filter(Boolean).join("; ")}`);
}

/** Single read-only validation barrier shared by install and update. */
export async function prepareInstallation(flowtaskDir, projectDir, mode = "install", options = {}) {
  const manifest = loadPluginManifest(flowtaskDir, { required: true });
  const configPath = path.join(projectDir, ".opencode", "opencode.json");
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
    catch { throw new Error(`invalid OpenCode config: ${configPath}`); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`invalid OpenCode config: ${configPath}`);
    for (const key of ["plugin", "plugins"]) {
      if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`invalid OpenCode config: ${key} must be an array`);
    }
  }
  const pluginEntry = manifest.find((entry) => entry.name === CONTEXT_CHECKPOINT_NAME);
  if (!pluginEntry) throw new Error(`required plugin manifest entry missing: ${CONTEXT_CHECKPOINT_NAME}`);
  for (const entry of manifest) {
    const resolved = path.resolve(flowtaskDir, "plugins", entry.path);
    const pluginRoot = path.resolve(flowtaskDir, "plugins");
    if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}${path.sep}`)) {
      throw new Error(`plugin manifest path escapes plugin root: ${entry.name}`);
    }
    const entrypoint = path.resolve(resolved, entry.entrypoint);
    if (entrypoint !== resolved && !entrypoint.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`plugin manifest entrypoint escapes source: ${entry.name}`);
    }
  }
  if (!pluginEntry.destinations.includes("opencode") || pluginEntry.kind !== "server") {
    throw new Error(`required plugin manifest entry has incompatible destination/kind: ${CONTEXT_CHECKPOINT_NAME}`);
  }
  const pluginDir = path.join(projectDir, ".opencode", "plugins", CONTEXT_CHECKPOINT_NAME);
  const ownership = classifyOwnership(pluginDir, { config });
  if (!["ABSENT", "MANAGED_V1", "MANAGED_V2"].includes(ownership.state)) {
    throw new Error(`ownership-${ownership.state.toLowerCase()}: ${pluginDir}`);
  }
  const classifierOwnership = [];
  for (const name of CLASSIFIER_PLUGIN_NAMES) {
    const classifierDir = path.join(projectDir, ".opencode", "plugins", name);
    const decision = classifyOwnership(classifierDir, { config });
    // Classifier cleanup is a destructive writer; only absent or explicitly
    // FlowTask-managed directories may be removed by the installation flow.
    if (!["ABSENT", "MANAGED_V1", "MANAGED_V2"].includes(decision.state)) {
      throw new Error(`ownership-${decision.state.toLowerCase()}: ${classifierDir}`);
    }
    classifierOwnership.push(decision);
  }
  // The manager gate runs before any materialization, so an installation
  // without a usable transport never leaves a newly written source behind.
  if (options.worktreeManager) {
    const capabilities = options.worktreeManager.capabilities ?? options.worktreeManager;
    if ((capabilities?.transports ?? []).length === 0) {
      const causes = [capabilities?.cli?.cause, capabilities?.mcp?.cause].filter(Boolean).join("; ");
      throw new Error(`Worktree Manager has no usable transport: ${causes || "no transport was detected"}`);
    }
  }
  // Do any potentially mutating source materialization only after all other
  // read-only preflight checks have passed, so bad config/ownership/manifest
  // cannot leave a newly materialized source behind.
  const source = await (options.ensureSource ?? ensureCanonicalSubmodule)(flowtaskDir);
  const sourceDigest = source.sourceCommit;
  if (sourceDigest !== CONTEXT_CHECKPOINT_SHA) throw new Error(`unexpected context-checkpoint source SHA: ${sourceDigest}`);
  for (const entry of manifest) {
    const resolved = path.resolve(flowtaskDir, "plugins", entry.path);
    const entrypoint = path.resolve(resolved, entry.entrypoint);
    if (!fs.existsSync(resolved) || !fs.existsSync(entrypoint)) {
      throw new Error(`plugin manifest source/entrypoint missing: ${entry.name}`);
    }
  }
  const targets = options.targets ?? [];
  const descriptor = {
    txID: `install-${process.pid}-${Date.now()}`, mode, strictManifest: true,
    targets, sourceDigest, sourceDir: source.sourceDir, manifest, configPath,
    ownership, classifierOwnership, writers: INSTALLER_WRITERS, allowedWrites: [], preDigest: null,
    worktreeManager: options.worktreeManager ?? null,
  };
  return Object.freeze(descriptor);
}

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
// standalone → .flowtask/          : agents/, commands/, skills/, plugins/, scripts/

export const ASSETS = {
  opencode: [
    { src: "agents",  dest: "agents" },
    { src: "scripts", dest: "scripts" },
  ],
  claude: [],
  standalone: [
    { src: "agents",   dest: "agents" },
    { src: "commands", dest: "commands" },
    { src: "skills",   dest: "skills" },
    { src: "plugins",  dest: "plugins" },
    { src: "scripts",  dest: "scripts" },
  ],
  // vscode mirrors standalone for now
  vscode: [
    { src: "agents",   dest: "agents" },
    { src: "commands", dest: "commands" },
    { src: "skills",   dest: "skills" },
    { src: "plugins",  dest: "plugins" },
    { src: "scripts",  dest: "scripts" },
  ],
};

const CLASSIFIER_PLUGIN_NAMES = [
  "flowtask-classifier-hook",
  "flowtask-classifier-tui",
];

const LEGACY_MODEL_SELECTOR_NAME = "flowtask-model-selector";

const CANONICAL_TUI_KEYS = new Set(["$schema", "plugin"]);

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
    logInfo(`ferris-search MCP is not available on ${process.platform}. Skipping.`);
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
    rl.question(`${COLORS.cyan}?${COLORS.reset} Install ferris-search MCP for web search? ${COLORS.dim}(Y/n):${COLORS.reset} `, (ans) => { rl.close(); resolve(ans.trim().toLowerCase()); });
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

const levelToChoice = { training: 1, junior: 1, mid: 2, senior: 3, custom: 4 };
const mapping = {
  1: { level: "training", persona: "tutor-training", file: "tutor-training.md", onboarded: true },
  2: { level: "mid", persona: "tutor-mid", file: "tutor-mid.md", onboarded: true },
  3: { level: "senior", persona: "tutor-senior", file: "tutor-senior.md", onboarded: true },
  4: { level: "custom", persona: "custom", file: null, onboarded: false },
};

async function promptPersonaSeleccion(readline, currentLevel = null) {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available to select a personality. Pass --persona <training|mid|senior|custom> or create/fix TARGET_DIR/config/profile.json.");
  }

  logStep("P", "Agent Personality");
  logInfo("Define how the assistant will communicate with you according to your experience level.");

  const options = [
    { label: "1. I am learning / Entry-level",    desc: "If you are taking your first steps in software development" },
    { label: "2. Mid-level",                          desc: "If you are comfortable in your stack and make technical decisions" },
    { label: "3. Senior",                             desc: "If you design architectures, mentor others, and think long-term" },
    { label: "4. Custom ✦ (recommended)",       desc: "Let the assistant learn your style through a short guided audit" },
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
      `\n${COLORS.dim}↑/↓: navigate, Enter: confirm, Ctrl+C: cancel${COLORS.reset}`,
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
        log("\nInstallation cancelled.", COLORS.yellow);
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
    logError(`Personality file not found: ${personaPath}. Installation will continue without a personality.`);
    return null;
  }
  return fs.readFileSync(personaPath, "utf8");
}

function injectPersonaIntoRunner(targetDir, personaContent) {
  if (personaContent === undefined) return;

  const runnerPath = path.join(targetDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) {
    logWarn(`runner.md not found in ${targetDir}. No personality was injected.`);
    return;
  }

  const content = fs.readFileSync(runnerPath, "utf8");
  fs.writeFileSync(runnerPath, injectPersonaIntoRunnerContent(content, personaContent), "utf8");
  logSuccess(personaContent
    ? `Personality injected into runner.md of ${targetDir}.`
    : `Personality block cleared in runner.md of ${targetDir}.`);
}

export function injectAutonomyIntoRunner(targetDir, descriptor) {
  const runnerPath = path.join(targetDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) {
    const error = new Error(
      `[FlowTask Layers] Could not inject autonomy into runner.md: runner.md not found in ${targetDir}.`,
    );
    error.code = "autonomy_runner_missing";
    throw error;
  }

  const content = fs.readFileSync(runnerPath, "utf8");
  fs.writeFileSync(runnerPath, injectAutonomyIntoRunnerContent(content, descriptor), "utf8");
  logSuccess(`Autonomy injected into runner.md of ${targetDir}.`);
}

/** Autonomy descriptor resolved by layer synchronization. */
function autonomyDescriptorFrom(targetConfig) {
  const layer = targetConfig && targetConfig.autonomy;
  if (!layer || layer.status !== "valid" || !layer.value) return null;
  return { profile: layer.value.profile, source: layer.source };
}

function configureRunnerScripts(targetDir, targetSubDir) {
  const runnerPath = path.join(targetDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) return;
  const content = fs.readFileSync(runnerPath, "utf8");
  fs.writeFileSync(runnerPath, configureRunnerScriptsContent(content, targetSubDir), "utf8");
}

function cleanupLegacyScripts(projectDir, targetDir, flowtaskDir) {
  if (flowtaskDir && path.resolve(path.join(projectDir, ".flowtask")) === path.resolve(flowtaskDir)) return;
  const legacyScripts = path.join(projectDir, ".flowtask", "scripts");
  const standaloneMarker = path.join(projectDir, ".flowtask", ".installation-method");
  let standaloneInstalled = false;
  if (fs.existsSync(standaloneMarker)) {
    try {
      standaloneInstalled = JSON.parse(fs.readFileSync(standaloneMarker, "utf8")).target === "standalone";
    } catch (_) {}
  }
  if (!standaloneInstalled && fs.existsSync(legacyScripts) && fs.existsSync(path.join(targetDir, "scripts"))) {
    fs.rmSync(legacyScripts, { recursive: true, force: true });
    logSuccess(`Legacy scripts cleaned from ${legacyScripts}.`);
  }
}

export function targetConfigDir(targetDir) {
  return path.join(targetDir, "config");
}

function writeProfile(targetDir, level, persona, onboarded) {
  const configDir = targetConfigDir(targetDir);
  const profile = { level, persona, onboarded };
  fs.mkdirSync(configDir, { recursive: true });
  const profilePath = path.join(configDir, "profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
  logSuccess(`Profile saved to ${profilePath}`);
}

function readProfile(targetDir) {
  const profilePath = path.join(targetConfigDir(targetDir), "profile.json");
  if (!fileExists(profilePath)) return null;
  try { return JSON.parse(fs.readFileSync(profilePath, "utf8")); } catch { return null; }
}

function readProfileLevel(targetDir) {
  const level = readProfile(targetDir)?.level;
  return level && levelToChoice[level] ? level : null;
}

const OPERATIONAL_LAYERS = Object.freeze(["autonomy", "permissions"]);

function layerLabel(name) {
  return name === "autonomy" ? "autonomy" : "permissions";
}

function layerOperationalError(name, layer) {
  const reason = layer.reason
    ?? (layer.status === "missing"
      ? "layer missing: the layer file was not found"
      : "invalid layer");
  const error = new Error(describeOperationalFailure({
    layer: name,
    path: layer.path,
    reason,
  }));
  error.code = name === "autonomy" ? "autonomy_invalid" : "permissions_invalid";
  error.layer = name;
  error.path = layer.path ?? null;
  error.reason = reason;
  return error;
}

function writeLayerDefault(configDir, name) {
  const filePath = path.join(configDir, LAYER_FILES[name]);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(MIGRATION_DEFAULTS[name], null, 2), "utf8");
  logSuccess(`${layerLabel(name)} layer migrated at ${filePath} with the installation default value.`);
}

/**
 * Ensures the target has the autonomy and permissions layers.
 *
 * Resolution is per layer with full replacement: a valid layer is
 * preserved, and an invalid layer fails the target without overwriting the file.
 * The migration default is written only when the layer does not exist in any
 * source: the default is a migration, not a runtime fallback.
 */
export function ensureTargetLayers(targetDir, { teamConfigDir = null } = {}) {
  const configDir = targetConfigDir(targetDir);
  const project = readLayerSources(configDir);
  const team = teamConfigDir ? readLayerSources(teamConfigDir) : null;

  const resolution = resolveLayers({ team, project });
  const created = [];

  // An invalid layer fails the target before writing anything: the file is
  // preserved and is not repaired with a default.
  for (const name of OPERATIONAL_LAYERS) {
    const layer = resolution.layers[name];
    if (layer.status === "invalid") throw layerOperationalError(name, layer);
  }

  for (const name of OPERATIONAL_LAYERS) {
    if (resolution.layers[name].status !== "missing") continue;
    writeLayerDefault(configDir, name);
    created.push(name);
  }

  const finalResolution = resolveLayers({ team, project: readLayerSources(configDir) });
  return { resolution: finalResolution, created };
}

export function materializeReviewConfig(flowtaskDir, targetDir) {
  const sourcePath = path.join(flowtaskDir, "config", "review.json");
  const config = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const configDir = targetConfigDir(targetDir);
  const projectDir = path.basename(targetDir) === ".flowtask"
    ? path.dirname(targetDir)
    : path.dirname(path.dirname(targetDir));
  const materialized = {
    ...config,
    stampPath: path.relative(projectDir, path.join(configDir, ".review-stamp")) || path.join(configDir, ".review-stamp"),
  };
  const destination = path.join(configDir, "review.json");
  fs.mkdirSync(configDir, { recursive: true });
  if (!writeJsonVerified(destination, materialized)) throw new Error(`could not verify ${destination}`);
  return destination;
}

/**
 * Synchronizes the target configuration: managed review, the persona layer,
 * and the autonomy and permissions layers.
 *
 * Persona is written only with an explicit choice; a valid profile is
 * preserved, and an invalid one without an explicit choice is not overwritten. The
 * operational layers are resolved separately and are never repaired with a default.
 */
export function syncTargetConfig(flowtaskDir, targetDir, personaChoice, { preserveProfile = false, explicitPersona = false } = {}) {
  materializeReviewConfig(flowtaskDir, targetDir);

  const existing = readProfile(targetDir);
  const valid = Boolean(existing && levelToChoice[existing.level] && typeof existing.persona === "string");

  let personaStatus;
  if (explicitPersona && personaChoice) {
    writeProfile(targetDir, personaChoice.level, personaChoice.persona, personaChoice.onboarded);
    personaStatus = "valid";
  } else if (valid) {
    personaStatus = "valid";
  } else if (existing) {
    personaStatus = "invalid";
    logWarn(`Invalid persona profile in ${targetConfigDir(targetDir)}: it is not overwritten and the flow continues without persona.`);
  } else if (!preserveProfile && personaChoice) {
    writeProfile(targetDir, personaChoice.level, personaChoice.persona, personaChoice.onboarded);
    personaStatus = "valid";
  } else {
    personaStatus = "missing";
    logWarn(`No persona profile was found in ${targetConfigDir(targetDir)}: continuing without persona.`);
  }

  const { resolution } = ensureTargetLayers(targetDir);

  return {
    persona: personaStatus,
    autonomy: resolution.layers.autonomy,
    permissions: resolution.layers.permissions,
  };
}

export async function resolvePersonaSelection(projectDir, readline, options = {}) {
  const profileLevel = readProfileLevel(path.join(projectDir, ".flowtask"));
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
export function loadPluginManifest(flowtaskDir, { required = false } = {}) {
  const manifestPath = path.join(flowtaskDir, "plugins", "flowtask-plugins.json");
  try {
    if (!fileExists(manifestPath)) {
      if (required) throw new Error(`required plugin manifest not found at ${manifestPath}`);
      logWarn(`Plugin manifest not found at ${manifestPath}`);
      return [];
    }
    const content = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(content);
    if (!Array.isArray(manifest)) throw new Error("plugin manifest must be an array");
    if (required && manifest.some((entry) => !validateManifestEntry(entry))) throw new Error("plugin manifest contains an invalid entry");
    return manifest;
  } catch (err) {
    if (required) throw new Error(`Failed to load required plugin manifest: ${err.message}`, { cause: err });
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
    const plugins = Array.isArray(config.plugins) ? config.plugins : config.plugin;
    return Array.isArray(plugins) && plugins.some((entry) => {
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
    const pluginKey = Array.isArray(config.plugins) ? "plugins" : "plugin";
    if (!Array.isArray(config[pluginKey])) return false;

    const originalLength = config[pluginKey].length;
    config[pluginKey] = config[pluginKey].filter((entry) => {
      const pluginPath = typeof entry === "string" ? entry : entry?.path;
      return !CLASSIFIER_PLUGIN_NAMES.includes(extractPluginName(pluginPath));
    });

    if (config[pluginKey].length === originalLength) return false;
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

function writeBytesIfChanged(filePath, content) {
  const next = Buffer.from(content, "utf8");
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath).equals(next)) return true;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, next);
    fs.renameSync(tempPath, filePath);
    return fs.readFileSync(filePath).equals(next);
  } catch (err) {
    try { fs.rmSync(`${filePath}.${process.pid}.tmp`, { force: true }); } catch { /* preserve original */ }
    logError(`Could not write ${filePath}: ${err.message}`);
    return false;
  }
}

/** Regenerate the standalone TUI declaration from the active installation only. */
export function regenerateCanonicalTui(projectDir, flowtaskDir, manifest) {
  const plugins = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!validateManifestEntry(entry) || entry.kind !== "tui" || !entry.destinations.includes("opencode")) continue;
    if (CLASSIFIER_PLUGIN_NAMES.includes(entry.name) && !isClassifierEnabled(manifest)) continue;
    const sourceEntrypoint = path.join(flowtaskDir, "plugins", entry.path, entry.entrypoint);
    if (!fileExists(sourceEntrypoint)) {
      logWarn(`TUI plugin omitted from the canonical declaration: ${entry.name}`);
      continue;
    }
    let relative = path.relative(path.dirname(path.join(flowtaskDir, "tui.json")), sourceEntrypoint).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    plugins.push(relative);
  }

  const canonical = { "$schema": "https://opencode.ai/tui.json", plugin: plugins };
  const unexpectedKeys = Object.keys(canonical).filter((key) => !CANONICAL_TUI_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    logWarn(`The canonical TUI declaration contains unexpected keys: ${unexpectedKeys.join(", ")}`);
  }

  const legacyPath = path.join(projectDir, "tui.json");
  const destination = path.join(flowtaskDir, "tui.json");
  const preservationSource = fileExists(legacyPath)
    ? legacyPath
    : (fileExists(destination) ? destination : null);
  let preservedFields = {};
  if (preservationSource) {
    try {
      const legacy = JSON.parse(fs.readFileSync(preservationSource, "utf8"));
      if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
        preservedFields = Object.fromEntries(
          Object.entries(legacy).filter(([key]) => !CANONICAL_TUI_KEYS.has(key)),
        );
      }
    } catch (err) {
      logWarn(`Could not preserve fields from ${preservationSource}: ${err.message}`);
    }
  }

  const content = `${JSON.stringify({ ...preservedFields, ...canonical }, null, 2)}\n`;
  if (!writeBytesIfChanged(destination, content)) {
    throw new Error(`could not verify the canonical TUI declaration ${destination}`);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (JSON.stringify(parsed) !== JSON.stringify(JSON.parse(content))) throw new Error("invalid TUI content");
  } catch (err) {
    throw new Error(`verification of ${destination} failed: ${err.message}`);
  }
  return destination;
}

/** Normalize a CLI plugin path for stable comparison. */
function normalizePluginPath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/").replace(/^\.\//, "") : "";
}

/** Regenerate the project CLI plugin declaration while preserving unrelated settings. */
export function regenerateCanonicalCli(projectDir, flowtaskDir, manifest) {
  const destination = path.join(flowtaskDir, "cli.json");
  let config = {};
  if (fileExists(destination)) {
    try {
      config = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("root must be an object");
    } catch (err) { throw new Error(`invalid CLI config ${destination}: ${err.message}`); }
  }
  const managedNames = new Set((manifest ?? []).filter((entry) => entry?.destinations?.includes("opencode")).map((entry) => entry.name));
  const desiredPlugins = [];
  for (const entry of manifest ?? []) {
    if (entry?.kind !== "cli" || !entry.destinations?.includes("opencode")) continue;
    const sourceEntrypoint = path.join(flowtaskDir, "plugins", entry.path, entry.entrypoint);
    if (!fileExists(sourceEntrypoint)) continue;
    let relative = path.relative(path.dirname(destination), sourceEntrypoint).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    desiredPlugins.push(relative);
  }
  const desiredPaths = new Set(desiredPlugins.map(normalizePluginPath));
  const plugins = (Array.isArray(config.plugins) ? config.plugins : []).filter((item) => {
    const rawPath = typeof item === "string" ? item : item?.path;
    const name = extractPluginName(rawPath);
    return !(name && managedNames.has(name)) && !desiredPaths.has(normalizePluginPath(rawPath));
  });
  plugins.push(...desiredPlugins);
  const next = { ...config, $schema: config.$schema || "https://opencode.ai/cli.json", plugins };
  if (!writeBytesIfChanged(destination, `${JSON.stringify(next, null, 2)}\n`)) throw new Error(`could not write CLI config ${destination}`);
  const runtimeConfig = path.join(projectDir, ".opencode", "cli.json");
  let existingRuntime = {};
  if (fileExists(runtimeConfig)) {
    try { existingRuntime = JSON.parse(fs.readFileSync(runtimeConfig, "utf8")); } catch { throw new Error(`invalid CLI config ${runtimeConfig}`); }
    if (!existingRuntime || typeof existingRuntime !== "object" || Array.isArray(existingRuntime)) throw new Error(`invalid CLI config ${runtimeConfig}`);
  }
  const runtimeDesired = [];
  for (const entry of manifest ?? []) {
    if (entry?.kind !== "cli" || !entry.destinations?.includes("opencode")) continue;
    const installedEntrypoint = path.join(projectDir, ".opencode", "plugins", entry.name, entry.entrypoint);
    if (!fileExists(installedEntrypoint)) continue;
    runtimeDesired.push(calculatePluginRelativePath(runtimeConfig, projectDir, entry.name, entry.entrypoint));
  }
  const runtimePaths = new Set(runtimeDesired.map(normalizePluginPath));
  const runtimePlugins = (Array.isArray(existingRuntime?.plugins) ? existingRuntime.plugins : []).filter((item) => {
    const rawPath = typeof item === "string" ? item : item?.path;
    const name = extractPluginName(rawPath);
    return !(name && managedNames.has(name)) && !runtimePaths.has(normalizePluginPath(rawPath));
  });
  runtimePlugins.push(...runtimeDesired);
  const runtime = { ...existingRuntime, $schema: existingRuntime.$schema || "https://opencode.ai/cli.json", plugins: runtimePlugins };
  if (!writeBytesIfChanged(runtimeConfig, `${JSON.stringify(runtime, null, 2)}\n`)) throw new Error(`could not write CLI config ${runtimeConfig}`);
  return destination;
}

export function removeLegacyConsumerFiles(projectDir, fileNames = ["tui.json", "CLAUDE.md"]) {
  let success = true;
  for (const fileName of fileNames) {
    const filePath = path.join(projectDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      fs.rmSync(filePath, { force: true });
      if (fs.existsSync(filePath)) throw new Error("the file is still present");
      logInfo(`Legacy residue removed: ${fileName}`);
    } catch (err) {
      success = false;
      logError(`Could not remove ${filePath}: ${err.message}. Retry with flowtask update.`);
    }
  }
  return success;
}

function removeClassifierDirectories(projectDir, preparedDecisions = null) {
  let removed = false;
  const pluginsDir = path.join(projectDir, ".opencode", "plugins");

  for (const name of CLASSIFIER_PLUGIN_NAMES) {
    const pluginDir = path.join(pluginsDir, name);
    if (!fileExists(pluginDir)) continue;
    const decision = preparedDecisions?.find((item) => item.path === pluginDir);
    if (preparedDecisions && !["MANAGED_V1", "MANAGED_V2"].includes(decision?.state)) continue;
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      logWarn(`Could not remove deprecated plugin ${name}: ${err.message}`);
    }
  }
  return removed;
}

function cleanupDisabledClassifier(projectDir, manifest, preparedDecisions = null) {
  if (isClassifierEnabled(manifest)) return;

  const tuiConfigPath = path.join(projectDir, ".opencode", "tui.json");
  const serverConfigPath = path.join(projectDir, ".opencode", "opencode.json");
  const hasInstallation = CLASSIFIER_PLUGIN_NAMES.some((name) =>
    fileExists(path.join(projectDir, ".opencode", "plugins", name))
  ) || configContainsClassifier(tuiConfigPath) || configContainsClassifier(serverConfigPath);

  const removedDirectory = removeClassifierDirectories(projectDir, preparedDecisions);
  const removedServerEntry = removeClassifierEntries(serverConfigPath);

  if (hasInstallation || removedDirectory || removedServerEntry) {
    logWarn("the classifier plugin was deprecated");
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
export function installManifestPlugins(projectDir, manifest, flowtaskDir, preflight = null) {
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
      logWarn(`Could not read the legacy tui.json ${projectTuiPath}: ${err.message}. It is preserved without migration.`);
    }
  }
  const migratedLegacyIndexes = new Set();
  let installedAgentModelSelector = false;

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

    if (entry.name === CONTEXT_CHECKPOINT_NAME) {
      const sourceDir = path.join(flowtaskDir, "plugins", entry.path);
      replaceManagedPackage({ sourceDir, destinationDir: destDir,
        configPath: path.join(projectDir, ".opencode", "opencode.json"), sourceCommit: CONTEXT_CHECKPOINT_SHA,
        ownershipDecision: preflight?.ownership?.path === destDir ? preflight.ownership : undefined });
      continue;
    }

    const allowlist = Array.isArray(entry.files) && entry.files.length > 0 ? entry.files : null;
    try {
      copyDirectoryDelta(srcDir, destDir, [], new Set(), null, allowlist);
      if (allowlist) pruneAllowlistedDestination(destDir, allowlist);
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

    if (entry.name === "agent-model-selector-opencode") installedAgentModelSelector = true;

    if (entry.kind === "cli") {
      const cliPath = path.join(projectDir, ".opencode", "cli.json");
      const pluginRuntimePath = calculatePluginRelativePath(cliPath, projectDir, entry.name, entry.entrypoint);
      if (!registerPluginArrayEntry(cliPath, pluginRuntimePath, "https://opencode.ai/cli.json")) {
        throw new Error(`Could not update ${cliPath}`);
      }
      removePluginFromConfigArrays(nativeTuiPath, entry.name);
      removePluginFromConfigArrays(projectTuiPath, entry.name);
    } else if (entry.kind === "tui") {
      const installationRuntimePath = calculatePluginRelativePath(nativeTuiPath, projectDir, entry.name, entry.entrypoint);
      if (!registerPluginArrayEntry(nativeTuiPath, installationRuntimePath, "https://opencode.ai/tui.json")) {
        throw new Error(`Could not write the native TUI registration ${nativeTuiPath}`);
      }
      const installationTui = JSON.parse(fs.readFileSync(nativeTuiPath, "utf8"));
      const registered = Array.isArray(installationTui.plugin) && installationTui.plugin.some((plugin) => {
        const pluginPath = typeof plugin === "string" ? plugin : plugin?.path;
        return pluginPath === installationRuntimePath;
      });
      if (!registered) throw new Error(`Could not verify the TUI path ${installationRuntimePath}`);
      removePluginFromConfigArrays(path.join(projectDir, ".opencode", "cli.json"), entry.name);
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
        throw new Error(`Could not update ${opencodeConfigPath}`);
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
        if (!writeJsonVerified(projectTuiPath, cleaned)) throw new Error("destination verification failed");
      }
    } catch (err) {
      logWarn(`Could not clean the legacy tui.json ${projectTuiPath}: ${err.message}. Configuration is preserved; retry with flowtask update.`);
    }
  }

  cleanupDisabledClassifier(projectDir, manifest, preflight?.classifierOwnership ?? null);
  if (installedAgentModelSelector) cleanupLegacyModelSelector(projectDir, flowtaskDir, manifest);
  if (manifest.some((entry) => entry?.kind === "cli")) regenerateCanonicalCli(projectDir, flowtaskDir, manifest);
}

/** Remove destination entries outside an explicit manifest allowlist. */
function pruneAllowlistedDestination(destDir, includePaths) {
  if (!fs.existsSync(destDir)) return;
  for (const name of fs.readdirSync(destDir)) {
    if (includePaths.includes(name)) continue;
    fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
  }
}

/**
 * Remove the legacy model selector installation once its replacement was
 * copied and validated. The manifest is the source of truth: if the legacy
 * name is still declared, nothing is removed.
 */
function cleanupLegacyModelSelector(projectDir, flowtaskDir, manifest) {
  if ((manifest ?? []).some((entry) => entry?.name === LEGACY_MODEL_SELECTOR_NAME)) return false;

  let removed = false;
  const pluginDir = path.join(projectDir, ".opencode", "plugins", LEGACY_MODEL_SELECTOR_NAME);
  if (fileExists(pluginDir)) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      removed = true;
      logInfo(`Legacy plugin removed: ${LEGACY_MODEL_SELECTOR_NAME}`);
    } catch (err) {
      logWarn(`Could not remove the legacy plugin ${LEGACY_MODEL_SELECTOR_NAME}: ${err.message}`);
    }
  }

  const configPaths = new Set([
    path.join(projectDir, ".opencode", "cli.json"),
    path.join(projectDir, ".opencode", "tui.json"),
    path.join(projectDir, ".opencode", "opencode.json"),
    path.join(flowtaskDir, "cli.json"),
    path.join(flowtaskDir, "tui.json"),
  ]);
  for (const configPath of configPaths) {
    if (removePluginFromConfigArrays(configPath, LEGACY_MODEL_SELECTOR_NAME)) removed = true;
  }
  return removed;
}

function removePluginFromConfigArrays(configPath, pluginName) {
  if (!fileExists(configPath)) return false;
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return false; }
  if (!config || typeof config !== "object") return false;
  let changed = false;
  const next = { ...config };
  for (const key of ["plugin", "plugins"]) {
    if (!Array.isArray(config[key])) continue;
    next[key] = config[key].filter((item) => extractPluginName(typeof item === "string" ? item : item?.path) !== pluginName);
    changed ||= next[key].length !== config[key].length;
  }
  if (changed) writeJsonVerified(configPath, next);
  return changed;
}

// ─── Migration & Cleanup ──────────────────────────────────────────────────────

export function migrateProfileLocation(projectDir, flowtaskDir, targetDirs = [flowtaskDir]) {
  const legacyPaths = [
    path.join(projectDir, ".flowtask", "config", "profile.json"),
    path.join(projectDir, ".flowtask", "profile.json"),
  ];
  const source = legacyPaths.find((candidate) => fs.existsSync(candidate));
  if (!source) return true;
  try {
    const profile = JSON.parse(fs.readFileSync(source, "utf8"));
    const destinations = targetDirs.map((targetDir) => path.join(targetConfigDir(targetDir), "profile.json"));
    for (const destination of destinations) {
      if (path.resolve(source) === path.resolve(destination)) continue;
      if (fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (!writeJsonVerified(destination, profile)) throw new Error(`verification of ${destination} failed`);
    }
    for (const destination of destinations) {
      if (path.resolve(source) === path.resolve(destination)) continue;
      const verified = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (JSON.stringify(verified) !== JSON.stringify(profile)) throw new Error(`verification of ${destination} failed`);
    }
    fs.rmSync(source);
    logSuccess(`Profile migrated from ${source} to ${destinations.join(", ")}`);
    return true;
  } catch (err) {
    logError(`Could not migrate profile.json from ${source}: ${err.message}. Check permissions/space and retry with flowtask update.`);
    return false;
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

export async function install(flowtaskDir, options = {}) {
  const worktreeManager = prepareWorktreeManagerForRun(options, { mode: "install" });
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Installation Wizard       ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const readline = await import("readline");

  // ── Step 0: IDE Selection ────────────────────────────────────────────────
  logStep(0, "Select Target Environment");
  const selectedOptions = Array.isArray(options.target) && options.target.length > 0
    ? options.target
    : await showInteractiveSelector(readline);

  const targets = [];
  if (selectedOptions.length === 0) {
    targets.push({ id: "standalone", ideDir: "", targetSubDir: ".flowtask" });
  } else {
    if (selectedOptions.includes("opencode")) targets.push({ id: "opencode", ideDir: ".opencode", targetSubDir: path.join(".opencode", "flowtask") });
    if (selectedOptions.includes("vscode"))   targets.push({ id: "vscode",   ideDir: ".vscode",   targetSubDir: path.join(".vscode",   "flowtask") });
    if (selectedOptions.includes("claude"))   targets.push({ id: "claude",   ideDir: ".claude",   targetSubDir: path.join(".claude",   "flowtask") });
  }
  const nonClaudeTargets = targets.filter(({ id }) => id !== "claude");
  const claudeSelected = targets.some(({ id }) => id === "claude");

  // ── Step P: Agent Personality ─────────────────────────────────
  const personaChoice = options.persona
    ? mapping[levelToChoice[options.persona]]
    : await promptPersonaSeleccion(readline);
  const personaContent = resolvePersonaContent(flowtaskDir, personaChoice);

  const projectDir = process.cwd();
  const preflight = nonClaudeTargets.some(({ id }) => id === "opencode")
    ? await prepareInstallation(flowtaskDir, projectDir, "install", { targets: nonClaudeTargets, worktreeManager }) : null;
  const targetDirs = nonClaudeTargets.map(({ targetSubDir }) => path.join(projectDir, targetSubDir));
  if (!migrateProfileLocation(projectDir, flowtaskDir, targetDirs)) {
    throw new Error("Could not migrate profile.json; the source is preserved. Check permissions/space and retry with flowtask update.");
  }
  const results = [];

  for (const { id, ideDir, targetSubDir } of nonClaudeTargets) {
    const TARGET_DIR = path.join(projectDir, targetSubDir);
    logInfo(`\nProcessing target: ${id.toUpperCase()} (${targetSubDir})...`);

    try {
      // ── Step 1: IDE check ────────────────────────────────────────────────
      logStep(1, `Checking ${id}...`);
      if (id === "opencode" && !checkOpenCode()) throw new Error("OpenCode is required for this target.");

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
        const pruned = pruneDirectoryExtras(srcDir, destDir);
        copyWithProgress(srcDir, destDir, src, readline);
        if (!verifyDirectoryMirror(srcDir, destDir, { ignorePaths: pruned.preserved })) throw new Error(`Mirror verification failed for ${src}`);
      }

      // ── Target config: persona and autonomy/permissions layers ──
      // Layers are resolved and written before installing the plugin and before
      // injecting persona and autonomy.
      configureRunnerScripts(TARGET_DIR, targetSubDir);
      const targetConfig = syncTargetConfig(flowtaskDir, TARGET_DIR, personaChoice, { explicitPersona: true });
      const autonomyDescriptor = autonomyDescriptorFrom(targetConfig);

      // OpenCode: skills go to .opencode/skills/ (outside flowtask subdir)
      if (id === "opencode") {
        const srcSkills = path.join(flowtaskDir, "skills");
        if (fileExists(srcSkills)) copyWithProgress(srcSkills, path.join(projectDir, ".opencode", "skills"), "skills (opencode)", readline);
        mergeOpencodeConfig(path.join(projectDir, ideDir, "opencode.json"), flowtaskDir, ideDir);
      }

      // ── Step 5: Install plugins from manifest (OpenCode only) ────────────
      // Copies each manifest entry (filtered by destinations) into
      // .opencode/plugins/<name>/ and registers it in tui.json (kind tui)
      // or .opencode/opencode.json (kind server).
      if (id === "opencode") {
        logStep(5, "Installing plugins from manifest...");
        const manifest = preflight?.manifest ?? loadPluginManifest(flowtaskDir);
        installManifestPlugins(projectDir, preflight?.manifest ?? manifest, flowtaskDir, preflight);
      }

      // ── Inject persona and autonomy into runner.md ───────────────────
      injectPersonaIntoRunner(TARGET_DIR, personaContent ?? null);
      if (autonomyDescriptor) injectAutonomyIntoRunner(TARGET_DIR, autonomyDescriptor);

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

  if (claudeSelected) {
    logInfo("\nProcessing target: CLAUDE (user-level runtime)...");
    try {
      logStep(1, "Checking claude...");
      checkClaudeCode();
      logStep(2, "Checking Engram...");
      checkEngram();
      const claudeResult = installClaudeTarget({
        flowtaskDir,
        projectDir,
        personaChoice,
        personaContent,
      });
      results.push({
        target: "claude",
        status: "Success",
        stats: { payloadId: claudeResult.runtime.payloadId },
      });
    } catch (err) {
      logError(`Failed to install in claude: ${err.message}`);
      results.push({ target: "claude", status: "Error", message: err.message });
    }
  }

  for (const { id, targetSubDir } of nonClaudeTargets) {
    try {
      await coordinateGraphify({ projectDir, targetDir: path.join(projectDir, targetSubDir), flowtaskDir, selectedClis: [id], readline });
    } catch (err) {
      logWarn(`Graphify (${id}): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
    }
  }

  if (claudeSelected) {
    try {
      await coordinateGraphify({
        projectDir,
        targetDir: path.join(projectDir, ".claude", "flowtask"),
        flowtaskDir,
        selectedClis: ["claude"],
        readline,
      });
    } catch (err) {
      logWarn(`Graphify (claude): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
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

export async function update(flowtaskDir, options = {}) {
  const worktreeManager = prepareWorktreeManagerForRun(options, { mode: "update" });
  if (worktreeManager) {
    const versionNotice = formatWorktreeManagerVersionNotice({ previousVersion: worktreeManager.previousVersion, version: worktreeManager.version });
    if (versionNotice) logInfo(versionNotice);
  }
  console.log(`
${COLORS.blue}╔═══════════════════════════════════════════╗
║        FlowTask Update Wizard (Delta)     ║
╚═══════════════════════════════════════════╝${COLORS.reset}
  `);

  const readline = await import("readline");
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

  const claudePaths = resolveClaudePaths(projectDir);
  const claudeRegistered = fileExists(claudePaths.registryPath);
  const claudeRuntimeInstalled = fileExists(claudePaths.runtimeManifestPath);
  if (claudeRegistered && !targets.some(({ id }) => id === "claude")) {
    targets.push({ id: "claude", marker: null, subDir: path.join(".claude", "flowtask"), ideDir: ".claude", registered: true });
    logSuccess("Found claude project registration");
  }

  const nonClaudeTargets = targets.filter(({ id }) => id !== "claude");
  const claudeTarget = targets.find(({ id }) => id === "claude") ?? null;
  const claudeActive = Boolean(claudeTarget || claudeRegistered || claudeRuntimeInstalled);

  if (targets.length === 0 && !claudeRuntimeInstalled) {
    logError("No FlowTask installation found. Run 'flowtask install' first.");
    return;
  }

  const preflight = nonClaudeTargets.some(({ id }) => id === "opencode")
    ? await prepareInstallation(flowtaskDir, projectDir, "update", { targets: nonClaudeTargets, worktreeManager }) : null;
  if (!claudeActive) {
    const legacyCleanupOk = removeLegacyConsumerFiles(projectDir, ["CLAUDE.md"]);
    if (!legacyCleanupOk) logWarn("CLAUDE.md cleanup was not complete; the result must be reviewed.");
  }

  const targetDirs = nonClaudeTargets.map(({ subDir }) => path.join(projectDir, subDir));
  if (!migrateProfileLocation(projectDir, flowtaskDir, targetDirs)) {
    throw new Error("Could not migrate profile.json; the source is preserved. Check permissions/space and retry with flowtask update.");
  }

  // ── Step 1.5: Agent Personality ──────────────────────────────
  let currentLevel = null;
  for (const targetDir of targetDirs) {
    currentLevel = readProfileLevel(targetDir);
    if (currentLevel) break;
  }

  let personaChoice = null;
  if (options.persona && levelToChoice[options.persona]) {
    personaChoice = mapping[levelToChoice[options.persona]];
  } else if (currentLevel && levelToChoice[currentLevel]) {
    personaChoice = mapping[levelToChoice[currentLevel]];
    logInfo(`Preserving existing personality: ${personaChoice.persona}`);
  } else {
    // Without a valid personality and without an explicit choice, the prompt is not opened:
    // the flow continues without persona and without altering autonomy or permissions.
    logWarn("No valid personality was found and --persona was not provided. Continuing without injecting a personality.");
  }
  const personaContent = personaChoice ? resolvePersonaContent(flowtaskDir, personaChoice) : null;

  // ── Step 2: Delta sync each target ──────────────────────────────────────
  const preservePaths = ["CA-", "workspace", ".workspace", ".installation-method"];
  const results = [];
  const manifest = preflight?.manifest ?? loadPluginManifest(flowtaskDir);

  for (const { id, subDir, ideDir, previousMethod } of nonClaudeTargets) {
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
        const pruned = pruneDirectoryExtras(srcDir, destDir, { preservePaths });
        totalCopied += stats.copied;
        totalSkipped += stats.skipped;
        if (!verifyDirectoryMirror(srcDir, destDir, { ignorePaths: pruned.preserved })) throw new Error(`Mirror verification failed for ${src}`);
      }

      if (id !== "standalone") cleanupLegacyScripts(projectDir, TARGET_DIR, flowtaskDir);

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

      // ── Target config: persona and autonomy/permissions layers ──
      // Layers are resolved and written before installing the plugin and before
      // injecting persona and autonomy.
      configureRunnerScripts(TARGET_DIR, subDir);
      const targetConfig = syncTargetConfig(flowtaskDir, TARGET_DIR, personaChoice, {
        preserveProfile: !options.persona,
        explicitPersona: Boolean(options.persona),
      });
      const autonomyDescriptor = autonomyDescriptorFrom(targetConfig);

      // ── Re-install plugins from manifest (OpenCode only) ─────────────────
      if (id === "opencode") {
        installManifestPlugins(projectDir, manifest, flowtaskDir, preflight);
      }

      // ── Inject persona and autonomy into runner.md ───────────────────
      injectPersonaIntoRunner(TARGET_DIR, personaContent ?? null);
      if (autonomyDescriptor) injectAutonomyIntoRunner(TARGET_DIR, autonomyDescriptor);

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

  if (claudeActive) {
    logStep(2, "Updating claude...");
    try {
      const explicitPersona = Boolean(options.persona);
      const claudeResult = updateClaudeTarget({
        flowtaskDir,
        projectDir,
        personaChoice: explicitPersona ? personaChoice : null,
        personaContent: explicitPersona ? personaContent : undefined,
      });
      results.push({
        target: "claude",
        status: "Success",
        stats: { registered: claudeResult.registered },
      });
    } catch (err) {
      logError(`Failed to update claude: ${err.message}`);
      results.push({ target: "claude", status: "Error", message: err.message });
    }
  }

  if (nonClaudeTargets.length > 0) {
    try {
      regenerateCanonicalCli(projectDir, flowtaskDir, manifest);
      logSuccess("Canonical CLI declaration regenerated");
      regenerateCanonicalTui(projectDir, flowtaskDir, manifest);
      logSuccess("Canonical TUI declaration regenerated");
      // The canonical destination is verified before deleting the legacy source.
      const legacyNames = claudeActive ? ["tui.json"] : ["tui.json", "CLAUDE.md"];
      if (!removeLegacyConsumerFiles(projectDir, legacyNames)) {
        logWarn("flowtask update finished with legacy residue that could not be removed.");
      }
    } catch (err) {
      logError(`Could not regenerate the canonical TUI declaration: ${err.message}`);
    }
  }

  for (const { id, subDir } of nonClaudeTargets) {
    try {
      await coordinateGraphify({ projectDir, targetDir: path.join(projectDir, subDir), flowtaskDir, selectedClis: [id], readline });
    } catch (err) {
      logWarn(`Graphify (${id}): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
    }
  }

  if (claudeActive) {
    try {
      await coordinateGraphify({
        projectDir,
        targetDir: path.join(projectDir, ".claude", "flowtask"),
        flowtaskDir,
        selectedClis: ["claude"],
        readline,
      });
    } catch (err) {
      logWarn(`Graphify (claude): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
    }
  }

  printSummary("Update Summary", results, (res) => {
    if (res.stats?.copied !== undefined) {
      return ` (${res.stats.copied} updated, ${res.stats.skipped} preserved)`;
    }
    if (res.target === "claude" && res.stats) {
      return res.stats.registered === false ? " (not registered)" : " (registered)";
    }
    return "";
  });
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
