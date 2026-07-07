import fs from "fs";
import path from "path";
import { logInfo, logSuccess, logError, fileExists } from "./logger.js";
import { deepMergeObjects } from "./opencode.js";

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
    "tools: Bash, Read, Write, Edit, Grep, Glob",
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
  ["OpenCode no ha sido reiniciado", "Claude Code no ha sido reiniciado"],
  ["Cierra OpenCode completamente", "Cierra Claude Code completamente"],
  ["Abre OpenCode nuevamente", "Abre Claude Code nuevamente"],
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
  let runnerBody;
  if (runnerBodyOverride !== null) {
    const parsed = parseFrontmatter(runnerBodyOverride);
    runnerBody = parsed.body;
  } else {
    const runnerPath = path.join(flowtaskDir, "agents", "runner.md");
    if (!fileExists(runnerPath)) {
      logError("runner.md not found — cannot generate CLAUDE.md");
      return;
    }
    const parsed = parseFrontmatter(fs.readFileSync(runnerPath, "utf8"));
    runnerBody = parsed.body;
  }

  const adaptationHeader = `# FlowTask Runner

Eres el runner de FlowTask. Tu definición operativa está a continuación.

## Adaptaciones para Claude Code

**Herramienta de subagentes**: En lugar de \`task(prompt: "...", subagent_type: "...")\`, usa la herramienta **Agent**:
- \`subagent_type\`: nombre del agente (ej: \`flowtask-ca-writer\`)
- \`prompt\`: texto del usuario u contexto requerido, copiado literalmente

Los subagentes están en \`.claude/agents/flowtask-*.md\`.

**Cargar skills**: En lugar de \`skill({ name: "..." })\`, usa **Read** sobre el archivo:
- \`skill({ name: "memory-protocol" })\` → \`.claude/flowtask/skills/memory-protocol/SKILL.md\`
- \`skill({ name: "manual-classification" })\` → \`.claude/flowtask/skills/manual-classification/SKILL.md\`
- \`skill({ name: "plan-template" })\` → \`.claude/flowtask/skills/plan-template/SKILL.md\`
- \`skill({ name: "topic-keys-convention" })\` → \`.claude/flowtask/skills/topic-keys-convention/SKILL.md\`

**Clasificación**: FLOWTASK_CLASSIFICATION no disponible en Claude Code — usa siempre \`manual-classification\` como fallback.

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

/**
 * Merge Engram MCP config from flowtask/claude/settings.json into .claude/settings.json.
 */
export function mergeClaudeSettings(settingsPath, flowtaskDir) {
  const templatePath = path.join(flowtaskDir, "claude", "settings.json");
  if (!fileExists(templatePath)) return;

  logInfo(`Merging Engram MCP into ${settingsPath}...`);

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    let existing = {};

    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf8").trim();
      if (content) {
        try { existing = JSON.parse(content); } catch { existing = {}; }
      }
    }

    const merged = deepMergeObjects(existing, template);
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), "utf8");
    logSuccess("Claude Code settings.json updated with Engram MCP.");
  } catch (err) {
    logError(`Failed to merge Claude settings: ${err.message}`);
  }
}
