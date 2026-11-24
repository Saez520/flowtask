import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getValidator, readSchema } from "../lib/schemas.js";
import { isTransitionAllowed, terminalStates } from "../lib/reference-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(readFileSync(join(ROOT, "state-machine.v1.json"), "utf8"));

const STATES = [
  "submitted",
  "working",
  "input_required",
  "auth_required",
  "completed",
  "failed",
  "canceled",
  "rejected"
];

const ORACLE_ALLOWED = [
  ["submitted", "working"],
  ["submitted", "rejected"],
  ["submitted", "failed"],
  ["submitted", "canceled"],
  ["working", "input_required"],
  ["working", "auth_required"],
  ["working", "completed"],
  ["working", "failed"],
  ["working", "canceled"],
  ["input_required", "working"],
  ["input_required", "failed"],
  ["input_required", "canceled"],
  ["auth_required", "working"],
  ["auth_required", "failed"],
  ["auth_required", "canceled"]
];

const ORACLE_TERMINAL = ["completed", "failed", "canceled", "rejected"];

const allPairs = STATES.flatMap((from) => STATES.map((to) => [from, to]));
const oracleKey = (from, to) => `${from}->${to}`;
const oracleSet = new Set(ORACLE_ALLOWED.map(([from, to]) => oracleKey(from, to)));

describe("state machine data", () => {
  it("validates against its schema", () => {
    const validate = getValidator("state-machine");
    assert.equal(validate(table), true, JSON.stringify(validate.errors));
  });

  it("lists the eight states and the four terminal states of the contract", () => {
    assert.deepEqual([...table.states].sort(), [...STATES].sort());
    assert.deepEqual([...table.terminal].sort(), [...ORACLE_TERMINAL].sort());
  });
});

describe("transitions", () => {
  it("allows exactly the fifteen transitions of the contract out of the 64 pairs", () => {
    assert.equal(allPairs.length, 64);
    const allowed = allPairs.filter(([from, to]) => isTransitionAllowed(table, from, to));
    assert.equal(allowed.length, 15);
    for (const [from, to] of allPairs) {
      assert.equal(
        isTransitionAllowed(table, from, to),
        oracleSet.has(oracleKey(from, to)),
        `${from} to ${to}`
      );
    }
  });

  it("gives no outgoing transition to any terminal state", () => {
    for (const terminal of ORACLE_TERMINAL) {
      for (const to of STATES) {
        assert.equal(isTransitionAllowed(table, terminal, to), false, `${terminal} to ${to} must be forbidden`);
      }
    }
    assert.deepEqual([...terminalStates(table)].sort(), [...ORACLE_TERMINAL].sort());
  });

  it("reaches rejected only from submitted", () => {
    const sources = allPairs
      .filter(([, to]) => to === "rejected")
      .filter(([from, to]) => isTransitionAllowed(table, from, to))
      .map(([from]) => from);
    assert.deepEqual(sources, ["submitted"]);
  });
});

describe("declared vocabularies", () => {
  const common = readSchema("common");

  it("lists the same failure reasons as the common definition", () => {
    assert.deepEqual([...table.failed_reasons].sort(), [...common.$defs.failed_reason.enum].sort());
  });

  it("lists the same pause causes as the common definitions", () => {
    assert.deepEqual(
      [...table.pause_causes.input_required].sort(),
      [...common.$defs.input_required_cause.enum].sort()
    );
    assert.deepEqual(
      [...table.pause_causes.auth_required].sort(),
      [...common.$defs.auth_required_cause.enum].sort()
    );
  });
});

describe("clocks", () => {
  it("runs no inactivity clock and keeps the wall clock in input_required and auth_required", () => {
    for (const state of ["input_required", "auth_required"]) {
      assert.equal(table.clocks[state].idle, false, `${state} idle clock`);
      assert.equal(table.clocks[state].wall, true, `${state} wall clock`);
    }
  });

  it("runs the first-event, idle and wall clocks in working", () => {
    assert.deepEqual(table.clocks.working, { first_event: true, idle: true, wall: true });
  });

  it("runs no clock in terminal states", () => {
    for (const terminal of ORACLE_TERMINAL) {
      assert.deepEqual(
        Object.values(table.clocks[terminal]),
        [false, false, false],
        `${terminal} must run no clock`
      );
    }
  });
});
