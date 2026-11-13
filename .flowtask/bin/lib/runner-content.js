import fs from "fs";
import path from "path";
import { logWarn, logSuccess, fileExists } from "./logger.js";
import { AUTONOMY_PROFILES, LAYER_SOURCES } from "./layers.js";

// ─── Frontmatter parser ───────────────────────────────────────────────────────

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { name: null, description: null, body: content };

  const yaml = match[1];
  const body = content.slice(match[0].length).trimStart();

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : null;

  let description = null;
  const descFolded = yaml.match(/^description:\s*>-\s*\n((?:[ \t]+.+\n?)*)/m);
  if (descFolded) {
    description = descFolded[1].split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  } else {
    const descSimple = yaml.match(/^description:\s*(.+)$/m);
    if (descSimple) description = descSimple[1].trim();
  }

  return { name, description, body };
}

// ─── Startup block and skill index ────────────────────────────────────────────

export const SKILLS_SECTION_HEADING = "## Skills disponibles";
export const FLOWS_SECTION_HEADING = "## Flujos bajo demanda";
export const RUNNER_CORE_BASELINE_BYTES = 97054;
const STARTUP_SKILLS = ["investigacion", "memory-protocol", "zero-assumptions"];
const FLOW_TRIGGER_PATTERN = /^evento:[a-z][a-z0-9-]*$/;
const FLOW_NAME_PATTERN = /^runner-flow-[a-z0-9-]+$/;
const FLOW_MOMENTS = ["intake", "define", "plan", "build", "validate", "close"];

/**
 * Extract the skills declared in runner.md's "## Skills disponibles" section.
 * Both `skill({ name: "..." })` calls and single-backticked skill names count.
 */
export function extractSkillReferences(runnerBody) {
  const start = runnerBody.indexOf(SKILLS_SECTION_HEADING);
  if (start === -1) {
    throw new Error(`runner.md is missing the "${SKILLS_SECTION_HEADING}" section — cannot build the skill index.`);
  }

  const rest = runnerBody.slice(start + SKILLS_SECTION_HEADING.length);
  const nextHeading = rest.search(/^## /m);
  const rawSection = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  // Flows and event names are declared in their own section; they are not
  // skills and must not enter the Claude skill index.
  const section = rawSection
    .replace(/`runner-flow-[a-z0-9-]+`/g, "")
    .replace(/evento\s+`[^`]+`/g, "");

  const names = new Set();
  for (const match of section.matchAll(/skill\(\{\s*name:\s*["']([^"']+)["']\s*\}\)/g)) {
    if (match[1] !== "...") names.add(match[1]);
  }
  for (const match of section.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g)) {
    names.add(match[1]);
  }
  return [...names];
}

// ─── Flow references ─────────────────────────────────────────────────────────

function flowSection(runnerBody) {
  const pattern = new RegExp(`^${FLOWS_SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(runnerBody);
  if (!match) return null;
  const rest = runnerBody.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function flowSubsection(section, heading) {
  const pattern = new RegExp(`^### ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const match = pattern.exec(section);
  if (!match) return null;
  const rest = section.slice(match.index + match[0].length);
  const next = rest.search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function flowTableRows(block) {
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

function flowError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Read the closed trigger index declared by the permanent core. A missing
 * section returns an empty list so the module works before the split lands.
 */
export function extractFlowReferences(runnerBody) {
  const section = flowSection(runnerBody);
  if (section === null) return [];

  const events = flowSubsection(section, "Índice de eventos");
  if (events === null) {
    throw flowError(
      "runner_flows_index_invalid",
      `The "${FLOWS_SECTION_HEADING}" section is missing "### Índice de eventos".`,
    );
  }

  const references = [];
  const triggers = new Set();
  const flows = new Set();
  let rowIndex = 0;
  for (const row of flowTableRows(events)) {
    rowIndex += 1;
    if (row.cells[0] === "Disparador") continue;
    if (row.cells.length !== 3) {
      throw flowError(
        "runner_flows_index_invalid",
        `Flow index row ${rowIndex} must have exactly 3 cells: ${row.line}`,
        { row: rowIndex, line: row.line, reason: "cell_count" },
      );
    }
    const [triggerCell, flowCell, beforeCell] = row.cells;
    const triggerMatch = triggerCell.match(/^`([^`]+)`$/);
    if (!triggerMatch || !FLOW_TRIGGER_PATTERN.test(triggerMatch[1])) {
      throw flowError(
        "runner_flows_index_invalid",
        `Flow index row ${rowIndex} has an invalid trigger: ${triggerCell}`,
        { row: rowIndex, line: row.line, reason: "trigger" },
      );
    }
    const flowMatch = flowCell.match(/^`skill\(\{\s*name:\s*"([^"]+)"\s*\}\)`$/);
    if (!flowMatch || !FLOW_NAME_PATTERN.test(flowMatch[1])) {
      throw flowError(
        "runner_flows_index_invalid",
        `Flow index row ${rowIndex} has an invalid flow call: ${flowCell}`,
        { row: rowIndex, line: row.line, reason: "flow" },
      );
    }
    if (beforeCell.trim() === "") {
      throw flowError(
        "runner_flows_index_invalid",
        `Flow index row ${rowIndex} does not declare when the flow loads.`,
        { row: rowIndex, line: row.line, reason: "before" },
      );
    }

    const trigger = triggerMatch[1];
    const flow = flowMatch[1];
    if (triggers.has(trigger)) {
      throw flowError(
        "runner_flows_trigger_duplicate",
        `The trigger ${trigger} is declared more than once.`,
        { trigger },
      );
    }
    if (flows.has(flow)) {
      throw flowError(
        "runner_flows_index_invalid",
        `The flow ${flow} is declared more than once.`,
        { flow },
      );
    }
    triggers.add(trigger);
    flows.add(flow);
    references.push({ trigger, flow, before: beforeCell });
  }

  if (references.length === 0) {
    throw flowError(
      "runner_flows_index_invalid",
      `The "${FLOWS_SECTION_HEADING}" index does not declare any flow.`,
    );
  }

  return references;
}

/**
 * Read the moment table. Every declared name must exist in the trigger index;
 * `ninguno` is only valid for intake.
 */
export function extractFlowMoments(runnerBody, { declaredFlows = null } = {}) {
  const section = flowSection(runnerBody);
  if (section === null) return Object.fromEntries(FLOW_MOMENTS.map((moment) => [moment, []]));

  const table = flowSubsection(section, "Flujos por momento");
  if (table === null) {
    throw flowError(
      "runner_flows_moment_invalid",
      `The "${FLOWS_SECTION_HEADING}" section is missing "### Flujos por momento".`,
    );
  }

  const declared = declaredFlows ?? extractFlowReferences(runnerBody).map((reference) => reference.flow);
  const declaredSet = new Set(declared);
  const moments = {};
  let rowIndex = 0;
  for (const row of flowTableRows(table)) {
    rowIndex += 1;
    if (row.cells[0] === "Momento") continue;
    if (row.cells.length !== 2) {
      throw flowError(
        "runner_flows_moment_invalid",
        `Moment row ${rowIndex} must have exactly 2 cells: ${row.line}`,
        { row: rowIndex, line: row.line, reason: "cell_count" },
      );
    }
    const [momentCell, flowsCell] = row.cells;
    const momentMatch = momentCell.match(/^`([^`]+)`$/);
    if (!momentMatch || !FLOW_MOMENTS.includes(momentMatch[1])) {
      throw flowError(
        "runner_flows_moment_invalid",
        `Moment row ${rowIndex} has an invalid moment: ${momentCell}`,
        { row: rowIndex, line: row.line, reason: "moment" },
      );
    }
    const moment = momentMatch[1];
    if (moments[moment]) {
      throw flowError(
        "runner_flows_moment_invalid",
        `The moment ${moment} is declared more than once.`,
        { moment, reason: "duplicate" },
      );
    }

    const names = [...flowsCell.matchAll(/runner-flow-[a-z0-9-]+/g)].map((match) => match[0]);
    if (names.length === 0) {
      const normalized = flowsCell.trim();
      if (normalized === "ninguno") {
        if (moment !== "intake") {
          throw flowError(
            "runner_flows_moment_invalid",
            `Moment ${moment} cannot be "ninguno"; only intake has no required flow.`,
            { moment, reason: "ninguno" },
          );
        }
        moments[moment] = [];
        continue;
      }
      if (normalized.includes("el flujo del trabajo")) {
        // The canonical table names the work flow generically for close.
        moments[moment] = [];
        continue;
      }
      throw flowError(
        "runner_flows_moment_invalid",
        `Moment ${moment} must declare flow names, "el flujo del trabajo" or "ninguno": ${flowsCell}`,
        { moment, reason: "names" },
      );
    }
    for (const name of names) {
      if (!declaredSet.has(name)) {
        throw flowError(
          "runner_flows_moment_invalid",
          `Moment ${moment} references ${name}, which the trigger index does not declare.`,
          { moment, flow: name, reason: "undeclared" },
        );
      }
    }
    moments[moment] = [...new Set(names)];
  }

  const missing = FLOW_MOMENTS.filter((moment) => moments[moment] === undefined);
  if (missing.length > 0) {
    throw flowError(
      "runner_flows_moment_invalid",
      `The moment table does not declare: ${missing.join(", ")}.`,
      { missing },
    );
  }
  return moments;
}

// ─── Skill declaration translation ────────────────────────────────────────────

export const SKILL_CALL_PATTERN = /skill\(\{\s*name:\s*["']([^"']+)["']\s*\}\)/g;
export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** List the calls declared in a body, in source order, ignoring the placeholder. */
export function findSkillCalls(body) {
  const pattern = new RegExp(SKILL_CALL_PATTERN.source, "g");
  const calls = [];
  for (const match of body.matchAll(pattern)) {
    if (match[1] === "...") continue;
    calls.push({ name: match[1], index: match.index, length: match[0].length });
  }
  return calls;
}

function listInstalledSkillNames(skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fileExists(path.join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name);
}

function bodyMentionsSkill(body, name) {
  let index = body.indexOf(name);
  while (index !== -1) {
    const before = index === 0 ? "" : body[index - 1];
    const after = body[index + name.length] ?? "";
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    index = body.indexOf(name, index + 1);
  }
  return false;
}

/**
 * Names declared by a body: every skill call plus every installed skill whose
 * name appears as a standalone word. Sorted so the generated appendix is stable.
 */
export function collectDeclaredSkillNames(body, { skillsDir }) {
  const names = new Set(findSkillCalls(body).map((call) => call.name));
  for (const name of listInstalledSkillNames(skillsDir)) {
    if (name.startsWith("runner-flow-")) continue;
    if (bodyMentionsSkill(body, name)) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right, "en"));
}

/** Problems that prevent resolving the calls of a body, unique per skill. */
export function resolveSkillCallProblems(body, { skillsDir }) {
  const problems = [];
  const seen = new Set();
  for (const call of findSkillCalls(body)) {
    if (seen.has(call.name)) continue;
    seen.add(call.name);
    const skillPath = path.join(skillsDir, call.name, "SKILL.md");
    if (!SKILL_NAME_PATTERN.test(call.name)) {
      problems.push({ skill: call.name, path: skillPath, reason: "invalid_name" });
      continue;
    }
    if (!fileExists(skillPath)) {
      problems.push({ skill: call.name, path: skillPath, reason: "missing" });
    }
  }
  return problems;
}

/** Replace every skill call with a direct read of the file in the payload. */
export function translateSkillCalls(body, { skillsDir }) {
  const calls = findSkillCalls(body);
  if (calls.length === 0) return body;

  const parts = [];
  let cursor = 0;
  for (const call of calls) {
    // An inline backticked call must consume its delimiters; otherwise the
    // translated read would stay wrapped in code spans and render nested.
    const startsInline = call.index > 0 && body[call.index - 1] === "`";
    const endsInline = body[call.index + call.length] === "`";
    const start = startsInline ? call.index - 1 : call.index;
    const end = call.index + call.length + (endsInline ? 1 : 0);
    parts.push(body.slice(cursor, start));
    const skillPath = path.join(skillsDir, call.name, "SKILL.md");
    parts.push(`**Read** \`${skillPath}\` — carga de la skill \`${call.name}\` antes de continuar.`);
    // An inline call usually closes the sentence; consume its period so the
    // translated sentence does not end with a double stop.
    cursor = startsInline && endsInline && body[end] === "." ? end + 1 : end;
  }
  parts.push(body.slice(cursor));
  return parts.join("");
}

/** Rewrite canonical `.flowtask/skills/<rel>` references to the payload path. */
export function normalizeSkillPaths(body, { skillsDir, context = null } = {}) {
  return body.replace(/\.flowtask\/skills\/([A-Za-z0-9._/-]+)/g, (match, rawRelative) => {
    const punctuation = rawRelative.match(/[.,;:]+$/)?.[0] ?? "";
    const relative = punctuation ? rawRelative.slice(0, -punctuation.length) : rawRelative;
    const segments = relative.split("/").filter(Boolean);

    if (segments.includes("..")) {
      const error = new Error(
        `Skill path "${relative}" escapes the skills directory; only payload-relative paths are allowed.`,
      );
      error.code = "claude_agent_skill_path_invalid";
      error.context = context;
      error.path = relative;
      throw error;
    }

    const target = path.join(skillsDir, ...segments);
    if (!fileExists(target)) {
      const error = new Error(`Skill path "${relative}" does not exist at ${target}.`);
      error.code = "claude_agent_skill_path_missing";
      error.context = context;
      error.path = target;
      throw error;
    }
    return `${target}${punctuation}`;
  });
}

/** Markdown appendix listing skills named without a call, with their path. */
export function buildSkillFilesSection(names, { skillsDir } = {}) {
  if (!names || names.length === 0) return "";
  return [
    "## Archivos de skills referenciadas",
    "",
    ...names.map((name) => `- \`${name}\` → \`${path.join(skillsDir, name, "SKILL.md")}\``),
  ].join("\n");
}

/** Fail when a generated body still contains a skill call. */
export function assertNoSkillCalls(content, context = null) {
  const calls = findSkillCalls(content);
  if (calls.length === 0) return content;

  const skills = [...new Set(calls.map((call) => call.name))];
  const error = new Error(
    `Skill calls remain untranslated in ${context ?? "generated content"}: ${skills.join(", ")}.`,
  );
  error.code = "claude_agent_skill_untranslated";
  error.context = context;
  error.skills = skills;
  throw error;
}

/** Fail when a declared skill has no absolute path in the content. */
export function assertEveryDeclaredSkillHasPath(content, names, { skillsDir, context = null } = {}) {
  const missing = names.filter((name) => !content.includes(path.join(skillsDir, name, "SKILL.md")));
  if (missing.length === 0) return content;

  const error = new Error(
    `Declared skills without an absolute path in ${context ?? "generated content"}: ${missing.join(", ")}.`,
  );
  error.code = "claude_agent_skill_unreferenced";
  error.context = context;
  error.missing = missing;
  throw error;
}

/**
 * Build the startup block emitted by the global hook. Every path points at the
 * active runtime payload so the block is independent of the project layout.
 */
export function buildStartupBlock({ skillsDir, runnerPath }) {
  const skillRead = (name) => path.join(skillsDir, name, "SKILL.md");

  return [
    "## Startup — run before answering",
    "",
    "Run this sequence at the start of every session, before classifying the request and without waiting for the user to ask:",
    "",
    "1. Load the Engram tools with **ToolSearch** (`mcp__engram__*`) before calling any `mem_*` tool.",
    "2. Run `mem_context` to recover context from previous sessions.",
    '3. Load heuristics with `mem_search(query: "heuristic", scope: "project")` and `mem_search(query: "heuristic", scope: "personal")`; when the same key exists in both scopes, the project value wins.',
    "4. Read the startup skills with **Read**:",
    ...STARTUP_SKILLS.map((name) => `   - \`${skillRead(name)}\``),
    `5. Read the runner definition with **Read**: \`${runnerPath}\``,
    "6. Show your identity at the start of every response: `[capa: orquestador] {base_name}`. Replace `{base_name}` with the BaseName assigned in the handshake; if no name is assigned, say the identity is unavailable instead of inventing one.",
    "7. Si esta sesión corre como el agente flowtask-runner, el cuerpo vigente ya está en el system prompt y el Read del paso 5 no es necesario.",
    "8. El nombre vigente es el que declara el system prompt del agente; el placeholder {base_name} se usa solo cuando no hay agente.",
  ].join("\n");
}

/**
 * Build the full skill index from runner.md, resolved against the installed skills.
 */
export function buildSkillIndex(runnerBody, { skillsDir, verificationDir = skillsDir }) {
  const references = extractSkillReferences(runnerBody);
  const missing = references.filter(
    (name) => !fileExists(path.join(verificationDir, name, "SKILL.md")),
  );

  if (missing.length > 0) {
    throw new Error(
      `Skill index references skills that are not installed in ${verificationDir}: ${missing.join(", ")}. ` +
        `Install the canonical skills or fix "${SKILLS_SECTION_HEADING}" in runner.md.`,
    );
  }

  const lines = references.map((name) => {
    const skillPath = path.join(skillsDir, name, "SKILL.md");
    return `- \`skill({ name: "${name}" })\` → **Read** \`${skillPath}\``;
  });

  const flows = extractFlowReferences(runnerBody);
  const missingFlows = flows.filter(
    (reference) => !fileExists(path.join(verificationDir, reference.flow, "SKILL.md")),
  );
  if (missingFlows.length > 0) {
    throw new Error(
      `Flow index references flows that are not installed in ${verificationDir}: ` +
        `${missingFlows.map((reference) => reference.flow).join(", ")}. ` +
        `Install the canonical flows or fix "${FLOWS_SECTION_HEADING}" in runner.md.`,
    );
  }
  for (const reference of flows) {
    const flowPath = path.join(skillsDir, reference.flow, "SKILL.md");
    lines.push(`- \`skill({ name: "${reference.flow}" })\` → **Read** \`${flowPath}\``);
  }

  return [
    "**Loading skills**: Instead of `skill({ name: \"...\" })`, use **Read** on the skill file:",
    "",
    ...lines,
  ].join("\n");
}

/** Hard limit of a SessionStart hook payload, in UTF-8 bytes. */
export const SESSION_START_LIMIT_BYTES = 10000;

/**
 * Reject a permanent core that reached the monolithic baseline. A relative
 * limit would allow the split to drift back into a single document.
 */
export function assertRunnerCoreUnderLimit(content, limit = RUNNER_CORE_BASELINE_BYTES) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes >= limit) {
    const error = new Error(
      `The runner core is ${bytes} bytes and must stay under ${limit} bytes. ` +
        "Move the sections that belong to a flow out of the permanent core.",
    );
    error.code = "runner_core_too_large";
    error.bytes = bytes;
    error.limit = limit;
    throw error;
  }
  return content;
}

export function assertSessionStartUnderLimit(content) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes >= SESSION_START_LIMIT_BYTES) {
    const error = new Error(
      `FlowTask startup is ${bytes} bytes and exceeds the ${SESSION_START_LIMIT_BYTES}-byte SessionStart hook limit. ` +
        "Reduce the startup skills or run flowtask update after fixing the runner.",
    );
    error.code = "session_start_too_large";
    error.bytes = bytes;
    throw error;
  }
  return content;
}

/**
 * Compose the startup document content without writing. The flow index is
 * appended after the skills so Claude can resolve both with **Read**.
 */
export function buildSessionStartContent({
  skillsDir,
  runnerPath,
  runnerContent = null,
  verificationSkillsDir = null,
}) {
  if (runnerContent === null && !fileExists(runnerPath)) {
    throw new Error(`runner.md not found at ${runnerPath} — cannot generate the startup document.`);
  }

  const runnerBody = parseFrontmatter(
    runnerContent ?? fs.readFileSync(runnerPath, "utf8"),
  ).body;
  return [
    "# FlowTask session start",
    "",
    buildStartupBlock({ skillsDir, runnerPath }),
    "",
    buildSkillIndex(runnerBody, { skillsDir, verificationDir: verificationSkillsDir ?? skillsDir }),
    "",
  ].join("\n");
}

/**
 * Write the startup document consumed by the global hook and return its content.
 */
export function generateClaudeSessionStart({
  skillsDir,
  runnerPath,
  sessionStartPath,
  runnerContent = null,
  verificationSkillsDir = null,
}) {
  const content = buildSessionStartContent({
    skillsDir,
    runnerPath,
    runnerContent,
    verificationSkillsDir,
  });

  assertSessionStartUnderLimit(content);
  fs.mkdirSync(path.dirname(sessionStartPath), { recursive: true });
  fs.writeFileSync(sessionStartPath, content, "utf8");
  return content;
}

/**
 * Adapt a flow body for the Claude Code payload: rewrite relative skill paths,
 * turn every skill call into a direct read and fail if any call remains.
 */
export function adaptFlowBodyForClaude(flowBody, { skillsDir, context = null } = {}) {
  const declared = [...new Set(findSkillCalls(flowBody).map((call) => call.name))];
  const normalized = normalizeSkillPaths(flowBody, { skillsDir, context });
  const translated = translateSkillCalls(normalized, { skillsDir });
  assertNoSkillCalls(translated, context);
  assertEveryDeclaredSkillHasPath(translated, declared, { skillsDir, context });
  return translated;
}

// ─── Runner agent prompt ──────────────────────────────────────────────────────

/** Name of the user-level agent that runs the main thread as the FlowTask runner. */
export const CLAUDE_RUNNER_AGENT_NAME = "flowtask-runner";

/**
 * Remove the platform metadata block at the top of the canonical runner. The
 * block opens with a `***` line and closes with a line of at least eleven
 * dashes; neither belongs to the generated system prompt.
 */
export function stripRunnerMetadata(content) {
  const opening = content.match(/^\*\*\*[ \t]*\r?\n/);
  if (!opening) return content;

  const rest = content.slice(opening[0].length);
  const closing = rest.match(/^-{11,}[ \t]*$/m);
  if (!closing) {
    const error = new Error("The runner metadata block is missing its closing dash line.");
    error.code = "runner_metadata_unclosed";
    throw error;
  }

  const end = opening[0].length + closing.index + closing[0].length;
  return content.slice(end).replace(/^\r?\n/, "");
}

/**
 * Compose the anchoring contract that turns the runner body into the system
 * prompt of the main thread. Paths resolve against the active payload.
 */
export function buildRunnerAnchorBlock({ baseName, skillsDir }) {
  const skillRead = (name) => path.join(skillsDir, name, "SKILL.md");

  return [
    "## Contrato de anclaje",
    "",
    "Sos el runner de FlowTask en este proyecto. Este system prompt es el cuerpo vigente del runner: el rol está asumido desde este turno, sin lectura previa y sin pedido del desarrollador.",
    "",
    "Esta sección prevalece sobre cualquier regla de este prompt que permita continuar sin la memoria del proyecto.",
    "",
    "### Arranque obligatorio",
    "",
    "Antes de clasificar el pedido, ejecutar comandos, leer documentación o consultar el repositorio:",
    "",
    "1. Cargá las herramientas de Engram con ToolSearch (mcp__engram__*).",
    "2. Ejecutá mem_context.",
    '3. Cargá las heurísticas con mem_search(query: "heuristic", scope: "project") y mem_search(query: "heuristic", scope: "personal"); si la misma key existe en ambos scopes, prevalece la de project.',
    "4. Leé con Read, si no están cargadas, las skills de arranque:",
    `   - ${skillRead("investigacion")}`,
    `   - ${skillRead("memory-protocol")}`,
    `   - ${skillRead("zero-assumptions")}`,
    `5. Mostrá la identidad al inicio de cada respuesta: [capa: orquestador] ${baseName}.`,
    "",
    `El bloque de SessionStart repite el índice de skills. El placeholder {base_name} de ese bloque no se usa: el nombre vigente es ${baseName}. Si un handshake posterior asigna un BaseName al trabajo activo, ese nombre pasa a ser el vigente desde esa respuesta.`,
    "",
    "### Memoria primero",
    "",
    "La memoria del proyecto se consulta antes que el repositorio y la documentación. No ejecutes git, no leas archivos del proyecto y no busques documentación antes de que mem_context haya respondido.",
    "",
    "### Fallo declarado",
    "",
    "Si Engram no responde o mem_context falla, detené la respuesta con esta línea y no continúes con otra fuente:",
    "",
    "⛔ Fuente no disponible: memoria del proyecto (Engram). No continúo sin ella. Para reanudar: verificá el registro MCP de Engram y volvé a intentar.",
    "",
    "Si una skill de arranque no se puede leer, declarás la ruta faltante con el mismo formato y detenés el paso que la requería.",
    "",
    "No presentes inferencias como hechos. Marcá todo dato no verificado como no verificado.",
    "",
    "Este contrato rige en proyectos con .claude/flowtask/project.json. Si el archivo no existe, no asumas el rol de runner.",
  ].join("\n");
}

/**
 * Build the runner prompt for the user-level agent: strip platform metadata,
 * translate every skill declaration to a payload read, and prepend the anchor.
 */
export function buildRunnerPromptBody({ runnerBody, skillsDir, baseName }) {
  const stripped = stripRunnerMetadata(runnerBody);
  const declared = collectDeclaredSkillNames(stripped, { skillsDir });
  const callNames = new Set(findSkillCalls(stripped).map((call) => call.name));
  const extras = declared.filter((name) => !callNames.has(name));

  let composed = translateSkillCalls(
    normalizeSkillPaths(stripped, { skillsDir, context: CLAUDE_RUNNER_AGENT_NAME }),
    { skillsDir },
  );
  // The canonical runner uses an illustrative placeholder next to the real
  // calls. It is not a skill call, but the generated prompt must not keep a
  // syntax that Claude Code cannot resolve.
  composed = composed.replace(
    '`skill({ name: "..." })`',
    "**Read** sobre la ruta absoluta de la skill",
  );
  assertNoSkillCalls(composed, CLAUDE_RUNNER_AGENT_NAME);
  if (extras.length > 0) {
    composed = `${composed}\n\n---\n\n${buildSkillFilesSection(extras, { skillsDir })}`;
  }
  assertEveryDeclaredSkillHasPath(composed, declared, { skillsDir, context: CLAUDE_RUNNER_AGENT_NAME });

  return `${buildRunnerAnchorBlock({ baseName, skillsDir })}\n\n${composed}\n`;
}

// ─── Runner adaptation ────────────────────────────────────────────────────────

function toEmbeddedPath(value) {
  return value.split(path.sep).join("/");
}

/**
 * Replace the three project-relative references of the canonical runner with
 * the absolute runtime paths. It fails if any reference is missing: a silent
 * partial adaptation would leave the runtime pointing at a project directory.
 */
export function adaptRunnerForRuntime(runnerBody, runtimeRoot) {
  const root = toEmbeddedPath(runtimeRoot);
  const replacements = [
    {
      from: 'FLOWTASK_SCRIPTS="./.flowtask/scripts"',
      to: `FLOWTASK_SCRIPTS="${root}/scripts"`,
    },
    { from: ".flowtask/skills/", to: `${root}/skills/` },
    { from: ".flowtask/bin/lib/", to: `${root}/bin/lib/` },
  ];

  let adapted = runnerBody;
  for (const { from, to } of replacements) {
    if (!adapted.includes(from)) {
      throw new Error(
        `runner.md no longer contains the expected runtime reference "${from}". ` +
          "Fix the canonical runner or update the runtime adaptation.",
      );
    }
    adapted = adapted.split(from).join(to);
  }
  return adapted;
}

/**
 * Compose the runner stored in the runtime payload: absolute paths, persona and
 * autonomy. The canonical runner.md is never written.
 */
export function buildRuntimeRunnerBody({ runnerContent, runtimeRoot, personaContent, autonomyDescriptor }) {
  assertRunnerCoreUnderLimit(runnerContent);
  let content = adaptRunnerForRuntime(runnerContent, runtimeRoot);
  content = injectPersonaIntoRunnerContent(content, personaContent);
  if (autonomyDescriptor) content = injectAutonomyIntoRunnerContent(content, autonomyDescriptor);
  return content;
}

// ─── Persona and autonomy injection ──────────────────────────────────────────

export const CUSTOM_PERSONA_TEXT = `The developer chose the custom personality option. Before continuing, ask whether they want to take the onboarding quiz (\`/onboard\`) so you can adapt your communication style to their experience level and improve the development experience.`;

export const PERSONA_START_MARKER = "<!-- FLOWTASK:PERSONA_START -->";
export const PERSONA_END_MARKER = "<!-- FLOWTASK:PERSONA_END -->";
export const AUTONOMY_START_MARKER = "<!-- FLOWTASK:AUTONOMY_START -->";
export const AUTONOMY_END_MARKER = "<!-- FLOWTASK:AUTONOMY_END -->";

/**
 * Injects a runner's persona block.
 *
 * `undefined` leaves the block intact; `null` (or empty content) clears it.
 * Missing markers only warn: persona is optional.
 */
export function injectPersonaIntoRunnerContent(content, personaContent) {
  if (personaContent === undefined) return content;

  const startIdx = content.indexOf(PERSONA_START_MARKER);
  const endIdx = content.indexOf(PERSONA_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx + PERSONA_START_MARKER.length) {
    logWarn("PERSONA markers not found in runner.md. No personality was injected.");
    return content;
  }

  const block = personaContent ? `\n${personaContent}\n` : "\n";
  return (
    content.slice(0, startIdx + PERSONA_START_MARKER.length) +
    block +
    content.slice(endIdx)
  );
}

export function injectPersonaIntoRunner(targetDir, personaContent) {
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

/**
 * Injects the resolved autonomy value between the autonomy markers.
 * Unlike persona, autonomy is mandatory: without markers or with an
 * invalid descriptor, the operation fails.
 */
export function injectAutonomyIntoRunnerContent(content, descriptor) {
  const profile = descriptor && descriptor.profile;
  const source = descriptor && descriptor.source;

  if (!AUTONOMY_PROFILES.includes(profile) || !LAYER_SOURCES.includes(source)) {
    const error = new Error(
      "[FlowTask Layers] Could not inject autonomy into runner.md: invalid autonomy descriptor.",
    );
    error.code = "autonomy_descriptor_invalid";
    throw error;
  }

  const startIdx = content.indexOf(AUTONOMY_START_MARKER);
  const endIdx = content.indexOf(AUTONOMY_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx + AUTONOMY_START_MARKER.length) {
    const error = new Error(
      `[FlowTask Layers] Could not inject autonomy into runner.md: markers ${AUTONOMY_START_MARKER} and ${AUTONOMY_END_MARKER} are missing.`,
    );
    error.code = "autonomy_markers_missing";
    throw error;
  }

  const block = `\nCurrent autonomy: ${profile} (source: ${source}).\n`;
  return (
    content.slice(0, startIdx + AUTONOMY_START_MARKER.length) +
    block +
    content.slice(endIdx)
  );
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

/** Replace the project-relative scripts directory used by non-Claude targets. */
export function configureRunnerScriptsContent(content, targetSubDir) {
  const scriptsDir = `${targetSubDir.replace(/\\/g, "/")}/scripts`;
  return content.replace('FLOWTASK_SCRIPTS="./.flowtask/scripts"', `FLOWTASK_SCRIPTS="./${scriptsDir}"`);
}
