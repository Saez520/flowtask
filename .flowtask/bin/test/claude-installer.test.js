import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  buildSessionStartHook,
  buildSkillIndex,
  extractSkillReferences,
  generateClaudeAgents,
  generateClaudeCommands,
  mergeClaudeSettings,
  removeClaudeHook,
  resolveActiveRuntimePaths,
  resolveClaudePaths,
} from "../lib/claude.js";
import {
  SESSION_START_LIMIT_BYTES,
  assertSessionStartUnderLimit,
  buildStartupBlock,
  generateClaudeSessionStart,
} from "../lib/runner-content.js";
import { injectPersonaIntoRunnerContent } from "../lib/installer.js";
import { materializeClaudeProject } from "../lib/claude-projects.js";
import { ensureUserEngram, removeUserEngram } from "../lib/claude-mcp.js";
import { installClaudeTarget } from "../lib/claude-install.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");
const REAL_RUNNER_PATH = path.join(FLOWTASK_SOURCE, "agents", "runner.md");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-installer-test-"));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSkillFixtures(rootDir, names, directoryName = "skills") {
  for (const name of names) {
    const dir = path.join(rootDir, directoryName, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  }
}

function minimalRunner(body = "runner canónico") {
  return [
    "---",
    "name: runner",
    "---",
    "***",
    "",
    body,
    "",
    "## Skills disponibles",
    "",
    'skill({ name: "investigacion" })',
    'skill({ name: "memory-protocol" })',
    'skill({ name: "zero-assumptions" })',
    "",
    "***",
    "",
  ].join("\n");
}

function writeAgentFixture(flowtaskDir, name, extraFrontmatter = "") {
  const agentsDir = path.join(flowtaskDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "description: Sample agent.",
      extraFrontmatter,
      "---",
      "",
      "Body.",
    ].filter(Boolean).join("\n"),
    "utf8",
  );
}

function writeAgentBodyFixture(flowtaskDir, name, body) {
  const agentsDir = path.join(flowtaskDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, `${name}.md`),
    ["---", `name: ${name}`, "description: Sample agent.", "---", "", body, ""].join("\n"),
    "utf8",
  );
}

function readGeneratedAgents(projectDir) {
  const agentsDir = path.join(projectDir, ".claude", "agents");
  return fs
    .readdirSync(agentsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ file, content: fs.readFileSync(path.join(agentsDir, file), "utf8") }));
}

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

function writeCommandFixture(flowtaskDir, name, body = "Body.\n") {
  const commandsDir = path.join(flowtaskDir, "commands");
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: ${name}\n---\n${body}`,
    "utf8",
  );
}

describe("Claude user-level runtime contract", () => {
  it("injects persona into the runtime runner content without writing a file", () => {
    const runner = "---\nname: runner\n---\n<!-- FLOWTASK:PERSONA_START -->\n<!-- FLOWTASK:PERSONA_END -->\nrest";
    const persona = "Habla con claridad y brevedad.";

    const transformed = injectPersonaIntoRunnerContent(runner, persona);

    assert.match(transformed, /PERSONA_START -->\nHabla con claridad y brevedad\.\n<!-- FLOWTASK:PERSONA_END/);
    assert.equal(runner.includes(persona), false);
  });

  it("keeps the original runtime runner when persona markers are incomplete", () => {
    const runner = "---\nname: runner\n---\n<!-- FLOWTASK:PERSONA_START -->\nrest";

    assert.equal(injectPersonaIntoRunnerContent(runner, "persona"), runner);
  });

  it("resolves the user runtime and the project registration without writing", () => {
    const root = makeTempDir();
    const projectDir = path.join(root, "project");
    const claudeUserDir = path.join(root, "claude-user");
    try {
      fs.mkdirSync(projectDir, { recursive: true });

      const paths = resolveClaudePaths(projectDir, { claudeUserDir });

      assert.equal(paths.claudeUserDir, claudeUserDir);
      assert.equal(paths.runtimeRoot, path.join(claudeUserDir, "flowtask"));
      assert.equal(paths.runtimeBinDir, path.join(claudeUserDir, "flowtask", "bin"));
      assert.equal(paths.runtimeManifestPath, path.join(claudeUserDir, "flowtask", "runtime.json"));
      assert.equal(paths.runtimeConfigDir, path.join(claudeUserDir, "flowtask", "config"));
      assert.equal(paths.runtimeVersionsDir, path.join(claudeUserDir, "flowtask", "versions"));
      assert.equal(paths.projectsIndexPath, path.join(claudeUserDir, "flowtask", "projects.json"));
      assert.equal(paths.hookScriptPath, path.join(claudeUserDir, "flowtask", "bin", "session-start.mjs"));
      assert.equal(paths.registryPath, path.join(projectDir, ".claude", "flowtask", "project.json"));
      assert.equal(paths.projectClaudeDir, path.join(projectDir, ".claude"));
      assert.equal(paths.projectSettingsPath, path.join(projectDir, ".claude", "settings.json"));
      assert.equal(paths.projectMcpPath, path.join(projectDir, ".mcp.json"));

      const active = resolveActiveRuntimePaths(paths.runtimeRoot, { payloadId: "1.2.3-abcdef123456" });
      assert.equal(active.payloadDir, path.join(claudeUserDir, "flowtask", "versions", "1.2.3-abcdef123456"));
      assert.equal(active.runnerPath, path.join(active.payloadDir, "runner.md"));
      assert.equal(active.sessionStartPath, path.join(active.payloadDir, "session-start.md"));
      assert.equal(active.skillsDir, path.join(active.payloadDir, "skills"));
      assert.equal(active.scriptsDir, path.join(active.payloadDir, "scripts"));
      assert.equal(active.binLibDir, path.join(active.payloadDir, "bin", "lib"));

      assert.equal(fs.existsSync(claudeUserDir), false, "resolving paths must not create the user runtime");
      assert.equal(fs.existsSync(path.join(projectDir, ".claude")), false, "resolving paths must not create project files");
    } finally {
      cleanupDir(root);
    }
  });

  it("builds the startup block with absolute runtime paths under the hook limit", () => {
    const root = makeTempDir();
    const skillsDir = path.join(root, "runtime", "versions", "1.0.0-aaaa", "skills");
    const runnerPath = path.join(root, "runtime", "versions", "1.0.0-aaaa", "runner.md");
    const sessionStartPath = path.join(root, "runtime", "versions", "1.0.0-aaaa", "session-start.md");
    try {
      writeSkillFixtures(path.dirname(skillsDir), ["investigacion", "memory-protocol", "zero-assumptions"], "skills");

      const block = buildStartupBlock({ skillsDir, runnerPath });
      assert.match(block, /ToolSearch/);
      assert.match(block, /mem_context/);
      assert.match(block, /\[capa: orquestador\] \{base_name\}/);
      for (const skill of ["investigacion", "memory-protocol", "zero-assumptions"]) {
        assert.ok(block.includes(path.join(skillsDir, skill, "SKILL.md")), `missing absolute skill path for ${skill}`);
      }
      assert.ok(block.includes(runnerPath), "the startup block must read the runner by absolute path");
      assert.equal(block.includes(".claude/flowtask/skills/"), false, "the block must not use project-relative paths");

      const content = generateClaudeSessionStart({
        skillsDir,
        runnerPath,
        sessionStartPath,
        runnerContent: minimalRunner(),
        verificationSkillsDir: skillsDir,
      });
      assert.equal(fs.readFileSync(sessionStartPath, "utf8"), content);
      assert.ok(Buffer.byteLength(content, "utf8") < SESSION_START_LIMIT_BYTES);
      assert.match(content, /# FlowTask session start/);
      assert.match(content, /## Startup — run before answering/);
      assert.ok(content.includes(path.join(skillsDir, "investigacion", "SKILL.md")));

      assert.throws(
        () => assertSessionStartUnderLimit("x".repeat(SESSION_START_LIMIT_BYTES)),
        (error) => error.code === "session_start_too_large" && error.bytes === SESSION_START_LIMIT_BYTES,
      );
    } finally {
      cleanupDir(root);
    }
  });

  it("builds the skill index from runner declarations and names missing skills", () => {
    const root = makeTempDir();
    const skillsDir = path.join(root, "skills");
    try {
      const declared = extractSkillReferences(fs.readFileSync(REAL_RUNNER_PATH, "utf8"));
      assert.equal(declared.length, 13);
      assert.equal(new Set(declared).size, 13);

      writeSkillFixtures(root, ["alpha-skill", "beta-skill"]);
      const customRunner = [
        "## Skills disponibles",
        "",
        'skill({ name: "alpha-skill" })',
        "",
        "Also `beta-skill` is declared in prose.",
        "",
        "***",
        "",
      ].join("\n");

      const index = buildSkillIndex(customRunner, { skillsDir });
      assert.ok(index.includes(`Read** \`${path.join(skillsDir, "alpha-skill", "SKILL.md")}\``));
      assert.ok(index.includes(`Read** \`${path.join(skillsDir, "beta-skill", "SKILL.md")}\``));
      assert.equal(index.includes("investigacion"), false, "the index must not hardcode skills");

      assert.throws(
        () => buildSkillIndex(minimalRunner(), { skillsDir }),
        /not installed.*investigacion, memory-protocol, zero-assumptions/s,
      );
    } finally {
      cleanupDir(root);
    }
  });

  it("generates marked agents and commands without model fields and preserves unowned commands", () => {
    const root = makeTempDir();
    const flowtaskDir = path.join(root, "flowtask");
    const projectDir = path.join(root, "project");
    try {
      writeAgentFixture(flowtaskDir, "sample", 'model: "OpenCode Go/glm-5.3"');
      writeAgentFixture(flowtaskDir, "helper");
      writeCommandFixture(flowtaskDir, "update");
      writeCommandFixture(flowtaskDir, "user");
      fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), minimalRunner(), "utf8");

      const agents = generateClaudeAgents(flowtaskDir, projectDir);
      const generatedAgent = fs.readFileSync(path.join(projectDir, ".claude", "agents", "flowtask-sample.md"), "utf8");
      assert.equal(agents.generated, 2, "the runner is not materialized as an agent");
      assert.match(generatedAgent, /<!-- FLOWTASK:MANAGED v1 -->/);
      assert.doesNotMatch(generatedAgent, /^model:/m);

      const unowned = path.join(projectDir, ".claude", "commands", "user.md");
      fs.mkdirSync(path.dirname(unowned), { recursive: true });
      fs.writeFileSync(unowned, "user command\n", "utf8");

      const commands = generateClaudeCommands(flowtaskDir, projectDir);
      const generatedCommand = fs.readFileSync(path.join(projectDir, ".claude", "commands", "update.md"), "utf8");
      assert.equal(commands.generated, 1);
      assert.match(generatedCommand, /<!-- FLOWTASK:MANAGED v1 -->/);
      assert.deepEqual(commands.skipped, [unowned]);

      const second = generateClaudeCommands(flowtaskDir, projectDir);
      assert.equal(second.generated, 1);
      assert.deepEqual(second.skipped, [unowned]);
      assert.equal(fs.readFileSync(unowned, "utf8"), "user command\n");
    } finally {
      cleanupDir(root);
    }
  });

  /**
   * gap_ref: C1
   * criterio: ningún agente generado contiene una referencia desnuda sin contrapartida ejecutable.
   * defecto: una llamada `skill({...})` sin traducir o una skill mencionada solo en una tabla
   *   llega a Claude Code sin ruta y el subagente improvisa.
   * why_not_detected: ningún test vigente inspecciona los cuerpos de agentes generados.
   * comportamiento observable: el agente con llamada contiene un `**Read**` con la ruta absoluta
   *   y cero `skill({`; el agente con mención solo en tabla recibe el apéndice con su ruta.
   */
  it("translates every skill declaration into an executable read path", () => {
    const root = makeTempDir();
    const flowtaskDir = path.join(root, "flowtask");
    const projectDir = path.join(root, "project");
    const skillsDir = path.join(root, "skills");
    try {
      writeSkillFixtures(root, ["alpha-skill", "beta-skill"]);
      writeAgentBodyFixture(flowtaskDir, "caller", 'skill({ name: "alpha-skill" }) ← cargar antes de verificar');
      writeAgentBodyFixture(
        flowtaskDir,
        "tabler",
        ["| Skill | Cuándo |", "|---|---|", "| `beta-skill` | antes de continuar |"].join("\n"),
      );

      const agents = generateClaudeAgents(flowtaskDir, projectDir, { skillsDir });
      assert.equal(agents.generated, 2);

      const generated = readGeneratedAgents(projectDir);
      for (const agent of generated) {
        assert.equal(agent.content.includes("skill({"), false, `${agent.file} keeps a raw skill call`);
      }

      const caller = generated.find((agent) => agent.file === "flowtask-caller.md");
      const alphaPath = path.join(skillsDir, "alpha-skill", "SKILL.md");
      assert.ok(caller.content.includes(`**Read** \`${alphaPath}\` — carga de la skill \`alpha-skill\``));
      assert.equal(countOccurrences(caller.content, alphaPath), 1, "each declared skill needs exactly one absolute path");

      const tabler = generated.find((agent) => agent.file === "flowtask-tabler.md");
      const betaPath = path.join(skillsDir, "beta-skill", "SKILL.md");
      assert.match(tabler.content, /## Archivos de skills referenciadas/);
      assert.ok(tabler.content.includes(`- \`beta-skill\` → \`${betaPath}\``));
      assert.equal(countOccurrences(tabler.content, betaPath), 1, "each mentioned skill needs exactly one absolute path");
    } finally {
      cleanupDir(root);
    }
  });

  /**
   * gap_ref: C2
   * criterio: cada ruta de skill apunta a un archivo existente en el payload activo.
   * defecto: una ruta apunta fuera del payload o a un archivo inexistente, incluidas las de `scripts/`.
   * why_not_detected: los tests actuales generan agentes fixture sin skills y nunca resuelven rutas generadas.
   * comportamiento observable: las rutas embebidas contienen `versions/<id>/skills/`, existen en disco
   *   y la referencia a `scripts/` también queda resuelta dentro del payload.
   */
  it("resolves generated skill paths inside the active runtime payload", () => {
    const root = makeTempDir();
    const claudeUserDir = path.join(root, "claude-user");
    const payloadId = "1.0.0-abc123";
    const payloadSkillsDir = path.join(claudeUserDir, "flowtask", "versions", payloadId, "skills");
    const flowtaskDir = path.join(root, "flowtask");
    const projectDir = path.join(root, "project");
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      const skillDir = path.join(payloadSkillsDir, "alpha-skill");
      fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: alpha-skill\n---\n", "utf8");
      fs.writeFileSync(path.join(skillDir, "scripts", "helper.mjs"), "export const helper = true;\n", "utf8");
      fs.mkdirSync(projectDir, { recursive: true });
      writeAgentBodyFixture(
        flowtaskDir,
        "caller",
        [
          'skill({ name: "alpha-skill" })',
          "Ejecutá `.flowtask/skills/alpha-skill/scripts/helper.mjs` antes de continuar.",
        ].join("\n"),
      );

      process.env.CLAUDE_CONFIG_DIR = claudeUserDir;
      materializeClaudeProject({
        projectDir,
        flowtaskDir,
        version: "1.0.0",
        runtimeManifest: { payloadId },
      });

      const content = fs.readFileSync(path.join(projectDir, ".claude", "agents", "flowtask-caller.md"), "utf8");
      assert.equal(content.includes(".flowtask/skills/"), false, "canonical paths must be normalized");

      const payloadFragment = `${path.join("versions", payloadId, "skills")}${path.sep}`;
      const paths = [...content.matchAll(/\x60([^\x60]*[\\/]skills[\\/][^\x60]*)\x60/g)].map((match) => match[1]);
      assert.ok(paths.length >= 2, "the generated agent must embed the skill file and the script");
      for (const embedded of paths) {
        assert.ok(embedded.includes(payloadFragment), `${embedded} does not point inside the active payload`);
        assert.ok(path.isAbsolute(embedded), `${embedded} is not an absolute path`);
        assert.equal(fs.existsSync(embedded), true, `${embedded} does not exist`);
      }
      assert.ok(
        paths.some((embedded) => embedded.includes(`${path.sep}scripts${path.sep}`)),
        "the scripts reference must resolve inside the payload",
      );
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      cleanupDir(root);
    }
  });

  /**
   * gap_ref: C3
   * criterio: una skill declarada inexistente detiene la generación, informa skill y agente
   *   y no escribe agentes parciales.
   * defecto: se generan agentes a medias o se falla en silencio.
   * why_not_detected: no hay test de resolución de skills durante la generación; el bucle
   *   anterior escribía cada agente antes de conocer el resto.
   * comportamiento observable: la generación lanza `claude_agent_skill_unresolved`, el mensaje
   *   nombra la skill y el agente, y el proyecto no recibe ningún agente.
   */
  it("aborts agent generation without partial writes when a declared skill is missing", () => {
    const root = makeTempDir();
    const flowtaskDir = path.join(root, "flowtask");
    const projectDir = path.join(root, "project");
    const skillsDir = path.join(flowtaskDir, "skills");
    try {
      writeSkillFixtures(flowtaskDir, ["ok-skill"]);
      writeAgentBodyFixture(flowtaskDir, "sample", 'skill({ name: "missing-skill" })');
      writeAgentBodyFixture(flowtaskDir, "valid", 'skill({ name: "ok-skill" })');

      assert.throws(
        () => generateClaudeAgents(flowtaskDir, projectDir, { skillsDir }),
        (error) => {
          assert.equal(error.code, "claude_agent_skill_unresolved");
          assert.match(error.message, /skill "missing-skill" declared in agent "sample"/);
          assert.deepEqual(error.problems, [
            {
              skill: "missing-skill",
              path: path.join(skillsDir, "missing-skill", "SKILL.md"),
              reason: "missing",
              agent: "sample",
            },
          ]);
          return true;
        },
      );

      const agentsDir = path.join(projectDir, ".claude", "agents");
      const written = fs.existsSync(agentsDir)
        ? fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"))
        : [];
      assert.deepEqual(written, [], "a failed generation must not leave partial agents");
    } finally {
      cleanupDir(root);
    }
  });

  it("merges the global SessionStart hook once and removes only that hook", () => {
    const root = makeTempDir();
    const settingsPath = path.join(root, "settings.json");
    const runtimeRoot = path.join(root, "flowtask");
    try {
      const userHooks = {
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "echo prompt" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop" }] }],
        StopFailure: [{ matcher: "", hooks: [{ type: "command", command: "echo stop-failure" }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "echo end" }] }],
        Notification: [{ matcher: "", hooks: [{ type: "command", command: "echo notification" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo user-start" }] }],
      };
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: userHooks, mcpServers: { engram: { command: "engram" } }, userKey: true }, null, 2),
        "utf8",
      );
      const before = fs.readFileSync(settingsPath, "utf8");

      const hook = buildSessionStartHook(runtimeRoot, "/usr/bin/node");
      assert.equal(mergeClaudeSettings(settingsPath, { hooks: hook }).changed, true);
      assert.equal(mergeClaudeSettings(settingsPath, { hooks: hook }).changed, false);

      const merged = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const allCommands = Object.values(merged.hooks).flatMap((groups) =>
        groups.flatMap((group) => group.hooks.map((entry) => entry.command)),
      );
      assert.equal(allCommands.filter((command) => command.includes("session-start.mjs")).length, 1);
      assert.equal(allCommands.length, 7, "the six user hooks plus the FlowTask hook are present");
      assert.equal(allCommands.includes("echo user-start"), true);
      assert.deepEqual(merged.mcpServers, { engram: { command: "engram" } });
      assert.equal(merged.userKey, true);

      const flowTaskHook = merged.hooks.SessionStart
        .flatMap((group) => group.hooks)
        .find((entry) => entry.command.includes("session-start.mjs"));
      assert.equal(flowTaskHook.command, `"/usr/bin/node" "${path.join(runtimeRoot, "bin", "session-start.mjs")}"`);
      assert.equal(flowTaskHook.timeout, 10);

      assert.equal(removeClaudeHook(settingsPath, { commandIncludes: path.join(runtimeRoot, "bin", "session-start.mjs") }).changed, true);
      const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const restoredCommands = Object.values(restored.hooks).flatMap((groups) =>
        groups.flatMap((group) => group.hooks.map((entry) => entry.command)),
      );
      assert.equal(restoredCommands.length, 6);
      assert.equal(restoredCommands.includes("echo user-start"), true);
      assert.deepEqual(restored.mcpServers, { engram: { command: "engram" } });
      assert.equal(restored.userKey, true);

      const malformed = path.join(root, "malformed.json");
      fs.writeFileSync(malformed, '{ "hooks": {\n', "utf8");
      const malformedBefore = fs.readFileSync(malformed);
      const result = mergeClaudeSettings(malformed, { hooks: hook });
      assert.equal(result.ok, false);
      assert.deepEqual(fs.readFileSync(malformed), malformedBefore);

      fs.writeFileSync(settingsPath, before, "utf8");
    } finally {
      cleanupDir(root);
    }
  });

  it("registers Engram in the user scope through the CLI and preserves a preexisting entry", () => {
    const root = makeTempDir();
    const claudeUserDir = path.join(root, "claude");
    const stateFile = path.join(claudeUserDir, ".claude.json");
    try {
      fs.mkdirSync(claudeUserDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ installMethod: "native", projects: { abc: {} } }, null, 2), "utf8");
      const stateBefore = fs.readFileSync(stateFile, "utf8");

      let present = false;
      const calls = [];
      const spawn = (bin, args) => {
        calls.push([bin, ...args]);
        if (args[0] === "mcp" && args[1] === "get") {
          return present
            ? { status: 0, stdout: "engram:\n  Scope: user\n", stderr: "" }
            : { status: 1, stdout: "", stderr: "No MCP server named engram" };
        }
        if (args[0] === "mcp" && args[1] === "add") {
          present = true;
          return { status: 0, stdout: "added", stderr: "" };
        }
        if (args[0] === "mcp" && args[1] === "remove") {
          present = false;
          return { status: 0, stdout: "removed", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected" };
      };

      const added = ensureUserEngram({ claudeUserDir, claudeBin: "claude", spawn });
      assert.equal(added.ok, true);
      assert.equal(added.action, "added");
      assert.equal(added.managed, true);
      assert.equal(added.command, "claude mcp add --scope user engram -- engram mcp");
      assert.ok(
        calls.some((args) => args.join(" ") === "claude mcp add --scope user engram -- engram mcp"),
        "the official user-scope command must be used",
      );
      assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore, "the CLI owns ~/.claude.json");

      const again = ensureUserEngram({ claudeUserDir, claudeBin: "claude", spawn });
      assert.equal(again.action, "present");
      assert.equal(again.managed, false, "a preexisting user registration is not owned by FlowTask");
      assert.equal(calls.filter((args) => args[2] === "add").length, 1, "ensure must not duplicate the registration");

      const removed = removeUserEngram({
        claudeUserDir,
        runtimeManifest: { mcp: { engram: { managed: true } } },
        claudeBin: "claude",
        spawn,
      });
      assert.equal(removed.ok, true);
      assert.equal(removed.action, "removed");
      assert.ok(calls.some((args) => args.join(" ") === "claude mcp remove --scope user engram"));

      const preserved = removeUserEngram({
        claudeUserDir,
        runtimeManifest: { mcp: { engram: { managed: false } } },
        claudeBin: "claude",
        spawn,
      });
      assert.equal(preserved.ok, true);
      assert.equal(preserved.action, "preserved");

      const failed = ensureUserEngram({
        claudeUserDir,
        claudeBin: "claude",
        spawn: () => ({ error: new Error("command not found"), status: null, stdout: "", stderr: "" }),
      });
      assert.equal(failed.ok, false);
      assert.match(failed.error, /claude mcp add --scope user engram -- engram mcp/);
      assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
    } finally {
      cleanupDir(root);
    }
  });
});

describe("Claude web search exclusion", () => {
  /*
   * gap_ref: C2
   * criterio: target Claude Code no ofrece ni configura búsqueda; ninguna
   *   superficie de Claude contiene ferris-search.
   * defecto: un cambio futuro podría volver a escribir ferris-search en
   *   .mcp.json o ~/.claude.json sin que ninguna prueba lo detecte.
   * why_not_detected: no había test que afirmara la ausencia de ferris-search
   *   en las superficies de Claude; solo se verificaba mcpServers con engram.
   * comportamiento observable: tras instalar el target Claude, el template
   *   canónico, el .mcp.json del proyecto, el estado de usuario y los settings
   *   de usuario conservan solo sus servidores previos y no aparece
   *   ferris-search ni una configuración global de OpenCode.
   */
  it("keeps ferris-search out of every Claude MCP surface", () => {
    const root = makeTempDir();
    const projectDir = path.join(root, "project");
    const claudeUserDir = path.join(root, "claude-user");
    const homeDir = path.join(root, "home");
    const binDir = path.join(root, "bin");
    const statePath = path.join(claudeUserDir, ".fake-claude-state");
    const userStatePath = path.join(claudeUserDir, ".claude.json");
    const settingsPath = path.join(claudeUserDir, "settings.json");
    const projectMcpPath = path.join(projectDir, ".mcp.json");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(claudeUserDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    fs.writeFileSync(projectMcpPath, JSON.stringify({
      mcpServers: { external: { type: "stdio", command: "external" } },
      userOwned: true,
    }, null, 2), "utf8");
    const projectMcpBefore = fs.readFileSync(projectMcpPath, "utf8");

    fs.writeFileSync(userStatePath, JSON.stringify({
      installMethod: "native",
      projects: { "/existing/project": { allowedTools: [] } },
      mcpServers: { existing: { type: "stdio", command: "existing" } },
    }, null, 2), "utf8");
    const userStateBefore = fs.readFileSync(userStatePath, "utf8");

    fs.writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { existing: { type: "stdio", command: "existing" } },
      userKey: true,
    }, null, 2), "utf8");

    fs.writeFileSync(path.join(binDir, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = process.env.FAKE_CLAUDE_STATE;
if (args[0] === "mcp" && args[1] === "get" && args[2] === "engram") {
  if (fs.existsSync(state)) { process.stdout.write("engram:\\n  Scope: user\\n"); process.exit(0); }
  process.stderr.write("No MCP server named engram\\n");
  process.exit(1);
}
if (args[0] === "mcp" && args[1] === "add") {
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, "present");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

    const previous = {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE,
    };
    process.env.CLAUDE_CONFIG_DIR = claudeUserDir;
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
    process.env.HOME = homeDir;
    process.env.FAKE_CLAUDE_STATE = statePath;

    try {
      installClaudeTarget({ flowtaskDir: FLOWTASK_SOURCE, projectDir });

      const template = JSON.parse(
        fs.readFileSync(path.join(FLOWTASK_SOURCE, "claude", "mcp.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(template.mcpServers ?? {}), ["engram"]);
      assert.equal(Object.hasOwn(template.mcpServers ?? {}, "ferris-search"), false);

      const projectMcp = JSON.parse(fs.readFileSync(projectMcpPath, "utf8"));
      assert.deepEqual(projectMcp.mcpServers, { external: { type: "stdio", command: "external" } });
      assert.equal(Object.hasOwn(projectMcp.mcpServers ?? {}, "ferris-search"), false);
      assert.equal(fs.readFileSync(projectMcpPath, "utf8"), projectMcpBefore);

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.deepEqual(settings.mcpServers, { existing: { type: "stdio", command: "existing" } });
      assert.equal(Object.hasOwn(settings.mcpServers ?? {}, "ferris-search"), false);
      assert.equal(settings.userKey, true);

      assert.equal(fs.readFileSync(userStatePath, "utf8"), userStateBefore);
      const userState = JSON.parse(fs.readFileSync(userStatePath, "utf8"));
      assert.equal(Object.hasOwn(userState.mcpServers ?? {}, "ferris-search"), false);

      assert.equal(
        fs.existsSync(path.join(homeDir, ".config", "opencode", "opencode.json")),
        false,
        "a Claude-only installation must not create the OpenCode global configuration",
      );
    } finally {
      if (previous.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous.CLAUDE_CONFIG_DIR;
      if (previous.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = previous.PATH;
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.FAKE_CLAUDE_STATE === undefined) delete process.env.FAKE_CLAUDE_STATE;
      else process.env.FAKE_CLAUDE_STATE = previous.FAKE_CLAUDE_STATE;
      cleanupDir(root);
    }
  });
});
