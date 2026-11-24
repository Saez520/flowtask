import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDelegationAuthority,
  checkEnforceable,
  delegateErrorFor,
  fingerprintOf,
  missingProfileError,
  parseProfileYaml,
  readAuthorityContract,
  resolveProfile
} from "../lib/authority.js";
import { getValidator } from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (path) => readFileSync(join(ROOT, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));

const STANDARD = readText("examples/authority/valid/authority-profile.standard.yaml");
const READ_ONLY = readText("examples/authority/valid/authority-profile.read-only.yaml");
const CONTRACT = readAuthorityContract();

describe("profile resolution", () => {
  it("resolves from project, then user, then team, and stops at the first source that defines the profile", () => {
    const fromProject = resolveProfile("standard", { project: () => STANDARD, user: () => READ_ONLY, team: () => READ_ONLY });
    assert.equal(fromProject.ok, true);
    assert.equal(fromProject.layer, "project");

    const fromUser = resolveProfile("standard", { project: () => null, user: () => STANDARD, team: () => READ_ONLY });
    assert.equal(fromUser.layer, "user");

    const fromTeam = resolveProfile("standard", { team: () => STANDARD });
    assert.equal(fromTeam.layer, "team");
  });

  it("does not fall back to a valid user profile when the project profile is invalid", () => {
    const invalidProject = STANDARD.replace("version: 1", "version: 2");
    const resolution = resolveProfile("standard", { project: () => invalidProject, user: () => STANDARD });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.code, "invalid");
    assert.equal(resolution.layer, "project");
    assert.deepEqual(resolution.fields, [{ field: "version", problem: "unsupported_version" }]);
  });

  it("never mixes fields of two sources: the resolved document is the one of the governing source", () => {
    const userVariant = STANDARD.replace("description: Work inside", "description: Mixed in from the user source. Work inside");
    const resolution = resolveProfile("standard", { project: () => STANDARD, user: () => userVariant });
    const expected = parseProfileYaml(STANDARD).document;
    assert.deepEqual(resolution.document, expected);
    assert.equal(resolution.layer, "project");
  });

  it("reports not_found when no source defines the profile", () => {
    assert.deepEqual(resolveProfile("standard", { project: () => null, user: () => null }), {
      ok: false,
      code: "not_found",
      layer: null,
      fields: []
    });
  });

  it("reports a name mismatch when the document names another profile", () => {
    assert.deepEqual(resolveProfile("other", { project: () => STANDARD }), {
      ok: false,
      code: "invalid",
      layer: "project",
      fields: [{ field: "name", problem: "name_mismatch" }]
    });
  });

  it("reports a malformed profile name without consulting any source", () => {
    const resolution = resolveProfile("Standard Profile", { project: () => STANDARD });
    assert.deepEqual(resolution, { ok: false, code: "invalid_name", layer: null, fields: [] });
  });

  it("propagates an error thrown by a source", () => {
    assert.throws(
      () =>
        resolveProfile("standard", {
          project: () => {
            throw new Error("source unavailable");
          }
        }),
      /source unavailable/
    );
  });

  it("returns the fingerprint of the resolved document", () => {
    const resolution = resolveProfile("standard", { project: () => STANDARD });
    assert.match(resolution.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(resolution.fingerprint, fingerprintOf(resolution.document));
  });
});

describe("delegate errors", () => {
  it("answers an unresolvable profile with a validation error that names authority_profile", () => {
    const error = delegateErrorFor(resolveProfile("standard", {}), "standard");
    const validate = getValidator("delegate-response");
    assert.equal(validate(error), true, JSON.stringify(validate.errors));
    assert.equal(error.error.fields[0].field, "authority_profile");
  });

  it("answers a request without a profile reference with a validation error that validates", () => {
    const error = missingProfileError();
    const validate = getValidator("delegate-response");
    assert.equal(validate(error), true, JSON.stringify(validate.errors));
    assert.deepEqual(error.error.fields, [{ field: "authority_profile", problem: "required" }]);
  });

  it("names the invalid fields of a profile that is invalid in its layer", () => {
    const resolution = resolveProfile("standard", { project: () => STANDARD.replace("version: 1", "version: 2") });
    const error = delegateErrorFor(resolution, "standard");
    assert.match(error.error.fields[0].problem, /in the project layer: version$/);
    assert.equal(error.error.fields[0].field, "authority_profile");
  });

  it("does not build an error for a resolved profile", () => {
    const resolution = resolveProfile("standard", { project: () => STANDARD });
    assert.throws(() => delegateErrorFor(resolution, "standard"), TypeError);
  });

  it("validates requests with and without a profile reference", () => {
    const validate = getValidator("delegation-request");
    const withoutProfile = readJson("examples/valid/delegation-request.minimal.json");
    const withProfile = readJson("examples/valid/delegation-request.with-authority-profile.json");
    assert.equal(validate(withoutProfile), true, JSON.stringify(validate.errors));
    assert.equal(validate(withProfile), true, JSON.stringify(validate.errors));
  });
});

describe("delegation authority", () => {
  const autonomous = { version: 1, profile: "autonomous-dev" };
  const permissions = { version: 1, envelope: "standard" };

  it("refuses a delegation whose permissions or autonomy layer is missing, with a closed reason", () => {
    assert.deepEqual(checkDelegationAuthority({ permissions: undefined, autonomy: autonomous }), {
      ok: false,
      reason: "authority_layers_missing",
      detail: "The permissions layer is missing."
    });
    assert.deepEqual(checkDelegationAuthority({ permissions, autonomy: null }), {
      ok: false,
      reason: "authority_layers_missing",
      detail: "The autonomy layer is missing."
    });
  });

  it("refuses an invalid layer, including extra keys and unknown values", () => {
    assert.equal(checkDelegationAuthority({ permissions: { version: 2, envelope: "standard" }, autonomy: autonomous }).reason, "authority_layers_invalid");
    assert.equal(checkDelegationAuthority({ permissions: { ...permissions, extra: true }, autonomy: autonomous }).reason, "authority_layers_invalid");
    assert.equal(checkDelegationAuthority({ permissions, autonomy: { version: 1, profile: "bogus" } }).reason, "authority_layers_invalid");
  });

  it("requires an explicit order from the operator under assistant autonomy", () => {
    const assistant = { version: 1, profile: "assistant" };
    assert.equal(checkDelegationAuthority({ permissions, autonomy: assistant }).reason, "authority_explicit_order_required");
    assert.deepEqual(checkDelegationAuthority({ permissions, autonomy: assistant, explicit_order: true }), { ok: true });
  });

  it("delegates under autonomous-dev without an explicit order", () => {
    assert.deepEqual(checkDelegationAuthority({ permissions, autonomy: autonomous }), { ok: true });
  });

  it("never grants a delegation from an absent or empty set of layers", () => {
    assert.equal(checkDelegationAuthority({}).ok, false);
  });

  it("uses only reasons from the closed rejection list", () => {
    const refusals = [
      checkDelegationAuthority({}),
      checkDelegationAuthority({ permissions, autonomy: null }),
      checkDelegationAuthority({ permissions: { version: 2, envelope: "standard" }, autonomy: autonomous }),
      checkDelegationAuthority({ permissions, autonomy: { version: 1, profile: "assistant" } })
    ];
    for (const refusal of refusals) {
      assert.ok(CONTRACT.rejection_reasons.includes(refusal.reason), refusal.reason);
    }
  });

  it("builds a rejected result with each closed reason that validates against the result schema", () => {
    const validate = getValidator("result");
    const example = readJson("examples/valid/result.rejected.json");
    for (const reason of CONTRACT.rejection_reasons) {
      const result = structuredClone(example);
      result.reason = reason;
      assert.equal(validate(result), true, `${reason}: ${JSON.stringify(validate.errors)}`);
    }
  });
});

describe("enforcement declaration", () => {
  it("refuses an adapter that declares no enforcement, naming every missing rule", () => {
    const verdict = checkEnforceable(undefined);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "authority_rule_unenforceable");
    assert.deepEqual(verdict.missing, CONTRACT.required_enforcement);
    assert.match(verdict.detail, /filesystem, shell, network, tools, direct_harness_denial/);
  });

  it("names the rule an adapter cannot make effective", () => {
    const enforcement = { filesystem: true, shell: true, network: false, tools: true, direct_harness_denial: true };
    const verdict = checkEnforceable(enforcement);
    assert.deepEqual(verdict.missing, ["network"]);
    assert.match(verdict.detail, /network/);
  });

  it("accepts an adapter that declares every rule", () => {
    const capabilities = readJson("examples/valid/adapter-capabilities.with-enforcement.json");
    assert.deepEqual(checkEnforceable(capabilities.enforcement), { ok: true });
  });
});
