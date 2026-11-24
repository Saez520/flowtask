import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProfileYaml } from "../lib/authority.js";
import {
  buildLogEntry,
  decide,
  formatLogLine,
  logDecisionOf,
  parseLog,
  redactCommand
} from "../lib/authority-decision.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STANDARD = parseProfileYaml(
  readFileSync(join(ROOT, "examples", "authority", "valid", "authority-profile.standard.yaml"), "utf8")
).document;
const CWD = "/work/run";
const RUN_ID = "run-0001";

describe("terminal log entries", () => {
  it("records each attempt with its run, moment, directory, command, decision and rule", () => {
    const entry = buildLogEntry({
      run_id: RUN_ID,
      timestamp: "2026-11-23T20:00:03Z",
      cwd: CWD,
      command: "git status",
      decision: "allowed",
      rule: "shell.allow[0]",
      exit_code: 0
    });
    assert.deepEqual(Object.keys(entry), ["run_id", "timestamp", "cwd", "command", "decision", "rule", "exit_code"]);
    assert.equal(entry.rule, "shell.allow[0]");
    assert.equal(entry.exit_code, 0);
  });

  it("never records the value of an environment assignment", () => {
    const seeded = "SEEDED_SECRET_VALUE_42";
    const entry = buildLogEntry({
      run_id: RUN_ID,
      timestamp: "2026-11-23T20:00:03Z",
      cwd: CWD,
      command: `TOKEN=${seeded} npm test`,
      decision: "allowed",
      rule: "shell.allow[5]",
      exit_code: 0
    });
    assert.equal(entry.command, "TOKEN=<redacted> npm test");
    assert.equal(formatLogLine(entry).includes(seeded), false);
  });

  it("redacts every unquoted assignment word, in any position, and leaves flags alone", () => {
    assert.equal(redactCommand("npm test --token=x FOO=bar"), "npm test --token=x FOO=<redacted>");
    assert.equal(redactCommand('FOO="a b" run'), "FOO=<redacted> run");
    assert.equal(redactCommand('echo "FOO=kept"'), 'echo "FOO=kept"');
  });

  it("builds an entry that does not validate with a TypeError", () => {
    assert.throws(
      () =>
        buildLogEntry({
          run_id: RUN_ID,
          timestamp: "2026-11-23T20:00:04Z",
          cwd: CWD,
          command: "git push origin main",
          decision: "denied",
          rule: "shell.deny[0]",
          exit_code: 1
        }),
      TypeError
    );
  });

  it("writes one JSON object per line and reads the same entries back", () => {
    const entry = buildLogEntry({
      run_id: RUN_ID,
      timestamp: "2026-11-23T20:00:05Z",
      cwd: CWD,
      command: "curl https://example.com",
      decision: "asked",
      rule: null,
      exit_code: null
    });
    const line = formatLogLine(entry);
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.split("\n").length, 2);
    assert.deepEqual(parseLog(line), { ok: true, entries: [entry] });
  });

  it("reports the first invalid line of a log", () => {
    const valid = formatLogLine(
      buildLogEntry({
        run_id: RUN_ID,
        timestamp: "2026-11-23T20:00:03Z",
        cwd: CWD,
        command: "git status",
        decision: "allowed",
        rule: "shell.allow[0]",
        exit_code: 0
      })
    );
    const parsed = parseLog(`${valid}{"run_id":"run-0002"}\n`);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.line, 2);
  });

  it("treats an empty line in the middle of a log as invalid", () => {
    const valid = formatLogLine(
      buildLogEntry({
        run_id: RUN_ID,
        timestamp: "2026-11-23T20:00:03Z",
        cwd: CWD,
        command: "git status",
        decision: "allowed",
        rule: "shell.allow[0]",
        exit_code: 0
      })
    );
    assert.equal(parseLog(`${valid}\n${valid}`).ok, false);
  });

  it("maps the decisions of decide to the log decisions", () => {
    assert.equal(logDecisionOf("allow"), "allowed");
    assert.equal(logDecisionOf("deny"), "denied");
    assert.equal(logDecisionOf("ask_parent"), "asked");
  });
});

describe("a simulated run leaves one line per attempt", () => {
  const ASK = { ...STANDARD, on_uncovered: { ...STANDARD.on_uncovered, shell: "ask_parent" } };
  const attempts = ["git status", "git push origin main", "curl https://example.com"];

  it("records the allowed, denied and asked attempts with every field", () => {
    const lines = attempts.map((command, index) => {
      const decision = decide(ASK, { category: "shell", command }, { run_cwd: CWD, home: "/home/u" });
      const logDecision = logDecisionOf(decision.decision);
      return formatLogLine(
        buildLogEntry({
          run_id: RUN_ID,
          timestamp: `2026-11-23T20:00:0${index + 3}Z`,
          cwd: CWD,
          command,
          decision: logDecision,
          rule: decision.rule,
          exit_code: logDecision === "allowed" ? 0 : null
        })
      );
    });
    const parsed = parseLog(lines.join(""));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.command, entry.decision, entry.rule, entry.exit_code]),
      [
        ["git status", "allowed", "shell.allow[0]", 0],
        ["git push origin main", "denied", "shell.deny[0]", null],
        ["curl https://example.com", "asked", null, null]
      ]
    );
  });

  it("appends the parent answer as a further line", () => {
    const asked = buildLogEntry({
      run_id: RUN_ID,
      timestamp: "2026-11-23T20:00:05Z",
      cwd: CWD,
      command: "curl https://example.com",
      decision: "asked",
      rule: null,
      exit_code: null
    });
    const answered = buildLogEntry({
      run_id: RUN_ID,
      timestamp: "2026-11-23T20:00:09Z",
      cwd: CWD,
      command: "curl https://example.com",
      decision: "denied",
      rule: null,
      exit_code: null
    });
    const parsed = parseLog(formatLogLine(asked) + formatLogLine(answered));
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries[1].decision, "denied");
  });
});
