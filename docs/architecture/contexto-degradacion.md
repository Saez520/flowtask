# Degraded context: levels, rules by moment, and verifiable recovery

The context of an execution grows with every read, every search, and every
round. This document describes how the system degrades that delivery before
omitting it, how it injects only the current moment's rules, and how it
recovers durable confirmed state when the thread loses context or changes
instance.

The canonical contract lives in `.flowtask/skills/context-degradation/SKILL.md`; its
executable implementation lives in
`.flowtask/plugins/flowtask-permission-gate/src/context-budget.ts` and its
application in the flow, in `.flowtask/agents/runner.md`.

## Purpose

1. Degrade by levels: warn, deliver less detail, and delegate what was omitted.
2. Inject progressively: only the current moment's rules.
3. Recover verifiably: what was already confirmed, with its source and observation
   time.
4. Do not lose information silently: nothing omitted is presented as complete.

## Scope

| Includes | Excludes |
|---------|---------|
| The three delivery degradation levels | History rewriting or compression |
| The rule pack for each moment | Simultaneous execution of several jobs |
| Recovery from existing durable records | Budget calibration |
| Inheritance of verified evidence | State backup on disk |
| Observable warnings and their delegation | The termination decision for a job |

## Degradation by levels

Degradation occurs in three levels and in that order. A level is never skipped
to deliver less without warning.

| Level | When it occurs | What the operator sees |
|-------|---------------|--------------------|
| Scoping warning | The first broad request of the turn. | What was requested, on which path, pattern, or window, and how to narrow it. |
| Reduced delivery | The delivery exceeds the per-call budget. | What was omitted, how much the omitted content weighed, and who to delegate it to. |
| Per-turn omission | The turn total reaches the accumulated budget. | The same warning, naming the turn's accumulated budget. |

### Prohibitions

- Delivering large content without warning.
- Presenting a cut as if it were the complete answer.
- Including a preview of the omitted content.
- Exposing the threshold figure: messages name the scope of the applied budget
  —per call or accumulated per turn— and the real omitted size.
- Cutting silently when the size cannot be measured: in that case a
  trace is emitted with the cause and the delivery is made without cutting.
- Delivering an image or document attachment to a flow that does not handle it: it is
  delegated with its measured size.

### Attachments and measurements

| Situation | Behavior |
|-----------|----------------|
| The delivery includes an image or document attachment | The measured text is declared, the attachment is delegated, and it is not delivered. |
| The tool output is not text and cannot be measured | A trace is emitted with the cause, the delivery is made intact, and the delivery is marked as unmeasurable. |

## Rules by moment

Work advances through moments. Each moment has a minimal pack of current
rules: what is expected, what is prohibited, and what warns. The full manual is not
repeated in every message.

| Moment | What is expected | What is prohibited | What warns |
|---------|---------------|--------------------|-----------|
| `intake` | Classification of the request and framing of the work. | Starting implementation without classifying. | Ambiguous input. |
| `define` | Requirement, observable behavior, and failure conditions. | Unexpressed business rules. | Assumed requirement. |
| `plan` | Tasks, dependencies, and execution order. | Unresolved design decisions. | Unsatisfied dependency. |
| `build` | Implementation according to the approved plan. | Scope outside the plan. | Scope conflict. |
| `validate` | Executed evidence and verdict. | Repeating already resolved checks. | Non-evaluable criterion. |
| `close` | Consolidation, close, and record. | Declaring unverified work closed. | Missing or unreadable record. |

Cross-cutting rules:

- When changing moments, the new pack is loaded and what was already resolved is inherited by
  reference: verified evidence is not re-verified by routine.
- If the pack is not shown, it is declared that it was not shown and the work is not
  presented as identified.
- If project memory is unavailable, the missing source is declared and work continues
  with the next available source; absence is not
  treated as confirmation.
- The pack describes behavior, not figures: thresholds are not shown.

## Verifiable recovery

Recovery runs before acting when the thread lost context due to
compaction, when it changed instance due to capacity, or when a new
thread was opened to continue an in-progress job.

### Sources and query order

| Order | Source | What it provides |
|-------|--------|------------|
| 1 | Instance map | Who is in charge, with which task, and in what state. |
| 2 | Approved plan | The tasks, their order, and the decisions already made. |
| 3 | Execution record | The execution state, the current round, and references to the other records. |
| 4 | Progress record | The last confirmed snapshot and its observable variables. |
| 5 | Spend record | The accumulated totals and the last evaluated gate. |

From those records, `round.number`, `variables`,
`integrity.last_snapshot_id`, `tokens.total`, `time.active_time_ms`,
`cost.estimated_usd`, and `integrity.last_confirmed_at` are recovered.

### Declaration block

Everything recovered is declared with its source and observation time:

```
Context recovery:
- Current decisions: {list} (source: {ref}, observed: {ISO-8601})
- Confirmed progress: round {N}; tasks {A}/{B}; criteria {C}/{D} (source: {ref}, observed: {ISO-8601})
- Accumulated spend: tokens {T}; active time {A}; estimated cost {C} (source: {ref}, observed: {ISO-8601})
- Last confirmed round: {N} (source: {ref})
- Unrecorded gaps: {list or "none"}
- To resume: {what is missing or "nothing"}
```

### Material pause and peripheral label

| Situation | Response |
|-----------|-----------|
| What is material to continue is not confirmed | Pause with reason `progress_unavailable` or `record_unavailable`, last confirmation preserved, and exact resumption condition. |
| The active execution is ambiguous | Response `no disponible` and pause: it is not chosen by convenience. |
| A record is unreadable or contradictory | The contradiction is declared and the execution pauses; contradictory records are not overwritten or merged. |
| A peripheral datum is missing | Work continues, labeling it `[No verificado]`; the absence of a minor source does not stop the work. |
| A material datum is missing without a current requirement | The gap is declared and work continues in a declared degraded mode. |

Zero is never declared for lack of data: what is absent is declared absent.

## Inheritance and discrepancy

Inherited evidence keeps its source and observation time. The next round
only verifies the new material datum it introduces.

| Situation | Effect |
|-----------|--------|
| Inherited evidence contradicts what was observed in the round | What disagrees and how is declared, and execution pauses before imposing a scope change. |
| A record from an earlier moment is still current | It is reused by reference: it is not re-verified by routine. |

The contradiction is not resolved by assuming which of the two sources is right,
and it is not hidden.

## Related references

- [INDEX.md](./INDEX.md) — index of the current architecture.
- [validacion.md](./validacion.md) — live validation, executed evidence, and single verdict.
- [verificacion-material.md](./verificacion-material.md) — material verification, citable evidence, and inheritance across roles.
- [../permission-gate.md](../permission-gate.md) — permissions, context budget, and review-stamp.
- `.flowtask/skills/context-degradation/SKILL.md` — canonical contract for degradation and recovery.
- `.flowtask/plugins/flowtask-permission-gate/src/context-budget.ts` — degradation levels and warning state.
- `.flowtask/agents/runner.md` — packs by moment and recovery block.
- `.flowtask/agents/ca-writer.md`, `.flowtask/agents/planner.md`,
  `.flowtask/agents/constructor.md`, `.flowtask/agents/validator.md` — current
  pack for each moment.
