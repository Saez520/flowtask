import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { generateClaudeMd } from "../lib/claude.js";
import { injectPersonaIntoRunnerContent } from "../lib/installer.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claude-installer-test-"));
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
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
      const runner = "---\nname: runner\n---\n<!-- FLOWTASK:PERSONA_START -->\nPersona de prueba\n<!-- FLOWTASK:PERSONA_END -->\n\n# Runner";
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), "---\nname: runner\n---\nrunner canónico", "utf8");

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
      fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), "---\nname: runner\n---\nrunner canónico", "utf8");

      assert.doesNotThrow(() => generateClaudeMd(flowtaskDir, projectDir));
      assert.equal(fs.existsSync(path.join(projectDir, ".claude", "flowtask", "agents", "runner.md")), false);
      assert.match(fs.readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8"), /runner canónico/);
    } finally {
      cleanupDir(projectDir);
      cleanupDir(flowtaskDir);
    }
  });
});
