import test from "node:test";
import assert from "node:assert/strict";
import { createWorktreeConsumerBridge } from "../src/worktree-consumer-bridge.js";

test("limits Engram calls to the three persistence methods", async () => {
  const calls: string[] = [];
  const bridge = createWorktreeConsumerBridge({
    invokeEngram: async (tool) => { calls.push(tool); return { output: "no results" }; },
    isDirectory: () => true, listLocalBranches: () => ["main"],
    invokeManager: async () => ({ output: "result: blocked" }),
    dispatchConstructor: async () => ({}), dispatchValidator: async () => ({}),
  });
  const result = await bridge.execute({ repo_root: "/repo", work_id: "alpha" });
  assert.equal(result.status, "blocked");
  assert.deepEqual(calls, ["mem_search", "mem_save"]);
});

test("rejects an unreadable Engram preview before persistence or mutation", async () => {
  const calls: string[] = [];
  const bridge = createWorktreeConsumerBridge({
    invokeEngram: async (tool) => { calls.push(tool); return { output: "truncated result; more results available" }; },
    isDirectory: () => true, listLocalBranches: () => ["main"],
    invokeManager: async () => { calls.push("mutate"); return "result: success"; },
    dispatchConstructor: async () => ({}), dispatchValidator: async () => ({}),
  });
  await assert.rejects(bridge.execute({ repo_root: "/repo", work_id: "alpha" }));
  assert.deepEqual(calls, ["mem_search"]);
});
