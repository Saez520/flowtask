# Worktree Manager architecture

## Two cooperating repositories

The standalone `worktree-manager` repository is the implementation source. In
FlowTask it is materialized at `.flowtask/scripts/worktree-manager/` as the
submodule recorded by `.gitmodules`. FlowTask must not maintain a second copy
of the manager core.

The standalone manager owns:

- the `worktree.sh` entrypoint and parent-only lifecycle;
- configuration parsing and path resolution;
- worktree creation, completion, cleanup, recovery, pruning, and listing;
- locks, journals, transaction state, backups, and target-direct behavior.

FlowTask owns:

- `.flowtask/scripts/worktree.sh`, the consumer entrypoint;
- `.flowtask/scripts/worktree-adapter.sh`, the compatibility adapter;
- submodule installation and gitlink validation.

The adapter does not commit, merge, or push for a consumer repository. The
standalone manager does not inspect FlowTask legacy paths or refs.

## Parent-only lifecycle

Parent-only operations act on the repository selected by `--repo` (or the
current repository) and use the standalone lifecycle. `complete` preserves
resources when it encounters conflict or drift. `cleanup` does not integrate
changes; removing unintegrated changes requires explicit `--discard`.

## Target-direct boundary

Target-direct operates on the explicit target repository and receives the
explicit parent repository with `--parent-repo`. It does not create a parent
worktree or modify the parent's `HEAD`. The supported link mode is exactly
`--link-parent staged-only`; linking records the target gitlink in the parent
index. `create`, `link-parent`, `abort`, `complete`, and `recover` retain the
transaction evidence needed for safe continuation or intervention.

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
