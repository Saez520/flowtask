# Gap-driven tests: budget and inheritance

Automated tests are generated only when real verification is missing.
This document describes their architecture; the canonical contract lives in
`.flowtask/agents/tester.md`, `.flowtask/agents/runner.md`, and
`.flowtask/agents/validator.md`.

## Purpose

Generating tests by risk produced volume without benefit: the flow almost always
concluded they were needed, wrote dozens of cases per delivery, and duplicated what
the plan already declared as a check. Cost grew while defect detection did not.

The gap-driven policy changes the trigger:

1. the plan declares how each acceptance criterion is verified;
2. only criteria without a sufficient path become gaps;
3. the Tester writes at most one test per gap and three per delivery;
4. validation inherits the report without repeating what was checked.

## Verification gap

A **verification gap** is an acceptance criterion whose non-compliance cannot
be observed with an existing test, a deterministic command, or the
manual check that the plan already declares.

The generation trigger is one of these:

| Situation | Result |
|-----------|-----------|
| The plan declares at least one gap with a defect and reason. | The Tester generates for those gaps within the budget. |
| The request names a plan criterion and an uncovered defect. | It is recorded as an `explicit_request` gap within the budget. |
| The request is generic and the plan declares no gaps. | `needs_decision`: nothing is generated. |
| The request names a criterion absent from the plan. | `needs_decision`: the Tester does not invent criteria or scope. |
| A gap declares no defect or reason. | `needs_decision`: correction of the plan is requested. |
| A criterion declares no path. | `not_covered` is reported with `missing_verification_path`; no test is invented. |
| A gap already has coverage. | `no_gaps` with the existing reference; coverage is not duplicated. |

Without declared gaps or a valid request, the flow continues to validation without
generating tests and without asking for confirmation.

## Per-criterion verification in the plan

Every plan with behavior criteria includes the section
`## Verification by criterion` with one row per material criterion:

| Criterion | Path | Reference | Defect | Why the path does not detect it |
|----------|-----|------------|---------|------------------------------|
| Material criterion. | `existing_test`, `command`, `manual`, or `gap`. | File and case, command, or manual steps. | Non-compliance that would go undetected. | Reason the path does not observe it. |

Plan rules:

- Each material criterion has its row.
- `existing_test` cites file and case; `command` cites command and expected
  result; `manual` cites steps and expected observation.
- `gap` requires a defect and `why_not_detected`.
- A criterion without a path is marked `gap` with defect and reason; it is not filled with a
  fictitious check.
- The plan does not write test code: tasks run existing tests,
  commands, or manual checks, but do not create or edit test files.
- Generic templates are not used, claims are not made about literal prose unless it is
  a format consumed by another component, and coverage is not duplicated.

The audit rejects a plan without the section, a gap without a defect or reason, a gap
with existing coverage, a task that creates or edits tests, and a filler or duplicated
check. A plan without test tasks is not a blocker.

## Budget

The budget is fixed and does not vary by environment:

| Rule | Value |
|-------|-------|
| Tests per gap | 1 test per gap. |
| Ceiling per delivery | 3 tests. |
| Default | 0 tests if there are no gaps or no valid request. |

The ceiling is not a quota: it is not filled with padding. Selection respects the plan's
order. What exceeds the ceiling is reported as an uncovered gap with reason
`budget_limit` and is not written.

## Generation and report

Only the Tester writes test code, and only for declared gaps. Each
test declares in its header:

| Field | Content |
|-------|-----------|
| `gap_ref` | Gap it covers. |
| Criterion | Associated acceptance criterion. |
| Defect | Non-compliance it detects. |
| `why_not_detected` | Why the plan's path did not detect it. |
| Observable behavior | Expected result under a condition. |

Without a named defect, the test is not written. Behavior is checked, not
internal structure. Generic templates are not used, coverage is not duplicated, claims
are not made about unconsumed literal prose, and no dependencies or network are added.

The report is recorded in `ca/CA-{ID}/artifact/tests-report` with `plan_ref`,
`execution_id`, `status`, `environment`, `report_detail`, `gaps_declared`,
`gaps_covered`, `gaps_not_covered`, `generated`, `coverage`, `commands`, `limits`,
and `persistence`. It does not reference a decision artifact because none exists.

Flow state is recorded in `flow-state/CA-{ID}/tests` with light treatment. If
persistence fails, the Tester reports the operational failure and does not
announce the delivery as ready for validation.

| Element | States |
|----------|---------|
| Test | `passed`, `failed`, or `unverified`. |
| Criterion | `covered`, `not_covered`, `failed`, or `unverified`. |

`failed` is a functional non-compliance: the expected behavior is not
met. `unverified` is a tool or environment limitation: it could not be
checked.

The detail of the operator message follows the current `policy.profile`: `detailed`
in development and `concise` in production.

## Inheritance in validation

Validation receives `plan_ref`, `tests_report_ref`, and `tests_gaps`, and inherits the
report with its source and observation time without re-running what was checked.

| Situation | Result |
|-----------|-----------|
| No gaps and report `NONE` | No report is expected; validation follows its normal course. |
| With gaps and report missing, unreadable, or incomplete | Operational failure with cause `tests_report_missing`; the scope remains `unverified` and is not approved. |
| Test `failed` | Functional rejection, with the case, command, expected, and actual. |
| Test `passed` | Verified evidence, inherited without re-running. |
| Criterion not covered or not verifiable | Manual verification or declaration as unverified with its cause. |

An incomplete report is one that does not declare all the plan's gaps. A missing
tool is not presented as non-compliance of the work: what was reached is preserved
and the cause and unverified scope are reported.

## No switches

There is no switch to enable or disable generation per delivery: the
trigger is the declared gap and the budget is fixed.

| There is no | Why |
|--------|---------|
| Per-delivery switch | The trigger is the gap, not a per-flow configuration. |
| Risk score or threshold | The decision is binary: there is a gap or there is not. |
| Question to the developer | Whether to generate is not consulted: the gap and the valid request determine it. |
| New agent or skill | The contract lives in the existing agents. |
| Decision artifact | The plan declares the gaps; the Tester only generates and reports. |

## Verification

From the repository root:

```
node --test '.flowtask/bin/test/tester-conditional-gate.test.js'
```

The test asserts the Tester, Runner, and Validator contract, the memory keys,
and coordination hygiene, and fails on a copy that reintroduces
a previous decision, loses the 1/3/0 budget, omits the gap's defect or reason,
accepts padding or duplicated coverage, loses the report, or confuses functional
failure with tool failure.

## Related references

- [INDEX.md](./INDEX.md) — index of the current architecture.
- [validation.md](./validation.md) — live validation, executed evidence, and single verdict.
- [../core-flowtask.md](../core-flowtask.md) — main flow of an execution.
- `.flowtask/agents/tester.md` — contract of the agent that generates gap-driven tests.
- `.flowtask/agents/runner.md` — dispatch of gap-driven generation.
- `.flowtask/agents/validator.md` — inheritance of the test report.
