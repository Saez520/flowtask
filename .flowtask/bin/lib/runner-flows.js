import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileExists } from "./logger.js";
import {
  FLOWS_SECTION_HEADING,
  RUNNER_CORE_BASELINE_BYTES,
  extractFlowMoments,
  extractFlowReferences,
  parseFrontmatter,
} from "./runner-content.js";

export const FLOWS_REPORT_SCHEMA = "runner-flows-report/v1";
export const FLOW_PREFIX = "runner-flow-";

const EVENT_TRIGGER_PATTERN = /^evento:[a-z][a-z0-9-]*$/;
const FLOW_NAME_PATTERN = /^runner-flow-[a-z0-9-]+$/;

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function headingInventory(content, location) {
  return [...content.matchAll(/^(#{2,3}) (.+)$/gm)].map((match) => ({
    heading: match[2].trim(),
    level: match[1].length,
    location,
    present: true,
  }));
}

function tableRows(block) {
  const rows = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push({ cells, line: trimmed });
  }
  return rows;
}

function selectSection(runnerBody, heading) {
  const pattern = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(runnerBody);
  if (!match) return null;
  const rest = runnerBody.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Read every flow declared by the runner index. The body excludes the
 * frontmatter so composition reproduces the canonical text verbatim.
 */
export function readFlowBodies({ runnerBody, skillsDir }) {
  return extractFlowReferences(runnerBody).map((reference) => {
    const flowPath = path.join(skillsDir, reference.flow, "SKILL.md");
    if (!fileExists(flowPath)) {
      throw codedError(
        "runner_flows_missing",
        `The runner index declares ${reference.flow} but ${flowPath} does not exist.`,
        { flow: reference.flow, path: flowPath },
      );
    }
    const content = fs.readFileSync(flowPath, "utf8");
    const { body } = parseFrontmatter(content);
    return { ...reference, path: flowPath, content, body };
  });
}

/**
 * Compose the canonical runner from the permanent core plus its flows. Used by
 * parity checks and tests; installation always ships core and flows separately.
 */
export function composeRunnerDocument({ runnerBody, skillsDir }) {
  const coreBody = parseFrontmatter(runnerBody).body;
  const flows = readFlowBodies({ runnerBody, skillsDir });
  if (flows.length === 0) return coreBody;

  const parts = [coreBody];
  for (const flow of flows) {
    parts.push(flow.body);
  }
  return parts.join("\n\n");
}

/** Compare a baseline document against the composed canon, line by line. */
export function compareBaselineLines({ baselineContent, composedContent, allowedDeltas = [] }) {
  const baselineLines = baselineContent.split("\n").filter((line) => line.trim() !== "");
  const composedLines = composedContent.split("\n").filter((line) => line.trim() !== "");
  const composedCounts = new Map();
  for (const line of composedLines) {
    composedCounts.set(line, (composedCounts.get(line) ?? 0) + 1);
  }

  const allowlist = allowedDeltas.map((entry) => entry.line);
  const allowlistCounts = new Map();
  for (const line of allowlist) {
    allowlistCounts.set(line, (allowlistCounts.get(line) ?? 0) + 1);
  }

  let matched = 0;
  let allowedMatched = 0;
  const missing = [];
  const missingOutsideAllowlist = [];
  for (const line of baselineLines) {
    const available = composedCounts.get(line) ?? 0;
    if (available > 0) {
      composedCounts.set(line, available - 1);
      matched += 1;
      continue;
    }
    const allowed = allowlistCounts.get(line) ?? 0;
    if (allowed > 0) {
      allowlistCounts.set(line, allowed - 1);
      allowedMatched += 1;
      continue;
    }
    missing.push(line);
    missingOutsideAllowlist.push(line);
  }

  const baselineHeadings = headingInventory(baselineContent, "baseline");
  const composedHeadings = headingInventory(composedContent, "composed");
  const composedHeadingCounts = new Map();
  for (const entry of composedHeadings) {
    const key = `${entry.level}:${entry.heading}`;
    composedHeadingCounts.set(key, (composedHeadingCounts.get(key) ?? 0) + 1);
  }
  const missingHeadings = [];
  for (const entry of baselineHeadings) {
    const key = `${entry.level}:${entry.heading}`;
    const available = composedHeadingCounts.get(key) ?? 0;
    if (available > 0) {
      composedHeadingCounts.set(key, available - 1);
      continue;
    }
    if (allowlist.includes(`#`.repeat(entry.level) + " " + entry.heading)) continue;
    missingHeadings.push(entry.heading);
  }

  return {
    baseline_lines: baselineLines.length,
    matched,
    allowed_deltas: allowedDeltas.length,
    allowed_matched: allowedMatched,
    missing,
    missing_outside_allowlist: missingOutsideAllowlist.length,
    missing_headings: missingHeadings,
  };
}

function collectFlowFailures({ runnerContent, skillsDir, references }) {
  const failures = [];
  const declared = new Set(references.map((reference) => reference.flow));

  if (fileExists(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(FLOW_PREFIX)) continue;
      if (declared.has(entry.name)) continue;
      failures.push(
        codedError(
          "runner_flows_orphan",
          `Flow directory ${entry.name} is not declared by the runner index.`,
          { flow: entry.name, path: path.join(skillsDir, entry.name) },
        ),
      );
    }
  }

  return failures;
}

function collectLoadInstructionFailures(runnerContent) {
  const failures = [];
  const anchors = [
    {
      anchor: "load",
      text: "La única forma de cargar un flujo es",
      message: "The permanent core does not declare the single flow load instruction.",
    },
    {
      anchor: "backup",
      text: "Flujo no disponible:",
      message: "The permanent core does not declare the runtime backup for a missing flow.",
    },
    {
      anchor: "unknown_event",
      text: "sin flujo declarado para",
      message: "The permanent core does not declare the unknown-event rule.",
    },
  ];
  for (const entry of anchors) {
    if (runnerContent.includes(entry.text)) continue;
    failures.push(codedError("runner_flows_load_instruction_missing", entry.message, { anchor: entry.anchor }));
  }
  return failures;
}

/**
 * Structural verification of the canonical runner. It never writes and never
 * throws for canonical defects: defects are returned as coded failures.
 */
export function verifyRunnerCanon({
  runnerContent,
  skillsDir,
  coreLimit = RUNNER_CORE_BASELINE_BYTES,
  requireFlows = false,
}) {
  const failures = [];
  const bytes = Buffer.byteLength(runnerContent, "utf8");
  const core = {
    bytes,
    limit: coreLimit,
    sha256: sha256(runnerContent),
  };

  const sectionPattern = new RegExp(`^${FLOWS_SECTION_HEADING}\\s*$`, "m");
  const sectionPresent = sectionPattern.test(runnerContent);
  // Before the split lands the core is still the monolithic document. The
  // tolerance mode reports the size but does not fail on it; every enforcing
  // path (assertRunnerCanon and the CLI) requires the flows section.
  if (bytes >= coreLimit && (requireFlows || sectionPresent)) {
    failures.push(
      codedError(
        "runner_core_too_large",
        `The runner core is ${bytes} bytes and must stay under ${coreLimit} bytes.`,
        { bytes, limit: coreLimit },
      ),
    );
  }

  if (sectionPresent) {
    const occurrences = runnerContent.match(new RegExp(`^${FLOWS_SECTION_HEADING}\\s*$`, "gm")) ?? [];
    if (occurrences.length > 1) {
      failures.push(
        codedError(
          "runner_flows_index_invalid",
          `The "${FLOWS_SECTION_HEADING}" section must appear exactly once.`,
          { occurrences: occurrences.length },
        ),
      );
    }
  } else if (requireFlows) {
    failures.push(
      codedError(
        "runner_flows_section_missing",
        `The runner core does not declare the "${FLOWS_SECTION_HEADING}" section.`,
      ),
    );
  }

  let references = [];
  let indexValid = true;
  if (sectionPresent) {
    try {
      references = extractFlowReferences(runnerContent);
    } catch (error) {
      if (!error.code) throw error;
      indexValid = false;
      failures.push(error);
    }
  }

  const flows = [];
  const pathByFlow = new Map();
  const triggers = new Set();
  for (const reference of references) {
    if (triggers.has(reference.trigger)) {
      failures.push(
        codedError(
          "runner_flows_trigger_duplicate",
          `The trigger ${reference.trigger} is declared more than once.`,
          { trigger: reference.trigger },
        ),
      );
      continue;
    }
    triggers.add(reference.trigger);

    if (pathByFlow.has(reference.flow)) {
      failures.push(
        codedError(
          "runner_flows_index_invalid",
          `The flow ${reference.flow} is declared more than once.`,
          { flow: reference.flow },
        ),
      );
      continue;
    }
    pathByFlow.set(reference.flow, reference);

    const flowPath = path.join(skillsDir, reference.flow, "SKILL.md");
    if (!fileExists(flowPath)) {
      failures.push(
        codedError(
          "runner_flows_missing",
          `The runner index declares ${reference.flow} but ${flowPath} does not exist.`,
          { flow: reference.flow, path: flowPath },
        ),
      );
      continue;
    }
    const content = fs.readFileSync(flowPath, "utf8");
    const { body } = parseFrontmatter(content);
    flows.push({
      name: reference.flow,
      trigger: reference.trigger,
      moments: [],
      path: flowPath,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
      headings: headingInventory(body, `flow:${reference.flow}`),
      load_instruction: "present",
    });
  }

  if (sectionPresent && indexValid) {
    failures.push(...collectFlowFailures({ runnerContent, skillsDir, references }));
    failures.push(...collectLoadInstructionFailures(runnerContent));
  }

  let moments = { intake: [], define: [], plan: [], build: [], validate: [], close: [] };
  if (sectionPresent && indexValid) {
    try {
      moments = extractFlowMoments(runnerContent, { declaredFlows: references.map((reference) => reference.flow) });
    } catch (error) {
      if (!error.code) throw error;
      failures.push(error);
    }
  }

  for (const flow of flows) {
    flow.moments = Object.entries(moments)
      .filter(([, names]) => names.includes(flow.name))
      .map(([moment]) => moment);
  }

  const rules = headingInventory(parseFrontmatter(runnerContent).body, "core");
  for (const flow of flows) {
    rules.push(...flow.headings);
  }

  return {
    ok: failures.length === 0,
    failures,
    core,
    flows,
    moments,
    rules,
    section_present: sectionPresent,
  };
}

/**
 * Installation guard: the canonical runner must be complete before any copy.
 * Unlike verification, a missing flow or a missing index is a hard failure.
 */
export function assertRunnerCanon({ flowtaskDir, coreLimit = RUNNER_CORE_BASELINE_BYTES }) {
  const runnerPath = path.join(flowtaskDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) {
    throw codedError("runner_core_missing", `runner.md not found at ${runnerPath}.`, { path: runnerPath });
  }
  const runnerContent = fs.readFileSync(runnerPath, "utf8");
  const verification = verifyRunnerCanon({
    runnerContent,
    skillsDir: path.join(flowtaskDir, "skills"),
    coreLimit,
    requireFlows: true,
  });
  if (!verification.ok) {
    const first = verification.failures[0];
    const error = new Error(
      `The FlowTask runner canon is invalid (${first.code}): ${first.message} ` +
        `Fix the runner and its flows before installing or updating.`,
    );
    error.code = first.code;
    error.failures = verification.failures;
    throw error;
  }
  return verification;
}

/** Assemble the machine-readable report from a verification result. */
export function buildFlowsReport({
  runnerPath,
  verification,
  parity = null,
  generatedAt = new Date().toISOString(),
}) {
  return {
    schema: FLOWS_REPORT_SCHEMA,
    generated_at: generatedAt,
    core: {
      path: runnerPath,
      bytes: verification.core.bytes,
      limit: verification.core.limit,
      sha256: verification.core.sha256,
    },
    flows: verification.flows.map((flow) => ({
      name: flow.name,
      trigger: flow.trigger,
      moments: flow.moments,
      path: flow.path,
      bytes: flow.bytes,
      sha256: flow.sha256,
      headings: flow.headings.map((entry) => entry.heading),
      opencode: flow.opencode ?? "not_installed",
      claude: flow.claude ?? "not_installed",
      load_instruction: flow.load_instruction,
    })),
    moments: verification.moments,
    rules: verification.rules,
    session_start: verification.session_start ?? { bytes: 0, limit: 0, flow_lines: 0 },
    parity: parity ?? {
      baseline_ref: null,
      baseline_lines: 0,
      matched: 0,
      allowed_deltas: 0,
      missing_outside_allowlist: 0,
      missing_headings: [],
    },
    verdict: verification.ok && (parity ? parity.missing_outside_allowlist === 0 : true) ? "pass" : "fail",
    failures: verification.failures.map((failure) => ({
      code: failure.code,
      message: failure.message,
    })),
  };
}

// ─── Target delivery ─────────────────────────────────────────────────────────

function flowStateFor(targetPath, canonicalPath, validate = null) {
  if (!fileExists(targetPath)) return "missing";
  if (validate && !validate(targetPath)) return "missing";
  const targetHash = sha256(fs.readFileSync(targetPath));
  const canonicalHash = sha256(fs.readFileSync(canonicalPath));
  return targetHash === canonicalHash ? "present" : "missing";
}

/** State of every flow in the OpenCode skills mirror. */
export function checkOpenCodeDelivery({ projectDir, canonicalSkillsDir, flows }) {
  const opencodeSkillsDir = path.join(projectDir, ".opencode", "skills");
  const states = {};
  for (const flow of flows) {
    if (!fileExists(opencodeSkillsDir)) {
      states[flow.name] = "not_installed";
      continue;
    }
    states[flow.name] = flowStateFor(
      path.join(opencodeSkillsDir, flow.name, "SKILL.md"),
      path.join(canonicalSkillsDir, flow.name, "SKILL.md"),
    );
  }
  return states;
}

/** State of every flow inside the active Claude Code payload. */
export function checkClaudeDelivery({ runtimeRoot, canonicalSkillsDir, flows }) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) {
    return Object.fromEntries(flows.map((flow) => [flow.name, "not_installed"]));
  }
  let payloadId = null;
  try {
    payloadId = JSON.parse(fs.readFileSync(manifestPath, "utf8")).payloadId ?? null;
  } catch {
    payloadId = null;
  }
  const payloadSkillsDir = payloadId ? path.join(runtimeRoot, "versions", payloadId, "skills") : null;
  const states = {};
  for (const flow of flows) {
    const targetPath = payloadSkillsDir ? path.join(payloadSkillsDir, flow.name, "SKILL.md") : null;
    if (!targetPath || !fileExists(targetPath)) {
      states[flow.name] = "missing";
      continue;
    }
    const content = fs.readFileSync(targetPath, "utf8");
    // The payload rewrites skill calls to absolute reads, so the body differs
    // from the canonical file by design; presence and shape are what matter.
    states[flow.name] = content.includes("**Read**") && !content.includes("skill(") ? "present" : "missing";
  }
  return states;
}
