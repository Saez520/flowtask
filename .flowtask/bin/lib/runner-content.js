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
const STARTUP_SKILLS = ["investigacion", "memory-protocol", "zero-assumptions"];

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
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const names = new Set();
  for (const match of section.matchAll(/skill\(\{\s*name:\s*["']([^"']+)["']\s*\}\)/g)) {
    if (match[1] !== "...") names.add(match[1]);
  }
  for (const match of section.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)*)`/g)) {
    names.add(match[1]);
  }
  return [...names];
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
  ].join("\n");
}

/**
 * Build the full skill index from runner.md, resolved against the installed skills.
 */
export function buildSkillIndex(runnerBody, { skillsDir }) {
  const references = extractSkillReferences(runnerBody);
  const missing = references.filter(
    (name) => !fileExists(path.join(skillsDir, name, "SKILL.md")),
  );

  if (missing.length > 0) {
    throw new Error(
      `Skill index references skills that are not installed in ${skillsDir}: ${missing.join(", ")}. ` +
        `Install the canonical skills or fix "${SKILLS_SECTION_HEADING}" in runner.md.`,
    );
  }

  const lines = references.map((name) => {
    const skillPath = path.join(skillsDir, name, "SKILL.md");
    return `- \`skill({ name: "${name}" })\` → **Read** \`${skillPath}\``;
  });

  return [
    "**Loading skills**: Instead of `skill({ name: \"...\" })`, use **Read** on the skill file:",
    "",
    ...lines,
  ].join("\n");
}

/** Hard limit of a SessionStart hook payload, in UTF-8 bytes. */
export const SESSION_START_LIMIT_BYTES = 10000;

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
 * Write the startup document consumed by the global hook and return its content.
 */
export function generateClaudeSessionStart({ skillsDir, runnerPath, sessionStartPath }) {
  if (!fileExists(runnerPath)) {
    throw new Error(`runner.md not found at ${runnerPath} — cannot generate the startup document.`);
  }

  const runnerBody = parseFrontmatter(fs.readFileSync(runnerPath, "utf8")).body;
  const content = [
    "# FlowTask session start",
    "",
    buildStartupBlock({ skillsDir, runnerPath }),
    "",
    buildSkillIndex(runnerBody, { skillsDir }),
    "",
  ].join("\n");

  assertSessionStartUnderLimit(content);
  fs.mkdirSync(path.dirname(sessionStartPath), { recursive: true });
  fs.writeFileSync(sessionStartPath, content, "utf8");
  return content;
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
  let content = adaptRunnerForRuntime(runnerContent, runtimeRoot);
  content = injectPersonaIntoRunnerContent(content, personaContent);
  if (autonomyDescriptor) content = injectAutonomyIntoRunnerContent(content, autonomyDescriptor);
  return content;
}

// ─── Persona and autonomy injection ──────────────────────────────────────────

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
