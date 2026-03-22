# Engram Memory Protocol

You have access to Engram persistent memory via MCP tools.
This protocol teaches you **when** and **how** to use the memory tools.

---

## Available Tools

| Tool | Purpose |
|------|---------|
| `mem_save` | Save structured observations (after decisions, bugfixes, patterns) |
| `mem_search` | Full-text search across all memories |
| `mem_context` | Get recent context from previous sessions |
| `mem_update` | Update an existing observation by ID |
| `mem_timeline` | Chronological context around a specific observation |
| `mem_get_observation` | Get full untruncated content by ID |
| `mem_suggest_topic_key` | Suggest a stable topic_key for evolving topics |
| `mem_save_prompt` | Save a user prompt for future context |
| `mem_stats` | Show memory system statistics |
| `mem_session_start` | Register session start |
| `mem_session_end` | Mark session complete |
| `mem_session_summary` | Save comprehensive end-of-session summary |

---

## WHEN TO SAVE (mandatory)

Call `mem_save` IMMEDIATELY after any of these:

- Architecture or design decision made
- Bug fix completed
- Non-obvious discovery about the codebase
- Configuration change or environment setup
- Pattern established (naming, structure, convention)
- User preference or constraint learned
- Implementation of a plan artifact completed

**Format for `mem_save`:**
```
- title: Short, searchable (e.g. "Added user validation endpoint")
- type: decision | architecture | bugfix | pattern | config | discovery | requirement
- scope: project (default) | personal
- topic_key: optional stable key for upsert (e.g. "project/api-types")
- content: structured with **What**, **Why**, **Where**, **Learned**
```

---

## WHEN TO SEARCH

When the user asks to "remember", "recall", "what did we do", or references past work:

1. Call `mem_context` first — checks recent session history (fast, cheap)
2. If not found, call `mem_search` with relevant keywords
3. If you find a match, call `mem_get_observation` for full content

Also search proactively when:
- Starting work that might have been done before
- The user mentions a topic you have no context on

---

## SESSION CLOSE PROTOCOL (mandatory)

Before ending a session, you MUST call `mem_session_summary`:

```
## Goal
[What we were working on this session]

## Instructions
[User preferences or constraints discovered]

## Discoveries
- [Technical findings, gotchas, non-obvious learnings]

## Accomplished
- [Completed items with key details]

## Next Steps
- [What remains for the next session]

## Relevant Files
- path/to/file — [what it does or what changed]
```

This is NOT optional. If you skip this, the next session starts blind.

---

## AFTER COMPACTION

If you see a message about compaction or context reset:
1. IMMEDIATELY call `mem_context` to recover session state
2. Call `mem_search` for any relevant topic_keys
3. Only then continue working

---

## TOPIC KEY RECOMMENDATIONS

| Type | Topic key pattern | Example |
|------|------------------|---------|
| Requirement | `ca/{id}` | `ca/001` |
| Plan | `plan/{id}` | `plan/001` |
| Validation | `validation/{id}` | `validation/001` |
| Flow state | `flow-state/{id}` | `flow-state/001` |
| Project conventions | `project/conventions` | — |
| Project naming | `project/naming` | — |
| Project layer | `project/{layer}` | `project/api`, `project/services` |
| Project stack | `project/stack` | — |
| Implementation | `impl/{id}/{artifact}` | `impl/001/user-service` |

---

## IMPORTANT

- These tools (mem_*) are NOT counted toward your tool call limit
- Always use topic_keys for project-scoped information to enable upsert
- Never save source code in memory — only conventions, patterns, decisions
- Search before you act: `mem_search` is cheap, assumptions are expensive
