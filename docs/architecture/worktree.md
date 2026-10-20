# Worktree Manager Integration

## Source of truth

The implementation lives in the standalone
[`worktree-manager`](https://github.com/Saez520/worktree-manager) and is
integrated into FlowTask as a submodule at
`.flowtask/scripts/worktree-manager/`. The integrated checkout must match the
gitlink registered by FlowTask; a local copy of the core must not be maintained.

For the architecture, configuration, commands, target-direct behavior,
recovery, and output contract, see the
[source repository README](https://github.com/Saez520/worktree-manager) and
[`docs/cli-contract-v1.md`](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md).
This document describes only the integration with FlowTask.

## FlowTask Adapter

The consumer implementation is `.flowtask/bin/lib/worktree-consumer-adapter.js`; its validation contract is `.flowtask/bin/lib/worktree-consumer-contract.js`.

`.flowtask/scripts/worktree.sh` is the consumer entrypoint and delegates to
`.flowtask/scripts/worktree-adapter.sh`. The adapter preserves compatibility
with legacy FlowTask invocations and records, and translates those records
only during recovery. The standalone does not know about FlowTask or inspect
its legacy paths or refs.

The installer validates the gitlink, materializes the submodule before copying
assets, and excludes the manager from the generic copy. If the source is not
available, installation or updating fails with a diagnostic; it does not
create an alternative copy.

## Consumer bridge

The assistant never reaches the manager directly. The bridge is
`.flowtask/plugins/flowtask-permission-gate/src/worktree-consumer-bridge.ts`
and it exposes one tool, `flowtask_worktree_consume`, restricted to the
FlowTask runner identity. The tool arguments are reduced to the canonical
request fields before they cross the boundary; the caller identity and the
derived paths stay in the plugin.

The bridge owns the association of every worktree. The intent is registered
before the operation and confirmed after it, and a worktree that was created
without a confirmed association is reported as blocked with the resource
preserved, never as a completed operation.

## Transport detection and fallback

Two transports are available and both publish the same nine-key envelope:
`contract_version`, `tool_version`, `operation`, `repository`, `result`, `data`,
`warnings`, `error` and `transaction_id`.

- The MCP client is `.flowtask/plugins/flowtask-permission-gate/src/worktree-mcp.ts`.
  It starts the standalone server over stdio with `python3 -m
  worktree_manager.mcp_transport` and the standalone checkout on the Python
  path, and it never imports the manager in process.
- The CLI client sends one canonical request document with `python3 -m
  worktree_manager --request-json -`.

The transport is chosen with an explicit precedence: an explicit choice in the
request, then the transport persisted with the worktree, then the read-only
detection, which prefers MCP and falls back to CLI. The chosen transport is
persisted with the worktree and a later operation does not change it.

The other transport is used exactly once, and only when the request was never
delivered. A rejection, a contract error, lock contention, a timeout or a lost
answer are never retried on the other transport: the outcome of a delivered
request is unknown, and the operation is reported as uncertain with the
reconciliation as its next action. The report names the operation, the work,
the repository, the way, the result, the cause and the next action, and it
never invents a transaction identifier.

A mutating operation is planned before it is executed: the preflight publishes
the plan digest and, for a completion, the planned transaction identifier, and
the execute call replays both. A read-only operation and a target-direct
operation use a single call. The manager rejects an execute whose repository
state or request changed since the preflight, and that rejection is reported
without mutating either repository.

## Responsibility boundaries

- The standalone owns the parent-only lifecycle, generic configuration,
  transactions, locks, journals, and target-direct behavior.
- FlowTask provides the compatible entrypoint, the adapter, and the submodule
  integration.
- The adapter does not commit, merge, or push on behalf of the consumer
  repository.
- The historical local URL in `.gitmodules` is only used to bootstrap this
  checkout and is not a portable distribution reference.
- The manager is integrated as a submodule and the registered gitlink is the
  single reference of its version. A vendored copy of the manager core is not
  maintained in this repository.
- The bridge and the transport clients belong to FlowTask; the manager owns the
  lifecycle, the transactions, the locks and the journals.
