# FlowTask Context

Shared context and utilities for all FlowTask agents.

---

## Topic Key Reference

| Type | Topic Key | Example |
|------|-----------|---------|
| Requirement | `ca/{id}` | `ca/001` |
| Plan | `plan/{id}` | `plan/001` |
| Plan Review | `validation/{id}` | `validation/001` |
| Flow State | `flow-state/{id}` | `flow-state/001` |
| Implementation | `impl/{id}/{artifact}` | `impl/001/user-service` |
| Implementation Decisions | `impl/{id}/decisions` | `impl/001/decisions` |
| Project Stack | `project/stack` | — |
| Project Layers | `project/layers` | — |
| Project Naming | `project/naming` | — |
| Project Conventions | `project/conventions` | — |
| Project Types | `project/types` | `project/types` |
| Project Repositories | `project/repositories` | `project/repositories` |
| Project Services | `project/services` | `project/services` |
| Project API | `project/api` | `project/api` |
| Project Config | `project/config` | `project/config` |

---

## Memory Types

| Type | When to use |
|------|-------------|
| `requirement` | Acceptance criteria, user stories |
| `architecture` | Implementation plans |
| `pattern` | Conventions, naming rules, structural patterns |
| `discovery` | Technical findings, implementation results |
| `decision` | Design decisions, flow state |

---

## Common Engram Patterns

### Before implementing, always search for:
```
mem_search(q: "project conventions")
mem_search(q: "project naming")
mem_search(q: "project patterns {layer}")
```

### After implementing, always save:
```
mem_save(
  type: "discovery",
  topic_key: "impl/{ca-id}/{artifact-name}",
  title: "{Artifact} implemented",
  content: "**What**: Created {artifact}\n**Where**: {path}\n**Patterns used**: {patterns}"
)
```

### When making design decisions, always save:
```
mem_save(
  type: "decision",
  topic_key: "impl/{ca-id}/decisions",
  title: "Decision: {title}",
  content: "**Decision**: {what was decided}\n**Alternatives**: {options considered}\n**Rationale**: {why}"
)
```

### When discovering new patterns, always save:
```
mem_save(
  type: "pattern",
  topic_key: "project/{layer}",
  title: "Pattern: {description}",
  content: "**Pattern**: {what was found}\n**Context**: {where}\n**Apply to**: {what else}"
)
```

### When searching for past work:
```
mem_search(q: "ca/{id}")
mem_search(q: "plan/{id}")
mem_search(q: "impl/{id}/decisions")
```

---

## Flow States

| State | Description |
|-------|-------------|
| `ca_created` | CA saved to Engram by CA-Writer |
| `plan_generated` | Plan saved to Engram by Planner |
| `plan_reviewed` | Plan-Auditor approved plan (auto for >5 tasks) |
| `executing` | Constructor is implementing |
| `implemented` | Implementation complete |
| `validating` | Validator is reviewing |
| `completed` | Workflow finished successfully |
| `failed` | Workflow failed after max retries |

---

## Error Classification

### Blockers (prevent approval)
- File not created
- Compilation error
- Violates plan constraint
- Protected file modified without permission
- Design decision taken but not documented

### Minor (don't prevent approval)
- Naming variation
- Missing comments
- Import ordering
- Minor code style issues

---

## Parallel Execution Guidelines

Subagents can run in parallel when:
- Tasks are independent (e.g., scanning different layers)
- Same layer but different artifacts (e.g., multiple DTOs)

Use Task tool with appropriate `subagent_type`:
```
task(
  description: "Scan types layer",
  prompt: "...",
  subagent_type: "flowtask-initializer"
)
```

---

## Important Reminders

- NEVER save source code in Engram
- ALWAYS use topic_keys for project-scoped information
- ALWAYS use upsert behavior (same topic_key updates existing)
- NEVER skip the checkpoint without --auto flag
- ALWAYS classify errors as blocker or minor
- ALWAYS update flow-state after completing a phase
- ALWAYS save design decisions to Engram
