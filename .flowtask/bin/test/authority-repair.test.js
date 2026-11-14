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
    fs.rmSync(fixtures.pop(), { recursive: true, force: true });
  }
});

function createProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-authority-"));
  fixtures.push(root);
  const configDir = path.join(root, ".opencode", "flowtask", "config");
  fs.mkdirSync(configDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(configDir, name),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
      "utf8",
    );
  }
  return { root, configDir };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
  });
}

describe("flowtask repair", () => {
  // gap: G1 — Reparación escribe sin respaldo, pisa una capa válida o no verifica
  it("restaura la configuración segura con respaldo y preserva la capa válida", () => {
    const invalidPermissions = '{not json';
    const { root, configDir } = createProject({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": invalidPermissions,
    });
    const originalAutonomy = fs.readFileSync(path.join(configDir, "autonomy.json"), "utf8");

    const repair = runCli(root, ["repair", "--json"]);

    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`);
    const payload = JSON.parse(repair.stdout);
    assert.equal(payload.schema, "flowtask-authority-repair/v1");
    assert.equal(payload.status, "repaired");
    assert.deepEqual(payload.restored, ["permissions"]);
    assert.deepEqual(payload.preserved, ["autonomy"]);
    assert.equal(payload.backups.length, 1);
    assert.match(path.basename(payload.backups[0]), /^permissions\.json\.bak-/);
    assert.equal(fs.readFileSync(payload.backups[0], "utf8"), invalidPermissions);

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, "permissions.json"), "utf8")), {
      version: 1,
      envelope: "standard",
    });
    assert.equal(fs.readFileSync(path.join(configDir, "autonomy.json"), "utf8"), originalAutonomy);

    const status = runCli(root, ["authority", "status", "--json"]);

    assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
    const diagnosis = JSON.parse(status.stdout);
    assert.equal(diagnosis.classification, "ok");
    assert.equal(diagnosis.profile, "autonomous-dev");
    assert.deepEqual(diagnosis.errors, []);
  });

  // gap: G2 — Reparación fallida retoma inválido o deriva a editar reglas
  it("conserva el original y escala cuando la reparación no puede completarse", () => {
    const { root, configDir } = createProject({
      "autonomy.json": { version: 1, profile: "assistant" },
    });
    const permissionsPath = path.join(configDir, "permissions.json");
    fs.mkdirSync(permissionsPath);
    const originalAutonomy = fs.readFileSync(path.join(configDir, "autonomy.json"), "utf8");

    const failed = runCli(root, ["repair", "--json"]);

    assert.equal(failed.status, 2, `${failed.stdout}\n${failed.stderr}`);
    const payload = JSON.parse(failed.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(
      payload.message,
      "No se pudo restaurar la configuración segura.\nAcción: reinstalar el producto o generar un diagnóstico.",
    );
    assert.equal(fs.statSync(permissionsPath).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(configDir, "autonomy.json"), "utf8"), originalAutonomy);
    assert.deepEqual(
      fs.readdirSync(configDir).filter((name) => name.startsWith("permissions.json.")),
      [],
    );

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-authority-empty-"));
    fixtures.push(emptyRoot);
    const missing = runCli(emptyRoot, ["repair", "--json"]);

    assert.equal(missing.status, 2, `${missing.stdout}\n${missing.stderr}`);
    const missingPayload = JSON.parse(missing.stdout);
    assert.equal(missingPayload.status, "not_installed");
    assert.equal(missingPayload.target, null);
    assert.equal(
      missingPayload.message,
      "La configuración de autorización no está disponible.\nAcción: reinstalar el producto o generar un diagnóstico.",
    );
  });
});

describe("flowtask authority status", () => {
  // gap: G3 — Diagnóstico a pedido mezcla o pierde códigos/rutas/causa
  it("publica los códigos, rutas y causa solo cuando se pide el diagnóstico", () => {
    const { root, configDir } = createProject({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": "{not json",
    });

    const json = runCli(root, ["authority", "status", "--json"]);

    assert.equal(json.status, 0, `${json.stdout}\n${json.stderr}`);
    const diagnosis = JSON.parse(json.stdout);
    assert.equal(diagnosis.classification, "authority_block");
    assert.equal(diagnosis.errors.length, 1);
    const [error] = diagnosis.errors;
    assert.deepEqual(Object.keys(error).sort(), ["code", "layer", "path", "reason"]);
    assert.equal(error.code, "permissions_invalid");
    assert.equal(error.layer, "permissions");
    assert.equal(fs.realpathSync(error.path), fs.realpathSync(path.join(configDir, "permissions.json")));
    assert.match(error.reason, /invalid JSON/);

    const operator = runCli(root, ["authority", "status"]);

    assert.equal(operator.status, 0, `${operator.stdout}\n${operator.stderr}`);
    assert.equal(operator.stdout, `${diagnosis.message}\n`);
  });
});
