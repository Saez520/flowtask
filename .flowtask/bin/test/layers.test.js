import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTONOMY_PROFILES,
  LAYER_FILES,
  LAYER_ORDER,
  LEGACY_PERSONA_LEVELS,
  MIGRATION_DEFAULTS,
  PERMISSION_ENVELOPES,
  PERSONA_LEVELS,
  assertOperationalLayers,
  describeOperationalFailure,
  normalizePersonaLevel,
  readLayerFile,
  readLayerSources,
  resolveLayers,
  validateAutonomyLayer,
  validatePermissionsLayer,
  validatePersonaLayer,
} from "../lib/layers.js";

const fixtures = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-layers-"));
  fixtures.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  return dir;
}

describe("catalogos de las capas", () => {
  it("declares the allowed values of every layer", () => {
    assert.deepEqual([...PERSONA_LEVELS], ["training", "mid", "senior", "custom"]);
    assert.deepEqual([...LEGACY_PERSONA_LEVELS], ["junior"]);
    assert.deepEqual([...AUTONOMY_PROFILES], ["assistant", "autonomous-dev"]);
    assert.deepEqual([...PERMISSION_ENVELOPES], ["standard"]);
  });

  it("declares the structural order and the file of every layer", () => {
    assert.deepEqual([...LAYER_ORDER], ["permissions", "autonomy", "persona"]);
    assert.equal(LAYER_FILES.persona, "profile.json");
    assert.equal(LAYER_FILES.autonomy, "autonomy.json");
    assert.equal(LAYER_FILES.permissions, "permissions.json");
  });

  it("declares the migration defaults as valid layer contents", () => {
    assert.deepEqual(MIGRATION_DEFAULTS.autonomy, { version: 1, profile: "assistant" });
    assert.deepEqual(MIGRATION_DEFAULTS.permissions, { version: 1, envelope: "standard" });
    assert.equal(validateAutonomyLayer(MIGRATION_DEFAULTS.autonomy).status, "valid");
    assert.equal(validatePermissionsLayer(MIGRATION_DEFAULTS.permissions).status, "valid");
  });
});

describe("validacion por capa", () => {
  it("normalizes the legacy persona level as a read alias", () => {
    assert.equal(normalizePersonaLevel("junior"), "training");
    assert.equal(normalizePersonaLevel("senior"), "senior");
    assert.equal(normalizePersonaLevel("expert"), null);
    assert.equal(normalizePersonaLevel(undefined), null);
  });

  it("validates the persona layer and returns its normalized six-field shape", () => {
    const valid = validatePersonaLayer({ level: "senior", persona: "tutor-senior", onboarded: true });
    assert.equal(valid.status, "valid");
    assert.deepEqual(valid.value, {
      level: "senior",
      persona: "tutor-senior",
      onboarded: true,
      quiz_completed_at: null,
      stack_snapshot: null,
      quiz_answers: [],
    });

    const legacy = validatePersonaLayer({ level: "junior", persona: "tutor-training", onboarded: true });
    assert.equal(legacy.status, "valid");
    assert.equal(legacy.value.level, "training");

    assert.equal(validatePersonaLayer({ level: "senior" }).status, "invalid");
    assert.equal(validatePersonaLayer({ level: "expert", persona: "x" }).status, "invalid");
    assert.equal(validatePersonaLayer(null).status, "missing");
  });

  it("validates the autonomy layer against its version and its profile", () => {
    assert.equal(validateAutonomyLayer({ version: 1, profile: "assistant" }).status, "valid");
    assert.equal(validateAutonomyLayer({ version: 2, profile: "assistant" }).status, "invalid");
    assert.equal(validateAutonomyLayer({ version: 1, profile: "root" }).status, "invalid");
    assert.equal(validateAutonomyLayer({ profile: "assistant" }).status, "invalid");
    assert.equal(validateAutonomyLayer(null).status, "missing");
  });

  it("validates the permissions layer against its version and its envelope", () => {
    assert.equal(validatePermissionsLayer({ version: 1, envelope: "standard" }).status, "valid");
    assert.equal(validatePermissionsLayer({ version: 1, envelope: "god-mode" }).status, "invalid");
    assert.equal(validatePermissionsLayer({ version: 1 }).status, "invalid");
    assert.equal(validatePermissionsLayer(null).status, "missing");
  });
});

describe("lectura de archivos de capa", () => {
  it("reports a missing file without a reason", () => {
    const dir = createConfigDir();
    const record = readLayerFile(path.join(dir, "autonomy.json"));
    assert.equal(record.status, "missing");
    assert.equal(record.value, null);
    assert.equal(record.reason, null);
  });

  it("reports an unreadable or malformed file as invalid", () => {
    const dir = createConfigDir({ "autonomy.json": "{not json" });
    const record = readLayerFile(path.join(dir, "autonomy.json"));
    assert.equal(record.status, "invalid");
    assert.match(record.reason, /invalid JSON/);
  });

  it("reads the three layers of a configuration directory", () => {
    const dir = createConfigDir({
      "profile.json": { level: "mid", persona: "tutor-mid", onboarded: true },
      "autonomy.json": { version: 1, profile: "assistant" },
      "permissions.json": { version: 1, envelope: "standard" },
    });
    const sources = readLayerSources(dir);
    assert.equal(sources.persona.status, "present");
    assert.equal(sources.autonomy.status, "present");
    assert.equal(sources.permissions.status, "present");
  });
});

describe("resolucion por capa", () => {
  it("resolves three valid layers and applies the project override per layer", () => {
    const resolution = resolveLayers({
      team: {
        autonomy: { version: 1, profile: "assistant" },
        permissions: { version: 1, envelope: "standard" },
      },
      project: {
        autonomy: { version: 1, profile: "autonomous-dev" },
      },
    });

    assert.equal(resolution.layers.autonomy.status, "valid");
    assert.equal(resolution.layers.autonomy.value.profile, "autonomous-dev");
    assert.equal(resolution.layers.autonomy.source, "project");
    assert.equal(resolution.layers.permissions.status, "valid");
    assert.equal(resolution.layers.permissions.value.envelope, "standard");
    assert.equal(resolution.layers.permissions.source, "team");
    assert.equal(resolution.operational.ok, true);
    assert.deepEqual(resolution.precedence, ["permissions", "autonomy", "persona"]);
  });

  it("does not fall back to the team base when the project layer is invalid", () => {
    const resolution = resolveLayers({
      team: { autonomy: { version: 1, profile: "assistant" } },
      project: { autonomy: { version: 1, profile: "root" } },
    });

    assert.equal(resolution.layers.autonomy.status, "invalid");
    assert.equal(resolution.layers.autonomy.source, "project");
    assert.equal(resolution.layers.autonomy.value, null);
    assert.throws(
      () => assertOperationalLayers(resolution),
      (error) => {
        assert.equal(error.code, "autonomy_invalid");
        assert.equal(error.layer, "autonomy");
        assert.match(error.message, /\[FlowTask Layers\] autonomy layer missing or invalid\./);
        assert.match(error.message, /unknown autonomy profile: "root"/);
        return true;
      },
    );
  });

  it("keeps an invalid persona as a warning without blocking", () => {
    const resolution = resolveLayers({
      team: null,
      project: {
        persona: { level: "senior" },
        autonomy: { version: 1, profile: "assistant" },
        permissions: { version: 1, envelope: "standard" },
      },
    });

    assert.equal(resolution.layers.persona.status, "invalid");
    assert.equal(resolution.warnings.length, 1);
    assert.match(resolution.warnings[0], /persona/i);
    assert.equal(resolution.operational.ok, true);
    assert.doesNotThrow(() => assertOperationalLayers(resolution));
  });

  it("does not mix fields between the team base and the project override", () => {
    const resolution = resolveLayers({
      team: {
        autonomy: { version: 1, profile: "assistant" },
        permissions: { version: 1, envelope: "standard" },
      },
      project: {
        autonomy: { version: 1, profile: "autonomous-dev" },
      },
    });

    assert.deepEqual(resolution.layers.autonomy.value, { version: 1, profile: "autonomous-dev" });
    assert.deepEqual(resolution.layers.permissions.value, { version: 1, envelope: "standard" });
  });

  it("reports a layer absent in both sources as missing", () => {
    const resolution = resolveLayers({ team: null, project: null });
    assert.equal(resolution.layers.autonomy.status, "missing");
    assert.equal(resolution.layers.permissions.status, "missing");
    assert.equal(resolution.layers.persona.status, "missing");
    assert.equal(resolution.layers.autonomy.source, null);
    assert.equal(resolution.operational.ok, false);
  });
});

describe("fallo operativo por capa", () => {
  const cases = [
    {
      code: "autonomy_missing",
      layer: "autonomy",
      project: { permissions: { version: 1, envelope: "standard" } },
      message: /autonomy layer missing or invalid\./,
    },
    {
      code: "autonomy_invalid",
      layer: "autonomy",
      project: {
        autonomy: { version: 1, profile: "root" },
        permissions: { version: 1, envelope: "standard" },
      },
      message: /autonomy layer missing or invalid\./,
    },
    {
      code: "permissions_missing",
      layer: "permissions",
      project: { autonomy: { version: 1, profile: "assistant" } },
      message: /permissions layer missing or invalid\./,
    },
    {
      code: "permissions_invalid",
      layer: "permissions",
      project: {
        autonomy: { version: 1, profile: "assistant" },
        permissions: { version: 1, envelope: "god-mode" },
      },
      message: /permissions layer missing or invalid\./,
    },
  ];

  for (const testCase of cases) {
    it(`produces the ${testCase.code} error code`, () => {
      const resolution = resolveLayers({ team: null, project: testCase.project });
      assert.equal(resolution.operational.ok, false);
      assert.equal(resolution.operational.errors.length, 1);
      assert.equal(resolution.operational.errors[0].code, testCase.code);
      assert.equal(resolution.operational.errors[0].layer, testCase.layer);
      assert.throws(() => assertOperationalLayers(resolution), (error) => {
        assert.equal(error.code, testCase.code);
        assert.equal(error.layer, testCase.layer);
        assert.match(error.message, testCase.message);
        return true;
      });
    });
  }

  it("publishes the exact operational message of the autonomy layer", () => {
    const resolution = resolveLayers({
      team: null,
      project: {
        autonomy: { version: 1, profile: "root" },
        permissions: { version: 1, envelope: "standard" },
      },
    });
    const message = describeOperationalFailure(resolution.operational.errors[0]);
    assert.equal(
      message,
      [
        "[FlowTask Layers] autonomy layer missing or invalid.",
        "File: unidentified",
        "Cause: unknown autonomy profile: \"root\"",
        'Action: define "profile" as assistant or autonomous-dev and retry; no execution starts.',
      ].join("\n"),
    );
  });

  it("publishes the exact operational message of the permissions layer", () => {
    const resolution = resolveLayers({
      team: null,
      project: {
        autonomy: { version: 1, profile: "assistant" },
        permissions: { version: 1, envelope: "god-mode" },
      },
    });
    const message = describeOperationalFailure(resolution.operational.errors[0]);
    assert.equal(
      message,
      [
        "[FlowTask Layers] permissions layer missing or invalid.",
        "File: unidentified",
        "Cause: unknown envelope: \"god-mode\"",
        'Action: define "envelope": "standard" and retry; no action with expanded limits is executed.',
      ].join("\n"),
    );
  });

  it("names the file of a missing layer in the operational message", () => {
    const dir = createConfigDir();
    const sources = readLayerSources(dir);
    const resolution = resolveLayers({ team: null, project: sources });
    const error = resolution.operational.errors.find((item) => item.code === "autonomy_missing");
    assert.ok(error, "the missing autonomy layer must produce an operational error");
    assert.equal(error.path, path.join(dir, "autonomy.json"));
    assert.match(describeOperationalFailure(error), /autonomy layer missing or invalid\./);
  });

  it("never invents a runtime default for an absent layer", () => {
    const resolution = resolveLayers({ team: null, project: null });
    assert.equal(resolution.layers.autonomy.value, null);
    assert.equal(resolution.layers.permissions.value, null);
    assert.notEqual(resolution.layers.autonomy.value?.profile, MIGRATION_DEFAULTS.autonomy.profile);
  });
});

describe("bordes de validacion y resolucion", () => {
  it("rejects non-object values for every layer", () => {
    for (const validator of [validatePersonaLayer, validateAutonomyLayer, validatePermissionsLayer]) {
      const result = validator([]);
      assert.equal(result.status, "invalid");
      assert.match(result.reason, /is not a JSON object/);
    }
  });

  it("rejects a layer file that does not contain a JSON object", () => {
    const dir = createConfigDir({ "permissions.json": "[]" });

    const record = readLayerFile(path.join(dir, "permissions.json"));

    assert.equal(record.status, "invalid");
    assert.match(record.reason, /does not contain a JSON object/);
  });

  it("reports a malformed layer file as invalid instead of missing", () => {
    const dir = createConfigDir({
      "autonomy.json": "{not json",
      "permissions.json": { version: 1, envelope: "standard" },
    });

    const resolution = resolveLayers({ team: null, project: readLayerSources(dir) });
    const error = resolution.operational.errors[0];

    assert.equal(resolution.layers.autonomy.status, "invalid");
    assert.equal(resolution.layers.autonomy.path, path.join(dir, "autonomy.json"));
    assert.match(resolution.layers.autonomy.reason, /invalid JSON/);
    assert.equal(error.code, "autonomy_invalid");
    assert.match(describeOperationalFailure(error), new RegExp(`File: ${path.join(dir, "autonomy.json")}`));
  });

  it("lets a valid project layer win over an invalid team layer", () => {
    const resolution = resolveLayers({
      team: {
        autonomy: { version: 1, profile: "root" },
        permissions: { version: 1, envelope: "standard" },
      },
      project: {
        autonomy: { version: 1, profile: "assistant" },
      },
    });

    assert.equal(resolution.layers.autonomy.status, "valid");
    assert.equal(resolution.layers.autonomy.source, "project");
    assert.equal(resolution.layers.autonomy.value.profile, "assistant");
    assert.equal(resolution.layers.permissions.source, "team");
    assert.equal(resolution.operational.ok, true);
  });

  it("warns about a missing persona and continues with the valid layers", () => {
    const resolution = resolveLayers({
      team: null,
      project: {
        autonomy: { version: 1, profile: "autonomous-dev" },
        permissions: { version: 1, envelope: "standard" },
      },
    });

    assert.equal(resolution.layers.persona.status, "missing");
    assert.equal(resolution.layers.persona.value, null);
    assert.equal(resolution.warnings.length, 1);
    assert.match(resolution.warnings[0], /Persona layer missing/);
    assert.equal(resolution.operational.ok, true);
    assert.doesNotThrow(() => assertOperationalLayers(resolution));
  });
});
