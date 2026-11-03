# Live validation: checks, evidence, and a single verdict

Live validation checks an implementation while it is being built,
with the environment's tools and executed evidence. This document
describes its architecture; the canonical contract lives in
`.flowtask/skills/validation-contract/SKILL.md` and its executable implementation
in `.flowtask/skills/validation-contract/scripts/validation-contract.js`.

## Purpose

Live validation replaces exclusively documentary inspection with
an executed and traceable check. Each validation:

1. declares what is reached and with which criteria it is evaluated;
2. runs checks with the available tools and records the
   command and its result;
3. distinguishes verified from unverified;
4. issues a single three-state verdict;
5. leaves reusable evidence for the next round.

## Scope

It applies to the validation of an implementation within a work flow.

| Includes | Excludes |
|---------|---------|
| `closure` and `intermediate` rounds | Validation of the entire repository by default |
| Scope declared per invocation | Partial approval |
| Checks per invocation and discovery through manifests | Correction of the implementation |
| Coordination-reference scanner | Dependency installation |
| Reusable executed evidence | Network consumption |
| Single three-state verdict | Numerical grading of the implementation |

## Validation rounds

| Round | What it validates | Result of a favorable verdict |
|-------|------------|------------------------------------|
| `closure` | The complete plan and its acceptance criteria. | `final: true`: closes the execution. |
| `intermediate` | Only what was reached, with declared scope. | `final: false`: execution continues. |

An intermediate round exists to verify what was reached before continuing. It does not
require the complete plan, does not ask for what does not exist yet, and never closes the
execution. The closure round is the only one that can produce `final: true`.

## Declared scope

Every invocation declares its scope. Scope is the validation
contract: without scope there is no possible verdict.

| Key | Rule |
|-------|-------|
| `schema_version` | Exactly `"1"`. |
| `execution_id` | Execution identifier, non-empty. |
| `round` | `closure` or `intermediate`. |
| `environment` | `development` or `production`. It is recorded; it does not alter the verdict. |
| `project_root` | Existing absolute path. Root of relative paths and of the working directory. |
| `plan_ref` | Reference to the plan. Mandatory in `closure`, optional in `intermediate`. |
| `scope.goal` | Declared objective, non-empty. |
| `scope.files` | Functional files in scope, relative to the project. They are scanned. |
| `scope.criteria` | Non-empty list of criteria with `id`, `material`, and `statement`. |

The descriptor also accepts `checks`, `findings`, `manual_verified`,
`manual_unverified`, `design_decisions`, and `scan`. An unknown key is
rejected at all levels and produces a structured error, never an
exception.

## Checks

Checks are declared per invocation. The list is the only adjustable part:

| Situation | Behavior |
|-----------|----------------|
| `checks` declared | Exactly the declared checks are run. |
| `checks` omitted | They are discovered through the project manifests. |
| `checks: []` | None are run. Without a successful check there is no favorable verdict. |

Discovery relies on the project manifests: scripts from a package
manifest, the project's own test directory, Python test
configuration, the Go module, the Rust manifest, the PHP
manifest, and the `make` build file. The returned list
is ordered, has no duplicates, and is not executed during discovery.

Each check declares `id`, `command`, `args`, `shell`, `timeout_ms`, `cwd`,
and `criteria`. The command runs without a shell by default; with `shell: true` the
argument list is empty. The working directory is relative and lives
inside the project root. The time limit per check ranges from 100
to 600000 milliseconds, with 120000 milliseconds by default.

Each check ends in one of three states:

| State | Cause |
|--------|-------|
| `passed` | The command exited with status 0. |
| `failed` | The command exited with a status other than 0, 126, or 127. |
| `unverified` | Timeout, missing tool, permission denied, signal, output limit, or execution error. |

A `failed` check does not by itself prove non-compliance with a
criterion. Every `failed` check receives an explicit disposition: it is
linked to a blocking finding with criterion, path, and evidence, or declared
as unverified with a known cause. Without disposition, the result is an
operational failure.

## Evidence schema

Evidence has a stable schema (`schema_version: "1"`) and the next round
reuses it.

| Field | Content |
|-------|-----------|
| `execution` | Identifier, round, environment, and plan reference. |
| `scope` | Objective, files, and declared criteria. |
| `checks` | Checks with command, state, cause, result, and bounded output. |
| `findings` | Findings with severity, criterion, path, line, and evidence. |
| `criteria` | State per criterion (`verified`, `unverified`, `uncovered`, `failed`) and its evidence. |
| `unverified` | Unverified checks and verifications, with their cause. |
| `design_decisions` | Design decisions with implementation, documentation, and evidence. |
| `counts` | Counts of checks, criteria, and findings. |
| `verdict`, `final`, `reasons` | Aggregated result and its reasons. |

Output excerpts are bounded to 2000 characters per stream and a finding's
evidence to 240 characters. Evidence does not contain complete logs or
source code.

## Verdict rules

The verdict is single and its precedence is fixed:

1. With at least one blocking finding, the verdict is `REJECTED`.
2. Without blockers, the verdict is `OPERATIONAL_FAILURE` when there is any
   unverified check, when a file remains without verifiable scanning,
   when a material criterion remains uncovered, when a `failed` check
   was left without disposition, when there are manual verifications
   declared as unverified, when no check was successful,
   or when there are no material criteria.
3. Without blockers and without any of those cases, the verdict is `APPROVED`.

`final` is true only with `APPROVED` in a `closure` round.

The report publishes counts of checks, criteria, and findings. It does not
publish a numerical grade: a number would suggest partial approval and is not
derived from the evidence.

## Validations not tied to the plan

The plan declares the implementation scope, not the exhaustive list of what
must be met. Live validation also checks:

- project conventions, even if the plan does not mention them;
- coordination hygiene in the functional files in scope;
- the coordination-reference scanner.

### Coordination-reference scanner

Functional code describes product behavior. Coordination references —the
execution identifier, its namespace, the artifact namespace, and coordination
keys— belong to the flow's coordination artifacts.

The scanner runs automatically on `scope.files` and, when declared,
on `scan.files`. It detects concrete values: execution identifiers,
artifact namespaces, flow-state paths, and literal coordination-key values.
Each match is a blocking finding.

| Rule | Behavior |
|-------|----------------|
| Scope | Only the declared functional files. |
| Directory traversals | They exclude `.git`, `.worktrees`, `node_modules`, `.flowtask`, the project history, and the roadmap record. |
| Explicit files | An explicit functional file inside `.flowtask/` is scanned. |
| Domain exception | `allowed_literals` allows a string required by the domain. |
| Unreadable or binary files | They remain unverified, never a finding. |

Execution placeholders are not findings.

## Reuse by the next round

A round's evidence remains in the validation artifact. The next round
receives its reference and does not repeat already
adjudicated checks. Per-criterion state travels with the evidence: a covered
criterion remains covered, and an unverified one remains declared as unverified,
with its cause.

Reusing evidence does not by itself enable a favorable verdict: the
precedence of states is applied independently in each round.

## Evidence inheritance and contradiction

A round's verified evidence is inherited with its source and observation
time. The next round is not re-verified by routine: it does not repeat
already adjudicated checks.

A mutable state is re-observed only when the decision depends on its current
value: it is a new record, not a repetition of the previous one.

| Situation | Effect |
|-----------|--------|
| Inherited evidence contradicts a check in the round | It is reported with both sources, no favorable verdict is issued, and scope is not changed. |
| A material datum cannot be confirmed | The check remains unverified with its cause, and the verdict is an operational failure, never a functional rejection. |
| A peripheral datum cannot be confirmed | It is declared unverified, with its cause, and does not block by itself. |

The contradiction is not resolved by assumption or turned into an automatic
rejection. The evidence schema, verdict precedence, and exit codes
do not change.

## Executable verification

From the repository root:

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js discover --project-root . --json
```

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js run --input <file|-> [--json]
```

`discover` lists the available checks and runs nothing. `run`
validates the descriptor, runs the checks, scans the scope, aggregates
the verdict, and publishes the report; with `--input -` it reads the descriptor from
standard input, and with `--json` it emits the complete result.

| Code | Meaning |
|--------|-------------|
| 0 | Approved. |
| 1 | Functional rejection. |
| 2 | Operational failure. |
| 3 | Invalid contract or usage error. |

## Hard limits

- The contract does not write files, install dependencies, fix code, or
  use the network.
- An invalid descriptor produces a structured error and never an exception.
- An unknown key, at any level, invalidates the descriptor.
- Approval requires at least one covered material criterion and at least one
  successful check.
- An operational failure is not a functional rejection or favorable evidence.
- The declared environment does not change the verdict.
- A coordination reference in a functional file blocks.

## Related references

- [INDEX.md](./INDEX.md) — index of the current architecture.
- [handshake.md](./handshake.md) — identity, continuity, and checkpoints.
- [verificacion-material.md](./verificacion-material.md) — material verification, citable evidence, and inheritance across roles.
- [../core-flowtask.md](../core-flowtask.md) — main flow of an execution.
- `.flowtask/agents/validator.md` — behavior of the agent that runs
  validation.
- `.flowtask/agents/runner.md` — dispatch per round and execution close.
