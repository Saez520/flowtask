# Material verification and citable evidence

## Purpose

Every decision that depends on a material datum records where that
datum came from and in what state it was confirmed. An unconfirmed material datum is never
presented as fact: it becomes a pending decision or a pause. An unconfirmed
peripheral datum may continue, declared as unverified.

The protocol's normative source is the `zero-assumptions` skill; the role
contracts that apply it are the agents in `.flowtask/agents/`.

## Verification order

The query order is fixed:

1. **Project memory** — requirements, decisions, and conventions already recorded.
2. **Documentation, code, and repository state** — what the project declares
   and what the repository shows. The knowledge graph and direct reading
   instrument this step.
3. **The person** — the authority who decides.

The order is altered only with a declared reason. When project memory is not
available, the missing source is declared and work continues with the next one: the
absence of a source confirms nothing and does not enable the datum.

## Evidence record

The record lives inside the artifact that contains the decision. There is no global
record, parallel file, or separate namespace.

| Field | Content |
|-------|-----------|
| `schema` | `verification-record/v1`. |
| `id` | Unique record identifier within the artifact. |
| `datum` | The verified datum, with non-empty content. |
| `materiality` | `material` or `peripheral`. |
| `source_kind` | `memory`, `document_or_code`, `repository_state`, or `person`. |
| `source_ref` | Concrete, resolvable reference to the source. |
| `status` | `verified`, `unverified`, or `discrepant`. |
| `observed_at` | ISO-8601 timestamp of the observation. |
| `order_exception` | Declared reason for altering the order, or empty. |
| `missing_source` | Missing source, or empty. |
| `note` | Observation note, or empty. |

State rules:

- `verified` requires a resolvable source.
- `unverified` requires the cause of the absence and is admissible only for a peripheral
  datum.
- `discrepant` requires both conflicting sources and how they disagree.

There is no confidence score: the state and the source are enough.

## Uncertainty and discrepancy

An unconfirmed material datum is not presented as fact: it becomes a pending
decision or a pause. An unconfirmed peripheral datum continues as
unverified. When two sources contradict each other, the contradiction is reported with
both sources and is not resolved by assumption.

## Scope by role

| Role | Scope |
|-----|---------|
| Writes, plans, and explores | Verifies the material datum in the current order and records the evidence. |
| Builds and validates | Inherits verified evidence and verifies only the new material datum. |
| Orchestrates | Verifies routing, the gate, and the diagnosis. |

## Evidence inheritance

Verified evidence is inherited with its source and observation time: it is not
re-verified by routine. A mutable state is re-observed only when the
decision depends on its current value, and that re-observation is a new record,
not a repetition.

A contradiction with inherited evidence is recorded as discrepant, with
both sources, and pauses before imposing a scope change.

## Pause and resumption

When a material datum cannot be confirmed, execution pauses with the
current reason: lack of authority to decide, source unavailable or unreadable,
or absence of hypotheses and verifiable progress. The pause is reported with the
three-line message:

~~~
⏸ Pause by exception: {reason}
Preserved state: {work; artifacts; changes; last confirmed round}
To resume: {exact condition}
~~~

The detail adjusts to the current policy profile: the development profile
details the source and observation time; the production profile keeps
source and state concise. The minimum verification to resume is the same in
both profiles.

On resumption, verified material evidence is reused and checks already performed
are not repeated. If a material datum remains unconfirmed, the
pause is maintained.

## Limits

- There is no automatic blocking: compliance is verified by audit.
- There is no confidence score, percentage, or general verification engine.
- There are no per-role switches or new static configuration.
- There are no new namespaces: the record lives in the container artifact.
- There is no new pause reason: the current reasons are used.

## Verification

~~~
node --test .flowtask/bin/test/zero-assumptions-enforcement.test.js
~~~

The contract test verifies the verification order, the evidence
record, conservative materiality, the pause for an unconfirmed material
datum, scope by role, evidence inheritance, and the absence of a new
pause-reason enum.
