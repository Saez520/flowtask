# Safe parallel orchestration

## Purpose

Independent jobs from the same request can advance at the same time without mixing their
histories. Latency is reduced only when independence is verifiable with a citable
source; when in doubt, the batch degrades to sequential and declares the cause.

This page describes how the batch is decided, how dispatch is bounded, how a conflict
is contained, and which inherited surfaces are not relaxed. The normative source is the
`parallel-orchestration` skill; the operational integration lives in `.flowtask/agents/runner.md`.

## Current support and boundary

- **Background dispatch exists.** The runner already invokes subagents in the background for
  documentation and media generation.
- **There is no parallel engine.** There is no scheduler, distributed consensus, or
  parallel worktree engine. The decision of which jobs advance together is a normative
  runner policy, not a deterministic module.
- **The worktree manager remains the lifecycle authority.** It acquires
  locks in deterministic order, reports `resource_locked`, and preserves the resource when
  there is contention. Parallel orchestration does not rewrite that manager.

## Verifiable independence

Two jobs are independent when the four dimensions are verifiable with a
citable source:

| Dimension | What is compared | Citable source |
|---|---|---|
| Planned files | The files each job declares it will modify. | The approved plan of each job. |
| Memory writes | The `topic_key` values each job declares it will write. | The instance map and the plan. |
| Work space and branch | The `worktree` and branch of each job. | The worktree manager and the confirmed association. |
| Dependency | Whether one job needs another's result to start. | The plan and its dependencies. |

If a dimension is not verifiable, the batch is sequential with the cause
`independence_unverifiable` and its reevaluation condition. An assumption is never
presented as proven independence.

Touching the orchestrator contract or a rule shared by several agents forces
sequential advancement, even if the four dimensions are independent. In `build` the plan
must declare the planned files; in `define` and `plan` the file dimension does not
apply, while memory, space and branch, and dependency do apply.

## Batch decision and queue

The decision takes one result: `parallel`, `sequential_independence_unverifiable`,
`sequential_shared_surface`, `sequential_dependency`, or `sequential_capacity_unset`.

It is persisted as an optional `parallel_batch` field inside each job's instance map,
by upsert and preserving previous fields. There is no new record or
new `topic_key`.

Capacity is declared in `.flowtask/config/parallel.json` with the `maxParallel` key.
Missing, `null`, or invalid is equivalent to capacity 1 and sequential advancement: there is no invented
default value. The FIFO queue preserves arrival order, shows the position of
each job, and does not reorder silently. The decision is reevaluated before each phase.

## Bounded dispatch and join

A job has at most one subagent phase in flight. Background dispatch uses the canonical
`subagent()` format with `background: true`.

Before each dispatch, the job handshake runs and its identity is persisted.
The batch does not reuse a `sessionID` between jobs: each one opens its own thread and
records the returned identifier in its map.

A job does not advance a phase until the previous one finished and its result is readable. If
the notification does not arrive or the result is unreadable, that job pauses with
`progress_unavailable` and the others keep their own. There is no blind
re-dispatch.

The batch does not skip the Gate, audit, test decision, or consents:
each job satisfies them separately.

## Identity and traces

Each job keeps its base name, instance map, `task_id`, and
`sessionID`, its `execution_id`, its progress, termination, idempotency,
budget, and execution records, its worktree, its branch, its artifacts, and its numbering. Nothing is
shared or reset between jobs.

If a job loses its identity, thread, or recoverable state, only that job
stops, with the loss of continuity declared. The lost identity is not replaced, and
a new thread is never presented as a successful resumption.

## Conflict containment

| Condition | Current code | Preserved state | Resumption condition |
|---|---|---|---|
| Work space lock occupied | `resource_locked` | Worktree, branch, and artifacts intact. | Lock release. |
| Suspected simultaneous write | `concurrent_write_suspected` | Last confirmed state and its evidence. | The suspicion is resolved. |
| `topic_key` overlap | `concurrent_write_suspected` | Both records, unmodified. | The `topic_key` values are separated. |
| Branch that no longer integrates cleanly | Worktree manager result | Worktree, branch, and uncommitted changes. | The developer declares how to continue. |
| Loss of identity or state | `progress_unavailable` | Its checkpoint and artifact. | Identity or state becomes available again. |
| Deduplication race | `concurrent_write_suspected` | Both states, unmerged. | Out of scope: it is declared and not resolved. |

Containment rules: do not overwrite, do not blindly retry through another path, do not invent
identifiers, do not create a parallel record to replace a missing or unreadable one, do not
merge contradictory records, and do not declare zero for lack of data. A contained
conflict is never presented as completed work.

## Serialized integration

The `complete` close runs one at a time on the same base. Squash-merge is not
parallelized: two integrations on the same base do not run at the same time, even if the
jobs are independent.

A conflict preserves the worktree and branch and escalates: integration is not forced, the
destination is not cleaned, and no stash is created. `--preserve-dirty` still requires
explicit human consent.

## Inherited surfaces

- `context-degradation` keeps its packs by moment, its thresholds, and its tests.
- The conditional test gate keeps its decision, generation, inheritance, and
  documentation coherence.
- `agent-loop-progress`, `agent-loop-termination`, `agent-loop-idempotency`,
  `agent-loop-budget`, and `agent-loop-run` are consulted as the current source and are not
  redefined.
- `checkpoint-mixin` keeps the separation between checkpoints and execution records.
- Spending is attributed per execution, without splitting across batch jobs and without new
  caps.
- If an inherited surface is unreadable or a reference is broken, execution
  stops with the exact cause and no substitute rule is improvised.

## References

- `.flowtask/skills/parallel-orchestration/SKILL.md` — normative contract for
  safe parallel orchestration.
- `.flowtask/agents/runner.md` — section `## Orquestación paralela segura`: when it is
  evaluated, batch decision, dispatch and join, queue and capacity, containment, serialized
  integration, and surface inheritance.
- `.flowtask/config/README.md` — optional declaration of per-project capacity.
- `docs/architecture/worktree.md` — worktree manager boundary and absence of a parallel
  engine.
