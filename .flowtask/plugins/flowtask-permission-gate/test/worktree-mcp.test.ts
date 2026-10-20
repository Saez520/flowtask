import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorktreeCliClient } from "../src/index.js";
import { createWorktreeMcpClient, WORKTREE_MANAGER_TOOLS } from "../src/worktree-mcp.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const managerDirectory = resolve(here, "../../../scripts/worktree-manager");
const managerReady = existsSync(join(managerDirectory, "worktree_manager", "mcp_transport.py"));
const python = process.env.WORKTREE_MANAGER_PYTHON ?? "python3";
const only = managerReady ? test : test.skip;

function makeRepository(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "wt-consumer-")));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "consumer@test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "consumer"]);
  execFileSync("git", ["-C", directory, "commit", "--allow-empty", "-qm", "init"]);
  return directory;
}

only("detects the seven real tools of the standalone server", async () => {
  const client = createWorktreeMcpClient({ managerDirectory, python });
  const detection = await client.detect();
  assert.equal(detection.available, true, detection.cause);
  assert.deepEqual([...detection.tools].sort(), [...WORKTREE_MANAGER_TOOLS].sort());
});

only("publishes the contract envelope for an accepted and for a rejected request", async () => {
  const client = createWorktreeMcpClient({ managerDirectory, python });
  const repository = makeRepository();
  const accepted = await client.invoke("worktree_list", { repo: repository });
  assert.equal(accepted.sent, true);
  const envelope = accepted.envelope as Record<string, unknown>;
  assert.equal(envelope.result, "success");
  assert.equal(envelope.repository, repository);
  assert.equal(envelope.error, null);

  const rejected = await client.invoke("worktree_list", {});
  assert.equal(rejected.sent, true);
  const rejection = rejected.envelope as Record<string, unknown>;
  assert.equal(rejection.result, "failure");
  assert.equal((rejection.error as Record<string, unknown>).code, "invalid_request");
});

only("reports an unavailable server as not sent", async () => {
  const client = createWorktreeMcpClient({ managerDirectory: join(managerDirectory, "missing"), python });
  const outcome = await client.invoke("worktree_list", { repo: "/tmp" });
  assert.equal(outcome.sent, false);
  assert.ok(outcome.cause);
});

only("detects the request protocol of the command line client", async () => {
  const client = createWorktreeCliClient({ managerDirectory, python });
  const detection = await client.detect();
  assert.equal(detection.available, true, detection.cause);
});

only("answers a command line request with the contract envelope", async () => {
  const client = createWorktreeCliClient({ managerDirectory, python });
  const repository = makeRepository();
  const outcome = await client.invoke({ operation: "worktree_list", repo: repository });
  assert.equal(outcome.sent, true);
  const envelope = outcome.envelope as Record<string, unknown>;
  assert.equal(envelope.result, "success");
  assert.equal(envelope.operation, "worktree_list");
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ["contract_version", "data", "error", "operation", "repository", "result", "tool_version", "transaction_id", "warnings"],
  );
});

only("reports a manager without the request protocol as incompatible", async () => {
  const client = createWorktreeCliClient({ managerDirectory: join(managerDirectory, "missing"), python });
  const detection = await client.detect();
  assert.equal(detection.available, false);
  assert.ok(detection.cause);
});
