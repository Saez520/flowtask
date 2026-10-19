# Worktree Manager operations and recovery

## Review without mutation

Use this checklist for documentation or release review; do not run destructive
lifecycle operations:

1. Confirm the repository identity, target identity, submodule path, and base
   branch from source and contract documents.
2. Confirm the selected configuration is a `key=value` file and contains no
   duplicate or unknown key.
3. Confirm whether the operation is parent-only or target-direct.
4. Confirm explicit consent before any discard or dirty-state preservation.
5. Inspect locks, journals, transaction directories, backups, and git status
   without deleting or integrating anything.
6. Record a gap when an assertion cannot be traced to implementation or the
   published CLI contract.

## Consent and preservation

`cleanup` does not integrate changes. Unintegrated changes are removed only
with explicit `--discard`. `complete --preserve-dirty` opts into temporary
backup and restoration of staged, unstaged, and untracked changes; it does not
create a commit. If restoration conflicts with the applied operation, the
backup and transaction evidence remain for human intervention.

No documentation procedure should imply implicit discard, automatic merge,
automatic push, or recovery that silently removes state.

## Locks, journals, and transactions

Lifecycle operations use locks and journaled transaction state. Lock
contention, invalid identity or descriptor, missing dependencies, access
failures, and ambiguous drift are failures. A transaction that needs human
action is not reported as successful recovery.

The JSON contract uses `pending_intervention` for failed destination-state
restoration. Recovery retains evidence and does not itself discard state.

## Parent-only and target-direct recovery

Parent-only lifecycle state belongs to the standalone manager. Target-direct
state belongs to the explicit target repository while the parent is represented
by its gitlink/index relationship. The required link mode is
`staged-only`. Target-direct `abort`, `complete`, and `recover` preserve the
snapshot and journal and stop on ambiguous drift.

## FlowTask adapter behavior

The adapter translates legacy records only during an explicit recovery request.
It mirrors transaction evidence for compatibility, while the standalone
manager remains unaware of FlowTask paths and legacy refs. This compatibility
translation is not a second lifecycle implementation.
