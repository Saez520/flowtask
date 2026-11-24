import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getValidator, readSchema } from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

const data = JSON.parse(readFileSync(join(ROOT, "authority-contract.v1.json"), "utf8"));

describe("authority contract data", () => {
  it("matches the authority-contract schema", () => {
    const validate = getValidator("authority-contract");
    assert.equal(validate(data), true, JSON.stringify(validate.errors));
  });

  it("names exactly the four rejection reasons, all in snake_case", () => {
    assert.deepEqual([...data.rejection_reasons].sort(), [
      "authority_explicit_order_required",
      "authority_layers_invalid",
      "authority_layers_missing",
      "authority_rule_unenforceable"
    ]);
    for (const reason of data.rejection_reasons) {
      assert.match(reason, SNAKE_CASE);
    }
  });

  it("requires exactly the enforcement rules that adapter capabilities can declare", () => {
    const declared = Object.keys(readSchema("adapter-capabilities").properties.enforcement.properties).sort();
    assert.deepEqual([...data.required_enforcement].sort(), declared);
  });

  it("resolves a profile from project, then user, then team", () => {
    assert.deepEqual(data.resolution.order, ["project", "user", "team"]);
    assert.equal(data.resolution.invalid_falls_back, false);
  });

  it("lists at least one harness executable that is always denied", () => {
    assert.ok(data.always_denied_executables.length > 0);
  });
});
