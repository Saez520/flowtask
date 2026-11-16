import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { isDeepStrictEqual } from "util";
import {
  COLORS, log, logStep, logSuccess, logError, logWarn, logInfo,
  isBinaryInstalled, getVersion, fileExists,
} from "./logger.js";
import { copyWithProgress, copyDirectoryDelta, pruneDirectoryExtras, verifyDirectoryMirror } from "./copy.js";
import { captureInstallSurfaces, createInstallTransaction, migrateLegacyRootTransactional } from "./install-transaction.js";
import { registerPluginArrayEntry } from "./opencode.js";
import { ensureGlobalFerrisSearch } from "./ferris-search.js";
import { installClaudeTarget, installClaudeUserSurface, updateClaudeTarget, uninstallClaudeGlobal, uninstallClaudeProject } from "./claude-install.js";
import { describeClaudeModResults, installClaudeModPlugins } from "./claude-plugin.js";
import { resolveClaudePaths } from "./claude.js";
import {
  ensureUserRuntime,
  ensureUserRuntimeConfig,
  preflightUserRuntimeConfig,
  removeUserRuntime,
  resolveUserRuntimePaths,
} from "./user-runtime.js";
import { installUserPlugins, removeUserPlugins } from "./user-plugins.js";
import { ensureOpencodeGlobalSurface, removeOpencodeGlobalSurface } from "./opencode-global.js";
import {
  migrateLegacyOpencodeProject,
  registerOpencodeProject,
  removeOpencodeProject,
} from "./opencode-project.js";
import {
  readProjectRegistration,
  readProjectsIndex,
  removeProjectRegistration,
} from "./project-registration.js";
import {
  AUTONOMY_END_MARKER,
  AUTONOMY_START_MARKER,
  CUSTOM_PERSONA_TEXT,
  PERSONA_END_MARKER,
  PERSONA_START_MARKER,
  buildRuntimeRunnerBody,
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
import {
  createUpdateReport,
  describeGraphifyPhase,
  describeSearchPhase,
  readProjectVersion,
} from "./update-report.js";
import { CONTEXT_CHECKPOINT_NAME, CONTEXT_CHECKPOINT_SHA, classifyOwnership, replaceManagedPackage } from "./ownership.js";
import { resolveGlobalConfigDir } from "./global-paths.js";
import { globalWorktreeManagerDir } from "./global-paths.js";
import { assertRunnerCanon } from "./runner-flows.js";
import { ensureGlobalWorktreeManager, formatWorktreeManagerVersionNotice } from "./worktree-manager-runtime.js";
import { downloadWorktreeManagerPackage } from "./worktree-manager-package.js";
import { resolvePythonRuntime } from "./python-runtime.js";
import { registerWorktreeManagerMcp } from "./worktree-mcp-registration.js";
import { ensureCanonicalSubmodule } from "./submodule-publication.js";
import {
  AUTONOMY_PROFILES,
  LAYER_FILES,
  MIGRATION_DEFAULTS,
  PERSONA_FILES,
  describeOperationalFailure,
  readLayerSources,
  resolveLayers,
} from "./layers.js";

export const INSTALLER_WRITERS = Object.freeze([
  "W01 removeLegacyConsumerFiles", "W02 migrateProfileLocation", "W03 ensureGlobalFerrisSearch",
  "W04 root migration", "W05 target creation", "W06 asset copy/mirror", "W07 OpenCode skills/config",
  "W08 plugin copy/register", "W09 markers", "W10 runner/persona/sync config", "W11 Claude outputs",
  "W12 TUI canonical/legacy", "W13 classifier cleanup", "W14 legacy scripts/consumers",
  "W15 root cleanup", "W16 Graphify", "W17 JSON/file primitives",
  "W18 worktree MCP registration",
]);

// ─── Worktree Manager ────────────────────────────────────────────────────────
// The manager is acquired from the published npm package and published as a
// single managed copy in the user's global directory. It is never copied into a
// target and it is never registered as a consumer server: the capabilities
// below describe what the downloaded package can actually do, not what a
// configuration claims.

const WORKTREE_MANAGER_PROBE_TIMEOUT_MS = 5000;
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
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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

/** Probe the CLI entrypoint: `python -m worktree_manager --version`. */
function probeManagerCli(managerDir, python, timeoutMs) {
  const result = runPythonProbe(python.executable, [...python.prefix, "-m", "worktree_manager", "--version"], { managerDir, timeoutMs });
  if (!result.ok) return { ok: false, cause: result.cause };
  const version = result.stdout.trim().split("\n").filter(Boolean).pop()?.trim();
  if (!version) return { ok: false, cause: "the CLI entrypoint reported no version" };
  return { ok: true, version };
}

/**
 * Probe the MCP entrypoint over stdio: initialize handshake plus tools/list.
 * The probe closes the transport as soon as both answers are read.
 */
function probeManagerMcp(managerDir, python, timeoutMs) {
  const requests = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "flowtask-installer", version: "1.0.0" } },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const result = runPythonProbe(python.executable, [...python.prefix, "-m", "worktree_manager.mcp_transport"], {
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
 * probe, never because a configuration declares it. `pythonRuntime` accepts an
 * already resolved runtime, which lets the caller compose the resolver contract
 * with the probes that invoke it.
 */
export function detectWorktreeManagerCapabilities(managerDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? WORKTREE_MANAGER_PROBE_TIMEOUT_MS;
  const python = options.pythonRuntime
    ?? (options.pythonBin
      ? resolvePythonRuntime({
          candidates: [{ command: options.pythonBin, prefix: [] }],
          resolveExecutables: () => [options.pythonBin],
          timeoutMs,
        })
      : resolvePythonRuntime({ timeoutMs }));
  const report = {
    managerDir,
    python: { available: false, version: null, executable: null, command: null, prefix: [], cause: null },
    cli: { available: false, version: null, cause: null },
    mcp: { available: false, version: null, tools: [], cause: null },
    transports: [],
  };

  if (!python.available) {
    const cause = `python is not usable: ${python.cause}`;
    report.python = {
      available: false,
      version: python.version,
      executable: python.executable,
      command: python.command,
      prefix: python.prefix,
      cause,
    };
    report.cli = { available: false, version: null, cause };
    report.mcp = { available: false, version: null, tools: [], cause };
    return report;
  }
  report.python = {
    available: true,
    version: python.version,
    executable: python.executable,
    command: python.command,
    prefix: python.prefix,
    cause: null,
  };

  const missingMcpEntrypoints = WORKTREE_MANAGER_MCP_ENTRYPOINTS
    .filter((entry) => !fs.existsSync(path.join(managerDir, entry)));
  if (missingMcpEntrypoints.length > 0) {
    report.mcp = {
      available: false, version: null, tools: [],
      cause: `missing MCP entrypoints: ${missingMcpEntrypoints.join(", ")}`,
    };
  } else {
    const mcp = probeManagerMcp(managerDir, python, timeoutMs);
    report.mcp = mcp.ok
      ? { available: true, version: mcp.version, tools: mcp.tools, cause: null }
      : { available: false, version: null, tools: [], cause: mcp.cause };
  }

  const cli = probeManagerCli(managerDir, python, timeoutMs);
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
 * Install or update the global manager without turning an optional capability
 * into a failed installation. A download failure and a machine without a usable
 * Python degrade with a visible warning; any other failure keeps its fail-closed
 * behavior.
 */
export function prepareWorktreeManagerForRun(options = {}, { mode = "install" } = {}) {
  try {
    const report = prepareGlobalWorktreeManager(options);
    reportWorktreeManagerCapabilities(report, { quiet: mode === "update" ? !report.versionChanged : false });
    return report;
  } catch (error) {
    if (error?.code === "WORKTREE_MANAGER_DOWNLOAD_FAILED" || error?.code === "WORKTREE_MANAGER_UNUSABLE") {
      reportWorktreeManagerUnavailable(error, { mode });
      return null;
    }
    throw error;
  }
}

/** Publish the visible degradation when the optional manager could not be published. */
export function reportWorktreeManagerUnavailable(error, { mode = "install" } = {}) {
  const action = mode === "update" ? "updated" : "installed";
  logWarn(`Worktree Manager could not be ${action}: ${error.message}`);
  const intact = mode === "update" ? " The previous copy, if any, was left unchanged." : "";
  if (error?.code === "WORKTREE_MANAGER_UNUSABLE") {
    logWarn(`FlowTask continues without worktree support. Install Python 3.9+ and run 'flowtask update' to enable worktrees.${intact}`);
    return;
  }
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
  logWarn(`Worktree Manager is not operational: ${[cli?.cause, mcp?.cause].filter(Boolean).join("; ")}`);
}

function reportWorktreeMcpRegistration(result, configPath) {
  switch (result.status) {
    case "registered":
      logSuccess(`Worktree Manager MCP registered in ${configPath}.`);
      return;
    case "unchanged":
      logInfo(`Worktree Manager MCP already registered in ${configPath}.`);
      return;
    case "preserved":
      logWarn(`Worktree Manager MCP was not registered in ${configPath}: ${result.cause}. The existing configuration was preserved.`);
      return;
    case "unavailable":
      logWarn(`Worktree Manager MCP is not available: ${result.cause}. Worktrees are not available in ${configPath}.`);
      return;
    default:
      logWarn(`Worktree Manager MCP could not be registered in ${configPath}: ${result.cause ?? "unknown cause"}. Retry with flowtask update.`);
  }
}

/** Register the manager server in the project's OpenCode config. */
function registerWorktreeManagerMcpForOpenCode(projectDir, ideDir, worktreeManager) {
  if (!worktreeManager) return null;
  const configPath = path.join(projectDir, ideDir, "opencode.json");
  const mcp = worktreeManager.capabilities?.mcp;
  if (mcp?.available !== true) {
    logWarn(`Worktree Manager MCP is not registered in ${configPath}: ${mcp?.cause ?? "the MCP probe did not succeed"}. Worktrees are not available in this target.`);
    return null;
  }
  const result = registerWorktreeManagerMcp({
    configPath,
    format: "opencode",
    managerDir: worktreeManager.managerDir,
    pythonBin: worktreeManager.capabilities?.python?.executable,
  });
  reportWorktreeMcpRegistration(result, configPath);
  return result;
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
  const managedEntries = manifest.filter((entry) =>
    (entry.managedPackage === true || entry.name === CONTEXT_CHECKPOINT_NAME) && entry.scope !== "user");
  for (const entry of manifest) {
    const resolved = path.resolve(flowtaskDir, "plugins", entry.path);
    const pluginRoot = path.resolve(flowtaskDir, "plugins");
    if (resolved !== pluginRoot && !resolved.startsWith(`${pluginRoot}${path.sep}`)) {
      throw new Error(`plugin manifest path escapes plugin root: ${entry.name}`);
    }
    if (entry.marketplaceRoot !== undefined) {
      if (typeof entry.marketplaceRoot !== "string" || entry.marketplaceRoot.length === 0) {
        throw new Error(`plugin manifest marketplaceRoot is invalid: ${entry.name}`);
      }
      const marketplaceRoot = path.resolve(pluginRoot, entry.marketplaceRoot);
      if (marketplaceRoot !== pluginRoot && !marketplaceRoot.startsWith(`${pluginRoot}${path.sep}`)) {
        throw new Error(`plugin manifest marketplaceRoot escapes plugin root: ${entry.name}`);
      }
    }
    const entrypoint = path.resolve(resolved, entry.entrypoint);
    if (entrypoint !== resolved && !entrypoint.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(`plugin manifest entrypoint escapes source: ${entry.name}`);
    }
  }
  for (const entry of managedEntries) {
    if (!entry.destinations.includes("opencode") || entry.kind !== "server") {
      throw new Error(`managed plugin manifest entry has incompatible destination/kind: ${entry.name}`);
    }
  }
  const managedOwnership = [];
  for (const entry of managedEntries) {
    const managedDir = path.join(projectDir, ".opencode", "plugins", entry.name);
    const decision = classifyOwnership(managedDir, { config, pluginName: entry.name });
    if (!["ABSENT", "MANAGED_V1", "MANAGED_V2"].includes(decision.state)) {
      throw new Error(`ownership-${decision.state.toLowerCase()}: ${managedDir}`);
    }
    managedOwnership.push(decision);
  }
  const ownership = managedOwnership.find((decision) =>
    decision.path === path.join(projectDir, ".opencode", "plugins", CONTEXT_CHECKPOINT_NAME),
  ) ?? null;
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
    ownership, managedOwnership, classifierOwnership, writers: INSTALLER_WRITERS, allowedWrites: [], preDigest: null,
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
  opencode: [],
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

export const CLASSIFIER_PLUGIN_NAMES = [
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

// ─── Persona Selection ────────────────────────────────────────────────────────

const levelToChoice = { training: 1, junior: 1, mid: 2, senior: 3, custom: 4 };
const mapping = {
  1: { level: "training", persona: "tutor-training", file: "tutor-training.md", onboarded: true },
  2: { level: "mid", persona: "tutor-mid", file: "tutor-mid.md", onboarded: true },
  3: { level: "senior", persona: "tutor-senior", file: "tutor-senior.md", onboarded: true },
  4: { level: "custom", persona: "custom", file: null, onboarded: false },
};

export const AUTONOMY_PROMPT = Object.freeze({
  title: "How much initiative should FlowTask take on this machine?",
  options: Object.freeze([
    Object.freeze({
      value: "assistant",
      label: "Wait for my explicit go-ahead for every job",
      description: "FlowTask prepares the work and waits for your order before starting anything.",
      recommended: true,
    }),
    Object.freeze({
      value: "autonomous-dev",
      label: "Start work on its own without asking first",
      description: "FlowTask can run the full loop on its own.",
      recommended: false,
    }),
  ]),
});

/** Plain text lines of the initiative question for a given cursor position. */
export function renderAutonomyPromptLines(cursor) {
  return [
    ...AUTONOMY_PROMPT.options.map((option, index) => {
      const cursorMark = index === cursor ? ">" : " ";
      const recommended = option.recommended ? " (recommended)" : "";
      return `${cursorMark} ${option.label}${recommended}    ${option.description}`;
    }),
    "",
    "↑/↓: navigate, Enter: confirm, Ctrl+C: cancel",
  ];
}

async function promptAutonomySelection(readline) {
  if (!process.stdin.isTTY) {
    throw new Error("No TTY available to answer the initiative question. Pass --autonomy <assistant|autonomous-dev> or run in an interactive terminal.");
  }

  logStep("P", "Initiative");
  logInfo(AUTONOMY_PROMPT.title);

  const options = AUTONOMY_PROMPT.options;
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
    const output = renderAutonomyPromptLines(cursor).join("\n");
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
        resolve(options[cursor].value);
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

function resolvePersonaContent(flowtaskDir, personaChoice) {
  if (personaChoice.persona === "custom") {
    if (!CUSTOM_PERSONA_TEXT.trim()) {
      logWarn("The custom personality has no text. Installation will continue without a personality.");
      return null;
    }
    return CUSTOM_PERSONA_TEXT;
  }

  const fileName = PERSONA_FILES[personaChoice.persona] ?? personaChoice.file;
  if (!fileName) {
    logWarn(`Unknown personality: ${personaChoice.persona}. Installation will continue without a personality.`);
    return null;
  }

  const personaPath = path.join(flowtaskDir, "personas", fileName);
  if (!fileExists(personaPath)) {
    logWarn(`Personality file not found: ${personaPath}. Installation will continue without a personality.`);
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

function readOptionalText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Blank the injected persona and autonomy blocks while keeping their markers. */
function stripRunnerInjectedBlocks(content) {
  let result = content;
  for (const [start, end] of [
    [PERSONA_START_MARKER, PERSONA_END_MARKER],
    [AUTONOMY_START_MARKER, AUTONOMY_END_MARKER],
  ]) {
    const startIndex = result.indexOf(start);
    const endIndex = result.indexOf(end);
    if (startIndex === -1 || endIndex < startIndex + start.length) continue;
    result = result.slice(0, startIndex + start.length) + result.slice(endIndex);
  }
  return result;
}

/** A runner differs from the canonical one only outside its injected blocks. */
function runnerContentDrifted(before, canonical, targetSubDir) {
  if (typeof before !== "string" || typeof canonical !== "string") return false;
  return stripRunnerInjectedBlocks(before) !== stripRunnerInjectedBlocks(configureRunnerScriptsContent(canonical, targetSubDir));
}

function toProjectPath(projectDir, absolutePath) {
  return path.relative(projectDir, absolutePath).split(path.sep).join("/");
}

const MANAGED_SKIP_DIRS = new Set(["node_modules", ".git", "worktree-manager"]);
const MANAGED_SKIP_FILES = new Set(["worktree-manager-core.sh", "worktree-manager-target-direct.sh"]);
const OWNER_MARKER_FILE = ".flowtask-plugin-owner.json";

function managedTreeEntry(targetPath) {
  const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!stat) return { exists: false };
  if (stat.isSymbolicLink()) return { exists: true, type: "symlink", target: fs.readlinkSync(targetPath) };
  if (stat.isDirectory()) return { exists: true, type: "directory" };
  return {
    exists: true,
    type: "file",
    sha256: crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex"),
  };
}

/**
 * Read-only snapshot of a managed tree keyed by project-relative path. It must
 * run before the install transaction moves the tree so update can tell an
 * untouched file from a restored one.
 */
function snapshotManagedTree(root, projectDir, snapshot) {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (MANAGED_SKIP_DIRS.has(entry.name) || MANAGED_SKIP_FILES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      snapshot.set(toProjectPath(projectDir, fullPath), managedTreeEntry(fullPath));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(fullPath);
    }
  };
  walk(root);
}

/** Compare a managed tree rebuilt by update against its pre-transaction snapshot. */
function classifyManagedTree(root, projectDir, snapshot, { preservePaths = [], exclude = [] } = {}) {
  const updated = [];
  const unchanged = [];
  const restoredPaths = [];
  const excluded = new Set(exclude);
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return { updated: 0, unchanged: 0, restoredPaths };
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (MANAGED_SKIP_DIRS.has(entry.name) || MANAGED_SKIP_FILES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (preservePaths.some((fragment) => fullPath.includes(fragment))) continue;
      const relative = toProjectPath(projectDir, fullPath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const before = snapshot.get(relative);
        if (before?.exists && before.type !== "directory") restoredPaths.push(relative);
        walk(fullPath);
        continue;
      }
      if (entry.name === OWNER_MARKER_FILE || excluded.has(relative)) continue;
      const before = snapshot.get(relative);
      const current = managedTreeEntry(fullPath);
      if (!before?.exists) { updated.push(relative); continue; }
      if (before.type !== current.type) { restoredPaths.push(relative); continue; }
      if (current.type === "symlink" && before.target !== current.target) { restoredPaths.push(relative); continue; }
      if (current.type === "file" && before.sha256 !== current.sha256) { restoredPaths.push(relative); continue; }
      unchanged.push(relative);
    }
  };
  walk(root);
  return { updated: updated.length, unchanged: unchanged.length, restoredPaths };
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

/** Persona level stored in the user-level profile, if any. */
function readUserProfileLevel() {
  const profilePath = path.join(resolveUserRuntimePaths().configDir, LAYER_FILES.persona);
  if (!fileExists(profilePath)) return null;
  try {
    const level = JSON.parse(fs.readFileSync(profilePath, "utf8")).level;
    return level && levelToChoice[level] ? level : null;
  } catch {
    return null;
  }
}

/**
 * Normalizes an explicit autonomy choice. Returns `null` when no choice was
 * given and rejects any value outside the two stored profiles.
 */
export function normalizeAutonomyChoice(value) {
  if (value === null || value === undefined) return null;
  if (AUTONOMY_PROFILES.includes(value)) return value;
  const error = new Error(
    `[FlowTask Layers] Invalid autonomy choice: ${JSON.stringify(value)}. Use assistant or autonomous-dev.`,
  );
  error.code = "autonomy_choice_invalid";
  throw error;
}

const OPERATIONAL_LAYERS = Object.freeze(["autonomy", "permissions"]);

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

function resolveTargetLayers() {
  const paths = resolveUserRuntimePaths();
  return resolveLayers({ user: readLayerSources(paths.configDir) });
}

/**
 * Read-only check of the user-level layers. An invalid operational layer fails
 * with its operational message; a missing one is reported so the caller can
 * decide which value to write. Nothing is written.
 */
export function preflightTargetLayers() {
  const resolution = resolveTargetLayers();
  for (const name of OPERATIONAL_LAYERS) {
    const layer = resolution.layers[name];
    if (layer.status === "invalid") throw layerOperationalError(name, layer);
  }
  const missing = OPERATIONAL_LAYERS.filter((name) => resolution.layers[name].status === "missing");
  return { resolution, missing };
}

/**
 * Ensures the user-level autonomy and permissions layers. A valid layer is
 * preserved and an invalid one fails without overwriting the file. A missing
 * layer receives the explicit choice when there is one and the migration
 * default otherwise.
 */
export function ensureTargetLayers(targetDir, { autonomyProfile = null, replaceAutonomy = false } = {}) {
  const paths = resolveUserRuntimePaths();
  const before = preflightTargetLayers();
  const config = ensureUserRuntimeConfig(paths.configDir, { autonomyProfile, replaceAutonomy });
  const resolution = resolveTargetLayers();
  const created = OPERATIONAL_LAYERS.filter((name) =>
    before.resolution.layers[name].status === "missing" && resolution.layers[name].status !== "missing");
  const updated = replaceAutonomy && autonomyProfile
    && before.resolution.layers.autonomy.status !== "missing"
    && before.resolution.layers.autonomy.value?.profile !== autonomyProfile
    ? ["autonomy"]
    : [];
  return { resolution, created, updated, config };
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
  let restored = false;
  const existingStat = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existingStat?.isFile()) {
    const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
    restored = !isDeepStrictEqual(existing, materialized);
  }
  if (!writeJsonVerified(destination, materialized)) throw new Error(`could not verify ${destination}`);
  return { path: destination, restored };
}

/**
 * Synchronizes the target configuration with the user-level layers. The
 * persona, autonomy and permissions layers live in the runtime config; the
 * target only receives the generated review configuration and the resolved
 * status used to report the run.
 */
export function syncTargetConfig(
  flowtaskDir,
  targetDir,
  personaChoice,
  { autonomyProfile = null, replaceAutonomy = false, userConfig = null } = {},
) {
  const config = userConfig ?? ensureUserRuntimeConfig(resolveUserRuntimePaths().configDir, {
    personaChoice,
    autonomyProfile,
    replaceAutonomy,
  });
  const review = materializeReviewConfig(flowtaskDir, targetDir);
  const personaStatus = config.profile?.status === "valid"
    ? "valid"
    : config.profile?.status === "invalid"
      ? "invalid"
      : "missing";

  return {
    persona: personaStatus,
    autonomy: config.autonomy,
    permissions: config.permissions,
    review,
    config,
  };
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
    return { registered: 0, restoredPaths: [] };
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
  const restoredPaths = new Set();
  let installedAgentModelSelector = false;
  let registeredCount = 0;

  for (const entry of manifest) {
    if (!validateManifestEntry(entry)) continue;
    if (entry.scope === "user") continue;
    if (!entry.destinations.includes("opencode")) continue;
    if (CLASSIFIER_PLUGIN_NAMES.includes(entry.name) && !isClassifierEnabled(manifest)) continue;

    const srcDir = path.join(flowtaskDir, "plugins", entry.path);
    if (!fileExists(srcDir)) {
      logWarn(`Plugin source not found, skipping: ${srcDir}`);
      continue;
    }
    const destDir = path.join(opencodePluginsDir, entry.name);

    if (entry.managedPackage === true || entry.name === CONTEXT_CHECKPOINT_NAME) {
      const sourceDir = path.join(flowtaskDir, "plugins", entry.path);
      const isCheckpoint = entry.name === CONTEXT_CHECKPOINT_NAME;
      const preparedOwnership = (preflight?.managedOwnership ?? []).find((decision) => decision.path === destDir)
        ?? (preflight?.ownership?.path === destDir ? preflight.ownership : undefined);
      const replaced = replaceManagedPackage({ sourceDir, destinationDir: destDir,
        configPath: path.join(projectDir, ".opencode", "opencode.json"),
        pluginName: entry.name,
        entrypoint: entry.entrypoint,
        source: isCheckpoint ? "submodule" : "local",
        sourceCommit: isCheckpoint ? CONTEXT_CHECKPOINT_SHA : null,
        ownershipDecision: preparedOwnership });
      for (const relative of replaced.restoredPaths ?? []) {
        restoredPaths.add(toProjectPath(projectDir, path.join(destDir, relative)));
      }
      continue;
    }

    const allowlist = Array.isArray(entry.files) && entry.files.length > 0 ? entry.files : null;
    try {
      const stats = copyDirectoryDelta(srcDir, destDir, [], new Set(), null, allowlist);
      for (const relative of stats.restoredPaths ?? []) {
        restoredPaths.add(toProjectPath(projectDir, path.join(destDir, relative)));
      }
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
      continue;
    }

    registeredCount += 1;
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
  return { registered: registeredCount, restoredPaths: [...restoredPaths] };
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
    const destination = path.join(resolveUserRuntimePaths().configDir, LAYER_FILES.persona);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (path.resolve(source) !== path.resolve(destination) && !fs.existsSync(destination)) {
      if (!writeJsonVerified(destination, profile)) throw new Error(`verification of ${destination} failed`);
      const verified = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (JSON.stringify(verified) !== JSON.stringify(profile)) throw new Error(`verification of ${destination} failed`);
    }
    fs.rmSync(source);
    logSuccess(`Profile migrated from ${source} to ${destination}`);
    return true;
  } catch (err) {
    logError(`Could not migrate profile.json from ${source}: ${err.message}. Check permissions/space and retry with flowtask update.`);
    return false;
  }
}

// ─── Web search reporting ─────────────────────────────────────────────────────

function describeLocalFerrisSearch(result) {
  if (!result) return "copia local no evaluada";
  if (result.ok !== true) {
    return result.error ? `copia local no retirada (${result.error})` : "copia local no retirada";
  }
  return result.removedFerrisSearch ? "copia local retirada" : "copia local ausente";
}

function failedFerrisSearchResult(err) {
  return {
    status: "failed",
    globalConfigPath: null,
    binaryInstalled: false,
    cause: err.message,
    action: "retry with flowtask update",
  };
}

function reportFerrisSearch(globalResult, localResult) {
  if (!globalResult) return;
  const local = describeLocalFerrisSearch(localResult);
  switch (globalResult.status) {
    case "configured":
      logInfo(`ferris-search ya configurado para este usuario; ${local}.`);
      return;
    case "installed":
      logInfo(`ferris-search instalado para este usuario; ${local}.`);
      return;
    case "declined":
      logInfo(`ferris-search no instalado por decisión del operador; ${local}.`);
      return;
    case "skipped":
      logInfo(`ferris-search omitido por falta de TTY; ${local}; ejecutar un update interactivo para configurarlo.`);
      return;
    case "unsupported":
      logInfo("ferris-search no disponible en esta plataforma; superficies sin cambios.");
      return;
    default:
      logWarn(
        `ferris-search no instalado: ${globalResult.cause ?? "causa desconocida"}. `
        + `${globalResult.action ?? "reintentar con flowtask update."} `
        + "La instalación continúa sin búsqueda; reintentar con flowtask update.",
      );
  }
}

// ─── Install ──────────────────────────────────────────────────────────────────

/** Payload variants needed by the selected targets. */
function userRuntimeVariantsFor(targets) {
  const ids = new Set((targets ?? []).map((target) => (typeof target === "string" ? target : target.id)));
  const variants = [];
  if ([...ids].some((id) => id !== "claude")) variants.push("canonical");
  if (ids.has("claude")) variants.push("claude");
  return variants.length > 0 ? variants : ["canonical", "claude"];
}

/**
 * Build the user runtime once for the selected destinations. The runner body
 * is composed against each final payload so it references its own files.
 */
function buildUserRuntime(flowtaskDir, { targets, userConfig, personaContent = undefined }) {
  const variants = userRuntimeVariantsFor(targets);
  const runnerContent = fs.readFileSync(path.join(flowtaskDir, "agents", "runner.md"), "utf8");
  const profile = userConfig.profile?.status === "valid" ? userConfig.profile.value : null;
  const autonomy = userConfig.autonomy?.status === "valid"
    ? userConfig.autonomy.value.profile
    : MIGRATION_DEFAULTS.autonomy.profile;
  let content = personaContent;
  if (content === undefined && profile) {
    const choice = mapping[levelToChoice[profile.level]] ?? {
      level: profile.level,
      persona: profile.persona,
      file: PERSONA_FILES[profile.persona] ?? null,
      onboarded: profile.onboarded,
    };
    content = resolvePersonaContent(flowtaskDir, choice);
  }
  return ensureUserRuntime(flowtaskDir, {
    version: readProjectVersion(flowtaskDir),
    variants,
    descriptor: {
      persona: profile?.persona ?? null,
      level: profile?.level ?? null,
      autonomy,
    },
    buildRunnerBody: (payloadPaths) => buildRuntimeRunnerBody({
      runnerContent,
      runtimeRoot: payloadPaths.payloadDir,
      personaContent: content ?? null,
      autonomyDescriptor: { profile: autonomy, source: "user" },
    }),
  });
}

/**
 * Install or update only the global surfaces: the user runtime, the layer
 * configuration, the OpenCode user configuration, the Claude user surfaces and
 * the user plugins. No project registration and no project file is written.
 */
async function installGlobalSurfaces(flowtaskDir, options, mode) {
  const userPaths = resolveUserRuntimePaths();
  const preflight = preflightUserRuntimeConfig(userPaths.configDir);
  const requested = Array.isArray(options.target) && options.target.length > 0
    ? options.target
    : ["opencode", "claude"];
  const requestedAutonomy = normalizeAutonomyChoice(options.autonomy);
  let autonomyProfile = requestedAutonomy;
  if (mode === "install" && !autonomyProfile && process.stdin.isTTY && preflight.missing.includes("autonomy")) {
    const readline = await import("readline");
    autonomyProfile = await promptAutonomySelection(readline);
  }
  const personaChoice = options.persona ? mapping[levelToChoice[options.persona]] : null;
  const personaContent = personaChoice ? resolvePersonaContent(flowtaskDir, personaChoice) : undefined;
  const userConfig = ensureUserRuntimeConfig(userPaths.configDir, {
    personaChoice,
    autonomyProfile,
    replaceAutonomy: Boolean(options.autonomy),
  });

  const runtime = buildUserRuntime(flowtaskDir, { targets: requested, userConfig, personaContent });
  const results = [{
    target: "runtime",
    status: "Success",
    stats: { version: runtime.version, payloads: Object.keys(runtime.payloads).join(" + ") },
  }];

  if (requested.includes("opencode")) {
    const surface = ensureOpencodeGlobalSurface({ flowtaskDir });
    if (!surface.ok) {
      const error = new Error(
        `The OpenCode user configuration could not be updated: ${surface.reason ?? surface.status}.`,
      );
      error.code = "opencode_global_failed";
      throw error;
    }
    results.push({ target: "opencode", status: "Success", stats: { config: surface.status } });
  }

  if (requested.includes("claude")) {
    installClaudeUserSurface({
      flowtaskDir,
      projectDir: process.cwd(),
      personaChoice,
      personaContent,
      options,
      userConfig,
    });
    results.push({ target: "claude", status: "Success", stats: { surface: "ready" } });
  }

  const plugins = installUserPlugins({ flowtaskDir, manifest: loadPluginManifest(flowtaskDir) });
  results.push({
    target: "plugins",
    status: "Success",
    stats: { installed: plugins.installed.length, replaced: plugins.replaced.length, preserved: plugins.preserved.length },
  });

  printSummary(mode === "install" ? "Installation Summary" : "Update Summary", results);
  return { ok: true };
}

export async function install(flowtaskDir, options = {}) {
  let transaction = null;
  try {
    assertRunnerCanon({ flowtaskDir });
    if (options.global) return await installGlobalSurfaces(flowtaskDir, options, "install");
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
    if (selectedOptions.length === 0 || selectedOptions.includes("standalone")) {
      targets.push({ id: "standalone", ideDir: "", targetSubDir: ".flowtask" });
    }
    if (selectedOptions.includes("opencode")) targets.push({ id: "opencode", ideDir: ".opencode", targetSubDir: path.join(".opencode", "flowtask") });
    if (selectedOptions.includes("vscode"))   targets.push({ id: "vscode",   ideDir: ".vscode",   targetSubDir: path.join(".vscode",   "flowtask") });
    if (selectedOptions.includes("claude"))   targets.push({ id: "claude",   ideDir: ".claude",   targetSubDir: path.join(".claude",   "flowtask") });
    if (targets.length === 0) throw new Error("No installation target was selected.");
    const nonClaudeTargets = targets.filter(({ id }) => id !== "claude");
    const claudeSelected = targets.some(({ id }) => id === "claude");

    // ── Step P: Agent Personality ─────────────────────────────────
    const personaChoice = options.persona ? mapping[levelToChoice[options.persona]] : null;
    const personaContent = personaChoice ? resolvePersonaContent(flowtaskDir, personaChoice) : null;

    const projectDir = process.cwd();
    const preflight = nonClaudeTargets.some(({ id }) => id === "opencode")
      ? await prepareInstallation(flowtaskDir, projectDir, "install", { targets: nonClaudeTargets, worktreeManager }) : null;

    const rootFlowtask = path.join(projectDir, ".flowtask");
    const isSourceDir = path.resolve(rootFlowtask) === path.resolve(flowtaskDir);

    const userRuntimePaths = resolveUserRuntimePaths();
    const userLayerPreflight = preflightUserRuntimeConfig(userRuntimePaths.configDir);
    const claudePaths = resolveClaudePaths(projectDir);

    const requestedAutonomy = normalizeAutonomyChoice(options.autonomy);
    const missingOperationalLayers = userLayerPreflight.missing.length > 0;
    const selectedAutonomy = !requestedAutonomy && process.stdin.isTTY && missingOperationalLayers
      ? await promptAutonomySelection(readline)
      : null;
    const autonomyProfile = requestedAutonomy ?? selectedAutonomy;
    const replaceAutonomy = Boolean(options.autonomy);

    const autonomyWillBeWritten = userLayerPreflight.missing.includes("autonomy") || replaceAutonomy;
    if (autonomyWillBeWritten) {
      const effective = autonomyProfile ?? MIGRATION_DEFAULTS.autonomy.profile;
      const initiative = effective === "assistant"
        ? "wait for an explicit go-ahead"
        : "start work without asking";
      logInfo(`Initiative on this machine: ${initiative} (${autonomyProfile ? "selected" : "installation default"}).`);
    }

    transaction = createInstallTransaction();
    captureInstallSurfaces(transaction, {
      projectDir,
      targets,
      manifest: preflight?.manifest ?? loadPluginManifest(flowtaskDir),
      flowtaskDir,
    });

    // The user-level layers are ensured once for every destination.
    const userConfig = ensureUserRuntimeConfig(userRuntimePaths.configDir, {
      personaChoice,
      autonomyProfile,
      replaceAutonomy,
    });

    // The canonical payload is published once for every non-Claude destination.
    const needsCanonical = nonClaudeTargets.length > 0;
    const userRuntime = needsCanonical
      ? buildUserRuntime(flowtaskDir, { targets: nonClaudeTargets, userConfig, personaContent })
      : null;
    if (nonClaudeTargets.some(({ id }) => id === "opencode")) {
      const surface = ensureOpencodeGlobalSurface({ flowtaskDir });
      if (!surface.ok) {
        throw new Error(`The OpenCode user configuration could not be updated: ${surface.reason ?? surface.status}.`);
      }
    }

    const targetDirs = nonClaudeTargets.map(({ targetSubDir }) => path.join(projectDir, targetSubDir));
    if (targetDirs.length > 0 && !migrateProfileLocation(projectDir, flowtaskDir, targetDirs)) {
      throw new Error("Could not migrate profile.json; the source is preserved. Check permissions/space and retry with flowtask update.");
    }

    let ferrisSearchResult = null;
    if (targets.some(({ id }) => id === "opencode")) {
      try {
        ferrisSearchResult = await ensureGlobalFerrisSearch({ flowtaskDir, readline, isTTY: Boolean(process.stdin.isTTY) });
      } catch (err) {
        ferrisSearchResult = failedFerrisSearchResult(err);
      }
    }
    const results = [];
    let localFerrisSearch = null;

    for (const target of nonClaudeTargets) {
      const { id, ideDir, targetSubDir } = target;
      const TARGET_DIR = path.join(projectDir, targetSubDir);
      logInfo(`\nProcessing target: ${id.toUpperCase()} (${targetSubDir})...`);

      try {
        // ── Step 1: IDE check ────────────────────────────────────────────────
        logStep(1, `Checking ${id}...`);
        if (id === "opencode" && !checkOpenCode()) throw new Error("OpenCode is required for this target.");

        // ── Step 2: Engram ───────────────────────────────────────────────────
        logStep(2, "Checking Engram...");
        checkEngram();

        // ── Step 3: Migrate legacy root .flowtask/ if present ────────────────
        logStep(3, "Checking existing installation...");
        if (id !== "standalone" && id !== "opencode" && !isSourceDir && fileExists(rootFlowtask)) {
          logWarn(`Found root .flowtask/ — moving contents to ${targetSubDir}...`);
          transaction.addJournal(migrateLegacyRootTransactional({ projectDir, targetDir: TARGET_DIR, flowtaskDir }));
        }
        if (id === "opencode") {
          migrateLegacyOpencodeProject({
            projectDir,
            flowtaskDir,
            runtimeRoot: userRuntimePaths.runtimeRoot,
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

        // ── Target config: generated review plus the user-level layers ──
        configureRunnerScripts(TARGET_DIR, targetSubDir);
        const targetConfig = syncTargetConfig(flowtaskDir, TARGET_DIR, personaChoice, {
          userConfig,
        });
        const autonomyDescriptor = autonomyDescriptorFrom(targetConfig);

        // OpenCode: the engine lives in the user runtime; the project keeps
        // only its registration and the generated review configuration.
        if (id === "opencode") {
          registerWorktreeManagerMcpForOpenCode(projectDir, ideDir, worktreeManager);
        }

        // ── Step 5: Install plugins from manifest (OpenCode only) ────────────
        // Copies each manifest entry (filtered by destinations) into
        // .opencode/plugins/<name>/ and registers it in tui.json (kind tui)
        // or .opencode/opencode.json (kind server).
        if (id === "opencode") {
          logStep(5, "Installing plugins from manifest...");
          const manifest = preflight?.manifest ?? loadPluginManifest(flowtaskDir);
          installManifestPlugins(projectDir, preflight?.manifest ?? manifest, flowtaskDir, preflight);
          registerOpencodeProject({
            projectDir,
            runtimeManifest: userRuntime.manifest,
            flowtaskDir,
          });
        }

        // ── Inject persona and autonomy into runner.md ───────────────────
        if (id !== "opencode") {
          injectPersonaIntoRunner(TARGET_DIR, personaContent ?? null);
          if (autonomyDescriptor) injectAutonomyIntoRunner(TARGET_DIR, autonomyDescriptor);
        }

        // ── Step 6: Write installation marker ───────────────────────────────
        if (id !== "opencode") {
          fs.writeFileSync(
            path.join(TARGET_DIR, ".installation-method"),
            JSON.stringify({ method: "unified-installation-v2", target: id, timestamp: new Date().toISOString() }, null, 2)
          );
        }

        results.push({ target: id, status: "Success" });
      } catch (err) {
        results.push({ target: id, status: "Error", message: err.message });
        throw err;
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
          options,
          worktreeManager,
          autonomyProfile,
          replaceAutonomy,
          userConfig,
        });
        results.push({
          target: "claude",
          status: "Success",
          stats: { payloadId: claudeResult.runtime.payloadId },
        });
      } catch (err) {
        results.push({ target: "claude", status: "Error", message: err.message });
        throw err;
      }
    }

    const committed = transaction.commit();
    transaction = null;
    if (!committed.ok) {
      logWarn(`Installation finished but some transaction backups could not be removed: ${committed.failures.map(({ path: failedPath }) => failedPath).join(", ")}.`);
    }

    if (claudeSelected) {
      installClaudeModPlugins({
        flowtaskDir,
        manifest: loadPluginManifest(flowtaskDir),
        claudeUserDir: claudePaths.claudeUserDir,
      });
    }

    const userPlugins = installUserPlugins({
      flowtaskDir,
      manifest: loadPluginManifest(flowtaskDir),
    });
    if (userPlugins.installed.length > 0 || userPlugins.replaced.length > 0 || userPlugins.preserved.length > 0) {
      results.push({
        target: "plugins",
        status: "Success",
        stats: {
          installed: userPlugins.installed.length,
          replaced: userPlugins.replaced.length,
          preserved: userPlugins.preserved.length,
        },
      });
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
    if (!isSourceDir && fileExists(rootFlowtask) && targets.some((t) => t.id !== "standalone")) {
      try { if (fs.readdirSync(rootFlowtask).length === 0) fs.rmdirSync(rootFlowtask); } catch (_) {}
    }

    reportFerrisSearch(ferrisSearchResult, localFerrisSearch);
    printSummary("Installation Summary", results);
    return { ok: true };
  } catch (error) {
    const rolled = transaction ? transaction.rollback() : { ok: true, failures: [] };
    logError(formatInstallFailure(error, { command: "install", verbose: options.verbose === true, rollback: rolled }));
    return { ok: false };
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function update(flowtaskDir, options = {}) {
  if (options.global) return installGlobalSurfaces(flowtaskDir, options, "update");
  const report = createUpdateReport({
    version: readProjectVersion(flowtaskDir),
    verbose: options.verbose === true,
  });
  report.begin();
  let result = { ok: false };
  try {
    result = await runUpdate(flowtaskDir, options, report);
  } catch (error) {
    const failure = formatUpdateFailure(error, {
      verbose: options.verbose === true,
      rollback: error?.rollback ?? null,
    });
    if (options.verbose === true) console.error(failure);
    else report.fail(failure.replace(/\s*\n\s*/g, " · "));
    result = { ok: false };
  } finally {
    report.finish();
    report.dispose();
  }
  return result;
}

async function runUpdate(flowtaskDir, options, report) {
  assertRunnerCanon({ flowtaskDir });

  const readline = await import("readline");
  const projectDir = process.cwd();
  // ── Step 1: Detect installed targets ────────────────────────────────────
  const detectStartedAt = Date.now();
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
  for (const candidate of [
    { id: "opencode", subDir: ".opencode/flowtask", ideDir: ".opencode" },
    { id: "vscode", subDir: ".vscode/flowtask", ideDir: ".vscode" },
    { id: "standalone", subDir: ".flowtask", ideDir: "" },
  ]) {
    if (targets.some(({ id }) => id === candidate.id)) continue;
    if (readProjectRegistration(projectDir, candidate.id).status !== "active") continue;
    targets.push({ ...candidate, marker: null, registered: true });
    logSuccess(`Found ${candidate.id} project registration`);
  }

  const nonClaudeTargets = targets.filter(({ id }) => id !== "claude");
  const claudeTarget = targets.find(({ id }) => id === "claude") ?? null;
  const claudeActive = Boolean(claudeTarget || claudeRegistered || claudeRuntimeInstalled);
  const installationFound = targets.length > 0 || claudeRuntimeInstalled;
  report.phase("detect", targets.map(({ id }) => id).join(" · ") || "none", {
    status: installationFound ? "ok" : "fail",
    durationMs: Date.now() - detectStartedAt,
  });

  if (targets.length === 0 && !claudeRuntimeInstalled) {
    logError("No FlowTask installation found. Run 'flowtask install' first.");
    report.markFailure();
    report.finish();
    return { ok: false };
  }

  if (targets.length === 0) {
    logWarn("This project is not registered with FlowTask; the global installation was updated without registering it.");
    logInfo("Run flowtask install in this project to register it.");
    let selected = [];
    try {
      const manifest = JSON.parse(fs.readFileSync(claudePaths.runtimeManifestPath, "utf8"));
      if (manifest.payloads?.canonical) selected.push("opencode");
      if (manifest.payloads?.claude) selected.push("claude");
    } catch {
      selected = [];
    }
    return installGlobalSurfaces(
      flowtaskDir,
      { ...options, target: selected.length > 0 ? selected : ["opencode", "claude"] },
      "update",
    );
  }

  const worktreeManager = prepareWorktreeManagerForRun(options, { mode: "update" });
  if (worktreeManager) {
    const versionNotice = formatWorktreeManagerVersionNotice({ previousVersion: worktreeManager.previousVersion, version: worktreeManager.version });
    if (versionNotice) logInfo(versionNotice);
  }

  const preflight = nonClaudeTargets.some(({ id }) => id === "opencode")
    ? await prepareInstallation(flowtaskDir, projectDir, "update", { targets: nonClaudeTargets, worktreeManager }) : null;

  const userRuntimePaths = resolveUserRuntimePaths();
  preflightUserRuntimeConfig(userRuntimePaths.configDir);

  const autonomyProfile = normalizeAutonomyChoice(options.autonomy);
  const replaceAutonomy = Boolean(options.autonomy);
  if (autonomyProfile) {
    const initiative = autonomyProfile === "assistant"
      ? "wait for an explicit go-ahead"
      : "start work without asking";
    logInfo(`Initiative on this machine: ${initiative} (selected).`);
  }

  const manifest = preflight?.manifest ?? loadPluginManifest(flowtaskDir);
  const managedSnapshot = new Map();
  const runnerBeforeByTarget = new Map();
  for (const { id, subDir } of nonClaudeTargets) {
    const targetDir = path.join(projectDir, subDir);
    for (const { src, dest } of ASSETS[id] ?? []) {
      if (fileExists(path.join(flowtaskDir, src))) snapshotManagedTree(path.join(targetDir, dest), projectDir, managedSnapshot);
    }
    runnerBeforeByTarget.set(id, readOptionalText(path.join(targetDir, "agents", "runner.md")));
    if (id === "opencode") {
      snapshotManagedTree(path.join(projectDir, ".opencode", "skills"), projectDir, managedSnapshot);
      snapshotManagedTree(path.join(projectDir, ".opencode", "plugins"), projectDir, managedSnapshot);
    }
  }
  const installedPluginNames = new Set();
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!validateManifestEntry(entry) || entry.scope === "user" || !entry.destinations.includes("opencode")) continue;
    if (CLASSIFIER_PLUGIN_NAMES.includes(entry.name) && !isClassifierEnabled(manifest)) continue;
    if (!fileExists(path.join(flowtaskDir, "plugins", entry.path))) continue;
    installedPluginNames.add(entry.name);
  }

  const transaction = createInstallTransaction();
  try {
    captureInstallSurfaces(transaction, { projectDir, targets, manifest, flowtaskDir });

    if (!claudeActive) {
      const legacyCleanupOk = removeLegacyConsumerFiles(projectDir, ["CLAUDE.md"]);
      if (!legacyCleanupOk) logWarn("CLAUDE.md cleanup was not complete; the result must be reviewed.");
    }

    const targetDirs = nonClaudeTargets.map(({ subDir }) => path.join(projectDir, subDir));
    if (targetDirs.length > 0 && !migrateProfileLocation(projectDir, flowtaskDir, targetDirs)) {
      throw new Error("Could not migrate profile.json; the source is preserved. Check permissions/space and retry with flowtask update.");
    }

    let ferrisSearchResult = null;
    if (nonClaudeTargets.some(({ id }) => id === "opencode")) {
      try {
        ferrisSearchResult = await ensureGlobalFerrisSearch({ flowtaskDir, readline, isTTY: Boolean(process.stdin.isTTY) });
      } catch (err) {
        ferrisSearchResult = failedFerrisSearchResult(err);
      }
    }

    // ── Step 1.5: Agent Personality ──────────────────────────────
    const currentLevel = readUserProfileLevel();

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

    // The user-level layers are ensured once for every destination.
    const userConfig = ensureUserRuntimeConfig(userRuntimePaths.configDir, {
      personaChoice,
      autonomyProfile,
      replaceAutonomy,
    });

    const userRuntime = nonClaudeTargets.length > 0
      ? buildUserRuntime(flowtaskDir, { targets: nonClaudeTargets, userConfig, personaContent })
      : null;
    if (nonClaudeTargets.some(({ id }) => id === "opencode")) {
      const surface = ensureOpencodeGlobalSurface({ flowtaskDir });
      if (!surface.ok) {
        throw new Error(`The OpenCode user configuration could not be updated: ${surface.reason ?? surface.status}.`);
      }
    }

    // ── Step 2: Delta sync each target ──────────────────────────────────────
    const preservePaths = ["CA-", "workspace", ".workspace", ".installation-method"];
    const results = [];
    let localFerrisSearch = null;
    let pluginsRegistered = null;
    let pluginsDurationMs = null;
    const graphifyStates = [];
    const canonicalRunnerContent = readOptionalText(path.join(flowtaskDir, "agents", "runner.md"));

    for (const { id, subDir, ideDir, previousMethod } of nonClaudeTargets) {
      const TARGET_DIR = path.join(projectDir, subDir);
      const targetPrefix = subDir.split(path.sep).join("/");
      logStep(2, `Updating ${id}...`);
      const syncStartedAt = Date.now();

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

        if (id !== "standalone" && id !== "opencode") cleanupLegacyScripts(projectDir, TARGET_DIR, flowtaskDir);

        // OpenCode: the engine lives in the user runtime; the project keeps
        // only its registration and the generated review configuration.
        if (id === "opencode") {
          migrateLegacyOpencodeProject({
            projectDir,
            flowtaskDir,
            runtimeRoot: userRuntimePaths.runtimeRoot,
          });
          registerWorktreeManagerMcpForOpenCode(projectDir, ideDir, worktreeManager);
        }

        logSuccess(`Updated ${totalCopied} files, ${totalSkipped} unchanged`);

        // ── Target config: generated review plus the user-level layers ──
        configureRunnerScripts(TARGET_DIR, subDir);
        const targetConfig = syncTargetConfig(flowtaskDir, TARGET_DIR, personaChoice, {
          userConfig,
        });
        const autonomyDescriptor = autonomyDescriptorFrom(targetConfig);

        // ── Re-install plugins from manifest (OpenCode only) ─────────────────
        if (id === "opencode") {
          const pluginsStartedAt = Date.now();
          pluginsRegistered = installManifestPlugins(projectDir, manifest, flowtaskDir, preflight).registered;
          pluginsDurationMs = Date.now() - pluginsStartedAt;
          registerOpencodeProject({
            projectDir,
            runtimeManifest: userRuntime.manifest,
            flowtaskDir,
          });
        }

        // The transaction moved the managed trees before the copy, so update
        // classifies them against the read-only snapshot taken in this run.
        const classification = { updated: 0, unchanged: 0, restoredPaths: new Set() };
        const classify = (root, options = {}) => {
          const result = classifyManagedTree(root, projectDir, managedSnapshot, options);
          classification.updated += result.updated;
          classification.unchanged += result.unchanged;
          for (const restoredPath of result.restoredPaths) classification.restoredPaths.add(restoredPath);
        };
        for (const { src, dest } of ASSETS[id] ?? []) {
          if (!fileExists(path.join(flowtaskDir, src))) continue;
          classify(path.join(TARGET_DIR, dest), {
            preservePaths,
            exclude: src === "agents" ? [path.posix.join(targetPrefix, "agents", "runner.md")] : [],
          });
        }
        if (id === "opencode") {
          classify(path.join(projectDir, ".opencode", "skills"), { preservePaths });
          for (const pluginName of installedPluginNames) {
            classify(path.join(projectDir, ".opencode", "plugins", pluginName));
          }
        }
        if (runnerContentDrifted(runnerBeforeByTarget.get(id), canonicalRunnerContent, subDir)) {
          classification.restoredPaths.add(path.posix.join(targetPrefix, "agents", "runner.md"));
        }
        if (targetConfig.review?.restored) classification.restoredPaths.add(toProjectPath(projectDir, targetConfig.review.path));
        const restoredPaths = classification.restoredPaths;

        // ── Inject persona and autonomy into runner.md ───────────────────
        if (id !== "opencode") {
          injectPersonaIntoRunner(TARGET_DIR, personaContent ?? null);
          if (autonomyDescriptor) injectAutonomyIntoRunner(TARGET_DIR, autonomyDescriptor);
        }

        if (id !== "opencode") {
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
        }

        const restored = [...restoredPaths];
        results.push({
          target: id,
          status: "Success",
          stats: { copied: totalCopied, skipped: totalSkipped, updated: classification.updated, unchanged: classification.unchanged, restored: restored.length },
        });
        report.syncRow(id, `${restored.length} restored · ${classification.updated} upd · ${classification.unchanged} eq`, {
          durationMs: Date.now() - syncStartedAt,
        });
        report.restored(id, restored);
        if (report.verbose && restored.length > 0) {
          logInfo(`${id}: ${restored.length} restored (${restored.join(", ")})`);
        }
      } catch (err) {
        results.push({ target: id, status: "Error", message: err.message });
        report.syncRow(id, err.message, { failed: true, durationMs: Date.now() - syncStartedAt });
        throw err;
      }
    }

    let claudeUpdate = null;
    if (claudeActive) {
      logStep(2, "Updating claude...");
      const claudeStartedAt = Date.now();
      try {
        const explicitPersona = Boolean(options.persona);
        claudeUpdate = updateClaudeTarget({
          flowtaskDir,
          projectDir,
          personaChoice: explicitPersona ? personaChoice : null,
          personaContent: explicitPersona ? personaContent : undefined,
          options,
          worktreeManager,
          autonomyProfile,
          replaceAutonomy,
          userConfig,
        });
        const claudeRestored = Array.isArray(claudeUpdate.restoredPaths) ? claudeUpdate.restoredPaths : [];
        results.push({
          target: "claude",
          status: "Success",
          stats: { registered: claudeUpdate.registered, restored: claudeRestored.length },
        });
        report.syncRow("claude", `${claudeRestored.length} restored · ${claudeUpdate.registered === false ? "not registered" : "registered"}`, {
          durationMs: Date.now() - claudeStartedAt,
        });
        report.restored("claude", claudeRestored);
        if (report.verbose && claudeRestored.length > 0) {
          logInfo(`claude: ${claudeRestored.length} restored (${claudeRestored.join(", ")})`);
        }
      } catch (err) {
        results.push({ target: "claude", status: "Error", message: err.message });
        report.syncRow("claude", err.message, { failed: true, durationMs: Date.now() - claudeStartedAt });
        throw err;
      }
    }

    report.endSync();
    if (pluginsRegistered !== null) {
      report.phase("plugins", `${pluginsRegistered} registered`, { durationMs: pluginsDurationMs });
    }

    if (nonClaudeTargets.length > 0) {
      regenerateCanonicalCli(projectDir, flowtaskDir, manifest);
      logSuccess("Canonical CLI declaration regenerated");
      regenerateCanonicalTui(projectDir, flowtaskDir, manifest);
      logSuccess("Canonical TUI declaration regenerated");
      // The canonical destination is verified before deleting the legacy source.
      const legacyNames = claudeActive ? ["tui.json"] : ["tui.json", "CLAUDE.md"];
      if (!removeLegacyConsumerFiles(projectDir, legacyNames)) {
        logWarn("flowtask update finished with legacy residue that could not be removed.");
      }
    }

    const committed = transaction.commit();
    if (!committed.ok) {
      logWarn(`Update finished but some transaction backups could not be removed: ${committed.failures.map(({ path: failedPath }) => failedPath).join(", ")}.`);
    }

    const userPlugins = installUserPlugins({ flowtaskDir, manifest });
    if (userPlugins.installed.length > 0 || userPlugins.replaced.length > 0) {
      report.phase("plugins-user", `${userPlugins.installed.length} installed · ${userPlugins.replaced.length} replaced`);
    }

    if (claudeUpdate?.registered === true) {
      const selectorStartedAt = Date.now();
      const selectorResults = installClaudeModPlugins({
        flowtaskDir,
        manifest,
        claudeUserDir: claudePaths.claudeUserDir,
      });
      if (selectorResults.length > 0) {
        report.phase("selector", describeClaudeModResults(selectorResults), {
          status: selectorResults.some(({ status }) => status === "failed") ? "warn" : "ok",
          durationMs: Date.now() - selectorStartedAt,
        });
      }
    }

    const graphifyStartedAt = Date.now();
    for (const { id, subDir } of nonClaudeTargets) {
      try {
        graphifyStates.push(await coordinateGraphify({ projectDir, targetDir: path.join(projectDir, subDir), flowtaskDir, selectedClis: [id], readline }));
      } catch (err) {
        logWarn(`Graphify (${id}): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
        graphifyStates.push(null);
      }
    }

    if (claudeActive) {
      try {
        graphifyStates.push(await coordinateGraphify({
          projectDir,
          targetDir: path.join(projectDir, ".claude", "flowtask"),
          flowtaskDir,
          selectedClis: ["claude"],
          readline,
        }));
      } catch (err) {
        logWarn(`Graphify (claude): coordination failed (${err.message}). Retry with flowtask update or contact an administrator.`);
        graphifyStates.push(null);
      }
    }

    const graphifyDurationMs = Date.now() - graphifyStartedAt;
    const graphifyText = describeGraphifyPhase(graphifyStates);
    if (graphifyText) report.phase("graphify", graphifyText, { durationMs: graphifyDurationMs });

    const searchStartedAt = Date.now();
    reportFerrisSearch(ferrisSearchResult, localFerrisSearch);
    const searchDurationMs = Date.now() - searchStartedAt;
    const searchText = describeSearchPhase(ferrisSearchResult);
    if (searchText) report.phase("search", searchText, { durationMs: searchDurationMs });

    if (report.verbose) {
      printSummary("Update Summary", results, (res) => {
        if (res.stats?.copied !== undefined) {
          return ` (${res.stats.copied} updated, ${res.stats.skipped} preserved)`;
        }
        if (res.target === "claude" && res.stats) {
          return res.stats.registered === false ? " (not registered)" : " (registered)";
        }
        return "";
      });
    } else {
      report.finish();
    }
    return { ok: true };
  } catch (error) {
    const rolled = transaction.rollback();
    if (error && typeof error === "object") error.rollback = rolled;
    throw error;
  }
}

// ─── Uninstall ────────────────────────────────────────────────────────────────

/**
 * Remove every FlowTask-owned artifact of the current project for every
 * destination, preserving user settings, hooks, plugins and MCP servers.
 */
export function uninstallProject({ flowtaskDir, projectDir }) {
  const removed = [];
  const preserved = [];
  const failures = [];

  try {
    const claude = uninstallClaudeProject({ projectDir, flowtaskDir });
    removed.push(...claude.removed);
    preserved.push(...claude.preserved);
  } catch (error) {
    failures.push({ target: "claude", error: error.message });
  }

  try {
    const opencode = removeOpencodeProject({ projectDir });
    removed.push(...opencode.removed);
    preserved.push(...opencode.preserved);
  } catch (error) {
    failures.push({ target: "opencode", error: error.message });
  }

  for (const target of ["vscode", "standalone"]) {
    try {
      const registration = readProjectRegistration(projectDir, target);
      if (registration.status === "absent") continue;
      const removal = removeProjectRegistration(projectDir, target);
      removed.push(...removal.removed);
      preserved.push(...removal.preserved);
    } catch (error) {
      failures.push({ target, error: error.message });
    }
  }

  return { ok: failures.length === 0, removed, preserved, failures };
}

/**
 * Remove the user-level runtime, the global surfaces and every registered
 * project. It stops before deleting the runtime when a project cannot be
 * cleaned, so no registered project is left pointing at a missing runtime.
 */
export function uninstallGlobal({ flowtaskDir, projectDir }) {
  const claudePaths = resolveClaudePaths(projectDir);
  const runtimeRoot = claudePaths.runtimeRoot;
  const index = readProjectsIndex(runtimeRoot);
  if (!index.ok) {
    return {
      ok: false,
      error: `The projects index is unreadable and uninstall stopped before removing the runtime: ${index.error}`,
      removed: [],
      preserved: [],
      failures: [],
      manualReview: [],
    };
  }

  const claude = uninstallClaudeGlobal({
    runtimeRoot,
    claudeUserDir: claudePaths.claudeUserDir,
    flowtaskDir,
    removeRuntime: false,
  });
  if (!claude.ok) {
    return {
      ok: false,
      error: claude.error ?? "The Claude Code user surface could not be removed.",
      removed: [],
      preserved: [],
      failures: claude.failures ?? [],
      manualReview: claude.manualReview ?? [],
    };
  }

  const removed = [...(claude.removed ?? [])];
  const preserved = [...(claude.preserved ?? [])];
  const failures = [];
  for (const entry of index.index.projects) {
    if (!entry || typeof entry.path !== "string") continue;
    const targets = Array.isArray(entry.targets) ? entry.targets : ["claude"];
    for (const target of targets) {
      if (target === "claude") continue;
      try {
        if (target === "opencode") {
          const result = removeOpencodeProject({ projectDir: entry.path, runtimeRoot });
          removed.push(...result.removed);
          preserved.push(...result.preserved);
        } else {
          const result = removeProjectRegistration(entry.path, target, { runtimeRoot });
          removed.push(...result.removed);
          preserved.push(...result.preserved);
        }
      } catch (error) {
        failures.push({ target, path: entry.path, error: error.message });
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error: "One or more projects could not be uninstalled; the runtime was preserved.",
      removed,
      preserved,
      failures,
      manualReview: claude.manualReview ?? [],
    };
  }

  const opencode = removeOpencodeGlobalSurface({ flowtaskDir, runtimeRoot });
  if (!opencode.ok) {
    preserved.push(`${opencode.path ?? "OpenCode configuration"}#FlowTask surface`);
  }
  const plugins = removeUserPlugins({ runtimeRoot });
  preserved.push(...plugins.preserved);

  const runtime = removeUserRuntime(runtimeRoot);
  removed.push(...runtime.removed);
  preserved.push(...runtime.preserved);

  return {
    ok: true,
    projects: index.index.projects,
    removed,
    preserved,
    failures,
    manualReview: claude.manualReview ?? [],
    opencodeSurface: opencode.status,
    pluginsRemoved: plugins.removed,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function describeFailureCause(error) {
  const message = String(error?.message ?? error ?? "unknown failure").trim();
  return message.replace(/\s*\n\s*/g, " · ");
}

function formatFailure(error, { command, verbose = false, rollback = null } = {}) {
  const lines = [
    `[FlowTask] Installation failed: ${describeFailureCause(error)}`,
    `Action: retry with flowtask ${command}${verbose ? "" : "; add --verbose for diagnostics"}.`,
  ];
  if (rollback && rollback.ok === false) {
    const failedPaths = (rollback.failures ?? [])
      .map(({ path: failedPath, reason }) => failedPath ?? reason)
      .filter(Boolean);
    lines.push(
      `Rollback could not restore: ${failedPaths.join(", ") || "unknown paths"}. ` +
        `Inspect these paths before retrying with flowtask ${command}.`,
    );
  }
  if (verbose && error?.stack) lines.push(error.stack);
  return lines.join("\n");
}

function formatInstallFailure(error, options = {}) {
  return formatFailure(error, { command: "install", ...options });
}

function formatUpdateFailure(error, options = {}) {
  return formatFailure(error, { command: "update", ...options });
}

function printSummary(title, results, extraFn = () => "") {
  console.log(`\n${COLORS.blue}╔═══════════════════════════════════════════╗
║  ${title.padEnd(41)}║
╚═══════════════════════════════════════════╝${COLORS.reset}`);
  results.forEach((res) => {
    const color = res.status === "Success" ? COLORS.green : COLORS.red;
    console.log(`  - ${res.target.toUpperCase()}: ${color}${res.status}${COLORS.reset}${extraFn(res)}${res.message ? ` (${res.message})` : ""}`);
  });
  const succeeded = results.length > 0 && results.every((result) => result.status === "Success");
  if (succeeded) {
    logSuccess(`\nFlowTask ${title.toLowerCase()} completed successfully!`);
  } else {
    logError(`\nFlowTask ${title.toLowerCase()} failed.`);
  }
}
