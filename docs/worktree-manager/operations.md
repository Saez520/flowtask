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

The manager publishes the consent of a call in the request itself. A
destructive execute requires the literal `authorization`, sent directly or
derived from `confirm: true`. The authorization value is the literal
`I_AUTHORIZE_THIS_CALL` and it is not retained between requests. A dry run is
exempt. A discard requires a separate `discard_consent` boolean, and a
confirmation that disagrees with an authorization is rejected as
`authorization_mismatch`. A confirmation and an authorization are never
resolved silently.

## Validation before the lock

The identity, the repository, the configuration, the base, the registration, the
state, the authorization and the discard consent are validated before the
lock is acquired. A rejection at that stage leaves no marker, no lock, no
journal, no ref and no worktree, and the state digest is unchanged.

The lock is acquired in a deterministic order and released in reverse. Dry
runs, `list` and `status` never mark anything and never acquire a lock. A
contention is a failure that preserves the worktree, the branch and the
journal; it is never resolved by removing the resources of the other operation.

The branch, the path, the registration, the head, the dirty state and the phase
of the journal are revalidated under the lock, so a decision taken before the
lock cannot be applied to a state that changed in between.

## Plan and execution

A mutating operation is planned and then executed. The plan call publishes the
plan digest and, for a completion, the planned transaction identifier; the
execute call replays both. A change of the repository state or of the request
between the plan and the execute is rejected as `plan_mismatch` before any
effect, with the same no-mutation guarantees of a pre-lock rejection.

A completion writes its binding before it captures or merges, atomically, with
the transaction, the repository, the work identifier, the operation, the
request, the plan digest, the state digest, the creation time and the phase.
A second execute is blocked: with the original digest it is rejected as
`plan_mismatch`, and with a recomputed digest it is reported as
`intervention_required`. No mutation is replayed and no second effect is
produced.

## Locks, journals, and transactions

Lifecycle operations use locks and journaled transaction state. Lock
contention, invalid identity or descriptor, missing dependencies, access
failures, and ambiguous drift are failures. A transaction that needs human
action is not reported as successful recovery.

The JSON contract uses `pending_intervention` for failed destination-state
restoration. Recovery retains evidence and does not itself discard state.

## Reconciliation after an interruption

An interrupted operation is reconciled by an explicit `recover`, never by an
automatic retry. The recovery reads the binding before the lock and validates
the transaction, the repository and the work identifier: an absent or corrupt
binding is reported as `intervention_required`, and an incongruent one as
`invalid_identity`, in both cases without a marker, a lock, a mutation or a
change of the state digest.

Under the lock the phase and the binding are read again. A transaction in a
terminal phase reports `no_pending_work` without effects, so a repeated
recovery is a no-op. A reconciliation only reconciles the observed resources:
it never re-sends the merge and never repeats the mutation. An interrupted
call whose outcome is unknown is reported as uncertain and its next action is
the reconciliation, not a new attempt.

## Parent-only and target-direct recovery

Parent-only lifecycle state belongs to the standalone manager. Target-direct
state belongs to the explicit target repository while the parent is represented
by its gitlink/index relationship. The required link mode is
`staged-only`. Target-direct `abort`, `complete`, and `recover` preserve the
snapshot and journal and stop on ambiguous drift. An incomplete target-direct
recovery is reported as `intervention_required` with exit code `6`, and the
descriptor and the snapshot are retained for human intervention.

## FlowTask adapter behavior

The consumer entrypoint `.flowtask/scripts/worktree.sh` delegates to
`.flowtask/scripts/worktree-adapter.sh`, which delegates to
`.flowtask/scripts/worktree-manager/worktree.sh`, which runs
`python3 -m worktree_manager`. There is a single lifecycle in that chain. The
adapter publishes the output of the manager unchanged, and its compatibility
notices go to stderr without any content of the backups.

The adapter translates a legacy setting or a legacy transaction only when the
request asks for it explicitly, and it declares the compatibility it applies.
It never writes a legacy artifact.

### Legacy configuration translation

The legacy configuration `.flowtask/config/worktree.json` is read only for a
`complete --preserve-dirty` request that carries no `--config`.

- `preserveDirty` set to `true` applies `preserve_dirty=true` through a
  temporary configuration file that the adapter passes with `--config`, and the
  adapter publishes `Compatibility: legacy FlowTask preserveDirty setting applied.`
- `preserveDirty` set to `false` changes nothing and publishes no notice.
- An invalid document or a value that is not a boolean is rejected with
  `The legacy configuration is invalid; no operation was started.` and exit
  code `3`, without any mutation.
- Reading the legacy document requires `node`; without it the operation is
  rejected with `The legacy configuration cannot be read without node; no operation was started.`
  and exit code `3`.
- An explicit `--config` never reads the legacy document; the adapter publishes
  `Compatibility: legacy FlowTask configuration ignored because --config was provided.`
  and the operation is not blocked.

### Legacy transaction import

A legacy transaction is imported only by an explicit parent-only `recover` that
names a transaction identifier. The identifier of a recovery request that
carries the `td-` prefix is translated to the `wt-` prefix before the request
reaches the manager.

The canonical location of a transaction is `<git-dir>/<state_dir>/transactions/<transaction>`,
where `state_dir` is the configured state directory. The legacy location is
`.flowtask/backups/<transaction>`.

- When both locations exist, the work identifier of each record is compared. A
  missing identity or a different identity blocks the operation with exit code
  `5` and nothing is changed; both records are preserved. When the identities
  match, the adapter publishes
  `Compatibility: canonical transaction <transaction> is authoritative; legacy copy left unchanged.`
- When only the legacy location exists, it is imported once: the legacy
  directory is copied into the canonical location, and the legacy backup
  references `refs/flowtask/backups/<transaction>` and
  `refs/flowtask/backups/<transaction>-untracked` are published as
  `refs/<backup_ref_prefix>/<transaction>` and
  `refs/<backup_ref_prefix>/<transaction>-untracked` when the canonical
  reference does not exist yet. A canonical reference that exists with a
  different object ID blocks the operation with exit code `5` and nothing is
  changed. The adapter publishes `Compatibility: legacy FlowTask transaction <transaction> imported for recovery.`
- The canonical state is never copied back to the legacy location.

### Legacy state and environment

No operation writes `.flowtask/backups` and no operation writes
`refs/flowtask/backups`; both are read only in the explicit import described
above. The variables `FLOWTASK_*` are inert: they change neither the
configuration, nor the authorization, nor the execution. The controls of the
standalone tests are `WORKTREE_MANAGER_TEST_*`.

## Consumer transport failures

The consumer reaches the manager over two transports that publish the same
envelope. The transport is chosen with an explicit precedence: an explicit
choice, then the transport persisted with the worktree, then the read-only
detection, which prefers MCP.

The other transport is used exactly once, and only when the request was never
delivered. A rejection, a contract error, lock contention, a timeout and a
lost answer are never retried on the other transport: the outcome of a
delivered request is unknown, the operation is reported as uncertain, and its
next action is the reconciliation. The report of every phase names the
operation, the work, the repository, the way, the result, the cause and the
next action, and it never invents a transaction identifier.

A worktree whose association cannot be registered is reported as blocked
before any mutation. A worktree that was created and whose association could
not be confirmed is reported as blocked with the effect confirmed and the
resource preserved, so that the operator can reconcile it.

Closure commits use `commit_title`/`commit_body` (or `--title`/`--body`); the consumer injects the Spanish generic fallback when they are absent.
