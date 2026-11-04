import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import {
  buildSkillIndex,
  extractSkillReferences,
  generateClaudeAgents,
  generateClaudeMd,
  generateClaudeSessionStart,
  mergeClaudeMcpConfig,
  mergeClaudeSettings,
  resolveClaudePaths,
} from "../lib/claude.js";
import { injectPersonaIntoRunnerContent } from "../lib/installer.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");
const REAL_RUNNER_PATH = path.join(FLOWTASK_SOURCE, "agents", "runner.md");
const REAL_SETTINGS_TEMPLATE = path.join(FLOWTASK_SOURCE, "claude", "settings.json");
const REAL_MCP_TEMPLATE = path.join(FLOWTASK_SOURCE, "claude", "mcp.json");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-installer-test-"));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSkillFixtures(projectDir, names) {
  for (const name of names) {
    const dir = path.join(projectDir, ".claude", "flowtask", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  }
}

function writeDeclaredSkillFixtures(projectDir) {
  const references = extractSkillReferences(fs.readFileSync(REAL_RUNNER_PATH, "utf8"));
  writeSkillFixtures(projectDir, references);
  return references;
}

function makeFlowtaskDir() {
  const flowtaskDir = makeTempDir();
  fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(flowtaskDir, "claude"), { recursive: true });
  fs.copyFileSync(REAL_RUNNER_PATH, path.join(flowtaskDir, "agents", "runner.md"));
  fs.copyFileSync(REAL_SETTINGS_TEMPLATE, path.join(flowtaskDir, "claude", "settings.json"));
  fs.copyFileSync(REAL_MCP_TEMPLATE, path.join(flowtaskDir, "claude", "mcp.json"));
  return flowtaskDir;
}

function minimalRunner(body = "runner canónico") {
  return [
    "---",
    "name: runner",
    "---",
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

describe("Claude installer runner", () => {
  it("injects persona into runner content without writing a file", () => {
    const runner = "---\nname: runner\n---\n<!-- FLOWTASK:PERSONA_START -->\n<!-- FLOWTASK:PERSONA_END -->\nrest";
    const persona = "Habla con claridad y brevedad.";

    const transformed = injectPersonaIntoRunnerContent(runner, persona);

    assert.match(transformed, /PERSONA_START -->\nHabla con claridad y brevedad\.\n<!-- FLOWTASK:PERSONA_END/);
    assert.equal(runner.includes(persona), false);
  });

  it("keeps the original runner when persona markers are incomplete", () => {
    const runner = "---\nname: runner\n---\n<!-- FLOWTASK:PERSONA_START -->\nrest";

    assert.equal(injectPersonaIntoRunnerContent(runner, "persona"), runner);
  });

  it("generates CLAUDE.md from the in-memory runnerBodyOverride", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeTempDir();
    try {
      const runner = minimalRunner("<!-- FLOWTASK:PERSONA_START -->\nPersona de prueba\n<!-- FLOWTASK:PERSONA_END -->\n\n# Runner");
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), minimalRunner("runner canónico"), "utf8");
      writeSkillFixtures(projectDir, ["investigacion", "memory-protocol", "zero-assumptions"]);

      generateClaudeMd(flowtaskDir, projectDir, runner);

      const claudeMd = fs.readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8");
      assert.match(claudeMd, /Persona de prueba/);
      assert.equal(fs.existsSync(path.join(projectDir, ".claude", "flowtask", "agents", "runner.md")), false);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("uses the canonical source without reading a target runner", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeTempDir();
    try {
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), minimalRunner(), "utf8");
      writeSkillFixtures(projectDir, ["investigacion", "memory-protocol", "zero-assumptions"]);

      assert.doesNotThrow(() => generateClaudeMd(flowtaskDir, projectDir));
      assert.equal(fs.existsSync(path.join(projectDir, ".claude", "flowtask", "agents", "runner.md")), false);
      assert.match(fs.readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8"), /runner canónico/);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });
});

describe("Claude Code startup contract", () => {
  it("AC-1: generated CLAUDE.md carries the startup block in its first lines", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeTempDir();
    try {
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.copyFileSync(REAL_RUNNER_PATH, path.join(flowtaskDir, "agents", "runner.md"));
      writeDeclaredSkillFixtures(projectDir);

      generateClaudeMd(flowtaskDir, projectDir);

      const header = fs.readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8").split("\n").slice(0, 30).join("\n");
      assert.match(header, /ToolSearch/);
      assert.match(header, /mem_context/);
      for (const skill of ["investigacion", "memory-protocol", "zero-assumptions"]) {
        assert.ok(
          header.includes(`.claude/flowtask/skills/${skill}/SKILL.md`),
          `startup block must read ${skill}`,
        );
      }
      assert.ok(header.includes("[capa: orquestador] {base_name}"), "startup block must declare the identity line");
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("AC-2: the index covers the skills declared in runner.md and is generated from that section", () => {
    const declared = extractSkillReferences(fs.readFileSync(REAL_RUNNER_PATH, "utf8"));
    assert.equal(declared.length, 13);
    assert.equal(new Set(declared).size, 13);

    const projectDir = makeTempDir();
    try {
      writeSkillFixtures(projectDir, ["alpha-skill", "beta-skill"]);
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

      const index = buildSkillIndex(customRunner, resolveClaudePaths(projectDir));

      assert.ok(index.includes("alpha-skill"));
      assert.ok(index.includes("beta-skill"));
      assert.equal(index.includes("investigacion"), false, "index must not be hardcoded");
    } finally {
      cleanupDir(projectDir);
    }
  });

  it("AC-2: a referenced skill that is not installed fails with a readable error", () => {
    const projectDir = makeTempDir();
    try {
      assert.throws(
        () => buildSkillIndex(minimalRunner(), resolveClaudePaths(projectDir)),
        /not installed.*investigacion, memory-protocol, zero-assumptions/s,
      );
    } finally {
      cleanupDir(projectDir);
    }
  });

  it("AC-3: session-start.md exists and settings register the SessionStart hook that reads it", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeFlowtaskDir();
    try {
      writeDeclaredSkillFixtures(projectDir);

      generateClaudeSessionStart(flowtaskDir, projectDir);

      const sessionStart = fs.readFileSync(path.join(projectDir, ".claude", "session-start.md"), "utf8");
      assert.match(sessionStart, /# FlowTask session start/);
      assert.match(sessionStart, /ToolSearch/);
      assert.match(sessionStart, /\[capa: orquestador\] \{base_name\}/);

      const settingsPath = path.join(projectDir, ".claude", "settings.json");
      const result = mergeClaudeSettings(settingsPath, flowtaskDir);
      assert.equal(result.ok, true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const flowTaskGroup = settings.hooks.SessionStart.find((group) =>
        group.hooks.some((hook) => hook.command.includes("session-start.md")),
      );
      assert.ok(flowTaskGroup, "settings must register the FlowTask SessionStart hook");
      assert.equal(flowTaskGroup.matcher, "^(startup|resume|clear|compact|fork)$");
      const flowTaskHook = flowTaskGroup.hooks.find((hook) => hook.command.includes("session-start.md"));
      assert.match(flowTaskHook.command, /\$CLAUDE_PROJECT_DIR/);
      assert.match(flowTaskHook.command, /session-start\.md/);
      assert.equal(flowTaskHook.timeout, 10);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("AC-4: two merges leave one FlowTask hook and preserve user hooks", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeFlowtaskDir();
    try {
      const settingsPath = path.join(projectDir, ".claude", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo user-hook" }] }],
            Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop-hook" }] }],
          },
          userSetting: true,
        }, null, 2),
        "utf8",
      );

      assert.equal(mergeClaudeSettings(settingsPath, flowtaskDir).ok, true);
      assert.equal(mergeClaudeSettings(settingsPath, flowtaskDir).ok, true);

      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const sessionCommands = settings.hooks.SessionStart.flatMap((group) => group.hooks).map((hook) => hook.command);
      assert.equal(sessionCommands.filter((command) => command.includes("session-start.md")).length, 1);
      assert.ok(sessionCommands.includes("echo user-hook"));
      assert.deepEqual(settings.hooks.Stop, [{ matcher: "", hooks: [{ type: "command", command: "echo stop-hook" }] }]);
      assert.equal(settings.userSetting, true);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("AC-5: a malformed settings.json stays byte-identical", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeFlowtaskDir();
    try {
      const settingsPath = path.join(projectDir, ".claude", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{\n  "hooks": {\n', "utf8");
      const before = fs.readFileSync(settingsPath);

      const result = mergeClaudeSettings(settingsPath, flowtaskDir);

      assert.equal(result.ok, false);
      assert.match(result.error, /not valid JSON/);
      assert.deepEqual(fs.readFileSync(settingsPath), before);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("AC-5: a malformed .mcp.json stays byte-identical", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeFlowtaskDir();
    try {
      const mcpPath = path.join(projectDir, ".mcp.json");
      fs.writeFileSync(mcpPath, "not json at all", "utf8");
      const before = fs.readFileSync(mcpPath);

      const result = mergeClaudeMcpConfig(mcpPath, flowtaskDir);

      assert.equal(result.ok, false);
      assert.match(result.error, /not valid JSON/);
      assert.deepEqual(fs.readFileSync(mcpPath), before);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });

  it("AC-6: generated agents never contain a model field", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = makeTempDir();
    try {
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(flowtaskDir, "agents", "sample.md"),
        ["---", "name: sample", "description: Sample agent.", 'model: "OpenCode Go/glm-5.3"', "---", "", "Body."].join("\n"),
        "utf8",
      );

      generateClaudeAgents(flowtaskDir, projectDir);

      const generated = fs.readFileSync(path.join(projectDir, ".claude", "agents", "flowtask-sample.md"), "utf8");
      assert.doesNotMatch(generated, /^model:/m);

      const realProjectDir = makeTempDir();
      try {
        generateClaudeAgents(FLOWTASK_SOURCE, realProjectDir);
        const agentsDir = path.join(realProjectDir, ".claude", "agents");
        for (const file of fs.readdirSync(agentsDir)) {
          assert.doesNotMatch(fs.readFileSync(path.join(agentsDir, file), "utf8"), /^model:/m, file);
        }
      } finally {
        cleanupDir(realProjectDir);
      }
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });
});
