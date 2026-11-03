import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktreeConsumerAdapter } from "./worktree-consumer-adapter.js";

const PLAN_HASH = "a".repeat(64);

function envelope(overrides = {}) {
  return {
    contract_version: 1,
    tool_version: "1.0.0",
    operation: "worktree_create",
    repository: "/repo",
    result: "success",
    data: {},
    warnings: [],
    error: null,
    transaction_id: null,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    isDirectory: () => true,
    listLocalBranches: () => ["main", "trunk"],
    detectTransport: async () => ({
      mcp: { available: false, cause: "mcp server is unavailable" },
      cli: { available: true },
    }),
    invokeCli: async ({ request }) => {
      calls.push(["cli", request]);
      const planned = request.dry_run === true;
      const data = planned
        ? { plan_hash: PLAN_HASH, ...(request.operation === "worktree_complete" ? { transaction_id: "tx-planned" } : {}) }
        : { path: "/repo/.worktrees/alpha_1", branch: "worktree/alpha_1", base_branch: "main" };
      return {
        envelope: envelope({
          operation: request.operation,
          data,
          transaction_id: request.operation === "worktree_complete" ? "tx-planned" : null,
        }),
        sent: true,
      };
    },
    invokeMcp: async ({ tool, request }) => {
      calls.push(["mcp", tool, request]);
      const planned = request.dry_run === true;
      const data = planned
        ? { plan_hash: PLAN_HASH, ...(request.operation === "worktree_complete" ? { transaction_id: "tx-planned" } : {}) }
        : { path: "/repo/.worktrees/alpha_1", branch: "worktree/alpha_1", base_branch: "main" };
      return { envelope: envelope({ operation: tool, data }), sent: true };
    },
    persistAssociation: async (record) => { calls.push(["persist", record]); },
    ...overrides,
  };
  return { adapter: createWorktreeConsumerAdapter(deps), calls };
}

const input = (overrides = {}) => ({
  operation: "create",
  repo_root: "/repo",
  work_id: "alpha_1",
  ...overrides,
});

test("keeps an explicit CLI transport and runs preflight then execute with one canonical request", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ transport: "cli" }));
  assert.equal(result.status, "success");
  assert.equal(result.effective_transport, "cli");
  assert.equal(result.transport_source, "explicit");
  assert.deepEqual(calls.filter(([kind]) => kind === "cli").map(([, request]) => request.dry_run), [true, false]);
  const [preflight, execute] = calls.filter(([kind]) => kind === "cli").map(([, request]) => request);
  assert.equal(preflight.operation, "worktree_create");
  assert.equal(execute.operation, "worktree_create");
  assert.equal(execute.repo, "/repo");
  assert.equal(execute.repo_root, undefined);
  assert.equal(execute.work_id, "alpha_1");
  assert.equal(execute.plan_hash, PLAN_HASH);
});

test("uses MCP when the detection finds it available", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "success");
  assert.equal(result.effective_transport, "mcp");
  assert.equal(result.transport_source, "detected");
  assert.equal(calls.filter(([kind]) => kind === "mcp").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 0);
});

test("falls back to the CLI once when MCP is unavailable before the request was sent", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
    invokeMcp: async ({ tool, request }) => { calls.push(["mcp", tool, request]); return { envelope: null, sent: false, cause: "mcp server is unavailable" }; },
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "success");
  assert.equal(result.effective_transport, "cli");
  assert.equal(result.fallback_from, "mcp");
  assert.match(result.fallback_reason, /mcp server is unavailable/);
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 2);
  assert.equal(calls.filter(([kind]) => kind === "mcp").length, 1);
});

test("never falls back once the request was sent", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
    invokeMcp: async () => { throw Object.assign(new Error("connection reset"), { sent: true }); },
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "uncertain");
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 0);
});

test("never falls back after an authorization rejection", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
    invokeMcp: async () => ({
      envelope: envelope({ result: "failure", error: { code: "authorization_required", message: "Explicit authorization for this call is required", exit_code: 3 } }),
      sent: true,
    }),
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "authorization_required");
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 0);
});

test("never falls back after a plan mismatch and reports it as blocked", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
    invokeMcp: async ({ request }) => ({
      envelope: envelope({ operation: request.operation, result: request.dry_run ? "success" : "failure", error: request.dry_run ? null : { code: "plan_mismatch", message: "Repository state or request changed since preflight", exit_code: 5 } }),
      sent: true,
    }),
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "plan_mismatch");
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 0);
});

test("never falls back after a lock rejection", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({ mcp: { available: true }, cli: { available: true } }),
    invokeMcp: async () => ({
      envelope: envelope({ result: "failure", error: { code: "resource_locked", message: "resource is locked", exit_code: 4 } }),
      sent: true,
    }),
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "blocked");
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 0);
});

test("blocks when no transport is available and reports the causes", async () => {
  const { adapter, calls } = fixture({
    detectTransport: async () => ({
      mcp: { available: false, cause: "mcp server is unavailable" },
      cli: { available: false, cause: "the worktree manager does not support the request protocol" },
    }),
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no worktree transport is available/);
  assert.equal(result.detection.cli.cause, "the worktree manager does not support the request protocol");
  assert.equal(calls.filter(([kind]) => kind === "cli" || kind === "mcp").length, 0);
});

test("reuses the planned transaction identifier on the execute request", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ operation: "complete", confirm: true }));
  assert.equal(result.status, "success");
  const [preflight, execute] = calls.filter(([kind]) => kind === "cli").map(([, request]) => request);
  assert.equal(preflight.transaction_id, undefined);
  assert.equal(execute.transaction_id, "tx-planned");
  assert.equal(execute.authorization, "I_AUTHORIZE_THIS_CALL");
  assert.equal(execute.confirm, true);
});

test("uses a single call for read-only operations", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ operation: "list", work_id: undefined }));
  assert.equal(result.status, "success");
  assert.equal(calls.filter(([kind]) => kind === "cli").length, 1);
  const [[, request]] = calls.filter(([kind]) => kind === "cli");
  assert.equal(request.operation, "worktree_list");
  assert.deepEqual(Object.keys(request).sort(), ["operation", "repo"]);
});

test("maps repo_root to repo without duplicating it", async () => {
  const { adapter, calls } = fixture();
  await adapter.execute(input());
  const [[, request]] = calls.filter(([kind]) => kind === "cli");
  assert.equal(request.repo, "/repo");
  assert.equal("repo_root" in request, false);
});

test("rejects unknown request fields before any transport call", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ surprise: true })), /unknown request field/);
  assert.deepEqual(calls, []);
});

test("rejects traversal before mutation", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ work_id: "../escape" })), /invalid work_id/);
  assert.deepEqual(calls, []);
});

test("rejects out-of-repository worktree paths", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.execute(input({ worktrees_dir: "../../outside" })), /worktrees_dir/);
});

test("requires explicit confirmation for destructive operations", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ operation: "cleanup" })), /confirm/);
  assert.deepEqual(calls, []);
});

test("requires a separate discard consent for discard", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ operation: "cleanup", confirm: true, discard: true })), /discard_consent/);
  assert.deepEqual(calls, []);
});

test("rejects a confirmation that disagrees with the authorization value", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ operation: "cleanup", confirm: false, authorization: "I_AUTHORIZE_THIS_CALL" })), /authorization/);
  assert.deepEqual(calls, []);
});

test("rejects create-only options on other operations", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute(input({ operation: "cleanup", confirm: true, init_submodules: true })), /init_submodules/);
  assert.deepEqual(calls, []);
});

test("does not retry or dispatch an uncertain transport result", async () => {
  const { adapter, calls } = fixture({
    invokeCli: async () => { calls.push(["invoke"]); throw Object.assign(new Error("timeout"), { sent: true }); },
    detectTransport: async () => ({ mcp: { available: false }, cli: { available: true } }),
  });
  let dispatched = false;
  const result = await adapter.createAndDispatch(input({ transport: "cli" }), () => { dispatched = true; });
  assert.equal(result.status, "uncertain");
  assert.equal(dispatched, false);
  assert.equal(calls.filter(([kind]) => kind === "invoke").length, 1);
});

test("retains confirmed resource and blocks dispatch when Engram persistence fails", async () => {
  let writes = 0;
  const { adapter } = fixture({
    persistAssociation: async () => { if (++writes > 1) throw new Error("Engram unavailable"); },
  });
  let dispatched = false;
  const result = await adapter.createAndDispatch(input({ transport: "cli" }), () => { dispatched = true; });
  assert.equal(result.status, "blocked");
  assert.equal(result.effect_confirmed, true);
  assert.equal(dispatched, false);
});

test("fails closed before invoking the manager when intent persistence fails", async () => {
  const { adapter, calls } = fixture({
    persistAssociation: async () => { throw new Error("Engram unavailable"); },
  });
  const result = await adapter.execute(input({ transport: "cli" }));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no mutation attempted/);
  assert.deepEqual(calls, []);
});

test("dispatches only after a confirmed association", async () => {
  const { adapter, calls } = fixture();
  let dispatched = false;
  const result = await adapter.createAndDispatch(input({ transport: "cli" }), (record) => {
    dispatched = true;
    assert.equal(calls.at(-1)[0], "persist");
    assert.equal(record.branch, "worktree/alpha_1");
  });
  assert.equal(result.status, "success");
  assert.equal(dispatched, true);
});

test("names the next action of every failed phase", async () => {
  const rejected = fixture({
    invokeMcp: async () => ({
      envelope: envelope({ result: "failure", error: { code: "plan_mismatch", message: "Repository state or request changed since preflight", exit_code: 5 } }),
      sent: true,
    }),
  });
  const rejectedResult = await rejected.adapter.execute(input({ transport: "mcp" }));
  assert.equal(rejectedResult.status, "blocked");
  assert.ok(rejectedResult.next_action);
  assert.match(rejectedResult.next_action, /plan the request again/);

  const uncertain = fixture({
    invokeMcp: async () => { throw Object.assign(new Error("connection reset"), { sent: true }); },
  });
  const uncertainResult = await uncertain.adapter.execute(input({ transport: "mcp" }));
  assert.equal(uncertainResult.status, "uncertain");
  assert.match(uncertainResult.next_action, /reconcile/);

  const unavailable = fixture({
    invokeMcp: async () => ({ envelope: null, sent: false, cause: "mcp server is unavailable" }),
    detectTransport: async () => ({
      mcp: { available: true, cause: "mcp server is unavailable" },
      cli: { available: false, cause: "the worktree manager does not support the request protocol" },
    }),
  });
  const unavailableResult = await unavailable.adapter.execute(input({ transport: "mcp" }));
  assert.equal(unavailableResult.status, "blocked");
  assert.match(unavailableResult.next_action, /make a transport available/);
});

test("reports the cause of every transport when the chosen one cannot take the request", async () => {
  const { adapter } = fixture({
    invokeMcp: async () => ({ envelope: null, sent: false, cause: "mcp server is unavailable" }),
    detectTransport: async () => ({
      mcp: { available: true, cause: "mcp server is unavailable" },
      cli: { available: false, cause: "the worktree manager does not support the request protocol" },
    }),
  });
  const result = await adapter.execute(input({ transport: "mcp" }));
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /mcp server is unavailable/);
  assert.equal(result.detection.cli.available, false);
  assert.equal(result.detection.cli.cause, "the worktree manager does not support the request protocol");
  assert.equal(result.detection.mcp.cause, "mcp server is unavailable");
});

test("keeps the identity of a repository that is reached through a symbolic link", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-consumer-"));
  const repository = path.join(root, "repository");
  const link = path.join(root, "link");
  fs.mkdirSync(repository);
  fs.symlinkSync(repository, link);

  const worktree = path.join(fs.realpathSync(repository), ".worktrees", "alpha_1");
  const associations = new Map();
  const { adapter } = fixture({
    isDirectory: (target) => { try { return fs.statSync(target).isDirectory(); } catch { return false; } },
    invokeCli: async ({ request }) => ({
      envelope: envelope({
        operation: request.operation,
        data: request.dry_run === true
          ? { plan_hash: PLAN_HASH }
          : { path: worktree, branch: "worktree/alpha_1", base_branch: "main" },
      }),
      sent: true,
    }),
    persistAssociation: async (record) => { associations.set(record.work_id, record); },
    findAssociation: async (workId) => associations.get(workId) ?? null,
  });

  const created = await adapter.execute({ operation: "create", repo_root: link, work_id: "alpha_1" });
  assert.equal(created.status, "success");
  assert.equal(associations.get("alpha_1").repo_root, fs.realpathSync(repository));

  // The same work, addressed through the symbolic link, is the same work.
  const status = await adapter.execute({ operation: "status", repo_root: link, work_id: "alpha_1" });
  assert.equal(status.status, "success");
  fs.rmSync(root, { recursive: true, force: true });
});

test("complete operation carries commit_title and commit_body in preflight and execute", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ operation: "complete", confirm: true, authorization: "I_AUTHORIZE_THIS_CALL", commit_title: "Titulo", commit_body: "Cuerpo" }));
  assert.equal(result.status, "success");
  const cliCalls = calls.filter(([kind]) => kind === "cli").map(([, request]) => request);
  assert.equal(cliCalls.length, 2);
  assert.equal(cliCalls[0].commit_title, "Titulo");
  assert.equal(cliCalls[0].commit_body, "Cuerpo");
  assert.equal(cliCalls[1].commit_title, "Titulo");
  assert.equal(cliCalls[1].commit_body, "Cuerpo");
});

test("complete operation injects spanish fallback when commit_title is absent", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ operation: "complete", confirm: true, authorization: "I_AUTHORIZE_THIS_CALL" }));
  assert.equal(result.status, "success");
  const cliCalls = calls.filter(([kind]) => kind === "cli").map(([, request]) => request);
  assert.equal(cliCalls[0].commit_title, "Cierre generico de alpha_1");
  assert.equal(cliCalls[0].commit_body, "No habia una descripcion de la entrega disponible al momento del cierre.");
});

test("commit_title is rejected outside complete", async () => {
  const { adapter } = fixture();
  await assert.rejects(
    adapter.execute(input({ commit_title: "Titulo" })),
    (error) => error instanceof TypeError,
  );
});

test("complete operation carries merge_strategy in preflight and execute", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input({ operation: "complete", confirm: true, authorization: "I_AUTHORIZE_THIS_CALL", merge_strategy: "preserve-history" }));
  assert.equal(result.status, "success");
  const cliCalls = calls.filter(([kind]) => kind === "cli").map(([, request]) => request);
  assert.equal(cliCalls.length, 2);
  assert.equal(cliCalls[0].merge_strategy, "preserve-history");
  assert.equal(cliCalls[1].merge_strategy, "preserve-history");
});

test("merge_strategy is rejected outside complete and for invalid values", async () => {
  const { adapter } = fixture();
  await assert.rejects(
    adapter.execute(input({ merge_strategy: "preserve-history" })),
    (error) => error instanceof TypeError,
  );
  await assert.rejects(
    adapter.execute(input({ operation: "complete", confirm: true, authorization: "I_AUTHORIZE_THIS_CALL", merge_strategy: "rebase" })),
    (error) => error instanceof TypeError,
  );
});
