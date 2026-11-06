import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { logSuccess, logError, fileExists } from "./logger.js";
import {
  assertEveryDeclaredSkillHasPath,
  assertNoSkillCalls,
  buildRunnerPromptBody,
  buildSkillFilesSection,
  CLAUDE_RUNNER_AGENT_NAME,
  collectDeclaredSkillNames,
  findSkillCalls,
  normalizeSkillPaths,
  parseFrontmatter,
  resolveSkillCallProblems,
  translateSkillCalls,
} from "./runner-content.js";
export { buildSkillIndex, buildStartupBlock, extractSkillReferences } from "./runner-content.js";

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
    projectLocalSettingsPath: path.join(projectClaudeDir, "settings.local.json"),
    projectMcpPath: path.join(projectDir, ".mcp.json"),
    projectAgentsDir: path.join(projectClaudeDir, "agents"),
    projectCommandsDir: path.join(projectClaudeDir, "commands"),
    legacySessionStartPath: path.join(projectClaudeDir, "session-start.md"),
    claudeAgentsDir: path.join(claudeUserDir, "agents"),
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

// ─── Agent generator ──────────────────────────────────────────────────────────

const SKILL_PREAMBLE =
  "> En Claude Code, cargá cada skill con **Read** sobre la ruta indicada; la herramienta nativa no resuelve las skills de FlowTask. Si no podés leerla, declaralo antes de continuar en lugar de improvisar.";

function composeClaudeAgent({ body, name, description, skillsDir }) {
  const displayName =
    "FlowTask " +
    name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  const declared = collectDeclaredSkillNames(body, { skillsDir });
  const callNames = new Set(findSkillCalls(body).map((call) => call.name));
  const extras = declared.filter((skill) => !callNames.has(skill));

  const normalizedBody = normalizeSkillPaths(body, { skillsDir, context: name });
  let composedBody = translateSkillCalls(normalizedBody, { skillsDir });
  if (extras.length > 0) {
    composedBody = `${composedBody.trimEnd()}\n\n---\n\n${buildSkillFilesSection(extras, { skillsDir })}\n`;
  }

  const parts = [
    "---",
    `name: ${displayName}`,
    `description: ${description || "FlowTask subagent. Activated only through the runner."}`,
    "---",
    FLOWTASK_MANAGED_MARKER,
    "",
  ];
  if (declared.length > 0) parts.push(SKILL_PREAMBLE, "");
  parts.push(composedBody);

  const content = parts.join("\n");
  assertNoSkillCalls(content, name);
  assertEveryDeclaredSkillHasPath(content, declared, { skillsDir, context: name });
  return content;
}

/**
 * Generate all Claude Code agent files from .flowtask/agents/ (except runner.md).
 * `flowtask-*` agents are owned by FlowTask and are replaced on every refresh.
 *
 * Composition is three-phase: every agent is read and validated, every body is
 * composed in memory, and only then are files written. An unresolved skill
 * aborts the whole generation without leaving a partial agent set.
 */
export function generateClaudeAgents(flowtaskDir, projectDir, options = {}) {
  const agentsDir = path.join(flowtaskDir, "agents");
  if (!fs.existsSync(agentsDir)) return { generated: 0, skipped: [], files: [] };

  const skillsDir = options.skillsDir ?? path.join(flowtaskDir, "skills");
  const destDir = path.join(projectDir, ".claude", "agents");

  const sources = [];
  const problems = [];
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith(".md") || file === "runner.md") continue;
    const agentName = path.basename(file, ".md");
    const content = fs.readFileSync(path.join(agentsDir, file), "utf8");
    const { description, body } = parseFrontmatter(content);

    for (const problem of resolveSkillCallProblems(body, { skillsDir })) {
      problems.push({ ...problem, agent: agentName });
    }
    sources.push({ agentName, description, body });
  }

  if (problems.length > 0) {
    const error = new Error(
      "Cannot generate Claude agents because declared skills are not installed: " +
        problems
          .map((problem) => `skill "${problem.skill}" declared in agent "${problem.agent}" (expected at ${problem.path})`)
          .join("; "),
    );
    error.code = "claude_agent_skill_unresolved";
    error.problems = problems;
    throw error;
  }

  const composed = sources.map((source) => ({
    destPath: path.join(destDir, `flowtask-${source.agentName}.md`),
    content: composeClaudeAgent({
      body: source.body,
      name: source.agentName,
      description: source.description,
      skillsDir,
    }),
  }));

  const files = [];
  for (const item of composed) {
    writeFileAtomic(item.destPath, item.content);
    files.push(item.destPath);
  }

  return { generated: files.length, skipped: [], files };
}

// ─── User-level runner agent ──────────────────────────────────────────────────

export const CLAUDE_RUNNER_AGENT_DESCRIPTION =
  "Orquestador principal de FlowTask para proyectos registrados. Ejecuta el hilo principal como runner con memoria primero, identidad de capa visible y fallo declarado.";

/**
 * Compose the user-level agent that Claude Code applies to the main thread. The
 * prompt body already carries the anchoring contract and the adapted runner.
 */
export function composeClaudeRunnerAgent({ promptBody }) {
  const parts = [
    "---",
    `name: ${CLAUDE_RUNNER_AGENT_NAME}`,
    `description: ${CLAUDE_RUNNER_AGENT_DESCRIPTION}`,
    "---",
    FLOWTASK_MANAGED_MARKER,
    "",
  ];
  parts.push(promptBody.trimEnd());
  return `${parts.join("\n")}\n`;
}

/**
 * Generate `~/.claude/agents/flowtask-runner.md` from the active payload. A
 * file without the ownership marker is preserved and reported, never replaced.
 */
export function generateClaudeRunnerAgent({ claudeUserDir, runtimeRoot, runtimeManifest, baseName }) {
  const active = resolveActiveRuntimePaths(runtimeRoot, runtimeManifest);
  if (!fileExists(active.runnerPath)) {
    const error = new Error(
      `FlowTask runner source not found at ${active.runnerPath}. Run: flowtask install`,
    );
    error.code = "runner_agent_source_missing";
    error.path = active.runnerPath;
    throw error;
  }

  const promptBody = buildRunnerPromptBody({
    runnerBody: fs.readFileSync(active.runnerPath, "utf8"),
    skillsDir: active.skillsDir,
    baseName,
  });
  const content = composeClaudeRunnerAgent({ promptBody });
  const destPath = path.join(claudeUserDir, "agents", `${CLAUDE_RUNNER_AGENT_NAME}.md`);

  if (fileExists(destPath)) {
    const existing = fs.readFileSync(destPath, "utf8");
    if (!existing.includes(FLOWTASK_MANAGED_MARKER)) return { status: "preserved", path: destPath };
    if (existing === content) return { status: "unchanged", path: destPath };
  }

  writeFileAtomic(destPath, content);
  return { status: "written", path: destPath };
}

/** Remove the generated runner agent only when it carries the ownership marker. */
export function removeClaudeRunnerAgent({ claudeUserDir }) {
  const destPath = path.join(claudeUserDir, "agents", `${CLAUDE_RUNNER_AGENT_NAME}.md`);
  if (!fileExists(destPath)) return { status: "absent", path: destPath };

  const content = fs.readFileSync(destPath, "utf8");
  if (!content.includes(FLOWTASK_MANAGED_MARKER)) return { status: "preserved", path: destPath };

  fs.rmSync(destPath, { force: true });
  return { status: "removed", path: destPath };
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

  const legacyContent = `---\ndescription: ${description}\n---\n${adaptedBody}`;
  const claudeContent = `---\ndescription: ${description}\n---\n${FLOWTASK_MANAGED_MARKER}\n${adaptedBody}`;

  if (fs.existsSync(destPath)) {
    const existing = fs.readFileSync(destPath, "utf8");
    const owned = existing.includes(FLOWTASK_MANAGED_MARKER);
    if (!owned && existing !== legacyContent) return { written: false, path: destPath };
  }

  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, claudeContent, "utf8");
  return { written: true, path: destPath };
}

/**
 * Generate all Claude Code command files from .flowtask/commands/.
 * A pre-existing command without the ownership marker is adopted only when its
 * content matches the legacy generated form exactly; any other content is
 * preserved and reported as skipped.
 */
export function generateClaudeCommands(flowtaskDir, projectDir) {
  const commandsDir = path.join(flowtaskDir, "commands");
  if (!fs.existsSync(commandsDir)) return { generated: 0, skipped: [], files: [] };

  const destDir = path.join(projectDir, ".claude", "commands");
  const files = [];
  const skipped = [];

  for (const file of fs.readdirSync(commandsDir)) {
    if (!file.endsWith(".md")) continue;
    const result = generateClaudeCommand(path.join(commandsDir, file), path.join(destDir, file));
    if (result.written) files.push(result.path);
    else skipped.push(result.path);
  }

  return { generated: files.length, skipped, files };
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
 * Arrays are never passed through an object deep merge.
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
 * Merge FlowTask hooks into a settings file. Only `hooks` is touched: every
 * other key, including `mcpServers`, is preserved verbatim. Malformed user JSON
 * fails closed without writing.
 */
export function mergeClaudeSettings(settingsPath, { hooks } = {}) {
  if (!hooks || typeof hooks !== "object") return { ok: true, skipped: true };

  try {
    const existingRead = readJsonFile(settingsPath, settingsPath);
    if (!existingRead.ok) {
      const message = `Refusing to overwrite ${settingsPath}: ${existingRead.error}. Fix or move the file and retry.`;
      logError(message);
      return { ok: false, error: message, changed: false };
    }

    const existing = existingRead.value;
    const existingHooks = existing.hooks ?? {};
    const mergedHooks = mergeHooks(existingHooks, hooks);
    if (JSON.stringify(existingHooks) === JSON.stringify(mergedHooks)) {
      return { ok: true, changed: false };
    }

    const next = { ...existing, hooks: mergedHooks };
    writeFileAtomic(settingsPath, JSON.stringify(next, null, 2));
    logSuccess(`FlowTask hook added to ${settingsPath}.`);
    return { ok: true, changed: true };
  } catch (err) {
    logError(`Failed to merge Claude settings: ${err.message}`);
    return { ok: false, error: err.message, changed: false };
  }
}

/** Return a hook tree without the entries matched by `predicate`. */
export function removeHookByCommand(hooks = {}, predicate) {
  const next = {};

  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }

    const remainingGroups = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        remainingGroups.push(group);
        continue;
      }
      const remaining = group.hooks.filter((hook) => !predicate(hook, group));
      if (remaining.length === 0) continue;
      remainingGroups.push({ ...group, hooks: remaining });
    }

    if (remainingGroups.length > 0) next[event] = remainingGroups;
  }

  return next;
}

/**
 * Remove only the FlowTask hook from a settings file. Either an exact command
 * or a command fragment may be supplied. Other hooks and keys are preserved.
 */
export function removeClaudeHook(settingsPath, { command = null, commandIncludes = null } = {}) {
  if (!command && !commandIncludes) {
    return { ok: false, error: "removeClaudeHook requires a command or commandIncludes value.", changed: false };
  }

  try {
    const existingRead = readJsonFile(settingsPath, settingsPath);
    if (!existingRead.ok) {
      const message = `Refusing to modify ${settingsPath}: ${existingRead.error}. Fix or move the file and retry.`;
      logError(message);
      return { ok: false, error: message, changed: false };
    }

    const existing = existingRead.value;
    const existingHooks = existing.hooks ?? {};
    const nextHooks = removeHookByCommand(existingHooks, (hook) => {
      const value = typeof hook?.command === "string" ? hook.command : "";
      return (command !== null && value === command) ||
        (commandIncludes !== null && value.includes(commandIncludes));
    });

    if (JSON.stringify(existingHooks) === JSON.stringify(nextHooks)) {
      return { ok: true, changed: false };
    }

    const next = { ...existing, hooks: nextHooks };
    writeFileAtomic(settingsPath, JSON.stringify(next, null, 2));
    logSuccess(`FlowTask hook removed from ${settingsPath}.`);
    return { ok: true, changed: true };
  } catch (err) {
    logError(`Failed to remove the Claude hook: ${err.message}`);
    return { ok: false, error: err.message, changed: false };
  }
}

/** Hook tree for the user-level SessionStart handler. */
export function buildSessionStartHook(runtimeRoot, nodePath = process.execPath) {
  return {
    SessionStart: [
      {
        matcher: "^(startup|resume|clear|compact|fork)$",
        hooks: [
          {
            type: "command",
            command: buildSessionStartHookCommand(runtimeRoot, nodePath),
            timeout: 10,
          },
        ],
      },
    ],
  };
}

