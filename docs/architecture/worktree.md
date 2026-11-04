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

## Direct consumption

The Runner consumes the manager through the MCP server `worktree_manager`, which the installer registers per project in the destination configuration: `mcp.worktree_manager` in `.opencode/opencode.json` and `mcpServers.worktree_manager` in `.mcp.json`. The registration uses `python3 -m worktree_manager.mcp_transport` with the managed global directory on `PYTHONPATH`, so the server does not depend on the working directory: every call carries `repo`.

The standalone publishes seven tools: `worktree_create`, `worktree_complete`, `worktree_cleanup`, `worktree_recover`, `worktree_list`, `worktree_prune` and `worktree_status`. The Runner plans a mutating operation with `dry_run: true`, reads the plan digest and the planned transaction identifier, and executes with the same fields plus `plan_hash` and, when it applies, `transaction_id`; `list` and `status` use a single call.

The closure commit carries a descriptive subject and body (`commit_title`/`commit_body`); the Runner composes the Spanish generic fallback when no source is available.

`.flowtask/scripts/worktree.sh` is the compatibility entrypoint and delegates to
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

The installer downloads the published package and publishes a managed global copy of the manager under the user's global FlowTask directory, and it excludes the manager from the generic asset copy. The consumer resolves the manager only from the global installation. The npm package does not expose a bin or `npx`; its MCP publishes the seven operations and the guide in `initialize.instructions`. The installer registers that server per project in each selected destination; FlowTask does not expose its own tool for the manager.

## Retired bridge

FlowTask no longer exposes a consumer tool for the manager and no longer requires the runner identity to use isolated worktrees. The former bridge, its MCP client, its JavaScript translator, its validation contract and their tests were removed. A session that names the retired tool receives a visible answer that the route no longer exists and the seven direct tools are the current surface; the runtime returns its unknown-tool error as a fallback. The compatibility matrix records the retired name and its removal.

The durable association remains in Engram under `worktree/association/{work_id}`: the Runner records `state: pending` before the first `create` call and replaces it with `state: confirmed` after the manager confirms the worktree. If the association cannot be confirmed, the resource is preserved and the work is blocked instead of reported as completed.

## Direct MCP and compatibility path

The MCP server is the primary path. `${FLOWTASK_SCRIPTS}/worktree.sh` remains a declared alternative for administration and compatibility; it runs the same canonical manager and can be used when the server is not registered or does not respond. There is no automatic fallback between the two paths.

A delivered request is never retried on the other path: a rejection, a contract error, lock contention, a timeout or a lost answer produce an uncertain outcome, and the next action is to reconcile before a new attempt. The manager rejects an execute whose repository state or request changed since the preflight, and that rejection is reported without mutating either repository.

## Responsibility boundaries

- The standalone owns the parent-only lifecycle, generic configuration,
  transactions, locks, journals, and target-direct behavior.
- FlowTask provides the compatibility entrypoint, the acquisition of the npm
  package, the global publication and the per-project MCP registration of the
  manager server.
- The compatibility adapter does not commit, merge, or push on behalf of the consumer
  repository.
- The historical local URL in `.gitmodules` is not a distribution reference.
- The manager is distributed as the npm package `worktree-for-agents` and the
  published global copy is the single runtime source. A vendored copy of the
  manager core is not maintained in this repository.
- The manager owns the lifecycle, the transactions, the locks and the journals;
  FlowTask does not translate its requests or choose a transport.
