---
name: memory-protocol
description: Protocol for using Engram persistent memory. Load when you need to save or search information in Engram (mem_save, mem_search, mem_context, etc.)
license: MIT
compatibility: opencode
metadata:
  category: memory
  scope: flowtask
---

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

## HOW TO SEARCH

`mem_search` es full-text search (FTS5). Busca en título y contenido de las observaciones.
NO soporta filtro por metadata (topic_key, type, scope). Usa keywords naturales.

### Reglas

1. **NUNCA uses `topic_key:` como prefix** — FTS5 no lo interpreta como filtro
2. **NUNCA uses `type:` como prefix** — FTS5 no filtra por metadata
3. **Busca por keywords del título/contenido** de la observación que querés encontrar
4. **Primero `mem_context`** (barato), luego `mem_search` si no encontrás
5. **Si encontrás un ID**, usá `mem_get_observation(id: N)` para contenido completo

### Queries correctas por categoría

| Qué buscar | Query correcta | Ejemplo |
|-----------|---------------|---------|
| CA específico | `"CA-{ID}"` | `mem_search(q: "CA-018")` |
| Plan específico | `"Plan CA-{ID}"` | `mem_search(q: "Plan CA-018")` |
| Flow-state | `"Flow State: CA-{ID}"` | `mem_search(q: "Flow State: CA-018")` |
| Validación | `"Validation Report: CA-{ID}"` | `mem_search(q: "Validation Report: CA-018")` |
| Plan-Audit | `"Plan-Auditor Review: CA-{ID}"` | `mem_search(q: "Plan-Auditor Review: CA-018")` |
| Convenciones | `"project conventions"` | `mem_search(q: "project conventions")` |
| Naming | `"project naming"` | `mem_search(q: "project naming")` |
| Layers | `"project layers"` | `mem_search(q: "project layers")` |
| Patrones por capa | `"project patterns {layer}"` | `mem_search(q: "project patterns api")` |
| Protected files | `"project protected-files"` | `mem_search(q: "project protected-files")` |
| Config | `"project config"` | `mem_search(q: "project config")` |
| Decisiones impl | `"Decisiones"` + `"CA-{ID}"` | `mem_search(q: "Decisiones CA-018")` |
| Patrones impl | `"Patrón descubierto"` | `mem_search(q: "Patrón descubierto")` |
| Stack | `"project stack"` | `mem_search(q: "project stack")` |
| CAs anteriores | `"CA-"` + dominio | `mem_search(q: "CA- dominio proyecto")` |

### Protocolo de búsqueda

```
1. mem_context(limit: 20)          ← reciente, barato
2. mem_search(q: "keywords")       ← FTS5
3. mem_get_observation(id: N)       ← contenido completo si encontrás ID
```

### Búsqueda proactiva

Buscar en Engram cuando:
- El usuario pide "recordar", "recall", "qué hicimos", o referencia trabajo pasado
- Empezás un trabajo que podría haberse hecho antes
- El usuario menciona un tema del que no tenés contexto

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
| Flow state | `flow-state/{id}/[namespace]` | `flow-state/001/create` |
| Project conventions | `project/conventions` | — |
| Project naming | `project/naming` | — |
| Project layer | `project/{layer}` | `project/api`, `project/business`, `project/data` |
| Project stack | `project/stack` | — |
| Implementation | `impl/{id}/{artifact}` | `impl/001/user-service` |

### Ownership Rules

| Topic key | Owner | Who can write |
|-----------|-------|---------------|
| `project/{layer}` | **Initializer only** | `initializer` agent via `/init` commands |
| `project/conventions` | **Initializer only** | `initializer` agent via `/init` commands |
| `project/naming` | **Initializer only** | `initializer` agent via `/init` commands |
| `project/stack` | **Initializer only** | `initializer` agent via `/init` commands |
| `project/protected-files` | **Initializer only** | `initializer` agent via `/init` commands |
| `impl/{id}/*` | **Constructor** | `constructor` agent during implementation |
| `flow-state/{id}/*` | **Any agent** | Any agent tracking flow state |
| `plan/{id}` | **Planner** | `planner` agent generating plans |

**Critical**: `project/{layer}` is owned exclusively by the Initializer. Other agents (constructor, planner, validator) MUST NOT write to `project/{layer}` directly. If a constructor discovers a new pattern, it saves to `impl/{ID}/patterns`. If a planner discovers a convention, it records it in the plan under `impl/{ID}/decisions`.

---

## IMPORTANT

- These tools (mem_*) are NOT counted toward your tool call limit
- Always use topic_keys for project-scoped information to enable upsert
- Never save source code in memory — only conventions, patterns, decisions
- Search before you act: `mem_search` is cheap, assumptions are expensive
