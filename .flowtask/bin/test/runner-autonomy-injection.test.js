import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureTargetLayers,
  injectAutonomyIntoRunner,
  injectAutonomyIntoRunnerContent,
  injectPersonaIntoRunnerContent,
  syncTargetConfig,
} from "../lib/installer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNNER_PATH = path.join(ROOT, ".flowtask", "agents", "runner.md");

const PERSONA_START = "<!-- FLOWTASK:PERSONA_START -->";
const PERSONA_END = "<!-- FLOWTASK:PERSONA_END -->";
const AUTONOMY_START = "<!-- FLOWTASK:AUTONOMY_START -->";
const AUTONOMY_END = "<!-- FLOWTASK:AUTONOMY_END -->";

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readRunner() {
  return fs.readFileSync(RUNNER_PATH, "utf8");
}

function blockBetween(content, start, end) {
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  assert.notEqual(startIdx, -1, `missing marker ${start}`);
  assert.notEqual(endIdx, -1, `missing marker ${end}`);
  return content.slice(startIdx + start.length, endIdx);
}

function createTarget(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-autonomy-"));
  fixtures.push(root);
  const targetDir = path.join(root, ".opencode", "flowtask");
  fs.mkdirSync(path.join(targetDir, "config"), { recursive: true });
  fs.mkdirSync(path.join(targetDir, "agents"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(targetDir, "config", name),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
      "utf8",
    );
  }
  return { root, targetDir };
}

function createFlowtaskDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-autonomy-source-"));
  fixtures.push(root);
  const flowtaskDir = path.join(root, ".flowtask");
  fs.mkdirSync(path.join(flowtaskDir, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(flowtaskDir, "config", "review.json"),
    JSON.stringify({ enabled: true, stampPath: ".flowtask/config/.review-stamp" }, null, 2),
    "utf8",
  );
  return { root, flowtaskDir };
}

function createConfigSource(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-team-layers-"));
  fixtures.push(root);
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(configDir, name),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
      "utf8",
    );
  }
  return configDir;
}

describe("runner del repositorio — capa de autonomia", () => {
  it("publishes the autonomy markers and the static section", () => {
    const runner = readRunner();
    assert.ok(runner.includes(AUTONOMY_START), "missing the autonomy start marker");
    assert.ok(runner.includes(AUTONOMY_END), "missing the autonomy end marker");
    assert.ok(runner.includes("## Capa de autonomía"), "missing the autonomy section");
    for (const profile of ["assistant", "autonomous-dev"]) {
      assert.ok(runner.includes(`\`${profile}\``), `missing autonomy profile ${profile}`);
    }
    assert.ok(
      runner.includes("`permisos > autonomía > persona`"),
      "missing the structural precedence",
    );
    assert.ok(
      runner.includes("NUNCA amplíes el sobre de permisos por la autonomía vigente"),
      "missing the rule that the autonomy never widens the envelope",
    );
    assert.match(runner, /`assistant` \| No inicia ejecución autónoma/);
    assert.match(runner, /`autonomous-dev` \| Ejecuta el loop completo bajo gates, auditoría, validación y permisos/);
    assert.ok(runner.includes("`progress_unavailable`"), "missing the pause for an empty or invalid autonomy block");
  });
});

describe("inyeccion de autonomia en el runner", () => {
  it("replaces only the content between the autonomy markers", () => {
    const runner = readRunner();

    const injected = injectAutonomyIntoRunnerContent(runner, { profile: "autonomous-dev", source: "project" });

    assert.equal(
      blockBetween(injected, AUTONOMY_START, AUTONOMY_END).trim(),
      "Current autonomy: autonomous-dev (source: project).",
    );
    assert.equal(
      injected.slice(0, injected.indexOf(AUTONOMY_START)),
      runner.slice(0, runner.indexOf(AUTONOMY_START)),
    );
    assert.equal(
      injected.slice(injected.indexOf(AUTONOMY_END)),
      runner.slice(runner.indexOf(AUTONOMY_END)),
    );
  });

  it("fails when the autonomy markers are absent", () => {
    const runner = readRunner().split("\n").filter((line) => !line.includes("FLOWTASK:AUTONOMY_")).join("\n");

    assert.throws(
      () => injectAutonomyIntoRunnerContent(runner, { profile: "autonomous-dev", source: "project" }),
      (error) => {
        assert.equal(error.code, "autonomy_markers_missing");
        assert.match(error.message, /FLOWTASK:AUTONOMY_START/);
        assert.match(error.message, /FLOWTASK:AUTONOMY_END/);
        return true;
      },
    );
  });

  it("fails when the descriptor is invalid", () => {
    const runner = readRunner();

    for (const descriptor of [
      { profile: "root", source: "project" },
      { profile: "autonomous-dev", source: "nowhere" },
      { profile: "autonomous-dev" },
      null,
    ]) {
      assert.throws(
        () => injectAutonomyIntoRunnerContent(runner, descriptor),
        (error) => {
          assert.equal(error.code, "autonomy_descriptor_invalid");
          assert.match(error.message, /invalid autonomy descriptor/);
          return true;
        },
      );
    }
  });

  it("writes the injected value in the target runner", () => {
    const { targetDir } = createTarget();
    fs.writeFileSync(path.join(targetDir, "agents", "runner.md"), readRunner(), "utf8");

    injectAutonomyIntoRunner(targetDir, { profile: "assistant", source: "team" });

    const written = fs.readFileSync(path.join(targetDir, "agents", "runner.md"), "utf8");
    assert.equal(
      blockBetween(written, AUTONOMY_START, AUTONOMY_END).trim(),
      "Current autonomy: assistant (source: team).",
    );
  });

  it("fails when the target runner is missing", () => {
    const { targetDir } = createTarget();

    assert.throws(
      () => injectAutonomyIntoRunner(targetDir, { profile: "assistant", source: "team" }),
      (error) => {
        assert.equal(error.code, "autonomy_runner_missing");
        assert.match(error.message, /runner\.md not found/);
        return true;
      },
    );
  });
});

describe("convivencia de los bloques de persona y autonomia", () => {
  it("clears the persona block without touching the autonomy block", () => {
    const runner = readRunner();
    const withPersona = injectPersonaIntoRunnerContent(runner, "Personalidad de prueba");
    assert.match(withPersona, /Personalidad de prueba/);

    const cleared = injectPersonaIntoRunnerContent(withPersona, null);

    assert.equal(blockBetween(cleared, PERSONA_START, PERSONA_END).trim(), "");
    assert.equal(
      blockBetween(cleared, AUTONOMY_START, AUTONOMY_END).trim(),
      blockBetween(withPersona, AUTONOMY_START, AUTONOMY_END).trim(),
    );
  });

  it("leaves the persona block untouched when the content is undefined", () => {
    const runner = readRunner();
    const withPersona = injectPersonaIntoRunnerContent(runner, "Personalidad de prueba");

    assert.equal(injectPersonaIntoRunnerContent(withPersona, undefined), withPersona);
  });

  it("does not alter the persona block when the autonomy is injected", () => {
    const runner = readRunner();
    const withPersona = injectPersonaIntoRunnerContent(runner, "Personalidad de prueba");

    const injected = injectAutonomyIntoRunnerContent(withPersona, { profile: "assistant", source: "project" });

    assert.equal(blockBetween(injected, PERSONA_START, PERSONA_END), blockBetween(withPersona, PERSONA_START, PERSONA_END));
  });
});

describe("migracion y sincronizacion de capas", () => {
  it("creates the absent layers with the migration defaults", () => {
    const { targetDir } = createTarget({
      "profile.json": { level: "senior", persona: "tutor-senior", onboarded: true },
    });

    const { resolution, created } = ensureTargetLayers(targetDir);

    assert.deepEqual(created, ["autonomy", "permissions"]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "assistant" },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "permissions.json"), "utf8")),
      { version: 1, envelope: "standard" },
    );
    assert.equal(resolution.layers.autonomy.status, "valid");
    assert.equal(resolution.layers.permissions.status, "valid");
  });

  it("does not repair an invalid layer and keeps the file untouched", () => {
    const { targetDir } = createTarget({
      "autonomy.json": { version: 1, profile: "root" },
    });

    assert.throws(
      () => ensureTargetLayers(targetDir),
      (error) => {
        assert.equal(error.code, "autonomy_invalid");
        assert.match(error.message, /\[FlowTask Layers\] autonomy layer missing or invalid\./);
        return true;
      },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "root" },
    );
    assert.equal(fs.existsSync(path.join(targetDir, "config", "permissions.json")), false);
  });

  it("preserves a valid layer and does not rewrite it", () => {
    const { targetDir } = createTarget({
      "autonomy.json": { version: 1, profile: "assistant" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const { created } = ensureTargetLayers(targetDir);

    assert.deepEqual(created, []);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "assistant" },
    );
  });

  it("applies an explicit autonomy choice over a valid layer only when replacing", () => {
    const { targetDir } = createTarget({
      "autonomy.json": { version: 1, profile: "assistant" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const preserved = ensureTargetLayers(targetDir, { autonomyProfile: "autonomous-dev" });

    assert.deepEqual(preserved.updated, []);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")).profile,
      "assistant",
    );

    const replaced = ensureTargetLayers(targetDir, {
      autonomyProfile: "autonomous-dev",
      replaceAutonomy: true,
    });

    assert.deepEqual(replaced.updated, ["autonomy"]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")).profile,
      "autonomous-dev",
    );
    assert.equal(replaced.resolution.layers.autonomy.value.profile, "autonomous-dev");
  });

  it("keeps three targets independent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-autonomy-targets-"));
    fixtures.push(root);
    const targets = [
      [".opencode/flowtask", "assistant"],
      [".claude/flowtask", "autonomous-dev"],
      [".vscode/flowtask", "assistant"],
    ];

    for (const [subDir, profile] of targets) {
      const targetDir = path.join(root, subDir);
      fs.mkdirSync(path.join(targetDir, "config"), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "config", "autonomy.json"),
        JSON.stringify({ version: 1, profile }, null, 2),
        "utf8",
      );
      ensureTargetLayers(targetDir);
    }

    for (const [subDir, profile] of targets) {
      const written = JSON.parse(
        fs.readFileSync(path.join(root, subDir, "config", "autonomy.json"), "utf8"),
      );
      assert.equal(written.profile, profile);
    }
  });

  it("creates the layers of a target without touching the persona profile", () => {
    const { flowtaskDir } = createFlowtaskDir();
    fs.mkdirSync(path.join(flowtaskDir, "personas"), { recursive: true });
    fs.writeFileSync(path.join(flowtaskDir, "personas", "tutor-senior.md"), "# tutor-senior\n", "utf8");
    const { targetDir } = createTarget({
      "profile.json": { level: "senior", persona: "tutor-senior", onboarded: true },
    });

    const result = syncTargetConfig(flowtaskDir, targetDir, { level: "senior", persona: "tutor-senior", onboarded: true });

    assert.equal(result.persona, "valid");
    assert.equal(result.autonomy.status, "valid");
    assert.equal(result.permissions.status, "valid");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "profile.json"), "utf8")),
      { level: "senior", persona: "tutor-senior", onboarded: true },
    );
  });

  it("keeps an invalid persona profile without altering the layers", () => {
    const { flowtaskDir } = createFlowtaskDir();
    const { targetDir } = createTarget({
      "profile.json": { level: "senior" },
      "autonomy.json": { version: 1, profile: "assistant" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const result = syncTargetConfig(
      flowtaskDir,
      targetDir,
      { level: "mid", persona: "tutor-mid", onboarded: true },
      { preserveProfile: true },
    );

    assert.equal(result.persona, "invalid");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "profile.json"), "utf8")),
      { level: "senior" },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "assistant" },
    );
    assert.equal(result.autonomy.status, "valid");
    assert.equal(result.permissions.status, "valid");
  });

  it("fails the target when a layer is invalid and keeps the file untouched", () => {
    const { flowtaskDir } = createFlowtaskDir();
    const { targetDir } = createTarget({
      "autonomy.json": { version: 1, profile: "root" },
    });

    assert.throws(
      () => syncTargetConfig(flowtaskDir, targetDir, { level: "senior", persona: "tutor-senior", onboarded: true }),
      (error) => {
        assert.equal(error.code, "autonomy_invalid");
        return true;
      },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "root" },
    );
  });
});

describe("base de equipo y override por proyecto en el instalador", () => {
  const TEAM_LAYERS = {
    "autonomy.json": { version: 1, profile: "assistant" },
    "permissions.json": { version: 1, envelope: "standard" },
  };

  it("uses the team base for the layers the project does not override", () => {
    const { targetDir } = createTarget();
    const teamConfigDir = createConfigSource(TEAM_LAYERS);

    const { resolution, created } = ensureTargetLayers(targetDir, { teamConfigDir });

    assert.deepEqual(created, []);
    assert.equal(resolution.layers.autonomy.status, "valid");
    assert.equal(resolution.layers.autonomy.value.profile, "assistant");
    assert.equal(resolution.layers.autonomy.source, "team");
    assert.equal(resolution.layers.permissions.value.envelope, "standard");
    assert.equal(resolution.layers.permissions.source, "team");
    assert.equal(fs.existsSync(path.join(targetDir, "config", "autonomy.json")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "config", "permissions.json")), false);
  });

  it("applies the project override per layer over the team base", () => {
    const { targetDir } = createTarget({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
    });
    const teamConfigDir = createConfigSource(TEAM_LAYERS);

    const { resolution, created } = ensureTargetLayers(targetDir, { teamConfigDir });

    assert.deepEqual(created, []);
    assert.equal(resolution.layers.autonomy.value.profile, "autonomous-dev");
    assert.equal(resolution.layers.autonomy.source, "project");
    assert.equal(resolution.layers.permissions.value.envelope, "standard");
    assert.equal(resolution.layers.permissions.source, "team");
  });

  it("migrates only the layer absent from both sources", () => {
    const { targetDir } = createTarget();
    const teamConfigDir = createConfigSource({
      "autonomy.json": { version: 1, profile: "assistant" },
    });

    const { resolution, created } = ensureTargetLayers(targetDir, { teamConfigDir });

    assert.deepEqual(created, ["permissions"]);
    assert.equal(resolution.layers.autonomy.source, "team");
    assert.equal(resolution.layers.autonomy.value.profile, "assistant");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "permissions.json"), "utf8")),
      { version: 1, envelope: "standard" },
    );
    assert.equal(fs.existsSync(path.join(targetDir, "config", "autonomy.json")), false);
  });

  it("fails without writing defaults when the team layer is invalid", () => {
    const { targetDir } = createTarget();
    const teamConfigDir = createConfigSource({
      "autonomy.json": { version: 1, profile: "root" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    assert.throws(
      () => ensureTargetLayers(targetDir, { teamConfigDir }),
      (error) => {
        assert.equal(error.code, "autonomy_invalid");
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(targetDir, "config", "autonomy.json")), false);
    assert.equal(fs.existsSync(path.join(targetDir, "config", "permissions.json")), false);
  });

  it("changing only the persona leaves the autonomy and permissions untouched", () => {
    const { flowtaskDir } = createFlowtaskDir();
    const { targetDir } = createTarget({
      "profile.json": { level: "senior", persona: "tutor-senior", onboarded: true },
      "autonomy.json": { version: 1, profile: "assistant" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const result = syncTargetConfig(
      flowtaskDir,
      targetDir,
      { level: "mid", persona: "tutor-mid", onboarded: true },
      { explicitPersona: true },
    );

    assert.equal(result.persona, "valid");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "profile.json"), "utf8")),
      {
        level: "mid",
        persona: "tutor-mid",
        onboarded: true,
        quiz_completed_at: null,
        stack_snapshot: null,
        quiz_answers: [],
      },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "autonomy.json"), "utf8")),
      { version: 1, profile: "assistant" },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(targetDir, "config", "permissions.json"), "utf8")),
      { version: 1, envelope: "standard" },
    );
  });
});

describe("orden de instalacion de las capas", () => {
  it("resolves the layers before installing the plugin and injecting the autonomy", () => {
    const source = fs.readFileSync(path.join(ROOT, ".flowtask", "bin", "lib", "installer.js"), "utf8");

    for (const [name, nextName] of [["install", "update"], ["update", null]]) {
      const start = source.indexOf(`export async function ${name}(`);
      assert.notEqual(start, -1, `missing ${name}()`);
      const end = nextName ? source.indexOf(`export async function ${nextName}(`, start) : source.length;
      assert.notEqual(end, -1, `missing ${nextName}()`);
      const body = source.slice(start, end);

      const layersIndex = body.indexOf("syncTargetConfig(");
      const pluginIndex = body.indexOf("installManifestPlugins(");
      const injectionIndex = body.indexOf("injectAutonomyIntoRunner(");

      assert.notEqual(layersIndex, -1, `${name} must synchronize the layers`);
      assert.notEqual(pluginIndex, -1, `${name} must install the plugin`);
      assert.notEqual(injectionIndex, -1, `${name} must inject the autonomy`);
      assert.ok(layersIndex < pluginIndex, `${name} must resolve the layers before installing the plugin`);
      assert.ok(pluginIndex < injectionIndex, `${name} must install the plugin before injecting the autonomy`);
    }
  });
});
