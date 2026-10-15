# Worktree Manager Integration

## Source of truth

The implementation lives in the standalone
[`worktree-manager`](https://github.com/Saez520/worktree-manager) and is
integrated into FlowTask as a submodule at
`.flowtask/scripts/worktree-manager/`. The integrated checkout must match the
gitlink registered by FlowTask; a copy of the core must not be maintained in
`.flowtask/scripts/lib/`.

For the architecture, configuration, commands, target-direct behavior,
recovery, and output contract, see the
[source repository README](https://github.com/Saez520/worktree-manager) and
[`docs/cli-contract-v1.md`](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md).
This document describes only the integration with FlowTask.

## FlowTask Adapter

`.flowtask/scripts/worktree.sh` is the consumer entrypoint and delegates to
`.flowtask/scripts/worktree-adapter.sh`. The adapter preserves compatibility
with legacy FlowTask invocations and records, and translates those records
only during recovery. The standalone does not know about FlowTask or inspect
its legacy paths or refs.

The installer validates the gitlink, materializes the submodule before copying
assets, and excludes the manager from the generic copy. If the source is not
available, installation or updating fails with a diagnostic; it does not
create an alternative copy.

## Responsibility boundaries

- The standalone owns the parent-only lifecycle, generic configuration,
  transactions, locks, journals, and target-direct behavior.
- FlowTask provides the compatible entrypoint, the adapter, and the submodule
  integration.
- The adapter does not commit, merge, or push on behalf of the consumer
  repository.
- The historical local URL in `.gitmodules` is only used to bootstrap this
  checkout and is not a portable distribution reference.
