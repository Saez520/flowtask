import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { logInfo, logSuccess, logError, fileExists } from "./logger.js";
import { deepMergeObjects } from "./opencode.js";

// ─── Claude paths ─────────────────────────────────────────────────────────────

/** Schema of the runtime manifest written at the user-level runtime root. */
export const CLAUDE_RUNTIME_SCHEMA = 1;
/** Schema of the per-project registration file. */
export const PROJECT_REGISTRY_SCHEMA = 1;
/** Schema of the user-level project index. */
export const PROJECTS_INDEX_SCHEMA = 1;
/** Exact ownership marker for generated agents and commands. */
export const FLOWTASK_MANAGED_MARKER = "<!-- FLOWTASK:MANAGED v1 -->";

/**
 * Single resolver for every Claude Code path.
 *
 * The runtime lives once per operating-system account under the Claude user
 * directory; the project only receives a registration and the artifacts Claude
 * Code discovers per project. `CLAUDE_CONFIG_DIR` takes precedence over the
 * home directory, so isolated smoke tests can redirect the whole layout.
 */
export function resolveClaudePaths(projectDir = process.cwd(), options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const claudeUserDir =
    options.claudeUserDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude");

  const runtimeRoot = path.join(claudeUserDir, "flowtask");
  const projectClaudeDir = path.join(projectDir, ".claude");
  const projectFlowtaskDir = path.join(projectClaudeDir, "flowtask");

  return {
    projectDir,
    homeDir,
    claudeUserDir,
    runtimeRoot,
    runtimeBinDir: path.join(runtimeRoot, "bin"),
    runtimeManifestPath: path.join(runtimeRoot, "runtime.json"),
    runtimeConfigDir: path.join(runtimeRoot, "config"),
    runtimeVersionsDir: path.join(runtimeRoot, "versions"),
    projectsIndexPath: path.join(runtimeRoot, "projects.json"),
    hookScriptPath: path.join(runtimeRoot, "bin", "session-start.mjs"),
    projectClaudeDir,
    projectFlowtaskDir,
    registryPath: path.join(projectFlowtaskDir, "project.json"),
    projectSettingsPath: path.join(projectClaudeDir, "settings.json"),
    projectMcpPath: path.join(projectDir, ".mcp.json"),
    projectAgentsDir: path.join(projectClaudeDir, "agents"),
    projectCommandsDir: path.join(projectClaudeDir, "commands"),
    legacySessionStartPath: path.join(projectClaudeDir, "session-start.md"),
  };
}

/**
 * Resolve the paths inside the active payload directory.
 * `manifest` may be the runtime manifest or a payload id string.
 */
export function resolveActiveRuntimePaths(runtimeRoot, manifest) {
  const payloadId = typeof manifest === "string" ? manifest : manifest?.payloadId;
  if (!payloadId) throw new Error("runtime manifest does not declare a payloadId");
  const payloadDir = path.join(runtimeRoot, "versions", payloadId);
  return {
    payloadId,
    payloadDir,
    runnerPath: path.join(payloadDir, "runner.md"),
    sessionStartPath: path.join(payloadDir, "session-start.md"),
    skillsDir: path.join(payloadDir, "skills"),
    scriptsDir: path.join(payloadDir, "scripts"),
    binLibDir: path.join(payloadDir, "bin", "lib"),
  };
}

/** Exact hook command that launches the runtime script without relying on PATH. */
export function buildSessionStartHookCommand(runtimeRoot, nodePath = process.execPath) {
  return `"${nodePath}" "${path.join(runtimeRoot, "bin", "session-start.mjs")}"`;
}

/** Write a file atomically: temp file in the same directory, then rename. */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* already gone */ }
    throw error;
  }
}

/** SHA-256 hex digest of a file. */
export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
 * Build the startup block reused by CLAUDE.md and .claude/session-start.md.
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

function loadRunnerBody(flowtaskDir, runnerBodyOverride) {
  if (runnerBodyOverride !== null && runnerBodyOverride !== undefined) {
    return parseFrontmatter(runnerBodyOverride).body;
  }
  const runnerPath = path.join(flowtaskDir, "agents", "runner.md");
  if (!fileExists(runnerPath)) return null;
  return parseFrontmatter(fs.readFileSync(runnerPath, "utf8")).body;
}

/**
 * Write .claude/session-start.md with the startup block and the skill index.
 */
export function generateClaudeSessionStart(flowtaskDir, projectDir, runnerBodyOverride = null) {
  const claudePaths = resolveClaudePaths(projectDir);
  const runnerBody = loadRunnerBody(flowtaskDir, runnerBodyOverride);

  if (runnerBody === null) {
    logError("runner.md not found — cannot generate .claude/session-start.md");
    return;
  }

  const skillsDir = path.join(claudePaths.runtimeRoot, "skills");
  const runnerPath = path.join(claudePaths.runtimeRoot, "runner.md");
  const content = [
    "# FlowTask session start",
    "",
    buildStartupBlock({ skillsDir, runnerPath }),
    "",
    buildSkillIndex(runnerBody, { skillsDir }),
    "",
  ].join("\n");

  writeFileAtomic(claudePaths.legacySessionStartPath, content);
  logSuccess(`Claude Code startup written to ${claudePaths.legacySessionStartPath}.`);
}

// ─── Frontmatter parser ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { name: null, description: null, body: content };

  const yaml = match[1];
  const body = content.slice(match[0].length).trimStart();

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : null;

  let description = null;
  const descFolded = yaml.match(/^description:\s*>-\s*\n((?:[ \t]+.+\n?)*)/m);
  if (descFolded) {
    description = descFolded[1].split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  } else {
    const descSimple = yaml.match(/^description:\s*(.+)$/m);
    if (descSimple) description = descSimple[1].trim();
  }

  return { name, description, body };
}

// ─── Agent generator ──────────────────────────────────────────────────────────

function generateClaudeAgent(srcPath, destPath) {
  const content = fs.readFileSync(srcPath, "utf8");
  const { name, description, body } = parseFrontmatter(content);

  const rawName = name || path.basename(srcPath, ".md");
  const displayName =
    "FlowTask " +
    rawName.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  const claudeContent = [
    "---",
    `name: ${displayName}`,
    `description: ${description || "FlowTask subagent. Activated only through the runner."}`,
    "---",
    "",
    body,
  ].join("\n");

  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, claudeContent, "utf8");
}

/**
 * Generate all Claude Code agent files from .flowtask/agents/ (except runner.md).
 */
export function generateClaudeAgents(flowtaskDir, projectDir) {
  const agentsDir = path.join(flowtaskDir, "agents");
  if (!fs.existsSync(agentsDir)) return { generated: 0 };

  const destDir = path.join(projectDir, ".claude", "agents");
  let generated = 0;

  fs.readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md") && f !== "runner.md")
    .forEach((file) => {
      const agentName = path.basename(file, ".md");
      generateClaudeAgent(path.join(agentsDir, file), path.join(destDir, `flowtask-${agentName}.md`));
      generated++;
    });

  return { generated };
}

// ─── Command generator ────────────────────────────────────────────────────────

const CLAUDE_COMMAND_REPLACEMENTS = [
  ["opencode.json", ".claude/settings.json"],
  ["OpenCode no ha sido reiniciado", "Claude Code has not been restarted"],
  ["Cierra OpenCode completamente", "Close Claude Code completely"],
  ["Abre OpenCode nuevamente", "Open Claude Code again"],
];

function generateClaudeCommand(srcPath, destPath) {
  const content = fs.readFileSync(srcPath, "utf8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  let description = "";
  let body = content;

  if (fmMatch) {
    const yaml = fmMatch[1];
    body = content.slice(fmMatch[0].length);
    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    if (descMatch) description = descMatch[1].trim();
  }

  let adaptedBody = body;
  for (const [from, to] of CLAUDE_COMMAND_REPLACEMENTS) {
    adaptedBody = adaptedBody.split(from).join(to);
  }

  const claudeContent = `---\ndescription: ${description}\n---\n${adaptedBody}`;
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, claudeContent, "utf8");
}

/**
 * Generate all Claude Code command files from .flowtask/commands/.
 */
export function generateClaudeCommands(flowtaskDir, projectDir) {
  const commandsDir = path.join(flowtaskDir, "commands");
  if (!fs.existsSync(commandsDir)) return { generated: 0 };

  const destDir = path.join(projectDir, ".claude", "commands");
  let generated = 0;

  fs.readdirSync(commandsDir)
    .filter((f) => f.endsWith(".md"))
    .forEach((file) => {
      generateClaudeCommand(path.join(commandsDir, file), path.join(destDir, file));
      generated++;
    });

  return { generated };
}

// ─── CLAUDE.md generator ──────────────────────────────────────────────────────

/**
 * Inject runner.md content into the project's CLAUDE.md using FLOWTASK markers.
 * @param {string} flowtaskDir - Path to the FlowTask source directory
 * @param {string} projectDir - Path to the target project directory
 * @param {string|null} runnerBodyOverride - Optional pre-injected runner.md content (from target). If null, reads from source.
 */
export function generateClaudeMd(flowtaskDir, projectDir, runnerBodyOverride = null) {
  const runnerBody = loadRunnerBody(flowtaskDir, runnerBodyOverride);
  if (runnerBody === null) {
    logError("runner.md not found — cannot generate CLAUDE.md");
    return;
  }

  const claudePaths = resolveClaudePaths(projectDir);
  const runtimeSkillsDir = path.join(claudePaths.runtimeRoot, "skills");
  const runtimeRunnerPath = path.join(claudePaths.runtimeRoot, "runner.md");
  const adaptationHeader = `# FlowTask Runner

You are the FlowTask runner. Your operational definition follows.

${buildStartupBlock({ skillsDir: runtimeSkillsDir, runnerPath: runtimeRunnerPath })}

## Claude Code adaptations

**Subagent tool**: Instead of \`task(prompt: "...", subagent_type: "...")\`, use the **Agent** tool:
- \`subagent_type\`: agent name (e.g., \`flowtask-ca-writer\`)
- \`prompt\`: user text or required context, copied literally

Subagents are in \`.claude/agents/flowtask-*.md\`.

${buildSkillIndex(runnerBody, { skillsDir: runtimeSkillsDir })}

**Classification**: FLOWTASK_CLASSIFICATION is unavailable in Claude Code — always use \`manual-classification\` as a fallback.

---

${runnerBody}`;

  const section = `<!-- FLOWTASK:START -->\n${adaptationHeader.trimEnd()}\n<!-- FLOWTASK:END -->`;
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");

  logInfo(`Merging FlowTask runner into ${claudeMdPath}...`);

  try {
    let existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : "";
    let updated;

    if (existing.includes("<!-- FLOWTASK:START -->")) {
      updated = existing.replace(/<!-- FLOWTASK:START -->[\s\S]*?<!-- FLOWTASK:END -->/, section);
      logSuccess("FlowTask section updated in CLAUDE.md.");
    } else {
      const separator = existing.trim().length > 0 ? "\n\n---\n\n" : "";
      updated = existing + separator + section + "\n";
      logSuccess("FlowTask section added to CLAUDE.md.");
    }

    fs.writeFileSync(claudeMdPath, updated, "utf8");
  } catch (err) {
    logError(`Failed to generate CLAUDE.md: ${err.message}`);
  }
}

// ─── Settings merger ──────────────────────────────────────────────────────────

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) return { ok: true, value: {} };

  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.trim() === "") return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `${label} is not valid JSON: ${err.message}` };
  }
}

function hookMatches(group, matcher, command) {
  const groupMatcher = typeof group?.matcher === "string" ? group.matcher : "";
  if (groupMatcher !== matcher) return false;
  return (group.hooks ?? []).some((hook) => hook?.command === command);
}

/**
 * Additive hook merge: keeps every existing entry and appends only the
 * template (matcher, command) combinations that are not present yet.
 * Arrays are never passed through deepMergeObjects.
 */
export function mergeHooks(existingHooks = {}, templateHooks = {}) {
  const merged = JSON.parse(JSON.stringify(existingHooks ?? {}));

  for (const [event, templateGroups] of Object.entries(templateHooks ?? {})) {
    if (!Array.isArray(templateGroups)) {
      if (!(event in merged)) merged[event] = templateGroups;
      continue;
    }

    if (!Array.isArray(merged[event])) merged[event] = [];
    const groups = merged[event];

    for (const templateGroup of templateGroups) {
      const matcher = typeof templateGroup?.matcher === "string" ? templateGroup.matcher : "";
      for (const hook of templateGroup?.hooks ?? []) {
        if (groups.some((group) => hookMatches(group, matcher, hook?.command))) continue;

        let target = groups.find(
          (group) => (typeof group?.matcher === "string" ? group.matcher : "") === matcher && Array.isArray(group.hooks),
        );
        if (!target) {
          target = { matcher: templateGroup.matcher, hooks: [] };
          groups.push(target);
        }
        target.hooks.push({ ...hook });
      }
    }
  }

  return merged;
}

/**
 * Merge the Claude settings template into .claude/settings.json.
 * Hooks merge additively; malformed user JSON fails closed without writing.
 */
export function mergeClaudeSettings(settingsPath, flowtaskDir) {
  const templatePath = path.join(flowtaskDir, "claude", "settings.json");
  if (!fileExists(templatePath)) return { ok: true, skipped: true };

  logInfo(`Merging Engram MCP into ${settingsPath}...`);

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const existingRead = readJsonFile(settingsPath, settingsPath);

    if (!existingRead.ok) {
      const message = `Refusing to overwrite ${settingsPath}: ${existingRead.error}. Fix or move the file and retry.`;
      logError(message);
      return { ok: false, error: message };
    }

    const { hooks: existingHooks, ...existingRest } = existingRead.value;
    const { hooks: templateHooks, ...templateRest } = template;
    const merged = deepMergeObjects(existingRest, templateRest);

    if (existingHooks !== undefined || templateHooks !== undefined) {
      merged.hooks = mergeHooks(existingHooks ?? {}, templateHooks ?? {});
    }

    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf8");
    logSuccess("Claude Code settings.json updated with Engram MCP.");
    return { ok: true };
  } catch (err) {
    logError(`Failed to merge Claude settings: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── MCP Config merger ───────────────────────────────────────────────────────

export function mergeClaudeMcpConfig(mcpJsonPath, flowtaskDir) {
  const templatePath = path.join(flowtaskDir, "claude", "mcp.json");
  if (!fileExists(templatePath)) return { ok: true, skipped: true };
  logInfo(`Merging Engram MCP into ${mcpJsonPath}...`);
  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const existingRead = readJsonFile(mcpJsonPath, mcpJsonPath);

    if (!existingRead.ok) {
      const message = `Refusing to overwrite ${mcpJsonPath}: ${existingRead.error}. Fix or move the file and retry.`;
      logError(message);
      return { ok: false, error: message };
    }

    const merged = deepMergeObjects(existingRead.value, template);
    fs.writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2), "utf8");
    logSuccess(".mcp.json updated with Engram MCP.");
    return { ok: true };
  } catch (err) {
    logError(`Failed to merge .mcp.json: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
