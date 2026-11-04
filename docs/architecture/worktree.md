# Worktree Manager Integration

## Source of truth

The implementation lives in the standalone
[`worktree-manager`](https://github.com/Saez520/worktree-manager) and is
distributed as the npm package `worktree-for-agents`. FlowTask publishes a
managed global copy of that package; a local copy of the manager core is not
maintained in this repository.

For the architecture, configuration, commands, target-direct behavior,
recovery, and output contract, see the
[source repository README](https://github.com/Saez520/worktree-manager) and
[`docs/cli-contract-v1.md`](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md).
This document describes only the integration with FlowTask.

## FlowTask Adapter

The consumer implementation is `.flowtask/bin/lib/worktree-consumer-adapter.js`; its validation contract is `.flowtask/bin/lib/worktree-consumer-contract.js`.

The closure commit carries a descriptive subject and body (`--title`/`--body` or `commit_title`/`commit_body`); the consumer injects the Spanish generic fallback when no title is supplied.

`.flowtask/scripts/worktree.sh` is the consumer entrypoint and delegates to
`.flowtask/scripts/worktree-adapter.sh`, which delegates to the canonical
manager. There is no parallel engine.

The configuration precedence is explicit: the path passed with `--config`
first, then `.worktree-manager.conf`. The file `.flowtask/config/worktree.json`
is a legacy read-only datum. It is interpreted only for a `complete
--preserve-dirty` without `--config`, where its `preserveDirty` value is
translated to `preserve_dirty=true` and the applied compatibility is declared
on stderr, and for an explicit `recover`, where a legacy transaction is
imported into the canonical state once. An explicit `--config` never reads the
legacy file, an invalid legacy configuration blocks the operation with exit
code 3, and a conflict of identity blocks it with exit code 5 while both
records are preserved. The canonical state is never copied back, and no
operation writes a legacy backup directory or a legacy backup reference.

The variables `FLOWTASK_*` are inert: they do not change the configuration,
the authorization or the execution. The controls of the standalone tests are
`WORKTREE_MANAGER_TEST_*`. The standalone does not know about FlowTask or
inspect its legacy paths or refs.

The installer downloads the published package and publishes a managed global copy of the manager under the user's global FlowTask directory, and it excludes the manager from the generic asset copy. The consumer resolves the manager only from the global installation. The npm package does not expose a bin or `npx`; its MCP publishes the seven operations and the guide in `initialize.instructions`. The authorized bridge remains the surface exposed by FlowTask.

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
- FlowTask provides the compatible entrypoint, the adapter, the acquisition of
  the npm package and the global publication.
- The adapter does not commit, merge, or push on behalf of the consumer
  repository.
- The historical local URL in `.gitmodules` is not a distribution reference.
- The manager is distributed as the npm package `worktree-for-agents` and the
  published global copy is the single runtime source. A vendored copy of the
  manager core is not maintained in this repository.
- The bridge and the transport clients belong to FlowTask; the manager owns the
  lifecycle, the transactions, the locks and the journals.
