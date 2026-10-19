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
