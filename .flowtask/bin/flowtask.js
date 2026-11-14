#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { runCliAction } from "./lib/cli-errors.js";
import { install, update } from "./lib/installer.js";
import { uninstallClaudeGlobal, uninstallClaudeProject } from "./lib/claude-install.js";
import { resolveClaudePaths } from "./lib/claude.js";
import { SESSION_START_LIMIT_BYTES, buildSessionStartContent } from "./lib/runner-content.js";
import {
  buildFlowsReport,
  checkClaudeDelivery,
  checkOpenCodeDelivery,
  compareBaselineLines,
  composeRunnerDocument,
  verifyRunnerCanon,
} from "./lib/runner-flows.js";
import {
  AUTONOMY_PROFILES,
  PERSONA_LEVELS,
  describeOperationalFailure,
  readLayerSources,
  resolveLayers,
} from "./lib/layers.js";
import { diagnoseAuthority } from "./lib/layer-repair.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// FlowTask root directory (one level above bin/)
export const FLOWTASK_DIR = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const command = args[0] || "install";

/** Layer configuration directory for each target, in detection order. */
const LAYER_TARGETS = [
  { id: "opencode", dir: ".opencode/flowtask/config" },
  { id: "claude", dir: ".claude/flowtask/config", global: true },
  { id: "vscode", dir: ".vscode/flowtask/config" },
  { id: "standalone", dir: ".flowtask/config" },
];

const TARGET_IDS = ["opencode", "claude", "vscode", "standalone"];

function parseTargetValues(raw) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseOptions(commandArgs) {
  const options = {};

  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];

    if (argument === "--persona") {
      const value = commandArgs[index + 1];
      if (!PERSONA_LEVELS.includes(value)) {
        throw new Error(`--persona must be one of: ${PERSONA_LEVELS.join(", ")}`);
      }
      options.persona = value;
      index += 1;
      continue;
    }

    if (argument === "--autonomy") {
      const value = commandArgs[index + 1];
      if (!AUTONOMY_PROFILES.includes(value)) {
        throw new Error(`--autonomy must be one of: ${AUTONOMY_PROFILES.join(", ")}`);
      }
      options.autonomy = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--autonomy=")) {
      const value = argument.slice("--autonomy=".length);
      if (!AUTONOMY_PROFILES.includes(value)) {
        throw new Error(`--autonomy must be one of: ${AUTONOMY_PROFILES.join(", ")}`);
      }
      options.autonomy = value;
      continue;
    }

    if (argument === "--target") {
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`--target requires a value: ${TARGET_IDS.join(", ")}`);
      }
      for (const target of parseTargetValues(value)) {
        if (!TARGET_IDS.includes(target)) {
          throw new Error(`--target must be one of: ${TARGET_IDS.join(", ")}`);
        }
        options.target ??= [];
        if (!options.target.includes(target)) options.target.push(target);
      }
      index += 1;
      continue;
    }

    if (argument.startsWith("--target=")) {
      for (const target of parseTargetValues(argument.slice("--target=".length))) {
        if (!TARGET_IDS.includes(target)) {
          throw new Error(`--target must be one of: ${TARGET_IDS.join(", ")}`);
        }
        options.target ??= [];
        if (!options.target.includes(target)) options.target.push(target);
      }
      continue;
    }

    if (argument === "--project") {
      options.project = true;
      continue;
    }

    if (argument === "--yes") {
      options.yes = true;
      continue;
    }

    if (argument === "--verbose") {
      options.verbose = true;
      continue;
    }
  }

  return options;
}

function parseLayersOptions(commandArgs) {
  const options = { target: null, json: false };

  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--target") {
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--target requires a value: opencode, claude, vscode, or standalone");
      }
      options.target = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      options.target = argument.slice("--target=".length);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  const known = LAYER_TARGETS.map((target) => target.id);
  if (options.target && !known.includes(options.target)) {
    throw new Error(`--target must be one of: ${known.join(", ")}`);
  }
  return options;
}

function layerValueText(layer, key) {
  if (!layer || layer.status !== "valid" || !layer.value) return null;
  const value = layer.value[key];
  return typeof value === "string" ? value : null;
}

function layerStateText(layer) {
  if (!layer) return "missing";
  if (layer.status === "valid") return "valid";
  if (layer.status === "invalid") return "invalid";
  return "missing";
}

function runLayersResolve(commandArgs) {
  let options;
  try {
    options = parseLayersOptions(commandArgs);
  } catch (error) {
    process.stderr.write(`[FlowTask Layers] ${error.message}\n`);
    process.exit(1);
    return;
  }

  const projectDir = process.cwd();
  const claudePaths = resolveClaudePaths(projectDir);
  let target = null;
  let configDir = null;

  if (options.target) {
    const known = LAYER_TARGETS.find((entry) => entry.id === options.target);
    target = known.id;
    configDir = known.global ? claudePaths.runtimeConfigDir : path.join(projectDir, known.dir);
    if (!fs.existsSync(configDir)) {
      process.stderr.write(
        known.global
          ? "[FlowTask Layers] No user-level Claude Code layer configuration was found. Run flowtask install.\n"
          : "[FlowTask Layers] No layer configuration was found in the current project.\n",
      );
      process.exit(1);
      return;
    }
  } else {
    for (const entry of LAYER_TARGETS) {
      if (entry.id === "claude") continue;
      const candidate = path.join(projectDir, entry.dir);
      if (!fs.existsSync(candidate)) continue;
      target = entry.id;
      configDir = candidate;
      break;
    }
    if (!configDir && fs.existsSync(claudePaths.registryPath) && fs.existsSync(claudePaths.runtimeConfigDir)) {
      target = "claude";
      configDir = claudePaths.runtimeConfigDir;
    }
    if (!configDir) {
      process.stderr.write("[FlowTask Layers] No layer configuration was found in the current project.\n");
      process.exit(1);
      return;
    }
  }

  const project = readLayerSources(configDir);
  const resolution = resolveLayers({ team: null, project });
  const { persona, autonomy, permissions } = resolution.layers;

  if (options.json) {
    const payload = {
      target,
      precedence: resolution.precedence,
      layers: {
        persona: { status: persona.status, value: persona.value, source: persona.source, reason: persona.reason },
        autonomy: { status: autonomy.status, value: autonomy.value, source: autonomy.source, reason: autonomy.reason },
        permissions: { status: permissions.status, value: permissions.value, source: permissions.source, reason: permissions.reason },
      },
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Target: ${target}`);
    console.log(`Persona: ${layerValueText(persona, "persona") ?? layerStateText(persona)} [${persona.source ?? "no injection"}]`);
    console.log(`Autonomy: ${layerValueText(autonomy, "profile") ?? layerStateText(autonomy)} [${autonomy.source ?? "no source"}]`);
    console.log(`Permissions: ${layerValueText(permissions, "envelope") ?? layerStateText(permissions)} [${permissions.source ?? "no source"}]`);
    console.log("Precedence: permissions > autonomy > persona");
    for (const warning of resolution.warnings) {
      console.log(`Warning: ${warning}`);
    }
  }

  if (!resolution.operational.ok) {
    process.stderr.write(`${describeOperationalFailure(resolution.operational.errors[0])}\n`);
    process.exit(2);
    return;
  }
  process.exit(0);
}

function parseFlowsVerifyOptions(commandArgs) {
  const options = { flowtaskDir: null, baseline: null, allowDeltas: null, report: null, json: false };

  for (let index = 0; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index];
    const takeValue = (flag) => {
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };

    if (argument === "--flowtask-dir") {
      options.flowtaskDir = takeValue(argument);
      continue;
    }
    if (argument.startsWith("--flowtask-dir=")) {
      options.flowtaskDir = argument.slice("--flowtask-dir=".length);
      continue;
    }
    if (argument === "--baseline") {
      options.baseline = takeValue(argument);
      continue;
    }
    if (argument.startsWith("--baseline=")) {
      options.baseline = argument.slice("--baseline=".length);
      continue;
    }
    if (argument === "--allow-deltas") {
      options.allowDeltas = takeValue(argument);
      continue;
    }
    if (argument.startsWith("--allow-deltas=")) {
      options.allowDeltas = argument.slice("--allow-deltas=".length);
      continue;
    }
    if (argument === "--report") {
      options.report = takeValue(argument);
      continue;
    }
    if (argument.startsWith("--report=")) {
      options.report = argument.slice("--report=".length);
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.json && options.report) {
    throw new Error("--json and --report cannot be combined.");
  }
  return options;
}

function parseAllowlist(content) {
  let entries;
  try {
    entries = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid JSON (${error.message})`);
  }
  if (!Array.isArray(entries)) {
    throw new Error('expected a JSON array of { line | sha256, reason } entries');
  }
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`entry ${index} must be an object with exactly one of "line" or "sha256"`);
    }
    const hasLine = Object.prototype.hasOwnProperty.call(entry, "line");
    const hasFingerprint = Object.prototype.hasOwnProperty.call(entry, "sha256");
    if (hasLine === hasFingerprint) {
      throw new Error(`entry ${index} needs exactly one of "line" or "sha256"`);
    }
    if (hasLine && (typeof entry.line !== "string" || entry.line.length === 0)) {
      throw new Error(`entry ${index} needs a non-empty "line" string`);
    }
    if (hasFingerprint && (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))) {
      throw new Error(`entry ${index} needs a lowercase 64-character hexadecimal "sha256"`);
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new Error(`entry ${index} needs a non-empty "reason" string`);
    }
  }
  return entries;
}

function resolveAllowlistPath({ projectDir, explicitPath }) {
  if (explicitPath) return path.resolve(projectDir, explicitPath);
  const defaultPath = path.join(projectDir, ".flowtask", "config", "runner-parity-allowlist.json");
  return fs.existsSync(defaultPath) ? defaultPath : null;
}

function readBaselineRunner({ projectDir, runnerPath, ref }) {
  const root = execFileSync("git", ["-C", projectDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const relative = path.relative(root, runnerPath).split(path.sep).join("/");
  try {
    return execFileSync("git", ["-C", root, "show", `${ref}:${relative}`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A copy verified with --flowtask-dir still compares against the canonical
    // runner path recorded in the baseline commit.
    return execFileSync("git", ["-C", root, "show", `${ref}:.flowtask/agents/runner.md`], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }
}

function countFlowIndexLines(content) {
  return content
    .split("\n")
    .filter((line) => /^- `skill\(\{ name: "runner-flow-[a-z0-9-]+" \}\)`/.test(line)).length;
}

function runFlowsVerify(commandArgs) {
  let options;
  try {
    options = parseFlowsVerifyOptions(commandArgs);
  } catch (error) {
    process.stderr.write(`[FlowTask Flows] ${error.message}\n`);
    process.exit(1);
  }

  const projectDir = process.cwd();
  const flowtaskDir = path.resolve(projectDir, options.flowtaskDir ?? ".flowtask");
  const runnerPath = path.join(flowtaskDir, "agents", "runner.md");
  const skillsDir = path.join(flowtaskDir, "skills");

  if (!fs.existsSync(runnerPath)) {
    process.stderr.write(`[FlowTask Flows] runner.md not found at ${runnerPath}.\n`);
    process.exit(1);
  }

  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  const verification = verifyRunnerCanon({ runnerContent, skillsDir, requireFlows: true });
  const failures = [...verification.failures];

  let sessionStart = { bytes: 0, limit: SESSION_START_LIMIT_BYTES, flow_lines: 0 };
  try {
    const content = buildSessionStartContent({
      skillsDir,
      runnerPath,
      runnerContent,
      verificationSkillsDir: skillsDir,
    });
    sessionStart = {
      bytes: Buffer.byteLength(content, "utf8"),
      limit: SESSION_START_LIMIT_BYTES,
      flow_lines: countFlowIndexLines(content),
    };
    if (sessionStart.bytes >= SESSION_START_LIMIT_BYTES) {
      failures.push({
        code: "session_start_too_large",
        message: `The startup document is ${sessionStart.bytes} bytes and must stay under ${SESSION_START_LIMIT_BYTES}.`,
      });
    }
    if (sessionStart.flow_lines !== verification.flows.length) {
      failures.push({
        code: "runner_flows_missing",
        message: `The Claude startup index declares ${sessionStart.flow_lines} flow line(s); expected ${verification.flows.length}.`,
      });
    }
  } catch (error) {
    failures.push({
      code: error.code ?? "runner_session_start_invalid",
      message: error.message,
    });
  }

  const opencodeStates = checkOpenCodeDelivery({
    projectDir,
    canonicalSkillsDir: skillsDir,
    flows: verification.flows,
  });
  const claudeStates = checkClaudeDelivery({
    projectDir,
    runtimeRoot: resolveClaudePaths(projectDir).runtimeRoot,
    canonicalSkillsDir: skillsDir,
    flows: verification.flows,
  });
  for (const flow of verification.flows) {
    flow.opencode = opencodeStates[flow.name];
    flow.claude = claudeStates[flow.name];
    for (const [target, state] of [["opencode", flow.opencode], ["claude", flow.claude]]) {
      if (state !== "missing") continue;
      failures.push({
        code: "runner_flows_missing",
        message: `Flow ${flow.name} is missing from the ${target} delivery.`,
      });
    }
  }

  let parity = null;
  if (options.baseline) {
    const allowlistPath = resolveAllowlistPath({
      projectDir,
      explicitPath: options.allowDeltas,
    });
    let allowedDeltas = [];
    let allowlistReady = true;
    if (allowlistPath) {
      try {
        allowedDeltas = parseAllowlist(fs.readFileSync(allowlistPath, "utf8"));
      } catch (error) {
        allowlistReady = false;
        failures.push({
          code: "runner_allowlist_invalid",
          message: `Could not read the allowlist ${allowlistPath}: ${error.message}`,
        });
      }
    }

    if (allowlistReady) {
      try {
        const baselineContent = readBaselineRunner({ projectDir, runnerPath, ref: options.baseline });
        const composed = composeRunnerDocument({ runnerBody: runnerContent, skillsDir });
        const comparison = compareBaselineLines({
          baselineContent,
          composedContent: composed,
          allowedDeltas,
        });
        parity = {
          baseline_ref: options.baseline,
          baseline_lines: comparison.baseline_lines,
          matched: comparison.matched,
          allowed_deltas: comparison.allowed_deltas,
          missing_outside_allowlist: comparison.missing_outside_allowlist,
          missing_headings: comparison.missing_headings,
          missing: comparison.missing,
        };
        if (comparison.missing_outside_allowlist > 0 || comparison.missing_headings.length > 0) {
          failures.push({
            code: "runner_parity_missing_lines",
            message:
              `Parity against ${options.baseline} has ${comparison.missing_outside_allowlist} ` +
              `missing line(s) outside the allowlist and ${comparison.missing_headings.length} missing heading(s).`,
            headings: comparison.missing_headings,
          });
        }
      } catch (error) {
        failures.push({
          code: error.code ?? "runner_baseline_unavailable",
          message: `Could not read the baseline ${options.baseline}: ${error.message}`,
        });
      }
    }
  }

  verification.ok = failures.length === 0;
  verification.failures = failures;
  verification.session_start = sessionStart;
  const report = buildFlowsReport({ runnerPath, verification, parity });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Core: ${report.core.bytes} bytes (limit ${report.core.limit})`);
    console.log(`Flows: ${report.flows.length}`);
    console.log(`Moments: ${Object.keys(report.moments).length}`);
    console.log(
      `Session start: ${report.session_start.bytes} bytes, ${report.session_start.flow_lines} flow lines`,
    );
    if (report.parity.baseline_ref) {
      console.log(
        `Parity: ${report.parity.missing_outside_allowlist} missing outside allowlist, ` +
          `${report.parity.missing_headings.length} missing headings`,
      );
      for (const missing of report.parity.missing) {
        console.log(`missing line ${missing.line_number}: sha256 ${missing.sha256}`);
      }
    }
    for (const flow of report.flows) {
      console.log(
        `- ${flow.name}: trigger ${flow.trigger}; opencode ${flow.opencode}; ` +
          `claude ${flow.claude}; load ${flow.load_instruction}`,
      );
    }
    for (const failure of report.failures) {
      console.log(`✖ ${failure.code}: ${failure.message}`);
    }
    console.log(`Verdict: ${report.verdict}`);
    if (options.report) {
      const reportPath = path.resolve(projectDir, options.report);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`Report: ${reportPath}`);
    }
  }

  if (report.verdict !== "pass") process.exit(1);
}

async function main() {
let options;
try {
  options = parseOptions(args.slice(1));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

switch (command) {
  case "install": {
    let result = null;
    await runCliAction(async () => { result = await install(FLOWTASK_DIR, options); });
    if (result?.ok === false) process.exitCode = 1;
    break;
  }

  case "update": {
    let result = null;
    await runCliAction(async () => { result = await update(FLOWTASK_DIR, options); });
    if (result?.ok === false) process.exitCode = 1;
    break;
  }

  case "uninstall": {
    await runCliAction(async () => {
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error("uninstall requires --yes when no interactive terminal is available.");
        }
        const { createInterface } = await import("node:readline/promises");
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        const scope = options.project ? "this project" : "the user-level runtime and every registered project";
        const answer = await readline.question(`Remove FlowTask from ${scope}? (y/N) `);
        readline.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("Uninstall cancelled.");
          return;
        }
      }

      const projectDir = process.cwd();
      const claudePaths = resolveClaudePaths(projectDir);

      if (options.project) {
        const result = uninstallClaudeProject({
          projectDir,
          runtimeRoot: claudePaths.runtimeRoot,
          flowtaskDir: FLOWTASK_DIR,
        });
        console.log(`Removed ${result.removed.length} FlowTask artifact(s) from ${projectDir}.`);
        if (result.preserved.length > 0) {
          console.log(`Preserved ${result.preserved.length} unowned file(s): ${result.preserved.join(", ")}`);
        }
        return;
      }

      const result = uninstallClaudeGlobal({
        runtimeRoot: claudePaths.runtimeRoot,
        claudeUserDir: claudePaths.claudeUserDir,
        flowtaskDir: FLOWTASK_DIR,
      });
      if (!result.ok) throw new Error(result.error);
      console.log(`Removed the FlowTask runtime and ${result.projects.length} project registration(s).`);
      if (result.manualReview.length > 0) {
        for (const message of result.manualReview) console.log(message);
      }
      if (result.preserved.length > 0) {
        console.log(`Preserved ${result.preserved.length} unowned file(s): ${result.preserved.join(", ")}`);
      }
    });
    break;
  }

  case "layers": {
    const subCommand = args[1];
    if (subCommand !== "resolve") {
      process.stderr.write(`[FlowTask Layers] Unknown subcommand: ${subCommand ?? "(none)"}. Use: layers resolve.\n`);
      process.exitCode = 1;
      break;
    }
    runLayersResolve(args.slice(2));
    break;
  }

  case "authority": {
    const subCommand = args[1];
    if (subCommand !== "status") {
      process.stderr.write(`[FlowTask Authority] Unknown subcommand: ${subCommand ?? "(none)"}. Use: authority status.\n`);
      process.exitCode = 1;
      break;
    }
    const statusArgs = args.slice(2);
    const unknown = statusArgs.find((argument) => argument !== "--json");
    if (unknown) {
      process.stderr.write(`[FlowTask Authority] Unknown option: ${unknown}. Use: authority status [--json].\n`);
      process.exitCode = 1;
      break;
    }
    const diagnosis = diagnoseAuthority();
    if (statusArgs.includes("--json")) console.log(JSON.stringify(diagnosis, null, 2));
    else console.log(diagnosis.message);
    break;
  }

  case "flows": {
    const subCommand = args[1];
    if (subCommand !== "verify") {
      process.stderr.write(`[FlowTask Flows] Unknown subcommand: ${subCommand ?? "(none)"}. Use: flows verify.\n`);
      process.exitCode = 1;
      break;
    }
    runFlowsVerify(args.slice(2));
    break;
  }

  case "graphify": {
    // Legacy compatibility shim: graphify query no longer runs local queries.
    const subCommand = args[1];
    if (subCommand === "query") {
      process.stderr.write(
        "[graphify] Deprecated: graphify query no longer runs local queries. " +
        "Use graphify_query_graph through MCP; if it is unavailable, escalate to the Inspector " +
        "or use the project's normal search.\n",
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(`[graphify] Unknown subcommand: ${subCommand}. Use: graphify query (deprecated).\n`);
      process.exitCode = 1;
    }
    break;
  }

  case "--help":
  case "-h":
    console.log(`
FlowTask CLI

Usage:
  flowtask install    Install FlowTask in the current project
  flowtask install --target <opencode|claude|vscode|standalone>
                      Select targets explicitly; repeat the flag or use commas
  flowtask install --persona <training|mid|senior|custom>
                      Select the agent personality explicitly
  flowtask install --autonomy <assistant|autonomous-dev>
                      Select how much initiative FlowTask takes on this machine
  flowtask update     Update FlowTask files (delta-only sync)
  flowtask update --persona <training|mid|senior|custom>
  flowtask update --autonomy <assistant|autonomous-dev>
  flowtask update --verbose
                      Show the per-step diagnostic output
  flowtask uninstall  Remove the user-level runtime and registered projects
  flowtask uninstall --project
                      Remove only the current project registration
  flowtask uninstall --yes
                      Skip the interactive confirmation
  flowtask layers resolve --target <opencode|claude|vscode|standalone>
                      Show the resolved persona, autonomy and permissions layers
  flowtask layers resolve --json
                      Show the resolved layers as JSON
  flowtask authority status [--json]
                      Show whether the authority configuration is healthy
  flowtask flows verify [--flowtask-dir <path>] [--baseline <ref>]
                      Verify the permanent core, its flows and the target deliveries
  flowtask flows verify --baseline <ref>
                      Apply the versioned .flowtask/config/runner-parity-allowlist.json by default
  flowtask flows verify --allow-deltas <json> --report <path>
                      Override the default allowlist and write the report outside the versioned tree
  flowtask flows verify --json
                      Print the report as JSON without writing files
  flowtask graphify query --query <q>  Deprecated shim; no local query is executed
  flowtask --help     Show this help message
  flowtask --version  Show version

Examples:
  flowtask install --target claude --persona senior
  flowtask install --target opencode,claude --autonomy autonomous-dev
  flowtask update --autonomy assistant
  flowtask uninstall --project --yes
  flowtask layers resolve --target claude
  flowtask graphify query --query UserService  Deprecated; use Graphify MCP
    `);
    break;

  case "--version":
  case "-v": {
    const pkgPath = path.join(FLOWTASK_DIR, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    console.log(pkg.version);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run 'flowtask --help' for usage information.");
    process.exit(1);
}
}
main().catch((err) => { console.error(err?.message ?? err); process.exitCode = 1; });
