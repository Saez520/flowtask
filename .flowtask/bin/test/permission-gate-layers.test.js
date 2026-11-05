import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTONOMY_PROFILES,
  LAYER_DIR_CANDIDATES,
  PERMISSION_ENVELOPES,
  buildLayerBlockMessage,
  parseAutonomyLayer,
  parsePermissionsLayer,
  readOperationalLayers,
} from "../../plugins/flowtask-permission-gate/dist/layers.js";
import {
  AUTONOMY_PROFILES as SOURCE_AUTONOMY_PROFILES,
  PERMISSION_ENVELOPES as SOURCE_PERMISSION_ENVELOPES,
  parseAutonomyLayer as parseSourceAutonomyLayer,
} from "../../plugins/flowtask-permission-gate/src/layers.js";
import {
  AUTONOMY_PROFILES as CLI_AUTONOMY_PROFILES,
  PERMISSION_ENVELOPES as CLI_PERMISSION_ENVELOPES,
  validateAutonomyLayer,
} from "../lib/layers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLUGIN = path.join(ROOT, ".flowtask", "plugins", "flowtask-permission-gate");

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTarget(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-gate-layers-"));
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
  return root;
}

function createProject(layouts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-gate-project-"));
  fixtures.push(root);
  for (const [relative, files] of Object.entries(layouts)) {
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

const VALID_LAYERS = {
  "autonomy.json": { version: 1, profile: "autonomous-dev" },
  "permissions.json": { version: 1, envelope: "standard" },
};

describe("parser de la capa de autonomia del gate", () => {
  it("accepts a valid autonomy layer", () => {
    const parsed = parseAutonomyLayer(JSON.stringify({ version: 1, profile: "autonomous-dev" }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { version: 1, profile: "autonomous-dev" });
  });

  it("rejects an unknown profile", () => {
    const parsed = parseAutonomyLayer(JSON.stringify({ version: 1, profile: "root" }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /unknown autonomy profile/);
  });

  it("rejects an invalid version", () => {
    const parsed = parseAutonomyLayer(JSON.stringify({ version: 2, profile: "assistant" }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /invalid autonomy version/);
  });

  it("rejects a malformed document", () => {
    const parsed = parseAutonomyLayer("{not json");
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /invalid JSON/);
  });
});

describe("parser de la capa de permisos del gate", () => {
  it("accepts the standard envelope", () => {
    const parsed = parsePermissionsLayer(JSON.stringify({ version: 1, envelope: "standard" }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { version: 1, envelope: "standard" });
  });

  it("rejects an unknown envelope", () => {
    const parsed = parsePermissionsLayer(JSON.stringify({ version: 1, envelope: "god-mode" }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /unknown envelope/);
  });

  it("rejects a document without an envelope", () => {
    const parsed = parsePermissionsLayer(JSON.stringify({ version: 1 }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /unknown envelope/);
  });

  it("rejects an invalid permissions version", () => {
    const parsed = parsePermissionsLayer(JSON.stringify({ version: 2, envelope: "standard" }));
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /invalid permissions version/);
  });

  it("rejects a document that is not a JSON object", () => {
    for (const parse of [parseAutonomyLayer, parsePermissionsLayer]) {
      const parsed = parse("[]");
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason, /does not contain a JSON object/);
    }
  });
});

describe("resolucion de las capas operativas del gate", () => {
  it("resolves both layers of a valid target", () => {
    const root = createTarget({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, true);
    assert.equal(result.layers.permissions.envelope, "standard");
    assert.equal(result.layers.autonomy.profile, "autonomous-dev");
  });

  it("fails when the permissions layer is absent in the source", () => {
    const root = createTarget({ "autonomy.json": { version: 1, profile: "autonomous-dev" } });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, false);
    assert.equal(result.layer, "permissions");
    assert.match(result.reason, /missing/);
    assert.match(buildLayerBlockMessage(result), /\[FlowTask Permission Gate\] Missing or invalid permissions layer\./);
  });

  it("fails when the autonomy layer is absent in the source", () => {
    const root = createTarget({ "permissions.json": { version: 1, envelope: "standard" } });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, false);
    assert.equal(result.layer, "autonomy");
    assert.match(result.reason, /missing/);
    assert.match(buildLayerBlockMessage(result), /\[FlowTask Permission Gate\] Missing or invalid autonomy layer\./);
  });

  it("fails when the envelope is unknown", () => {
    const root = createTarget({
      "autonomy.json": { version: 1, profile: "autonomous-dev" },
      "permissions.json": { version: 1, envelope: "god-mode" },
    });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, false);
    assert.equal(result.layer, "permissions");
    assert.match(result.reason, /unknown envelope/);
  });

  it("reports a target without any layer configuration", () => {
    const root = createTarget({});

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, false);
    assert.equal(result.configDir, null);
  });

  it("denies when the target declares a layer configuration that is incomplete", () => {
    const root = createTarget({ "autonomy.json": { version: 1, profile: "autonomous-dev" } });

    const result = readOperationalLayers([root]);
    const denied = !result.ok && Boolean(result.configDir);

    assert.equal(denied, true, "an incomplete layer configuration must be denied");
    assert.match(buildLayerBlockMessage(result), /Missing or invalid permissions layer\./);
  });

  it("denies when the target declares no layer configuration", () => {
    const root = createTarget({});

    const result = readOperationalLayers([root]);
    const denied = !result.ok;

    assert.equal(denied, true, "a target without layer configuration must be denied");
    assert.equal(result.configDir, null);
    assert.match(buildLayerBlockMessage(result), /the target declares no layer configuration/);
  });

  it("does not fall through when the first candidate declares an incomplete configuration", () => {
    const root = createProject({
      ".opencode/flowtask/config": {
        "autonomy.json": VALID_LAYERS["autonomy.json"],
      },
      ".claude/flowtask/config": VALID_LAYERS,
    });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, false);
    assert.equal(result.layer, "permissions");
    assert.equal(result.configDir, path.join(root, ".opencode", "flowtask", "config"));
    assert.equal(result.path, path.join(root, ".opencode", "flowtask", "config", "permissions.json"));
    assert.match(result.reason, /missing/);
  });

  it("uses the next candidate when the earlier candidates declare no layer", () => {
    const root = createProject({
      ".claude/flowtask/config": VALID_LAYERS,
    });

    const result = readOperationalLayers([root]);

    assert.equal(result.ok, true);
    assert.equal(result.configDir, path.join(root, ".claude", "flowtask", "config"));
    assert.equal(result.layers.autonomy.profile, "autonomous-dev");
    assert.equal(result.layers.permissions.envelope, "standard");
  });

  it("falls back to the next root when the first root declares no layer", () => {
    const emptyRoot = createProject({});
    const validRoot = createProject({
      ".opencode/flowtask/config": VALID_LAYERS,
    });

    const result = readOperationalLayers([emptyRoot, validRoot]);

    assert.equal(result.ok, true);
    assert.equal(result.configDir, path.join(validRoot, ".opencode", "flowtask", "config"));
  });

  it("publishes the operational message with the file, the cause and the action", () => {
    const root = createTarget({ "autonomy.json": { version: 1, profile: "autonomous-dev" } });

    const result = readOperationalLayers([root]);
    const message = buildLayerBlockMessage(result);

    assert.equal(
      message,
      [
        "[FlowTask Permission Gate] Missing or invalid permissions layer.",
        `File: ${path.join(root, ".opencode", "flowtask", "config", "permissions.json")}`,
        "Cause: missing layer: the layer file was not found",
        "Action: fix the layer or run flowtask update; the Runner does not execute tools with expanded limits.",
      ].join("\n"),
    );
  });

  it("publishes the exact operational message of the autonomy layer", () => {
    const root = createTarget({ "permissions.json": { version: 1, envelope: "standard" } });

    const result = readOperationalLayers([root]);
    const message = buildLayerBlockMessage(result);

    assert.equal(
      message,
      [
        "[FlowTask Permission Gate] Missing or invalid autonomy layer.",
        `File: ${path.join(root, ".opencode", "flowtask", "config", "autonomy.json")}`,
        "Cause: missing layer: the layer file was not found",
        "Action: fix the layer or run flowtask update; the Runner does not execute tools with expanded limits.",
      ].join("\n"),
    );
  });
});

describe("paridad del plugin", () => {
  it("keeps the source and the compiled artifact byte for byte identical", () => {
    const source = fs.readFileSync(path.join(PLUGIN, "src", "layers.js"));
    const compiled = fs.readFileSync(path.join(PLUGIN, "dist", "layers.js"));
    assert.equal(source.equals(compiled), true, "src/layers.js and dist/layers.js must be identical");
  });

  it("keeps the three catalogs aligned on the two profiles", () => {
    for (const catalog of [AUTONOMY_PROFILES, SOURCE_AUTONOMY_PROFILES, CLI_AUTONOMY_PROFILES]) {
      assert.deepEqual([...catalog], ["assistant", "autonomous-dev"]);
    }
    for (const catalog of [PERMISSION_ENVELOPES, SOURCE_PERMISSION_ENVELOPES, CLI_PERMISSION_ENVELOPES]) {
      assert.deepEqual([...catalog], ["standard"]);
    }
  });

  /**
   * gap_ref: C6
   * criterio: la batería de autonomía y capas pasa con dos valores y dos
   *   capas, incluida la prueba cruzada de las tres copias.
   * defecto: una copia conserva el perfil retirado o no se compara el
   *   comportamiento de las tres copias.
   * why_not_detected: las pruebas vigentes afirman tres valores, la prueba del
   *   gate no importa la fuente y no hay prueba cruzada de comportamiento.
   * comportamiento observable: para el ejecutable, la fuente y el compilado,
   *   los dos valores son aceptados y el valor retirado construido en runtime
   *   es rechazado.
   */
  it("accepts the two profiles and rejects the retired one in the three copies", () => {
    const RETIRED_PROFILE = ["her", "mes"].join("");
    const copies = [
      {
        label: "ejecutable",
        accepts: (profile) => validateAutonomyLayer({ version: 1, profile }).status === "valid",
      },
      {
        label: "fuente",
        accepts: (profile) => parseSourceAutonomyLayer(JSON.stringify({ version: 1, profile })).ok,
      },
      {
        label: "compilado",
        accepts: (profile) => parseAutonomyLayer(JSON.stringify({ version: 1, profile })).ok,
      },
    ];

    for (const copy of copies) {
      for (const profile of ["assistant", "autonomous-dev"]) {
        assert.equal(copy.accepts(profile), true, `${copy.label} must accept ${profile}`);
      }
      assert.equal(copy.accepts(RETIRED_PROFILE), false, `${copy.label} must reject the retired profile`);
    }
  });

  it("probes the known configuration directories in order", () => {
    assert.deepEqual(
      [...LAYER_DIR_CANDIDATES],
      [
        ".opencode/flowtask/config",
        ".claude/flowtask/config",
        ".vscode/flowtask/config",
        ".flowtask/config",
      ],
    );
  });

  it("checks the layers before the runner allowlist in the source and in the compiled artifact", () => {
    for (const relative of ["src/index.ts", "dist/index.js"]) {
      const content = fs.readFileSync(path.join(PLUGIN, relative), "utf8");
      const checkIndex = content.indexOf("readOperationalLayers");
      const allowlistIndex = content.indexOf("runnerToolAllowed");
      assert.ok(checkIndex !== -1, `${relative} must resolve the operational layers`);
      assert.ok(allowlistIndex !== -1, `${relative} must keep the runner allowlist`);
      assert.ok(checkIndex < allowlistIndex, `${relative} must check the layers before the allowlist`);
      assert.ok(content.includes("buildLayerBlockMessage"), `${relative} must publish the operational message`);
    }
  });

  it("does not apply the layer check to agents that are not the runner", () => {
    const content = fs.readFileSync(path.join(PLUGIN, "src", "index.ts"), "utf8");
    const block = content.slice(content.indexOf("if (isRunner(agent)) {"));
    assert.ok(block.includes("readOperationalLayers"), "the check must live inside the runner block");
  });

  it("denies every failed layer resolution, including an absent configuration", () => {
    for (const relative of ["src/index.ts", "dist/index.js"]) {
      const content = fs.readFileSync(path.join(PLUGIN, relative), "utf8");
      assert.ok(
        content.includes("if (!operationalLayers.ok)"),
        `${relative} must deny every failed layer resolution`,
      );
      assert.equal(
        content.includes("operationalLayers.configDir"),
        false,
        `${relative} must not skip the layer check when no configuration was declared`,
      );
      assert.ok(
        content.includes("throw new Error(buildLayerBlockMessage(operationalLayers))"),
        `${relative} must deny with the operational message`,
      );
    }
  });

  it("enables the JavaScript sources in the build configuration", () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(PLUGIN, "tsconfig.json"), "utf8"));
    assert.equal(tsconfig.compilerOptions.allowJs, true);
    assert.ok(tsconfig.include.includes("src/**/*.js"), "the build must include the JavaScript sources");
  });
});

describe("documentacion de la capa de permisos", () => {
  const page = fs.readFileSync(path.join(ROOT, "docs", "permission-gate.md"), "utf8");

  it("publishes the section with the schema and the envelope", () => {
    assert.ok(page.includes("## Permissions layer"), "missing the permissions layer section");
    assert.ok(page.includes('"envelope": "standard"'), "missing the envelope schema");
    assert.ok(page.includes('"profile": "autonomous-dev"'), "missing the autonomy schema");
    assert.ok(page.includes("`standard`"), "missing the standard envelope");
  });

  it("publishes the failure table and the operational message", () => {
    assert.ok(page.includes("[FlowTask Permission Gate] Missing or invalid permissions layer."), "missing the block message");
    assert.ok(page.includes("[FlowTask Permission Gate] Missing or invalid autonomy layer."), "missing the autonomy block message");
    assert.ok(page.includes("Action: fix the layer or run flowtask update"), "missing the recommended action");
  });

  it("declares the scope and the smoke with a restart", () => {
    assert.ok(page.includes("only to the runner's tools"), "missing the scope of the layer check");
    assert.ok(page.includes("restart OpenCode"), "missing the restart in the smoke");
    assert.ok(page.includes("delete"), "missing the deletion step of the smoke");
    assert.ok(page.includes("restore the file"), "missing the restore step of the smoke");
  });
});
