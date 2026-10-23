# Worktree Manager architecture

## Python runtime

The standalone entrypoint `worktree.sh` is a POSIX shell script that validates
that `python3` is available and that the package entry point exists, and then
executes `python3 -m worktree_manager "$@"`. The package `worktree_manager` is
the only lifecycle implementation: there is no shell engine, no shell lifecycle
and no second lifecycle. The retired shell files `lib/worktree-manager-core.sh` and
`lib/worktree-manager-target-direct.sh` do not exist in the standalone checkout
and they are not a supported alternative to the package.

The package uses only the Python standard library. `worktree_manager.git_repository`
is the shared Git access point for the lifecycle modules; `cli`, `state_digest`,
`target_direct_adapter` and `worktree_lifecycle` also invoke `git` directly
where they need a subprocess outside that wrapper.

## Module map

| Module | Responsibility |
|---|---|
| `worktree_manager.cli` | Command dispatcher, target-direct dispatch and output contract |
| `worktree_manager.configuration` | Reading and validation of the `key=value` configuration |
| `worktree_manager.models` | Shared domain values: results, errors and identities |
| `worktree_manager.output` | Publication of the result as human-readable text or as JSON |
| `worktree_manager.git_repository` | Shared Git access for the lifecycle modules |
| `worktree_manager.worktree_lifecycle` | `create`, `complete`, `cleanup` and `prune` |
| `worktree_manager.target_direct_adapter` | `target-direct` operations over a submodule |
| `worktree_manager.recovery_manager` | Recovery of pending transactions |
| `worktree_manager.transaction_journal` | Durable journal of transactions and bindings |
| `worktree_manager.backup_store` | Retained backup references |
| `worktree_manager.lock_manager` | Mutual exclusion between processes |
| `worktree_manager.state_digest` | Canonical digest of the repository state and of a plan |
| `worktree_manager.mcp_server` | MCP service published over stdio |
| `worktree_manager.mcp_contract` | Strict, versioned request and envelope contracts |
| `worktree_manager.commit_message` | Deterministic composition of closure commit subject and body, including the neutral fallback |
| `worktree_manager.mcp_operations` | Façade over the lifecycle and the recovery services |
| `worktree_manager.mcp_transport` | Entry point of the stdio transport |

The package also contains the package marker `__init__.py` and the module entry
point `__main__.py`, which is what `python3 -m worktree_manager` executes. The
stdio entry point is `python3 -m worktree_manager.mcp_transport`, and that
module delegates to `mcp_server.main`.

## Two cooperating repositories

The standalone `worktree-manager` repository is the implementation source. In
FlowTask it is materialized at `.flowtask/scripts/worktree-manager/` as the
submodule recorded by `.gitmodules`. FlowTask must not maintain a second copy
of the manager core.

The standalone manager owns:

- the `worktree.sh` entrypoint and the parent-only lifecycle;
- configuration parsing and path resolution;
- worktree creation, completion, cleanup, recovery, pruning, and listing;
- locks, journals, transaction state, backups, and target-direct behavior.

FlowTask owns:

- `.flowtask/scripts/worktree.sh`, the consumer entrypoint;
- `.flowtask/scripts/worktree-adapter.sh`, the compatibility adapter;
- the consumer bridge and the transport clients;
- submodule installation and gitlink validation.

The adapter does not commit, merge, or push for a consumer repository. The
standalone manager does not inspect the paths, refs or variables of the
consumer, and it does not know that the consumer exists.

## Parent-only lifecycle

Parent-only operations act on the repository selected by `--repo` (or the
current repository) and use the standalone lifecycle. `complete` preserves
resources when it encounters conflict or drift. `cleanup` does not integrate
changes; removing unintegrated changes requires explicit `--discard`.

## Target-direct boundary

Target-direct operates on the explicit target repository and receives the
explicit parent repository with `--parent-repo`, which is placed after the
`target-direct` action. It does not create a parent worktree and does not
modify the parent's `HEAD`. The supported link mode is exactly
`--link-parent staged-only`; linking records the target gitlink in the parent
index and never commits the parent. `create`, `link-parent`, `abort`,
`complete`, and `recover` retain the transaction evidence needed for safe
continuation or intervention, and every action but `create` compares the
persisted descriptor identity with the arguments of the command.

## Installation boundary

The installer validates and materializes the submodule before copying assets
and excludes the manager from generic copies. If the source is unavailable,
installation fails rather than creating an alternative implementation.

## Consumer transport boundary

FlowTask reaches the manager through a bridge that exposes one tool,
`flowtask_worktree_consume`, restricted to the FlowTask runner identity. The
bridge reduces the tool arguments to the canonical request fields before they
cross the boundary and owns the durable association of every worktree.

Two transports implement the same request and publish the same nine-key
envelope: the stdio service of the manager and its `--request-json` command
line. The transport is selected with an explicit precedence — an explicit
choice, the transport persisted with the worktree, and the read-only detection
— and the selection is persisted with the worktree.

The other transport is used once, and only when the request was never
delivered. A rejection, a contract error, lock contention, a timeout and a
lost answer are reported without a second attempt, because the outcome of a
delivered request is unknown. The manager owns the plan digest, the planned
transaction identifier, the locks, the journal and the reconciliation; the
consumer only plans, replays the plan and reports.

## Submodule boundary

The manager is consumed as a submodule and the registered gitlink is the single
reference of its version. A vendored copy of the manager core is not
maintained in the consumer repository, and the manager is never copied into an
installed target.
