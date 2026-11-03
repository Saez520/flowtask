import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeConsumerBridge } from "../src/worktree-consumer-bridge.js";

const PLAN_HASH = "a".repeat(64);

function envelope(overrides: Record<string, unknown> = {}) {
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

type BridgeOptions = {
  engram?: (tool: string) => Promise<unknown>;
  detection?: unknown;
  invokeCli?: (input: { repoRoot: string; request: Record<string, unknown> }) => Promise<unknown>;
  invokeMcp?: (input: { repoRoot: string; tool: string; request: Record<string, unknown> }) => Promise<unknown>;
};

function fixture(options: BridgeOptions = {}) {
  const calls: unknown[] = [];
  const bridge = createWorktreeConsumerBridge({
    invokeEngram: async (tool) => {
      calls.push(tool);
      return options.engram ? await options.engram(tool) : { output: "no results" };
    },
    isDirectory: () => true,
    listLocalBranches: () => ["main"],
    detectTransport: async () => (options.detection ?? { mcp: { available: false, cause: "mcp server is unavailable" }, cli: { available: true } }),
    invokeCli: async (input) => {
      calls.push(["cli", input.request]);
      if (options.invokeCli) return await options.invokeCli(input);
      const planned = input.request.dry_run === true;
      return {
        envelope: envelope({
          operation: input.request.operation,
          data: planned ? { plan_hash: PLAN_HASH } : { path: "/repo/.worktrees/alpha", branch: "worktree/alpha", base_branch: "main" },
        }),
        sent: true,
      };
    },
    invokeMcp: async (input) => {
      calls.push(["mcp", input.tool, input.request]);
      if (options.invokeMcp) return await options.invokeMcp(input);
      return { envelope: envelope({ operation: input.tool }), sent: true };
    },
    dispatchConstructor: async () => ({}),
    dispatchValidator: async () => ({}),
  });
  return { bridge, calls };
}

test("limits Engram calls to the three persistence methods", async () => {
  const { bridge, calls } = fixture();
  const result = await bridge.execute({ repo_root: "/repo", work_id: "alpha" });
  const engramCalls = calls.filter((call): call is string => typeof call === "string");
  assert.ok(engramCalls.length > 0);
  assert.ok(engramCalls.every((call) => ["mem_search", "mem_get_observation", "mem_save"].includes(call)));
  assert.equal(result.status, "success");
});

test("rejects an unreadable Engram preview before persistence or mutation", async () => {
  const { bridge, calls } = fixture({
    engram: async () => ({ output: "truncated result; more results available" }),
  });
  await assert.rejects(bridge.execute({ repo_root: "/repo", work_id: "alpha" }));
  assert.deepEqual(calls, ["mem_search"]);
});

test("does not force a fixed transport and reports the detected one", async () => {
  const { bridge } = fixture();
  const result = await bridge.execute({ operation: "create", repo_root: "/repo", work_id: "alpha" });
  assert.equal(result.status, "success");
  assert.equal(result.effective_transport, "cli");
  assert.equal(result.transport_source, "detected");
});

test("uses the MCP transport when the detection finds the server available", async () => {
  const { bridge, calls } = fixture({
    detection: { mcp: { available: true }, cli: { available: true } },
  });
  const result = await bridge.execute({ operation: "create", repo_root: "/repo", work_id: "alpha" });
  assert.equal(result.effective_transport, "mcp");
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "mcp"));
});

test("never forwards the agent identity or the derived paths to the manager", async () => {
  const { bridge, calls } = fixture();
  await bridge.execute({
    agent: "flowtask-runner",
    operation: "create",
    repo_root: "/repo",
    work_id: "alpha",
    path: "/repo/.worktrees/alpha",
    branch: "worktree/alpha",
    base_branch: "main",
  });
  const request = (calls.find((call) => Array.isArray(call) && call[0] === "cli") as [string, Record<string, unknown>])[1];
  assert.equal("agent" in request, false);
  assert.equal("path" in request, false);
  assert.equal("branch" in request, false);
  assert.equal(request.base, "main");
});

test("does not dispatch when the operation is not successful", async () => {
  const { bridge } = fixture({
    invokeCli: async () => ({
      envelope: envelope({ result: "failure", error: { code: "authorization_required", message: "Explicit authorization for this call is required", exit_code: 3 } }),
      sent: true,
    }),
  });
  const result = await bridge.execute({ operation: "cleanup", repo_root: "/repo", work_id: "alpha", confirm: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.dispatch_result, undefined);
});

test("publishes the report of a rejected phase with its cause and its next action", async () => {
  const { bridge } = fixture({
    invokeCli: async () => ({
      envelope: envelope({ result: "failure", error: { code: "plan_mismatch", message: "Repository state or request changed since preflight", exit_code: 5 } }),
      sent: true,
    }),
  });
  const result = await bridge.execute({ operation: "cleanup", repo_root: "/repo", work_id: "alpha", confirm: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.error.code, "plan_mismatch");
  assert.equal(result.reason, "Repository state or request changed since preflight");
  assert.ok(result.next_action);
  assert.equal(result.transaction_id, undefined);
});

test("forwards merge_strategy for complete", async () => {
  const { bridge, calls } = fixture();
  const result = await bridge.execute({ operation: "complete", repo_root: "/repo", work_id: "alpha", confirm: true, authorization: "I_AUTHORIZE_THIS_CALL", merge_strategy: "preserve-history" });
  assert.equal(result.status, "success");
  const request = (calls.find((call) => Array.isArray(call) && call[0] === "cli") as [string, Record<string, unknown>])[1];
  assert.equal((request as Record<string, unknown>).merge_strategy, "preserve-history");
});
