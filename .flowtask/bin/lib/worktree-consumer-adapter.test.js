import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeConsumerAdapter } from "./worktree-consumer-adapter.js";

function fixture(overrides = {}) {
  const calls = [];
  const deps = {
    isDirectory: () => true,
    listLocalBranches: () => ["main", "trunk"],
    invokeCli: async ({ args }) => { calls.push(["cli", args]); return "operation: create\nresult: success\npath: .worktrees/alpha_1\nbranch: worktree/alpha_1\nbase_branch: main\n"; },
    invokeMcp: async ({ args }) => { calls.push(["mcp", args]); return { output: "operation: create\nresult: success\npath: .worktrees/alpha_1\nbranch: worktree/alpha_1\nbase_branch: main\n" }; },
    persistAssociation: async (record) => calls.push(["persist", record]),
    ...overrides,
  };
  return { adapter: createWorktreeConsumerAdapter(deps), calls };
}

const input = (transport = "cli") => ({ operation: "create", transport, repo_root: "/repo", work_id: "alpha_1" });

test("validates generic work-id, resolves base and persists before dispatch", async () => {
  const { adapter, calls } = fixture();
  let dispatched = false;
  const result = await adapter.createAndDispatch(input(), async (record) => {
    dispatched = true;
    assert.equal(calls.at(-1)[0], "persist");
    assert.equal(record.branch, "worktree/alpha_1");
  });
  assert.equal(result.status, "success");
  assert.equal(dispatched, true);
});

test("supports explicit MCP transport with same normalized contract", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.execute(input("mcp"));
  assert.equal(result.status, "success");
  assert.ok(calls.some(([kind]) => kind === "mcp"));
  assert.equal(result.transport, "mcp");
});

test("rejects traversal before mutation", async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.execute({ ...input(), work_id: "../escape" }), /invalid work_id/);
  assert.deepEqual(calls, []);
});

test("does not retry or dispatch an uncertain transport result", async () => {
  const { adapter, calls } = fixture({ invokeCli: async () => { calls.push(["invoke"]); throw new Error("timeout"); } });
  let dispatched = false;
  const result = await adapter.createAndDispatch(input(), () => { dispatched = true; });
  assert.equal(result.status, "uncertain");
  assert.equal(dispatched, false);
  assert.equal(calls.filter(([kind]) => kind === "invoke").length, 1);
});

test("retains confirmed resource and blocks dispatch when Engram persistence fails", async () => {
  let writes = 0;
  const { adapter } = fixture({ persistAssociation: async () => { if (++writes > 1) throw new Error("Engram unavailable"); } });
  let dispatched = false;
  const result = await adapter.createAndDispatch(input(), () => { dispatched = true; });
  assert.equal(result.status, "blocked");
  assert.equal(result.effect_confirmed, true);
  assert.equal(dispatched, false);
});

test("fails closed before invoking the manager when intent persistence fails", async () => {
  const { adapter, calls } = fixture({
    persistAssociation: async () => { throw new Error("Engram unavailable"); },
  });
  const result = await adapter.execute(input());
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no mutation attempted/);
  assert.deepEqual(calls, []);
});

test("rejects out-of-repository worktree paths", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.execute({ ...input(), worktrees_dir: "../../outside" }), /worktrees_dir/);
});
