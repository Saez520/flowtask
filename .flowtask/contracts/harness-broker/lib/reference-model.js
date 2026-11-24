const CANCEL_ONLY_IF_TURN_LIVE = "only_if_turn_live";

function assertTable(table) {
  if (table === null || typeof table !== "object" || !Array.isArray(table.transitions) || !Array.isArray(table.terminal)) {
    throw new TypeError("state machine table is malformed");
  }
}

export function isTransitionAllowed(table, from, to) {
  assertTable(table);
  return table.transitions.some((transition) => transition.from === from && transition.to === to);
}

export function terminalStates(table) {
  assertTable(table);
  return [...table.terminal];
}

export function cancelPolicy(table, state, { turnLive }) {
  assertTable(table);
  if (typeof turnLive !== "boolean") {
    throw new TypeError("turnLive must be a boolean");
  }
  const policy = table.cancel_policy?.[state];
  if (policy === undefined) {
    throw new TypeError(`no cancellation policy for state ${state}`);
  }
  return {
    action: policy.action,
    sendToChild: policy.send_to_child === CANCEL_ONLY_IF_TURN_LIVE && turnLive
  };
}

function stateOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "state_changed") return events[index].payload.to;
  }
  return null;
}

export function checkEventLog(table, events) {
  assertTable(table);
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  if (events.length === 0) {
    return { ok: false, errors: ["the log has no events"] };
  }

  const errors = [];
  const runId = events[0].run_id;
  let state = null;
  let terminalAt = null;

  events.forEach((event, index) => {
    const position = index + 1;
    if (event.cursor !== position) {
      errors.push(`event at position ${position} has cursor ${event.cursor}; cursors must be consecutive from 1`);
    }
    if (event.run_id !== runId) {
      errors.push(`event at position ${position} belongs to another run`);
    }
    if (terminalAt !== null) {
      errors.push(`event at position ${position} follows the terminal state reached at position ${terminalAt}`);
      return;
    }
    if (index === 0) {
      const first = event.type === "state_changed" && event.payload.from === null && event.payload.to === table.initial;
      if (!first) {
        errors.push(`the first event must change the state from null to ${table.initial}`);
      }
    }
    if (event.type !== "state_changed") {
      return;
    }
    const { from, to } = event.payload;
    if (index > 0) {
      if (from !== state) {
        errors.push(`event at position ${position} leaves ${from} but the run was in ${state}`);
      }
      if (!isTransitionAllowed(table, from, to)) {
        errors.push(`transition ${from} to ${to} at position ${position} is not allowed`);
      }
    }
    state = to;
    if (table.terminal.includes(to)) {
      terminalAt = position;
    }
  });

  return { ok: errors.length === 0, errors };
}

export function readEvents(log, cursor) {
  if (log === null || log === undefined) {
    return { ok: false, error: { code: "unknown_run" } };
  }
  const last = log.events.length;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > last) {
    return { ok: false, error: { code: "invalid_cursor", last_valid_cursor: last } };
  }
  const events = log.events.slice(cursor);
  const nextCursor = events.length > 0 ? events[events.length - 1].cursor : cursor;
  return {
    ok: true,
    page: {
      run_id: log.run_id,
      state: stateOf(log.events),
      events,
      next_cursor: nextCursor,
      last_cursor: last
    }
  };
}

export function mapStopReason(mapping, stopReason, origin) {
  if (!Array.isArray(mapping)) {
    throw new TypeError("stop reason mapping must be an array");
  }
  const row =
    mapping.find((item) => item.stop_reason === stopReason && item.origin === origin) ??
    mapping.find((item) => item.stop_reason === stopReason && item.origin === "any");
  return row === undefined ? null : { state: row.state, reason: row.reason };
}
