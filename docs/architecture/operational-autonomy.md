# Operational autonomy by policies

## Purpose

Execution advances by policy, not by routine waiting. Technical control is verified
first and, when it passes, construction starts without asking for a second confirmation.

Autonomy **does not remove controls**. The technical gate, plan audit, and
implementation validation remain mandatory. What is removed is the routine
confirmation after the gate: the developer's original order authorizing the work and the
gate's `PASS` result are the start signal.

Bounded parallelism does not relax these controls: each job keeps its Gate, audit,
test decision, and consents; integration is serialized and spending is attributed per
execution.

The layer that declares initiative is defined together with the persona and permissions layers in
[persona-autonomy-permissions-layers.md](./persona-autonomy-permissions-layers.md). That page fixes the
autonomy values, the `permissions > autonomy > persona` precedence, and per-layer failure.

## Automatic transition after the gate

- **Gate `PASS`** enables construction. The runner reports the result in one line,
  records the gate evidence as a policy decision, and continues with the worktree and the
  Constructor. There is no intermediate wait.
- **Gate `FAIL`** builds nothing. The runner reports the reason in a single line, does not create
  a worktree, does not open an execution, and does not invoke the Constructor or the Validator.
  The plan keeps its gate state as evidence.

In a hotfix, the start signal is explicit acceptance of the agreed diagnosis. A second
confirmation is not required, and risk actions keep their explicit consent.

## Consents that are preserved

These consents are never derived from the current policy or from an invocation flag:

- Preserving the destination's uncommitted changes (`--preserve-dirty`).
- Discarding unintegrated work (`cleanup --discard`).
- Publishing or moving work to a remote.
- Deleting someone else's or pending-manual work.
- Modifying protected files.

A close with a dirty destination is escalated to the developer without cleaning the destination:
the rejection is safe and leaves everything intact.

## Pause by exception

Execution stops only by exception. It never pauses by routine: if the gate allows and no
consent is missing, it advances.

| Operational situation | Pause reason |
|--------------------|-----------------|
| Lack of authority, scope or requirement change, or missing risk consent. | `authority_block` |
| Explicit work limit reached with a pause effect. | `explicit_limit` |
| Absence of hypotheses or verifiable progress. | `no_verifiable_progress` |
| Invariant violated. | `invariant_violation` |
| Unverifiable external failure or unreadable record. | `progress_unavailable` |

The pause is reported with a canonical three-line message:

~~~
⏸ Pause by exception: {reason}
Preserved state: {worktree/branch; artifacts; last confirmed round; checkpoint if applicable}
To resume: {exact condition}
~~~

The detail adjusts to the execution's current profile: the development profile adds
evidence references and the last verified command; the production profile keeps the
three concise lines. The technical verification to resume is the same in both profiles.

An operational failure is not a functional rejection: it is not a round, it does not increment counters, and it does not
ask the Constructor for corrections. An unrecoverable failure declared with evidence and diagnosis
closes for an external cause while preserving work, history, and diagnosis; an unverifiable
external failure is not declared unrecoverable and produces a pause.

## Resumption

Resuming requires, together:

1. An explicit resumption signal.
2. The same execution: identity does not change.
3. The cause resolved, according to the pause reason.
4. Reading the execution record and the progress record.

Resumption reuses the evidence from the last round and the policy decisions: it does not
repeat already verified checks or reset counters. Non-idempotent actions whose
previous effect is uncertain are not repeated: they stop and escalate.

## Automatic decision record

The `AgentRunRecord` execution record includes an `autonomy` block:

| Field | Value |
|-------|-------|
| `autonomy.policy` | `gate-then-auto` — the technical gate is verified first and, when it passes, advancement is automatic. |
| `autonomy.decisions[]` | Append-only list of policy decisions. |

Each gate `PASS`, each pause by exception, and each resumption adds **exactly one**
entry. Each entry describes a policy decision:

| Field | Content |
|-------|-----------|
| `id` | Monotonic decision identity. |
| `kind` | `gate`, `pause`, or `resume`. |
| `policy` | `execution_gate`, `exception_pause`, or `resume_gate`. |
| `outcome` | `pass`, `fail`, `pause`, `resume`, or `reject`. |
| `verified` | `true` only if the evidence was read and confirmed. |
| `reason` | `null` or the current pause reason. |
| `command` | Command executed when applicable. |
| `result` | Summarized and verifiable result. |
| `evidence_refs` | Citable references for the decision. |
| `at` | Time of evaluation. |

A decision with `verified: false` never authorizes a risk permission or a close: it enables
at most a pause.

## Automatic mode

The `--auto` invocation flag **does not add permissions**: it declares that there is no routine
wait. It does not alter the gate or consents, does not enable preservation or
discard of changes, does not authorize publishing, does not enable deletion of someone else's work, and does not
enable modification of protected files.

## Limits

- The autonomy layer declares initiative (`assistant`, `autonomous-dev`); it is not a
  per-flow switch and does not alter the gate, audit, validation, or consents. The
  execution policy remains `gate-then-auto`.
- There are no new persistence spaces: policy decisions live in the execution
  record.
- There are no new agents or contracts: the current surfaces of runner,
  constructor, loop control, and termination are extended.
- The live validation contract keeps its schema and its verdict: material
  verification relies on its distinction between verified and unverified
  and on evidence inheritance.

## Verification

~~~
node --test .flowtask/bin/test/hitl-policy-gates.test.js
node --test .flowtask/bin/test/capas-contrato.test.js
~~~

The contract test verifies the `gate-then-auto` policy, the start signal without a second
confirmation, the policy decision record, the pause reasons, the canonical
three-line message, the preserved consents, and the coherence of the functional documentation.

The layers contract test verifies the autonomy values, the precedence between layers,
the per-layer failure table, and the migration defaults.

The normative source of the contract is the `agent-loop-run` skill and, for termination, the
`agent-loop-termination` skill.
