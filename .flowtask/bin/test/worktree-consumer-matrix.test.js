/**
 * Contract matrix of the worktree consumer.
 *
 * The consumer wrapper is driven against the real manager over both real
 * transports (command line and stdio MCP) and against two independent
 * repositories. Every cell runs the real manager: the backend is never
 * mocked, the requests are compared after serialization and the envelopes are
 * the ones published by the manager.
 *
 * The mismatch classes reproduce the direct transport matrix: the request that
 * reaches the manager is deliberately altered at the transport boundary after
 * the wrapper has planned it, so the manager answers with its real rejection
 * and the wrapper has to report it without mutating either repository.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorktreeConsumerAdapter } from "../lib/worktree-consumer-adapter.js";
import { AUTHORIZATION, TOOL_FIELDS } from "../lib/worktree-consumer-contract.js";
import { createWorktreeCliClient } from "../../plugins/flowtask-permission-gate/dist/index.js";
import { createWorktreeMcpClient } from "../../plugins/flowtask-permission-gate/dist/worktree-mcp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MANAGER = path.resolve(
  process.env.WORKTREE_MANAGER_SUBMODULE || path.join(ROOT, ".flowtask", "scripts", "worktree-manager"),
);

/** The twelve mismatch classes covered by the matrix. */
const CASES = [
  "happy", "operation", "repo", "work_id", "confirm_false", "transaction_id",
  "plan_hash", "operation_repo", "transaction_hash", "repo_work_id", "confirm_hash",
  "three_dimensions",
];
const TRANSPORTS = ["cli", "mcp"];
const REPOSITORIES = ["A", "B"];

/** Cases that need a worktree, and the ones that need a commit on it. */
const NEEDS_WORKTREE = ["confirm_false", "confirm_hash", "transaction_id", "transaction_hash"];
const NEEDS_COMMIT = ["transaction_id", "transaction_hash"];

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ft-consumer-matrix-"));
process.on("exit", () => { try { fs.rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
}

/** A repository with the configuration the manager expects. */
function createFixture(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Consumer Matrix");
  git(repo, "config", "user.email", "matrix@example.invalid");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\nstate/\nbackups/\nlocks/\n");
  fs.writeFileSync(
    path.join(repo, ".worktree-manager.conf"),
    "state_dir=state\nbackup_dir=backups\nbackup_ref_prefix=manager/backups\n" +
    "branch_prefix=worktree/\nlock_dir=locks\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
}

/** Files the manager keeps inside the repository state directory. */
function stateFiles(repo) {
  const gitDir = path.join(repo, ".git");
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const parts = path.relative(repo, full).split(path.sep);
        if (parts.includes("state") || parts.includes("locks")) found.push(path.relative(gitDir, full));
      }
    }
  };
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) walk(gitDir);
  return found.sort();
}

/** The observable state of a repository, compared before and after a call. */
function stateOf(repo) {
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    index: git(repo, "ls-files", "--stage"),
    status: git(repo, "status", "--porcelain=v2", "--untracked-files=all"),
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    worktrees: git(repo, "worktree", "list", "--porcelain"),
    state_files: stateFiles(repo),
  };
}

function worktreeCount(repo) {
  return git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
}

/** The canonical request the wrapper receives for one case. */
function requestFor(caseName, repo) {
  const work_id = `matrix-${repo.toLowerCase()}-${caseName.replace(/_/g, "-")}`;
  if (caseName === "confirm_false" || caseName === "confirm_hash") {
    return { operation: "cleanup", repo_root: repo, work_id, base: "main", confirm: true, authorization: AUTHORIZATION };
  }
  if (caseName === "transaction_id" || caseName === "transaction_hash") {
    return { operation: "complete", repo_root: repo, work_id, base: "main", confirm: true, authorization: AUTHORIZATION };
  }
  return { operation: "create", repo_root: repo, work_id, base: "main" };
}

/** The rejection the manager publishes for one case. */
function expectedFor(caseName) {
  if (caseName === "happy") return { code: "success", message: "" };
  if (caseName === "confirm_false" || caseName === "confirm_hash") {
    return { code: "invalid_request", message: "authorization_mismatch" };
  }
  return { code: "plan_mismatch", message: "Repository state or request changed since preflight" };
}

/**
 * Alter the request that reaches the manager, after the wrapper planned it.
 *
 * Only the execute request is altered, so the preflight stays the plan the
 * manager published and the execute contradicts it in one documented way.
 */
function applyAlteration(context, caseName, otherRepo) {
  const payload = context.transport === "cli" ? context.document : context.args;
  if (payload.dry_run !== false) return;
  const setOperation = (tool) => {
    if (context.transport === "cli") context.document.operation = tool;
    else context.tool = tool;
    // The altered request is a valid request of the new operation, so the
    // manager rejects it for the contradiction and not for its shape.
    const allowed = new Set(TOOL_FIELDS[tool]);
    if (context.transport === "cli") allowed.add("operation");
    for (const key of Object.keys(payload)) if (!allowed.has(key)) delete payload[key];
  };
  // A destructive operation states its own confirmation, so the altered
  // request is authorized the same way the direct matrix authorizes it.
  const authorize = () => { payload.authorization = AUTHORIZATION; payload.confirm = true; };
  switch (caseName) {
    case "operation": setOperation("worktree_cleanup"); authorize(); break;
    case "repo": payload.repo = otherRepo; break;
    case "work_id": payload.work_id = `${payload.work_id}-altered`; break;
    case "confirm_false": payload.confirm = false; break;
    case "transaction_id": payload.transaction_id = `${payload.transaction_id}-altered`; break;
    case "plan_hash": payload.plan_hash = "0".repeat(64); break;
    case "operation_repo": setOperation("worktree_cleanup"); authorize(); payload.repo = otherRepo; break;
    case "transaction_hash":
      payload.transaction_id = `${payload.transaction_id}-altered`;
      payload.plan_hash = "0".repeat(64);
      break;
    case "repo_work_id": payload.repo = otherRepo; payload.work_id = `${payload.work_id}-altered`; break;
    case "confirm_hash": payload.confirm = false; payload.plan_hash = "0".repeat(64); break;
    case "three_dimensions":
      setOperation("worktree_cleanup"); authorize();
      payload.repo = otherRepo; payload.work_id = `${payload.work_id}-altered`;
      break;
    default: break;
  }
}

/**
 * Build the consumer over the real transports.
 *
 * Every invocation records the document that crossed the process boundary, so
 * the matrix compares serialized requests and published envelopes.
 */
function createConsumer(options = {}) {
  const calls = [];
  const associations = options.associations ?? new Map();
  const cliDirectory = options.cliDirectory ?? MANAGER;
  const mcpDirectory = options.mcpDirectory ?? MANAGER;

  const deps = {
    isDirectory: (target) => { try { return fs.statSync(target).isDirectory(); } catch { return false; } },
    listLocalBranches: (repoRoot) => git(repoRoot, "branch", "--format=%(refname:short)").split("\n").filter(Boolean),
    detectTransport: async () => {
      const cli = await createWorktreeCliClient({ managerDirectory: cliDirectory }).detect();
      const mcp = await createWorktreeMcpClient({ managerDirectory: mcpDirectory }).detect();
      return {
        cli: { available: cli.available, cause: cli.cause },
        mcp: { available: mcp.available, cause: mcp.cause },
      };
    },
    invokeCli: async ({ request }) => {
      const context = { transport: "cli", document: { ...request } };
      const entry = { transport: "cli", wire: "", envelope: null, sent: false, cause: undefined, context };
      calls.push(entry);
      options.alter?.(context);
      entry.wire = JSON.stringify(context.document);
      const outcome = await createWorktreeCliClient({ managerDirectory: cliDirectory }).invoke(context.document);
      entry.sent = outcome.sent !== false;
      entry.envelope = outcome.envelope ?? null;
      entry.cause = outcome.cause;
      if (options.loseAnswer === "cli" && context.document.dry_run === false) {
        return { sent: true, cause: "the answer was lost after the request was delivered" };
      }
      return outcome;
    },
    invokeMcp: async ({ tool, request }) => {
      const context = { transport: "mcp", tool, args: { ...request } };
      const entry = { transport: "mcp", wire: "", envelope: null, sent: false, cause: undefined, context };
      calls.push(entry);
      options.alter?.(context);
      entry.wire = JSON.stringify({ tool: context.tool, arguments: context.args });
      const outcome = await createWorktreeMcpClient({ managerDirectory: mcpDirectory }).invoke(context.tool, context.args);
      entry.sent = outcome.sent !== false;
      entry.envelope = outcome.envelope ?? null;
      entry.cause = outcome.cause;
      if (options.loseAnswer === "mcp" && context.args.dry_run === false) {
        return { sent: true, cause: "the answer was lost after the request was delivered" };
      }
      return outcome;
    },
    persistAssociation: async (association) => { associations.set(association.work_id, association); },
    findAssociation: async (workId) => associations.get(workId) ?? null,
  };

  return { adapter: createWorktreeConsumerAdapter(deps), calls, associations };
}

/** Create the worktree a case needs, over the real manager. */
async function setupWorktree(transport, repo, workId, commit) {
  const args = { repo, work_id: workId, base: "main" };
  const outcome = transport === "cli"
    ? await createWorktreeCliClient({ managerDirectory: MANAGER }).invoke({ operation: "worktree_create", ...args })
    : await createWorktreeMcpClient({ managerDirectory: MANAGER }).invoke("worktree_create", args);
  assert.equal(outcome.envelope?.result, "success", `setup failed: ${JSON.stringify(outcome)}`);
  if (!commit) return;
  const worktree = path.join(repo, ".worktrees", workId);
  fs.writeFileSync(path.join(worktree, "change.txt"), "complete me\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "matrix change");
}

/** Remove the worktree and the branch a cell used, outside the measured interval. */
function retireWorktree(repo, workId) {
  const worktree = path.join(repo, ".worktrees", workId);
  if (fs.existsSync(worktree)) {
    try { git(repo, "worktree", "remove", "--force", worktree); } catch { /* the cell may have failed */ }
  }
  try { git(repo, "branch", "-D", `worktree/${workId}`); } catch { /* the branch may not exist */ }
}

/** The serialized request of one transport, with the backend digests normalized. */
function normalizedWire(entry) {
  const payload = entry.transport === "cli" ? { ...entry.context.document } : { ...entry.context.args };
  payload.operation = entry.transport === "cli" ? entry.context.document.operation : entry.context.tool;
  if (payload.plan_hash) payload.plan_hash = "<plan_hash>";
  if (payload.transaction_id) payload.transaction_id = "<transaction_id>";
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function callFor(calls, phase) {
  return calls.find((entry) => {
    const payload = entry.transport === "cli" ? entry.context.document : entry.context.args;
    return phase === "preflight" ? payload.dry_run === true : payload.dry_run === false;
  });
}

function observedOf(envelope) {
  const error = envelope?.error ?? null;
  return {
    code: error?.code ?? envelope?.result ?? "unknown",
    message: error?.message ?? "",
  };
}

const repositories = {};
for (const name of REPOSITORIES) {
  repositories[name] = path.join(temporaryRoot, name);
  createFixture(repositories[name]);
}

test("the case table names the twelve mismatch classes of the direct matrix", () => {
  assert.equal(CASES.length, 12);
  assert.equal(new Set(CASES).size, 12);
  assert.deepEqual(expectedFor("transaction_id"), { code: "plan_mismatch", message: "Repository state or request changed since preflight" });
  assert.deepEqual(expectedFor("confirm_false"), { code: "invalid_request", message: "authorization_mismatch" });
  assert.deepEqual(expectedFor("transaction_hash"), expectedFor("transaction_id"));
  assert.deepEqual(expectedFor("confirm_hash"), expectedFor("confirm_false"));
  for (const caseName of CASES) {
    if (caseName === "happy") continue;
    assert.notEqual(expectedFor(caseName).code, "success", caseName);
  }
});

/** Run one cell of the matrix over the real manager. */
async function runCell(transport, repoName, caseName) {
  const repo = repositories[repoName];
  const other = repositories[repoName === "A" ? "B" : "A"];
  const request = requestFor(caseName, repo);
  if (NEEDS_WORKTREE.includes(caseName)) {
    await setupWorktree(transport, repo, request.work_id, NEEDS_COMMIT.includes(caseName));
  }

  const barrier = fs.mkdtempSync(path.join(temporaryRoot, "barrier-"));
  process.env.WORKTREE_MANAGER_TEST_LOCK_BARRIER_DIR = barrier;
  const before = { target: stateOf(repo), other: stateOf(other) };
  const beforeCount = worktreeCount(repo);

  const consumer = createConsumer({
    alter: (context) => applyAlteration(context, caseName, other),
  });
  try {
    const result = await consumer.adapter.execute({ ...request, transport });
    delete process.env.WORKTREE_MANAGER_TEST_LOCK_BARRIER_DIR;

    const after = { target: stateOf(repo), other: stateOf(other) };
    const afterCount = worktreeCount(repo);
    const markers = fs.readdirSync(barrier).sort();
    const preflight = callFor(consumer.calls, "preflight");
    const execute = callFor(consumer.calls, "execute");
    const expected = expectedFor(caseName);
    const observed = observedOf(execute?.envelope);

    const cell = {
      transport,
      repo: repoName,
      case: caseName,
      operation: request.operation,
      request,
      wire: execute ? normalizedWire(execute) : null,
      effective_payload: execute ? JSON.parse(execute.wire) : null,
      envelope: execute?.envelope ?? null,
      expected_code: expected.code,
      observed_code: observed.code,
      expected_message: expected.message,
      observed_message: observed.message,
      barrier: markers,
      state_before: before,
      state_after: after,
      status: result.status,
      reason: result.reason ?? null,
      next_action: result.next_action ?? null,
      error_code: result.error?.code ?? null,
      effective_transport: result.effective_transport,
      fallback_reason: result.fallback_reason ?? null,
      attempts: result.attempts,
      ok: false,
    };

    // The wrapper reports the rejection of the manager without changing the
    // repository of the request or the other repository.
    assert.ok(execute, "the wrapper must reach the manager");
    assert.ok(preflight, "the wrapper must plan the request before executing it");
    assert.equal(result.effective_transport, transport, "the chosen transport must not change");
    assert.equal(result.fallback_reason, undefined, "a rejection must not trigger a fallback");
    assert.equal(
      consumer.calls.filter((entry) => entry.transport === transport).length,
      2,
      "the wrapper plans once and executes once",
    );
    assert.deepEqual(after.other, before.other, "the other repository must not change");

    if (caseName === "happy") {
      assert.equal(result.status, "success");
      assert.equal(execute.envelope.result, "success");
      assert.equal(afterCount, beforeCount + 1, "the happy cell mutates the requested repository once");
      assert.notDeepEqual(after.target, before.target);
      assert.deepEqual(markers, ["lock_acquired", "pre_lock_validation"]);
      cell.ok = true;
    } else {
      assert.equal(result.status, "blocked", `${caseName} must be blocked`);
      assert.equal(observed.code, expected.code, `${caseName} observed code`);
      assert.ok(observed.message.includes(expected.message), `${caseName} observed message: ${observed.message}`);
      assert.deepEqual(after.target, before.target, `${caseName} must not mutate the repository`);
      assert.deepEqual(markers, [], `${caseName} must not leave a lock barrier marker`);
      cell.ok = true;
    }
    return cell;
  } finally {
    delete process.env.WORKTREE_MANAGER_TEST_LOCK_BARRIER_DIR;
    // The worktree of the cell is retired outside the measured interval, even
    // when the cell fails.
    retireWorktree(repo, request.work_id);
  }
}

test("the wrapper matrix runs every case over both transports and both repositories", async (t) => {
  const cells = [];
  const byKey = new Map();

  for (const transport of TRANSPORTS) {
    for (const repoName of REPOSITORIES) {
      for (const caseName of CASES) {
        await t.test(`${transport}/${repoName}/${caseName}`, async () => {
          const cell = await runCell(transport, repoName, caseName);
          cells.push(cell);
          byKey.set(`${transport}|${repoName}|${caseName}`, cell);
        });
      }
    }
  }

  await t.test("the matrix publishes forty-eight cells without duplicates", () => {
    assert.equal(cells.length, 48);
    assert.equal(byKey.size, 48);
    assert.ok(cells.every((cell) => cell.ok));
  });

  await t.test("both transports publish the same request and the same envelope for every cell", () => {
    for (const repoName of REPOSITORIES) {
      for (const caseName of CASES) {
        const cli = byKey.get(`cli|${repoName}|${caseName}`);
        const mcp = byKey.get(`mcp|${repoName}|${caseName}`);
        assert.ok(cli && mcp, `${repoName}/${caseName} must exist for both transports`);
        assert.equal(cli.wire, mcp.wire, `${repoName}/${caseName} must send the same request over both transports`);
        assert.deepEqual(Object.keys(cli.envelope).sort(), Object.keys(mcp.envelope).sort());
        assert.equal(cli.envelope.operation, mcp.envelope.operation);
        assert.equal(cli.envelope.repository, mcp.envelope.repository);
        assert.equal(cli.envelope.result, mcp.envelope.result);
        assert.deepEqual(Object.keys(cli.envelope.error ?? {}).sort(), Object.keys(mcp.envelope.error ?? {}).sort());
        assert.equal(cli.envelope.error?.code, mcp.envelope.error?.code);
        assert.equal(cli.envelope.error?.message, mcp.envelope.error?.message);
        assert.equal(cli.observed_code, mcp.observed_code);
        assert.equal(cli.observed_message, mcp.observed_message);
      }
    }
  });

  await t.test("the evidence of the matrix is written only when a destination is defined", () => {
    const destination = process.env.MCP_MATRIX_EVIDENCE;
    if (!destination) return;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify(cells, null, 2)}\n`);
    const written = JSON.parse(fs.readFileSync(destination, "utf8"));
    assert.equal(written.length, 48);
    assert.ok(written.every((cell) => cell.ok));
  });
});

test("a transport that never received the request is replaced once by the other transport", async () => {
  const repo = repositories.A;
  const broken = path.join(temporaryRoot, "manager-without-package");
  fs.mkdirSync(broken, { recursive: true });
  const before = worktreeCount(repo);
  const consumer = createConsumer({ cliDirectory: MANAGER, mcpDirectory: broken });
  const result = await consumer.adapter.execute({
    operation: "create", repo_root: repo, work_id: "fallback-pre-send", base: "main", transport: "mcp",
  });

  assert.equal(result.status, "success");
  assert.equal(result.effective_transport, "cli");
  assert.equal(result.fallback_from, "mcp");
  assert.ok(result.fallback_reason, "the fallback must name the cause");
  assert.deepEqual(result.attempts.map((attempt) => `${attempt.transport}/${attempt.phase}/${attempt.outcome}`), [
    "mcp/preflight/unavailable",
    "cli/preflight/accepted",
    "cli/execute/accepted",
  ]);
  assert.equal(consumer.calls.filter((entry) => entry.transport === "mcp").length, 1);
  assert.equal(consumer.calls.filter((entry) => entry.transport === "cli").length, 2);
  assert.equal(worktreeCount(repo), before + 1, "the fallback mutates the repository exactly once");
  retireWorktree(repo, "fallback-pre-send");
});

test("a rejected request is never sent to the other transport", async () => {
  const repo = repositories.A;
  const consumer = createConsumer();
  const before = stateOf(repo);
  const result = await consumer.adapter.execute({
    operation: "cleanup", repo_root: repo, work_id: "missing-worktree", base: "main",
    confirm: true, authorization: AUTHORIZATION, transport: "mcp",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "invalid_identity");
  assert.equal(result.fallback_reason, undefined);
  assert.equal(consumer.calls.filter((entry) => entry.transport === "cli").length, 0, "no fallback after a rejection");
  assert.equal(consumer.calls.filter((entry) => entry.transport === "mcp").length, 1, "only the preflight is sent");
  assert.deepEqual(stateOf(repo), before, "a rejected request does not mutate the repository");
});

test("a request whose answer was lost is neither repeated nor delegated", async () => {
  const repo = repositories.A;
  const before = worktreeCount(repo);
  const consumer = createConsumer({ loseAnswer: "mcp" });
  const result = await consumer.adapter.execute({
    operation: "create", repo_root: repo, work_id: "lost-answer", base: "main", transport: "mcp",
  });

  assert.equal(result.status, "uncertain");
  assert.match(result.reason, /reconcile/);
  assert.equal(result.fallback_reason, undefined);
  assert.equal(consumer.calls.filter((entry) => entry.transport === "mcp").length, 2, "the plan and the execution are sent once each");
  assert.equal(consumer.calls.filter((entry) => entry.transport === "cli").length, 0, "the request is not delegated");
  assert.equal(worktreeCount(repo), before + 1, "the effect is preserved for the reconciliation");
  retireWorktree(repo, "lost-answer");
});

test("the report of every phase names the operation, the work, the repository, the way, the result, the cause and the next action", async () => {
  const repo = repositories.A;
  const broken = path.join(temporaryRoot, "manager-without-package-2");
  fs.mkdirSync(broken, { recursive: true });

  // The chosen transport cannot take the request and the other one is not
  // available either, so no manager is installed where the consumer looks.
  const unavailable = createConsumer({ cliDirectory: broken, mcpDirectory: broken });
  const unavailableResult = await unavailable.adapter.execute({
    operation: "create", repo_root: repo, work_id: "report-unavailable", base: "main", transport: "mcp",
  });
  assert.equal(unavailableResult.status, "blocked");
  assert.equal(unavailableResult.effective_transport, "mcp");
  assert.ok(unavailableResult.detection, "the report names the cause of every transport");
  assert.equal(unavailableResult.detection.cli.available, false);
  assert.equal(unavailableResult.detection.mcp.available, false);
  assert.ok(unavailableResult.detection.cli.cause, "the report names the cause of the command line");
  assert.ok(unavailableResult.detection.mcp.cause, "the report names the cause of the MCP server");
  retireWorktree(repo, "report-unavailable");

  const rejected = createConsumer();
  const rejectedResult = await rejected.adapter.execute({
    operation: "cleanup", repo_root: repo, work_id: "report-missing", base: "main",
    confirm: true, authorization: AUTHORIZATION, transport: "mcp",
  });

  const uncertain = createConsumer({ loseAnswer: "mcp" });
  const uncertainResult = await uncertain.adapter.execute({
    operation: "create", repo_root: repo, work_id: "report-uncertain", base: "main", transport: "mcp",
  });
  retireWorktree(repo, "report-uncertain");

  for (const result of [unavailableResult, rejectedResult, uncertainResult]) {
    assert.ok(result.operation, "the report names the operation");
    assert.ok(result.work_id, "the report names the work");
    assert.equal(result.repo_root, fs.realpathSync(repo), "the report names the repository");
    assert.ok(result.effective_transport, "the report names the way");
    assert.ok(result.status, "the report names the result");
    assert.ok(result.reason, "the report names the cause");
    assert.ok(result.next_action, "the report names the next action");
    assert.equal(result.transaction_id, undefined, "the report does not invent a transaction identifier");
  }
});

test("the persisted transport selection is not changed by a later operation", async () => {
  const repo = repositories.A;
  const associations = new Map();
  const consumer = createConsumer({ associations });
  const created = await consumer.adapter.execute({
    operation: "create", repo_root: repo, work_id: "persisted-cli", base: "main", transport: "cli",
  });
  assert.equal(created.status, "success");
  assert.equal(created.effective_transport, "cli");
  assert.equal(associations.get("persisted-cli").transport, "cli");

  const callsBefore = consumer.calls.length;
  const status = await consumer.adapter.execute({
    operation: "status", repo_root: repo, work_id: "persisted-cli", base: "main",
  });
  assert.equal(status.status, "success");
  assert.equal(status.effective_transport, "cli", "the persisted selection is kept");
  assert.equal(status.transport_source, "persisted");
  const after = consumer.calls.slice(callsBefore);
  assert.equal(after.filter((entry) => entry.transport === "cli").length, 1);
  assert.equal(after.filter((entry) => entry.transport === "mcp").length, 0, "the other transport is not used");
  retireWorktree(repo, "persisted-cli");
});
