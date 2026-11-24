import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getValidator } from "../lib/schemas.js";
import { mapStopReason, terminalStates } from "../lib/reference-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");
const table = JSON.parse(readFileSync(join(ROOT, "state-machine.v1.json"), "utf8"));
const adapter = JSON.parse(readFileSync(join(ROOT, "adapter-interface.v1.json"), "utf8"));
const mapping = adapter.stop_reason_mapping;

const example = (relative) => JSON.parse(readFileSync(join(EXAMPLES, relative), "utf8"));

function keyPaths(node, prefix = "") {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return [prefix];
  return Object.keys(node)
    .sort()
    .flatMap((key) => keyPaths(node[key], prefix ? `${prefix}.${key}` : key));
}

const MAPPED_EXAMPLES = [
  { row: { stop_reason: "end_turn", origin: "any" }, file: "valid/result.completed.json" },
  { row: { stop_reason: "cancelled", origin: "parent_cancel" }, file: "valid/result.canceled.json" },
  { row: { stop_reason: "cancelled", origin: "reject_once" }, file: "valid/result.failed.permission_rejected.json" },
  { row: { stop_reason: "refusal", origin: "any" }, file: "valid/result.failed.refusal.json" },
  { row: { stop_reason: "max_tokens", origin: "any" }, file: "valid/result.failed.max_tokens.json" },
  { row: { stop_reason: "max_turn_requests", origin: "any" }, file: "valid/result.failed.max_turn_requests.json" }
];

describe("stop reason mapping and result examples", () => {
  it("covers every row of the mapping with a coherent result example", () => {
    assert.equal(MAPPED_EXAMPLES.length, mapping.length);
    for (const { row, file } of MAPPED_EXAMPLES) {
      const expected = mapping.find((item) => item.stop_reason === row.stop_reason && item.origin === row.origin);
      assert.ok(expected, `no mapping row for ${row.stop_reason}/${row.origin}`);
      const result = example(file);
      assert.equal(result.stop_reason, row.stop_reason, file);
      assert.deepEqual(
        { state: result.state, reason: result.reason },
        { state: expected.state, reason: expected.reason },
        file
      );
      assert.deepEqual(mapStopReason(mapping, result.stop_reason, row.origin), { state: result.state, reason: result.reason }, file);
    }
  });

  it("keeps the native cancelled stop reason and the failed state for a reject_once outcome", () => {
    const result = example("valid/result.failed.permission_rejected.json");
    assert.equal(result.stop_reason, "cancelled");
    assert.equal(result.state, "failed");
    assert.equal(result.canceled_by, null);
    assert.notEqual(result.state, "canceled");
  });
});

describe("terminal outcomes", () => {
  const terminal = new Set(terminalStates(table));

  it("has an example for each of the eleven failure reasons in the state table", () => {
    for (const reason of table.failed_reasons) {
      const result = example(`valid/result.failed.${reason}.json`);
      assert.equal(result.state, "failed", reason);
      assert.equal(result.reason, reason, reason);
      assert.ok(terminal.has(result.state), reason);
    }
    assert.equal(table.failed_reasons.length, 11);
  });

  it("gives every outcome a terminal state of the table", () => {
    const files = [
      "valid/result.completed.json",
      "valid/result.canceled.json",
      "valid/result.rejected.json",
      ...table.failed_reasons.map((reason) => `valid/result.failed.${reason}.json`)
    ];
    for (const file of files) {
      assert.ok(terminal.has(example(file).state), file);
    }
  });

  it("reports a rejected run without a launched process", () => {
    const result = example("valid/result.rejected.json");
    assert.equal(result.process.exit_code, null);
    assert.equal(result.process.signal, null);
    assert.equal(result.process.terminated_by_broker, false);
    assert.equal(result.started_at, null);
  });

  it("names who asked for a cancellation", () => {
    assert.equal(typeof example("valid/result.canceled.json").canceled_by, "string");
    assert.notEqual(example("valid/result.canceled.json").canceled_by, "");
  });
});

describe("normalized shape", () => {
  it("distinguishes a null usage value from zero", () => {
    const usage = example("valid/result.usage-null-vs-zero.json").usage;
    assert.equal(usage.input_tokens, null);
    assert.equal(usage.output_tokens, 0);
    assert.notEqual(usage.input_tokens, usage.output_tokens);
  });

  it("keeps the same key structure across adapters for the same outcome", () => {
    const a = example("valid/result.completed.adapter-a.json");
    const b = example("valid/result.completed.adapter-b.json");
    assert.deepEqual(keyPaths(a), keyPaths(b));
    assert.equal(a.state, b.state);
    assert.equal(a.reason, b.reason);
  });

  it("rejects a harness-specific field in the normalized result", () => {
    const validate = getValidator("result");
    assert.equal(validate(example("invalid/result.harness-extra-field.json")), false);
    assert.ok(validate.errors.some((error) => error.params?.additionalProperty === "adapter_pid"));
  });

  it("accepts a result whose native session identifier is null", () => {
    const validate = getValidator("result");
    assert.equal(validate(example("valid/result.completed.native-session-null.json")), true, JSON.stringify(validate.errors));
  });
});
