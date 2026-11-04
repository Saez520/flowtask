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
import { ensureUserEngram, removeUserEngram } from "../lib/claude-mcp.js";

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
