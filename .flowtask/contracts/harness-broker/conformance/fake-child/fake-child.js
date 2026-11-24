#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const scenarioPath = process.argv[2];

function fail(message) {
  process.stderr.write(`fake-child: ${message}\n`);
  process.exit(2);
}

if (!scenarioPath) {
  fail("usage: fake-child.js <scenario.json>");
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch (error) {
  fail(`cannot read scenario ${scenarioPath}: ${error.message}`);
}

const { behavior, steps } = scenario;
const recordFile = behavior.record_messages_to === null ? null : resolve(process.cwd(), behavior.record_messages_to);

let turn = null;
let pendingCancel = false;
const pendingResponses = new Map();
const queued = [];
let started = !behavior.start_after_stdin_end;
let nextRequestId = 1000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function exitWith(code) {
  process.stdout.write("", () => process.exit(code));
}

function finishTurn(current, stopReason, usage) {
  if (current.finished) return;
  current.finished = true;
  if (turn === current) turn = null;
  send({ id: current.promptId, result: { stopReason, usage } });
}

function waitForResponse(id) {
  return new Promise((done) => pendingResponses.set(id, done));
}

async function requestPermission(request, current) {
  const id = nextRequestId;
  nextRequestId += 1;
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId: scenario.session_id,
      toolCall: { toolCallId: "tool-1", ...request.tool },
      options: request.options.map((option) => ({ optionId: option.option_id, kind: option.kind, name: option.name }))
    }
  });
  const response = await waitForResponse(id);
  if (current.finished) return;
  const optionId = response.result?.outcome?.optionId;
  const option = request.options.find((item) => item.option_id === optionId);
  if (option === undefined) return;
  const branch = option.kind.startsWith("allow") ? request.on_allow_once : request.on_reject_once;
  await runSteps(branch, current);
}

async function runSteps(list, current) {
  for (const step of list) {
    if (current.finished) return;
    if ("emit_update" in step) {
      send({ method: "session/update", params: { sessionId: scenario.session_id, update: step.emit_update.update } });
    } else if ("delay_ms" in step) {
      await sleep(step.delay_ms);
    } else if ("print_raw" in step) {
      process.stdout.write(`${step.print_raw}\n`);
    } else if ("request_permission" in step) {
      await requestPermission(step.request_permission, current);
    } else if ("spawn_subprocess" in step) {
      const [program, ...args] = step.spawn_subprocess.command;
      spawn(program, args, { stdio: "ignore" });
    } else if ("end_turn" in step) {
      finishTurn(current, step.end_turn.stop_reason, step.end_turn.usage);
    } else if ("exit" in step) {
      exitWith(step.exit.code);
      return;
    } else if ("self_signal" in step) {
      process.kill(process.pid, step.self_signal);
      return;
    } else if ("hang" in step) {
      return;
    }
  }
}

function onPrompt(message) {
  if (pendingCancel) {
    pendingCancel = false;
    send({ id: message.id, result: { stopReason: "cancelled", usage: null } });
    return;
  }
  if (turn !== null) {
    send({ id: message.id, error: { code: -32000, message: "a turn is already in flight" } });
    return;
  }
  const current = { promptId: message.id, finished: false };
  turn = current;
  runSteps(steps, current);
}

function onCancel() {
  if (behavior.on_cancel !== "stop_turn") return;
  if (turn === null) {
    pendingCancel = true;
    return;
  }
  finishTurn(turn, "cancelled", null);
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    const resolveResponse = pendingResponses.get(message.id);
    if (resolveResponse !== undefined) {
      pendingResponses.delete(message.id);
      resolveResponse(message);
    }
    return;
  }
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: 1 } });
      break;
    case "session/new":
      if (scenario.new_session_error !== null) {
        send({ id: message.id, error: scenario.new_session_error });
      } else {
        send({ id: message.id, result: { sessionId: scenario.session_id } });
      }
      break;
    case "session/prompt":
      onPrompt(message);
      break;
    case "session/cancel":
      onCancel();
      break;
    default:
      process.stderr.write(`fake-child: ignored method ${message.method}\n`);
  }
}

function consume(line) {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("fake-child: ignored input that is not JSON\n");
    return;
  }
  if (recordFile !== null) {
    appendFileSync(recordFile, `${JSON.stringify(message)}\n`);
  }
  if (started) {
    handle(message);
  } else {
    queued.push(message);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    consume(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.length > 0) {
    consume(buffer);
    buffer = "";
  }
  if (!started) {
    started = true;
    for (const message of queued.splice(0)) {
      handle(message);
    }
  }
  if (behavior.on_stdin_end === "exit_0") {
    exitWith(0);
  }
});
