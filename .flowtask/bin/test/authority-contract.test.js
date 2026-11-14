import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import plugin from "../../plugins/flowtask-permission-gate/dist/index.js";
import {
  isAuthorityCommand,
  isAuthorizedRunnerCommand,
} from "../../plugins/flowtask-permission-gate/dist/authorizer.js";
import {
  LAYER_DIR_CANDIDATES,
  readOperationalLayers,
} from "../../plugins/flowtask-permission-gate/dist/layers.js";
import { AUTHORITY_MESSAGES } from "../lib/authority-messages.js";
import { AUTHORITY_TARGETS } from "../lib/layer-repair.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, ".flowtask", "bin", "flowtask.js");

const fixtures = [];
const gates = [];

afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.dispose();
  while (fixtures.length > 0) {
    fs.rmSync(fixtures.pop(), { recursive: true, force: true });
  }
});

function createProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-authority-contract-"));
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

async function createGate(directory) {
  const callbacks = {};
  const ctx = {
    location: { directory },
    tool: {
      hook: async (name, callback) => {
        callbacks[name] = callback;
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, callback) => {
        callbacks[name] = callback;
        return { dispose: async () => {} };
      },
    },
  };
  const cleanup = await plugin.setup(ctx);
  const gate = {
    before: (event) =>
      callbacks["execute.before"]({ messageID: "m-g6", id: "c-g6", ...event }),
    dispose: async () => {
      await cleanup?.();
    },
  };
  gates.push(gate);
  return gate;
}

const FORBIDDEN_OPERATOR_TERMS = [
  /\bauthority_block\b/i,
  /\bprogress_unavailable\b/i,
  /\bpermissions\b/i,
  /\bautonomy\b/i,
  /\benvelope\b/i,
  /\bprofile\b/i,
  /\blayer\b/i,
  /\bgate\b/i,
  /\bconfig\b/i,
  /\.json\b/i,
  /\//,
  /\\/,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i,
  /flow-state/i,
  /flowtask/i,
  /CA-/,
];

describe("catálogo de operador", () => {
  // gap: G4 — El texto de operador filtra códigos, rutas o nombres internos
  it("no filtra códigos, rutas ni nombres internos en el canal de operador", () => {
    const messages = Object.entries(AUTHORITY_MESSAGES);

    assert.ok(messages.length > 0, "el catálogo de operador no puede estar vacío");
    for (const [key, message] of messages) {
      assert.equal(typeof message, "string", `${key} debe ser un texto`);
      assert.ok(message.trim().length > 0, `${key} no puede ser vacío`);
      for (const term of FORBIDDEN_OPERATOR_TERMS) {
        assert.doesNotMatch(message, term, `${key} filtra el término interno ${term}`);
      }
    }
  });
});

describe("paridad de targets de autoridad", () => {
  // gap: G5 — El comando repara un target distinto del que lee el gate
  it("repara el mismo target que lee el gate", () => {
    assert.deepEqual(
      AUTHORITY_TARGETS.map((target) => target.dir),
      [...LAYER_DIR_CANDIDATES],
      "el comando debe reparar los targets en el mismo orden que lee el gate",
    );

    const { root, configDir } = createProject({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": "{not json",
    });

    const repair = runCli(root, ["repair", "--json"]);

    assert.equal(repair.status, 0, `${repair.stdout}\n${repair.stderr}`);
    const payload = JSON.parse(repair.stdout);
    assert.equal(payload.target, "opencode");
    assert.equal(payload.status, "repaired");

    const layers = readOperationalLayers([root]);

    assert.equal(layers.ok, true, JSON.stringify(layers));
    assert.equal(fs.realpathSync(layers.configDir), fs.realpathSync(configDir));
  });
});

describe("excepción del gate por falta de autoridad", () => {
  // gap: G6 — La excepción del gate amplía la allowlist o deja de denegar
  it("deja pasar solo los comandos exactos de autoridad y deniega el resto", async () => {
    const { root } = createProject({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": "{not json",
    });
    const gate = await createGate(root);

    for (const command of [
      "flowtask authority status",
      "flowtask authority status --json",
      "flowtask repair",
      "flowtask repair --json",
      "node .flowtask/bin/flowtask.js authority status --json",
      "node .flowtask/bin/flowtask.js repair --json",
    ]) {
      await gate.before({
        tool: "bash",
        sessionID: "s-g6-allowed",
        agent: "flowtask-runner",
        input: { command },
      });
    }

    const deny = (event) =>
      assert.rejects(gate.before(event), (error) => {
        assert.match(
          error.message,
          /^\[FlowTask Permission Gate\] Missing or invalid permissions layer\./,
          `debe denegar por capas: ${error.message}`,
        );
        return true;
      });

    await deny({
      tool: "read",
      sessionID: "s-g6-read",
      agent: "flowtask-runner",
      input: { file: "package.json", limit: 5 },
    });
    for (const command of [
      "git status",
      "git status && flowtask repair",
      "flowtask repair; rm -rf build",
      "flowtask repair --force",
    ]) {
      await deny({
        tool: "bash",
        sessionID: "s-g6-denied",
        agent: "flowtask-runner",
        input: { command },
      });
    }

    assert.equal(isAuthorityCommand("flowtask repair"), true);
    assert.equal(isAuthorityCommand("git status && flowtask repair"), false);
    assert.equal(isAuthorityCommand("flowtask repair; rm -rf build"), false);
    assert.equal(isAuthorityCommand("flowtask repair --force"), false);
    assert.equal(isAuthorizedRunnerCommand("flowtask repair"), true);
    assert.equal(isAuthorizedRunnerCommand("flowtask repair; rm -rf build"), false);
    assert.equal(isAuthorizedRunnerCommand("flowtask repair --force"), false);
  });
});
