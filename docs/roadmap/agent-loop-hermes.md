# Implementation plan — Agent Loop and Hermes

**Status:** approved on 2026-10-19. F0, F1, and F2 completed. F3 next. HERMES GATE H1 open.
**Scope:** evolution of FlowTask/Flotas toward an autonomous development engine and Hermes as a general-purpose product.
**Boundary:** OpenCode V2 is the harness/runtime; FlowTask is the control plane; Hermes is the product. OpenCode will not be forked.

## Naming and commit convention

- F0–F4 are planning labels. They live in this document and in Engram.
- Worktrees, branches, and CAs use descriptive capability names, not the phase ID.
- Commits use Conventional Commits and describe what was done. They do not include F0.1, CA-..., or roadmap IDs.
- Examples:
  - feat(agent-loop): add progress variables
  - feat(agent-loop): add termination invariants
  - feat(agent-loop): add idempotent retry checkpoints
  - docs(agent-loop): add implementation roadmap
- The phase ID may appear in documentation and Engram; never in the commit message.

## Current status

F0 completed:
- Supervised validation loop — 602dfdd.
- Durable Constructor continuity — 82a3f65.
- task_id E2E with planner and ca-writer — flow-state/CA-task-id-e2e/instances (#9594).
- Documentation without a hardcoded version — dcb03db.

F1 completed:
- F1.2 Progress variables — 0f522a7.
- F1.4 Invariants — 3510b2c.
- F1.3 Termination — e986bd5.
- F1.5 Idempotency — 1db9197.
- F1.6a Budget observability — 3274881.
- Control integration — 761004f.
- F1.1 AgentRun with F1.6b declared brake — 712b89f.

F2 completed:
- F2.6 Identity — 546d559.
- F2.2 Realtime Validator — ea7e912.
- F2.1 HITL — f15e7b0.
- F2.7 Zero-Assumptions — b15ab03.
- F2.3 CA-Writer — 7806503.
- F2.4 Planner — c598233.
- F2.5 Conditional Tester — 4b18f7a.
- F2.8 Context degradation — 6886317.
- F2.9 Parallel orchestration — 248a7e5.

## F0 — Integration and baseline (completed)

| Item | What was done | Evidence |
|---|---|---|
| F0.1 Validation loop | Functional rejection vs. operational failure; Inspector from the second rejection; no global maximum; pause for lack of progress, authority, limit, unrecoverable failure, or scope change. | 602dfdd |
| F0.2 Constructor continuity | Resumption only with identity, valid task_id, and restorable checkpoint; only operational failure or interruption. | 82a3f65 |
| F0.3 task_id E2E | Capture, persistence in Engram, and resumption of the same thread with planner and ca-writer. | #9594 |

## F1 — Agent Loop core

Objective: define the controller, progress, termination, invariants, and idempotency.

| Item | Status | Dependencies / parallel | Merge |
|---|---|---|---|
| F1.2 Progress variables | Implemented and validated | Parallel with F1.3, F1.4, F1.5, F1.6 | 0f522a7 |
| F1.4 Invariants | Implemented and validated | Parallel with F1.2/F1.3/F1.5 | 3510b2c |
| F1.3 Termination | Implemented and validated | Depends on F1.2; parallel with F1.4/F1.5 | e986bd5 |
| F1.5 Idempotency | Implemented and validated | Parallel with F1.2/F1.3/F1.4 | 1db9197 |
| F1.6a Budget — observability | Implemented and validated | Parallel | 3274881 |
| F1.6b Budget — declared brake | Implemented and validated | Lives inside AgentRun (F1.1) | 712b89f |
| F1.1 AgentRun | Implemented and validated | Depends on F1.2–F1.5 | 712b89f |
| Control integration | Implemented and validated | Consolidates control from F1.2–F1.6 | 761004f |

Applied merge order: progress → invariants → termination → idempotency → budget → integration → AgentRun.

HERMES GATE H0 — OPEN: the F1.1 contract was validated.

## F2 — Operational autonomy

Objective: replace human waits with policies, strengthen validation, identity, and agent evolution.

Parallel groups:
- A foundational: F2.6 identity, F2.8 context degradation, F2.9 parallel orchestration.
- B agent evolution: F2.3 CA-Writer and F2.4 Planner, with coordination.
- C validation: F2.2 Realtime Validator and F2.5 Conditional Tester; F2.5 after F2.2.

Sequence: F2.1 HITL after F1.1 + F2.6 + F2.2. F2.7 Zero-Assumptions after F2.6 + F2.1.

| Item | Status | Dependencies / parallel | Merge |
|---|---|---|---|
| F2.1 HITL | Implemented and validated | Validate during implementation when it applies | f15e7b0 |
| F2.2 Realtime Validator | Implemented and validated | Harness tools and non-plan validations | ea7e912 |
| F2.3 CA-Writer | Implemented and validated | Contradiction audit before evolving | 7806503 |
| F2.4 Planner | Implemented and validated | Mediated communication between agents | c598233 |
| F2.5 Conditional Tester | Implemented and validated | plan-auditor-like gate | 4b18f7a |
| F2.6 Identity | Implemented and validated | Historical bug resolved (#572); Hermes scope | 546d559 |
| F2.7 Zero-Assumptions | Implemented and validated | Formalized for CA-Writer/Planner/Inspector; coverage pending | b15ab03 |
| F2.8 Context degradation | Implemented and validated | Progressive injection | 6886317 |
| F2.9 Parallel orchestration | Implemented and validated | Validate whether it is already supported | 248a7e5 |

Hermes gate H1: F1 complete + F2.1 + F2.6 + F2.7 + F0.3. H1 can run in parallel with F3.

## F3 — Product and distribution

| Item | Status | Note |
|---|---|---|
| F3.1 Per-team installation | Approved | First of F3; parallel with F1/F2 |
| F3.2 Registry/adapter | Approved | Ignored folder, not tracked and not at the root |
| F3.3 --profile | Analysis | After F3.4 |
| F3.4 Persona/autonomy/permissions separation | Analysis | Parallel with F3.1 |
| F3.5 npm/pnpm | Analysis | pnpm preferred; do not delay |
| F3.6 Post-save | Analysis | Independent |

Hermes gate H2: H1 + domain permissions (F4.8) + F3 + audit/rollback.

## F4 — Hermes

| Stage | Scope | Dependency |
|---|---|---|
| H0 Shell | Interface, configuration, tool registry, permissions skeleton | F1.1 contract |
| H1 Hermes dev-only | Development using FlowTask | F1 + F2.1 + F2.6 + F2.7 + F0.3 |
| H2 Hermes general-purpose | Files, apps, terminal, browser, automations | H1 + F4.8 + F3 + audit/rollback |

Gates:
- HERMES GATE H0 — OPEN: the F1.1 contract was validated.
- HERMES GATE H1 — OPEN: F1 + F2.1 + F2.6 + F2.7 + F0.3 satisfy their conditions; it can start in parallel with F3.
- HERMES GATE H2 — can start.

H2 is not built from scratch: existing runtime base + controller, permissions, and interface.

## Discarded

- Non-technical persona: the product does not target that profile.
- Consecutive ID consistency: CAs no longer use consecutive IDs.
- Shareable workspace: workspaces are deprecated.
- Automatic task_id purge: overkill; manual is enough.

## Independent

- LSP + AST-Grep: does not block the loop or Hermes.

## Version

- The FlowTask version lives only in .flowtask/package.json.
- README and docs do not hardcode a version.
- Bump per phase; release = bump + tag; hotfix = patch.
- Hermes 1.0 has its own repo/version; FlowTask remains a plugin/engine with an independent version.
- OpenCode is not bumped from FlowTask.

## Relationship with Engram

The operational index is in architecture/provisional-roadmap-agent-loop-hermes-index. This document is the human version of the plan; Engram preserves the operational state and the per-item memories.
