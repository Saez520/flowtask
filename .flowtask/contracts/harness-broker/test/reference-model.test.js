import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelPolicy,
  checkEventLog,
  mapStopReason,
  readEvents,
  terminalStates
} from "../lib/reference-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const table = JSON.parse(readFileSync(join(ROOT, "state-machine.v1.json"), "utf8"));
const adapter = JSON.parse(readFileSync(join(ROOT, "adapter-interface.v1.json"), "utf8"));
const RUN = "run-0001";

function logOf(entries) {
  return entries.map((entry, index) => ({
    run_id: RUN,
    cursor: index + 1,
    timestamp: `2026-11-23T20:00:${String(index).padStart(2, "0")}Z`,
    ...entry
  }));
}

const change = (from, to, extra = {}) => ({
  type: "state_changed",
  payload: { from, to, ...extra }
});

const SUBMITTED = change(null, "submitted");
const WORKING = change("submitted", "working");

const PERMISSION_CYCLE = logOf([
  SUBMITTED,
  WORKING,
  { type: "agent_message", payload: { text: "Reading." } },
  {
    type: "permission_requested",
    payload: {
      request_id: "request-1",
      tool_call_id: "tool-1",
      tool: { kind: "execute", title: null },
      options: [{ option_id: "allow_once", kind: "allow_once", name: "Allow once" }]
    }
  },
  change("working", "input_required", { cause: "permission_pending" }),
  {
    type: "permission_resolved",
    payload: { request_id: "request-1", option_id: "allow_once", option_kind: "allow_once", decided_by: "parent" }
  },
  change("input_required", "working"),
  change("working", "completed", { reason: null })
]);

const NO_FIRST_EVENT = logOf([SUBMITTED, WORKING, change("working", "failed", { reason: "no_first_event" })]);

describe("checkEventLog on valid logs", () => {
  it("accepts the full permission cycle to completion", () => {
    assert.deepEqual(checkEventLog(table, PERMISSION_CYCLE), { ok: true, errors: [] });
  });

  it("accepts a run that fails with no_first_event", () => {
    assert.deepEqual(checkEventLog(table, NO_FIRST_EVENT), { ok: true, errors: [] });
  });
});

describe("checkEventLog on broken logs", () => {
  const cases = {
    "a cursor gap": logOf([SUBMITTED, WORKING]).map((event, index) => (index === 1 ? { ...event, cursor: 3 } : event)),
    "a repeated cursor": logOf([SUBMITTED, WORKING]).map((event, index) => (index === 1 ? { ...event, cursor: 1 } : event)),
    "an event after the terminal state": logOf([
      SUBMITTED,
      WORKING,
      change("working", "completed", { reason: null }),
      { type: "agent_message", payload: { text: "late" } }
    ]),
    "a from that does not match the current state": logOf([
      SUBMITTED,
      change("input_required", "working")
    ]),
    "a transition the table does not allow": logOf([SUBMITTED, change("submitted", "completed", { reason: null })])
  };

  for (const [name, log] of Object.entries(cases)) {
    it(`rejects ${name}`, () => {
      const result = checkEventLog(table, log);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    });
  }

  it("rejects a log whose first event is not the move from null to submitted", () => {
    const result = checkEventLog(table, logOf([WORKING]));
    assert.equal(result.ok, false);
  });

  it("rejects an empty log", () => {
    assert.equal(checkEventLog(table, []).ok, false);
  });
});

describe("readEvents", () => {
  const LOG = { run_id: RUN, events: PERMISSION_CYCLE };
  const N = PERMISSION_CYCLE.length;

  it("returns every event from cursor 0", () => {
    const result = readEvents(LOG, 0);
    assert.equal(result.ok, true);
    assert.equal(result.page.events.length, N);
    assert.equal(result.page.next_cursor, N);
    assert.equal(result.page.last_cursor, N);
  });

  it("returns only the events after an intermediate cursor", () => {
    const result = readEvents(LOG, 3);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.page.events.map((event) => event.cursor),
      [4, 5, 6, 7, 8]
    );
    assert.equal(result.page.next_cursor, N);
  });

  it("returns an empty page with the same cursor when reading from the last cursor", () => {
    const first = readEvents(LOG, N);
    assert.equal(first.ok, true);
    assert.deepEqual(first.page.events, []);
    assert.equal(first.page.next_cursor, N);
    assert.deepEqual(readEvents(LOG, N), first);
  });

  it("gives the same result when reading twice from the same cursor", () => {
    assert.deepEqual(readEvents(LOG, 2), readEvents(LOG, 2));
  });

  for (const [label, cursor] of [
    ["a negative cursor", -1],
    ["a non-numeric cursor", "x"],
    ["a cursor past the last event", N + 1]
  ]) {
    it(`rejects ${label} with the last valid cursor`, () => {
      const result = readEvents(LOG, cursor);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid_cursor");
      assert.equal(result.error.last_valid_cursor, N);
    });
  }

  it("reports an unknown run when there is no log", () => {
    const result = readEvents(null, 0);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "unknown_run");
  });
});

describe("cancelPolicy", () => {
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

  for (const state of STATES) {
    for (const turnLive of [true, false]) {
      it(`resolves ${state} with turnLive ${turnLive}`, () => {
        const result = cancelPolicy(table, state, { turnLive });
        const expectedAction = table.cancel_policy[state].action;
        const expectedSend = table.cancel_policy[state].send_to_child === "only_if_turn_live" && turnLive;
        assert.deepEqual(result, { action: expectedAction, sendToChild: expectedSend });
      });
    }
  }

  it("returns noop and no child message for every terminal state with no live turn", () => {
    for (const terminal of terminalStates(table)) {
      assert.deepEqual(cancelPolicy(table, terminal, { turnLive: false }), {
        action: "noop_return_terminal",
        sendToChild: false
      });
    }
  });

  it("does not send a late cancellation to the child once the turn has ended", () => {
    assert.equal(cancelPolicy(table, "working", { turnLive: false }).sendToChild, false);
  });
});

describe("mapStopReason", () => {
  const mapping = adapter.stop_reason_mapping;

  it("maps each row of the contract mapping", () => {
    assert.equal(mapping.length, 6);
    for (const row of mapping) {
      assert.deepEqual(mapStopReason(mapping, row.stop_reason, row.origin), {
        state: row.state,
        reason: row.reason
      });
    }
  });

  it("keeps a cancellation caused by reject_once apart from a parent cancellation", () => {
    assert.deepEqual(mapStopReason(mapping, "cancelled", "reject_once"), {
      state: "failed",
      reason: "permission_rejected"
    });
    assert.deepEqual(mapStopReason(mapping, "cancelled", "parent_cancel"), {
      state: "canceled",
      reason: null
    });
  });

  it("returns null for a stop reason the mapping does not know", () => {
    assert.equal(mapStopReason(mapping, "unknown_reason", "any"), null);
  });
});

describe("adapter interface integrity", () => {
  const casesPath = join(ROOT, "conformance", "cases.v1.json");
  const casesPresent = existsSync(casesPath);

  it("names each operation once with a non-empty list of required behaviours", () => {
    const names = adapter.operations.map((operation) => operation.name);
    assert.equal(new Set(names).size, names.length);
    for (const operation of adapter.operations) {
      assert.ok(operation.required_behaviors.length > 0, `${operation.name} has no required behaviour`);
    }
  });

  it("cites only conformance cases that exist in the catalogue", { skip: casesPresent ? false : "conformance/cases.v1.json is created in a later task" }, () => {
    const catalogue = JSON.parse(readFileSync(casesPath, "utf8"));
    const known = new Set(catalogue.cases.map((item) => item.id));
    for (const operation of adapter.operations) {
      for (const behaviour of operation.required_behaviors) {
        for (const id of behaviour.cases) {
          assert.ok(known.has(id), `${behaviour.id} cites unknown case ${id}`);
        }
      }
    }
  });
});
