/**
 * Language gate of the worktree manager.
 *
 * The gate enumerates every human-readable text of the Python package, of its
 * standalone entry point and of the consumer entry point and compatibility
 * adapter. These tests exercise the gate over the real surfaces and over
 * disposable fixtures: the backend is never mocked and no real repository
 * state is used as a fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = path.join(ROOT, ".flowtask", "bin", "lib", "worktree-language-gate.py");
const ALLOWLIST = path.join(ROOT, ".flowtask", "bin", "lib", "worktree-language-allowlist.json");
const CONSUMER = path.join(ROOT, ".flowtask", "scripts", "worktree.sh");
const ADAPTER = path.join(ROOT, ".flowtask", "scripts", "worktree-adapter.sh");
const BASE = "166fc9961576fd313681d683d33dde92fb4c5f65";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ft-language-gate-"));
process.on("exit", () => { try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
}

function run(script, args, options = {}) {
  const result = spawnSync(script, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { ...result, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** A repository with the configuration the manager expects. */
function createRepository(name) {
  const repo = path.join(temporaryRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Language Gate");
  git(repo, "config", "user.email", "language-gate@example.invalid");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return repo;
}

/** The four surfaces of a disposable fixture. */
function createFixture(name) {
  const root = path.join(temporaryRoot, name);
  const manager = path.join(root, ".flowtask", "scripts", "worktree-manager");
  const scripts = path.join(root, ".flowtask", "scripts");
  write(path.join(scripts, "worktree.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    'MANAGER="$SCRIPT_DIR/worktree-manager/worktree.sh"',
    'if [[ ! -x "$MANAGER" ]]; then',
    "  printf '%s\\n' \"Worktree Manager standalone is missing or not initialized: $MANAGER\" >&2",
    "  exit 1",
    "fi",
    'exec "$MANAGER" "$@"',
    "",
  ].join("\n"));
  write(path.join(scripts, "worktree-adapter.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# The adapter publishes the manager output unchanged.",
    "printf '%s\\n' \"The compatibility adapter is available.\"",
    "",
  ].join("\n"));
  write(path.join(manager, "worktree.sh"), [
    "#!/bin/sh",
    "set -eu",
    "printf '%s\\n' \"The standalone manager is available.\"",
    "",
  ].join("\n"));
  write(path.join(manager, "worktree_manager", "__init__.py"), '"""Standalone fixture package."""\n');
  write(path.join(manager, "worktree_manager", "mcp_contract.py"), [
    '"""Fixture MCP contract."""',
    "TOOL_NAMES = (",
    '    "worktree_create", "worktree_complete", "worktree_cleanup",',
    '    "worktree_recover", "worktree_list", "worktree_prune", "worktree_status",',
    ")",
    "",
  ].join("\n"));
  write(path.join(manager, "worktree_manager", "mcp_operations.py"), '"""Fixture MCP façade over the canonical lifecycle."""\n');
  write(path.join(manager, "worktree_manager", "mcp_server.py"), '"""Fixture MCP server."""\n');
  write(path.join(manager, "worktree_manager", "mcp_transport.py"), '"""Fixture MCP transport."""\n');
  return { root, manager };
}

/** Run the gate over a root and return its result and its inventory. */
function runGate(options) {
  const inventory = options.inventory ?? path.join(temporaryRoot, "inventory.json");
  const result = run("python3", [
    "-B", GATE,
    "--root", options.root,
    "--manager", options.manager,
    "--allowlist", options.allowlist ?? ALLOWLIST,
    "--inventory", inventory,
    "--base", options.base ?? BASE,
    "--check",
  ], { cwd: options.root });
  return { ...result, inventory, document: fs.existsSync(inventory) ? readJson(inventory) : null };
}

/** An allowlist document with one more exact exception. */
function allowlistWith(exception) {
  const file = path.join(temporaryRoot, `allowlist-${exception.id}.json`);
  const document = readJson(ALLOWLIST);
  document.exceptions = [...document.exceptions, exception];
  write(file, `${JSON.stringify(document, null, 2)}\n`);
  return file;
}

const EXCEPTION = (id, literal, scope = "python-package") => ({
  id,
  category: "english-loanword",
  literal,
  scope,
  reason: "Fixture exception used by the language gate tests.",
  owner: "Language gate tests",
});

test("A: the consumer and the adapter report the missing manager in English", () => {
  const root = path.join(temporaryRoot, "missing-manager");
  const scripts = path.join(root, ".flowtask", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(CONSUMER, path.join(scripts, "worktree.sh"));
  fs.copyFileSync(ADAPTER, path.join(scripts, "worktree-adapter.sh"));
  const expected = `Worktree Manager standalone is missing or not initialized: ${path.join(scripts, "worktree-manager", "worktree.sh")}`;

  for (const script of ["worktree.sh", "worktree-adapter.sh"]) {
    const result = run("bash", [path.join(scripts, script), "list"], { cwd: root });
    assert.equal(result.status, 1, `${script}: the missing manager is an error`);
    assert.equal(result.stdout, "", `${script}: nothing is published on stdout`);
    assert.equal(result.stderr.trim(), expected, `${script}: the diagnostic is exact`);
    assert.doesNotMatch(result.stderr, /ausente|inicializado/, `${script}: no Spanish text remains`);
  }
});

test("B: the consumer publishes the version and the help in English", () => {
  const version = run(CONSUMER, ["--version"], { cwd: temporaryRoot });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "1.0.0");

  const help = run(CONSUMER, ["--help"], { cwd: temporaryRoot });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /target-direct/);
  assert.doesNotMatch(help.stdout, /[áéíóúñ¿¡]/i);

  const targetHelp = run(CONSUMER, ["target-direct", "--help"], { cwd: temporaryRoot });
  assert.equal(targetHelp.status, 0, targetHelp.stderr);
  for (const action of ["create", "link-parent", "abort", "complete", "recover"]) {
    assert.match(targetHelp.stdout, new RegExp(action), `the help publishes ${action}`);
  }
});

test("C: the usage error publishes one JSON document and nothing else", () => {
  const result = run(CONSUMER, ["--json", "--wat"], { cwd: temporaryRoot });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stderr, "", "the usage error writes nothing on stderr");
  const document = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(document).sort(), [
    "contract_version", "data", "error", "operation", "result", "tool_version", "warnings",
  ]);
  assert.equal(document.error.code, "usage_error");
  assert.equal(document.error.exit_code, 2);
  assert.equal(document.result, "failure");
});

test("F: a Spanish comment is pending and it names the path and the line", () => {
  const fixture = createFixture("spanish-comment");
  const sample = path.join(fixture.manager, "worktree_manager", "sample.py");
  write(sample, "# Este archivo está en español\n");
  const result = runGate(fixture);
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /spanish_signal/);
  assert.match(result.stderr, /sample\.py/);
  const entry = result.document.entries.find((item) => item.path === "worktree_manager/sample.py");
  assert.equal(entry.status, "pending");
  assert.equal(entry.reason, "spanish_signal");
  assert.equal(entry.line, 1);
});

test("G: a Spanish message is pending and it names the path and the line", () => {
  const fixture = createFixture("spanish-message");
  const sample = path.join(fixture.manager, "worktree_manager", "sample.py");
  write(sample, 'print("Hola mundo")\n');
  const result = runGate(fixture);
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /spanish_signal/);
  const entry = result.document.entries.find((item) => item.path === "worktree_manager/sample.py");
  assert.equal(entry.status, "pending");
  assert.equal(entry.reason, "spanish_signal");
  assert.equal(entry.text, "Hola mundo");
});

test("H: an exact exception that covers a complete message is rejected", () => {
  const fixture = createFixture("whole-message");
  write(path.join(fixture.manager, "worktree_manager", "sample.py"), 'print("Hola mundo")\n');
  const allowlist = allowlistWith(EXCEPTION("L-EX-002", "Hola mundo"));
  const result = runGate({ ...fixture, allowlist });
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /whole_message_exemption/);
});

test("I: an exact exception that covers most of a message is rejected", () => {
  const fixture = createFixture("wide-exception");
  write(path.join(fixture.manager, "worktree_manager", "sample.py"), 'print("Hola mundo cruel hoy")\n');
  const allowlist = allowlistWith(EXCEPTION("L-EX-002", "Hola mundo cruel"));
  const result = runGate({ ...fixture, allowlist });
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /whole_message_exemption/);
});

test("J: an exact exception that matches nothing is rejected", () => {
  const fixture = createFixture("stale-exception");
  const allowlist = allowlistWith(EXCEPTION("L-EX-002", "xyzzy-not-present"));
  const result = runGate({ ...fixture, allowlist });
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /stale_allowlist_entry/);
});

test("K: a duplicated exception is rejected", () => {
  const fixture = createFixture("duplicate-exception");
  const allowlist = allowlistWith(EXCEPTION("L-EX-001", "façade"));
  const result = runGate({ ...fixture, allowlist });
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /duplicate_allowlist_entry/);
});

test("L: a fixture without human text is reported and does not fail the gate", () => {
  const fixture = createFixture("quiet-module");
  write(path.join(fixture.manager, "worktree_manager", "quiet.py"), "VALUE = 1\n");
  const result = runGate(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.document.files_without_human_text.includes("worktree_manager/quiet.py"));
  assert.equal(result.document.summary.pending, 0);
});

test("M: a manager that does not publish seven tools is rejected", () => {
  const fixture = createFixture("broken-mcp");
  write(path.join(fixture.manager, "worktree_manager", "mcp_contract.py"), '"""Fixture MCP contract."""\nTOOL_NAMES = ()\n');
  const result = runGate(fixture);
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /mcp_integration_unverified/);
});

test("N: a missing surface is rejected", () => {
  const fixture = createFixture("missing-surface");
  fs.rmSync(path.join(fixture.root, ".flowtask", "scripts", "worktree-adapter.sh"));
  const result = runGate(fixture);
  assert.equal(result.status, 1, "the gate fails closed");
  assert.match(result.stderr, /missing_surface/);
});

test("O: the command envelope keeps its keys and its types", () => {
  const repo = createRepository("contract-envelope");
  const result = run(CONSUMER, ["--json", "--repo", repo, "list"], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(document).sort(), [
    "contract_version", "data", "error", "operation", "result", "tool_version", "warnings",
  ]);
  assert.equal(document.contract_version, 1);
  assert.equal(typeof document.tool_version, "string");
  assert.equal(document.operation, "list");
  assert.equal(document.result, "success");
  assert.equal(typeof document.data, "object");
  assert.ok(Array.isArray(document.warnings));
  assert.equal(document.error, null);
  assert.equal("output" in document.data, false, "the envelope does not publish an output field");
  assert.ok(Array.isArray(document.data.worktrees));
});

test("P: the list without JSON is byte for byte the Git porcelain", () => {
  const repo = createRepository("contract-porcelain");
  const listed = run(CONSUMER, ["--repo", repo, "list"], { cwd: repo });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, git(repo, "worktree", "list", "--porcelain"));
});

test("Q: the protocol request publishes the nine key envelope", () => {
  const repo = createRepository("contract-protocol");
  const request = path.join(temporaryRoot, "request.json");
  fs.writeFileSync(request, JSON.stringify({ operation: "worktree_list", repo }));
  const result = run(CONSUMER, ["--request-json", request], { cwd: repo });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "the protocol envelope writes nothing on stderr");
  const document = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(document).sort(), [
    "contract_version", "data", "error", "operation", "repository", "result",
    "tool_version", "transaction_id", "warnings",
  ]);

  const invalid = path.join(temporaryRoot, "invalid-request.json");
  fs.writeFileSync(invalid, JSON.stringify({ operation: "not_a_tool", repo }));
  const rejected = run(CONSUMER, ["--request-json", invalid], { cwd: repo });
  assert.equal(rejected.status, 3, rejected.stderr);
  assert.equal(rejected.stderr, "");
  const failure = JSON.parse(rejected.stdout);
  assert.equal(failure.error.code, "invalid_request");
  assert.equal(failure.error.exit_code, 3);
});

test("S: the public exit codes keep their observable classification", () => {
  const repository = createRepository("exit-codes");

  const success = run(CONSUMER, ["--repo", repository, "list"], { cwd: repository });
  assert.equal(success.status, 0, "0 is the success code");

  const usage = run(CONSUMER, ["--json", "--wat"], { cwd: repository });
  assert.equal(usage.status, 2, "2 is the invalid usage code");

  const relative = run(CONSUMER, ["--repo", "relative", "list"], { cwd: repository });
  assert.equal(relative.status, 3, "3 is the invalid identity code");

  const created = run(CONSUMER, ["create", "dirty", "--base", "main"], { cwd: repository });
  assert.equal(created.status, 0, created.stderr);
  const worktree = path.join(repository, ".worktrees", "dirty");
  fs.writeFileSync(path.join(worktree, "change.txt"), "change\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "worktree change");
  fs.appendFileSync(path.join(repository, "base.txt"), "local\n");
  const conflict = run(CONSUMER, ["complete", "dirty", "--base", "main"], { cwd: repository });
  assert.equal(conflict.status, 5, "5 is the conflict and intervention code");
  assert.match(conflict.stderr, /uncommitted changes/);
});

test("T: an invalid target descriptor phase exits 4", () => {
  const parent = createRepository("descriptor-parent");
  const target = createRepository("descriptor-target");
  fs.mkdirSync(path.join(parent, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(parent, "vendor", "tool.txt"), "tool\n");
  git(parent, "add", ".");
  git(parent, "commit", "-qm", "submodule path");

  const created = run(CONSUMER, [
    "--repo", target, "target-direct", "create", "descriptor-work",
    "--parent-repo", parent, "--submodule-path", "vendor/tool",
  ], { cwd: parent });
  assert.equal(created.status, 0, created.stderr);

  const rejected = run(CONSUMER, [
    "--repo", target, "target-direct", "complete", "descriptor-work",
    "--parent-repo", parent, "--submodule-path", "vendor/tool",
  ], { cwd: parent });
  assert.equal(rejected.status, 4, "4 is the invalid descriptor phase code");
  assert.match(rejected.stderr, /Descriptor phase does not permit complete/);
});

test("U: the four compatibility notices stay exact and in English", () => {
  const source = fs.readFileSync(ADAPTER, "utf8");
  const notices = source.split("\n").filter((line) => line.includes("notice \"Compatibility:"));
  assert.equal(notices.length, 4, "the adapter publishes exactly four compatibility notices");
  const expected = [
    "Compatibility: legacy FlowTask configuration ignored because --config was provided.",
    "Compatibility: legacy FlowTask preserveDirty setting applied.",
    "Compatibility: canonical transaction $transaction is authoritative; legacy copy left unchanged.",
    "Compatibility: legacy FlowTask transaction $transaction imported for recovery.",
  ];
  for (const notice of expected) {
    assert.ok(source.includes(notice), `the adapter keeps the notice: ${notice}`);
  }
});

test("V: the gate is not an operator switch and the allowlist stays an artifact", () => {
  const document = readJson(ALLOWLIST);
  assert.equal(document.schema, "worktree-language-allowlist/v1");
  assert.equal(document.policy, "literal-level");
  for (const identifier of [
    "L-CMD", "L-PATH", "L-ENV", "L-REF", "L-CONF", "L-ID", "L-ACRONYM", "L-CMDNAME", "L-PROTO",
  ]) {
    assert.ok(document.categories[identifier], `the allowlist declares ${identifier}`);
  }
  assert.equal(document.exceptions.length, 1);
  assert.equal(document.exceptions[0].id, "L-EX-001");
  assert.equal(document.exceptions[0].scope, "python-package");
  const consumer = fs.readFileSync(CONSUMER, "utf8");
  assert.doesNotMatch(consumer, /allowlist/i, "the product does not expose the allowlist");
});
