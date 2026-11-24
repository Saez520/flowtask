import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = join(ROOT, "conformance", "fake-child", "fake-child.js");
const SCENARIOS = join(ROOT, "conformance", "scenarios");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const running = new Set();

afterEach(() => {
  for (const child of running) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group already ended.
    }
  }
  running.clear();
});

class Session {
  constructor(child) {
    this.child = child;
    this.raw = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        this.raw.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stdout.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.resume();
    this.exited = new Promise((done) => {
      child.on("exit", (code, signal) => done({ code, signal }));
    });
  }

  get messages() {
    return this.raw.map(parseOrNull).filter((item) => item !== null);
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  async waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found !== undefined) return found;
      await sleep(10);
    }
    throw new Error(`no matching message within ${timeoutMs} ms; got ${JSON.stringify(this.raw)}`);
  }

  responseTo(id) {
    return (message) => message.id === id && message.method === undefined;
  }
}

function parseOrNull(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && parsed.jsonrpc === "2.0" ? parsed : null;
  } catch {
    return null;
  }
}

function start(name) {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-child-"));
  const child = spawn(process.execPath, [CHILD, join(SCENARIOS, `${name}.json`)], {
    cwd: dir,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  running.add(child);
  return { session: new Session(child), dir };
}

async function open(session) {
  session.write({ id: 1, method: "initialize", params: {} });
  await session.waitFor(session.responseTo(1));
  session.write({ id: 2, method: "session/new", params: { cwd: "/" } });
  return session.waitFor(session.responseTo(2));
}

async function prompt(session, id = 3) {
  session.write({ id, method: "session/prompt", params: { sessionId: "session-1", prompt: [] } });
  return id;
}

describe("simulated child: turn outcomes", () => {
  it("closes a turn with end_turn", async () => {
    const { session } = start("end-turn");
    await open(session);
    const id = await prompt(session);
    const response = await session.waitFor(session.responseTo(id));
    assert.equal(response.result.stopReason, "end_turn");
  });

  for (const [name, stopReason] of [
    ["stop-reason-refusal", "refusal"],
    ["stop-reason-max-tokens", "max_tokens"],
    ["stop-reason-max-turn-requests", "max_turn_requests"]
  ]) {
    it(`reports the native stop reason of ${name}`, async () => {
      const { session } = start(name);
      await open(session);
      const id = await prompt(session);
      const response = await session.waitFor(session.responseTo(id));
      assert.equal(response.result.stopReason, stopReason);
    });
  }

  it("answers session/new with the protocol error for a missing agent", async () => {
    const { session } = start("launch-error-agent-not-found");
    session.write({ id: 1, method: "initialize", params: {} });
    await session.waitFor(session.responseTo(1));
    session.write({ id: 2, method: "session/new", params: { cwd: "/" } });
    const response = await session.waitFor(session.responseTo(2));
    assert.equal(response.error.code, -32602);
  });
});

describe("simulated child: silence and output", () => {
  it("emits nothing for 500 ms when it stays silent", async () => {
    const { session } = start("silent");
    await open(session);
    const before = session.raw.length;
    await prompt(session);
    await sleep(500);
    assert.equal(session.raw.length, before);
  });

  it("prints only lines that are not protocol messages when it prints help", async () => {
    const { session } = start("help-on-stdout");
    await open(session);
    const before = session.raw.length;
    await prompt(session);
    await sleep(300);
    const fresh = session.raw.slice(before);
    assert.equal(fresh.length, 3);
    assert.ok(fresh.every((line) => parseOrNull(line) === null));
  });

  it("emits one update and then stays silent", async () => {
    const { session } = start("first-event-then-silent");
    await open(session);
    await prompt(session);
    await sleep(300);
    const updates = session.messages.filter((message) => message.method === "session/update");
    assert.equal(updates.length, 1);
    await sleep(200);
    assert.equal(session.messages.filter((message) => message.method === "session/update").length, 1);
  });

  it("keeps emitting updates at a steady rate", async () => {
    const { session } = start("constant-activity");
    await open(session);
    await prompt(session);
    await sleep(700);
    const updates = session.messages.filter((message) => message.method === "session/update");
    assert.ok(updates.length >= 5, `expected at least 5 updates, got ${updates.length}`);
  });
});

describe("simulated child: permissions", () => {
  it("asks for a permission with four options and continues after allow_once", async () => {
    const { session } = start("permission-request");
    await open(session);
    const id = await prompt(session);
    const request = await session.waitFor((message) => message.method === "session/request_permission");
    assert.equal(request.params.options.length, 4);
    assert.deepEqual(
      request.params.options.map((option) => option.kind),
      ["allow_once", "allow_always", "reject_once", "reject_always"]
    );
    session.write({ id: request.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    const response = await session.waitFor(session.responseTo(id));
    assert.equal(response.result.stopReason, "end_turn");
    assert.ok(session.messages.some((message) => message.params?.update?.content?.text === "Command allowed"));
  });

  it("ends the whole turn with cancelled after reject_once, as the OpenCode harness does", async () => {
    const { session } = start("permission-reject-once-aborts-turn");
    await open(session);
    const id = await prompt(session);
    const request = await session.waitFor((message) => message.method === "session/request_permission");
    session.write({ id: request.id, result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
    const response = await session.waitFor(session.responseTo(id));
    assert.equal(response.result.stopReason, "cancelled");
  });
});

describe("simulated child: exits", () => {
  it("dies by SIGKILL when it kills itself", async () => {
    const { session } = start("exit-signal-sigkill");
    await open(session);
    await prompt(session);
    const exit = await session.exited;
    assert.equal(exit.signal, "SIGKILL");
  });

  it("exits with code 1 when the scenario asks for it", async () => {
    const { session } = start("exit-code-1");
    await open(session);
    await prompt(session);
    const exit = await session.exited;
    assert.equal(exit.code, 1);
  });

  it("exits with code 0 when stdin closes while a turn is in flight", async () => {
    const { session } = start("exit-zero-in-flight");
    await open(session);
    await prompt(session);
    await session.waitFor((message) => message.method === "session/update");
    session.child.stdin.end();
    const exit = await session.exited;
    assert.equal(exit.code, 0);
    assert.equal(session.messages.some((message) => message.result?.stopReason !== undefined), false);
  });
});

describe("simulated child: cancellation", () => {
  it("keeps the turn alive after session/cancel when it ignores cancellation", async () => {
    const { session } = start("ignore-cancel");
    await open(session);
    const id = await prompt(session);
    await session.waitFor((message) => message.method === "session/update");
    session.write({ method: "session/cancel", params: { sessionId: "session-1" } });
    await sleep(500);
    assert.equal(session.messages.some(session.responseTo(id)), false);
    assert.equal(session.child.exitCode, null);
  });

  it("closes a live turn with cancelled and leaves its subprocess in the group", async () => {
    const { session } = start("cancel-live-turn-spawns-child");
    await open(session);
    const id = await prompt(session);
    await sleep(100);
    session.write({ method: "session/cancel", params: { sessionId: "session-1" } });
    const response = await session.waitFor(session.responseTo(id));
    assert.equal(response.result.stopReason, "cancelled");
  });

  it("applies a cancellation that arrived after the turn ended to the next prompt only", async () => {
    const { session, dir } = start("late-cancel-aborts-next-prompt");
    await open(session);
    const first = await prompt(session, 3);
    await session.waitFor(session.responseTo(first));
    session.write({ method: "session/cancel", params: { sessionId: "session-1" } });
    await sleep(100);
    const second = await prompt(session, 4);
    const response = await session.waitFor(session.responseTo(second));
    assert.equal(response.result.stopReason, "cancelled");
    const recorded = readFileSync(join(dir, "messages.ndjson"), "utf8");
    assert.ok(recorded.includes('"method":"session/cancel"'));
  });
});

describe("simulated child: standard input", () => {
  it("answers nothing until its standard input closes", async () => {
    const { session } = start("mute-unless-stdin-closed");
    session.write({ id: 1, method: "initialize", params: {} });
    session.write({ id: 2, method: "session/new", params: { cwd: "/" } });
    await prompt(session);
    await sleep(300);
    assert.equal(session.raw.length, 0);
    session.child.stdin.end();
    const response = await session.waitFor(session.responseTo(3));
    assert.equal(response.result.stopReason, "end_turn");
  });
});
