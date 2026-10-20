import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, ".flowtask", "bin", "flowtask.js");

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(configs = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-layers-cli-"));
  fixtures.push(root);
  for (const [relative, files] of Object.entries(configs)) {
    const configDir = path.join(root, relative);
    fs.mkdirSync(configDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(
        path.join(configDir, name),
        typeof content === "string" ? content : JSON.stringify(content, null, 2),
        "utf8",
      );
    }
  }
  return root;
}

function runLayers(root, args) {
  return spawnSync(process.execPath, [CLI, "layers", "resolve", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
}

const VALID_LAYERS = {
  "profile.json": { level: "senior", persona: "tutor-senior", onboarded: true },
  "autonomy.json": { version: 1, profile: "autonomous-dev" },
  "permissions.json": { version: 1, envelope: "standard" },
};

describe("flowtask layers resolve", () => {
  it("shows the resolved layers of a valid project", () => {
    const root = createProject({ ".opencode/flowtask/config": VALID_LAYERS });

    const result = runLayers(root, ["--target", "opencode"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Target: opencode/);
    assert.match(result.stdout, /Persona: tutor-senior \[project\]/);
    assert.match(result.stdout, /Autonomía: autonomous-dev \[project\]/);
    assert.match(result.stdout, /Permisos: standard \[project\]/);
    assert.match(result.stdout, /Precedencia: permisos > autonomía > persona/);
  });

  it("fails with the operational message when the permissions layer is absent", () => {
    const root = createProject({
      ".opencode/flowtask/config": {
        "profile.json": VALID_LAYERS["profile.json"],
        "autonomy.json": VALID_LAYERS["autonomy.json"],
      },
    });

    const result = runLayers(root, ["--target", "opencode"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /\[FlowTask Layers\] Capa de permisos ausente o inválida\./);
    assert.match(result.stderr, /Causa: /);
    assert.match(result.stderr, /Acción: definí "envelope": "standard"/);
  });

  it("fails with the operational message when the autonomy layer is invalid", () => {
    const root = createProject({
      ".opencode/flowtask/config": {
        "profile.json": VALID_LAYERS["profile.json"],
        "autonomy.json": { version: 1, profile: "root" },
        "permissions.json": VALID_LAYERS["permissions.json"],
      },
    });

    const result = runLayers(root, ["--target", "opencode"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /\[FlowTask Layers\] Capa de autonomía ausente o inválida\./);
    assert.match(result.stderr, /perfil de autonomía desconocido: "root"/);
  });

  it("publishes the resolved layers as JSON", () => {
    const root = createProject({ ".opencode/flowtask/config": VALID_LAYERS });

    const result = runLayers(root, ["--target", "opencode", "--json"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.target, "opencode");
    assert.equal(payload.layers.permissions.value.envelope, "standard");
    assert.equal(payload.layers.autonomy.value.profile, "autonomous-dev");
    assert.equal(payload.layers.persona.status, "valid");
    assert.equal(payload.layers.permissions.source, "project");
    assert.deepEqual(payload.precedence, ["permissions", "autonomy", "persona"]);
  });

  it("detects the target when none is declared", () => {
    const root = createProject({
      ".claude/flowtask/config": VALID_LAYERS,
    });

    const result = runLayers(root, []);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Target: claude/);
  });

  it("fails when the project has no layers configuration", () => {
    const root = createProject({});

    const result = runLayers(root, []);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[FlowTask Layers\] No se encontró una configuración de capas en el proyecto actual\./);
  });

  it("fails when the declared target does not exist", () => {
    const root = createProject({});

    const result = runLayers(root, ["--target", "vscode"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /No se encontró una configuración de capas/);
  });

  it("fails with a usage error on an unknown target", () => {
    const root = createProject({ ".opencode/flowtask/config": VALID_LAYERS });

    const result = runLayers(root, ["--target", "emacs"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--target debe ser uno de: opencode, claude, vscode, standalone/);
  });

  it("fails with a usage error on an unknown subcommand", () => {
    const root = createProject({ ".opencode/flowtask/config": VALID_LAYERS });

    const result = spawnSync(process.execPath, [CLI, "layers", "inspect"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[FlowTask Layers\] Subcomando desconocido: inspect/);
  });

  it("publishes the command in the help message", () => {
    const result = spawnSync(process.execPath, [CLI, "--help"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60000,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /flowtask layers resolve --target <opencode\|claude\|vscode\|standalone>/);
    assert.match(result.stdout, /flowtask layers resolve --json/);
  });

  it("warns about an invalid persona without failing", () => {
    const root = createProject({
      ".opencode/flowtask/config": {
        "profile.json": { level: "senior" },
        "autonomy.json": VALID_LAYERS["autonomy.json"],
        "permissions.json": VALID_LAYERS["permissions.json"],
      },
    });

    const result = runLayers(root, ["--target", "opencode"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Persona: inválida \[project\]/);
    assert.match(result.stdout, /Aviso: /);
  });

  it("resolves the standalone target from the root config directory", () => {
    const root = createProject({ ".flowtask/config": VALID_LAYERS });

    const result = runLayers(root, ["--target", "standalone"]);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Target: standalone/);
    assert.match(result.stdout, /Autonomía: autonomous-dev \[project\]/);
    assert.match(result.stdout, /Permisos: standard \[project\]/);
  });

  it("prefers opencode when several targets declare a configuration", () => {
    const root = createProject({
      ".opencode/flowtask/config": {
        ...VALID_LAYERS,
        "autonomy.json": { version: 1, profile: "assistant" },
      },
      ".claude/flowtask/config": VALID_LAYERS,
      ".vscode/flowtask/config": VALID_LAYERS,
      ".flowtask/config": VALID_LAYERS,
    });

    const result = runLayers(root, []);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Target: opencode/);
    assert.match(result.stdout, /Autonomía: assistant \[project\]/);
  });
});
