---
name: memory-protocol
description: Protocol for using Engram persistent memory. Load when you need to save or search information in Engram (mem\_save, mem\_search, mem\_context, etc.)
license: MIT
compatibility: opencode
metadata:
category: memory
scope: flowtask
---

# Engram Memory Protocol

***

## Available Tools

| Tool                    | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `mem_save`              | Save a structured observation (decision, snapshot, pattern)          |
| `mem_update`            | Update an existing observation by ID                                 |
| `mem_delete`            | Delete an observation (soft-delete by default, hard-delete optional) |
| `mem_search`            | Full-text search across all memories                                 |
| `mem_context`           | Get recent context from previous sessions                            |
| `mem_timeline`          | Chronological context around a specific observation                  |
| `mem_get_observation`   | Get full untruncated content by ID                                   |
| `mem_suggest_topic_key` | Suggest a stable topic\_key for evolving topics                      |
| `mem_save_prompt`       | Save a user prompt for future context                                |
| `mem_stats`             | Memory system statistics                                             |
| `mem_session_start`     | Register session start                                               |
| `mem_session_end`       | Mark session as completed                                            |
| `mem_session_summary`   | Save end-of-session summary                                          |
| `mem_capture_passive`   | Captura automática de observaciones desde contexto de conversación   |

***

## FILTROS NATIVOS

Engram v1.12.0 soporta filtros por metadata — úsalos en vez de prefijos en el título:

| Parámetro | Valores posibles                                                                                |
| --------- | ----------------------------------------------------------------------------------------------- |
| `type`    | `decision`, `architecture`, `bugfix`, `pattern`, `config`, `discovery`, `learning`, `manual`   |
| `scope`   | `"project"` (default FlowTask) \| `"personal"`                                                 |
| `project` | nombre del proyecto Engram                                                                      |

**Títulos**: cortos y buscables, como un commit message. Sin prefijos.

Ejemplo:
```
mem_search(query: "CA-42", type: "decision", scope: "project")   ← correcto
mem_search(q: "[OPS] CA-42")                                     ← obsoleto
```

### Tipos oficiales

| Type           | Cuándo usarlo en FlowTask                              |
| -------------- | ------------------------------------------------------ |
| `decision`     | Snapshots de estado, flow state, resultados de agentes |
| `architecture` | Decisiones estructurales cross-CA                      |
| `bugfix`       | Fix crítico que afecta futuras implementaciones        |
| `pattern`      | Convenciones de código descubiertas                    |
| `config`       | Stack, herramientas, configuración del proyecto        |
| `discovery`    | Hallazgos exploratorios, reportes de validación        |
| `learning`     | Aprendizajes personales del desarrollador              |
| `manual`       | Contenido creado manualmente fuera de un flujo         |

### Scope

`scope: "project"` — para toda memoria operativa de FlowTask
`scope: "personal"` — solo para learnings del desarrollador

***

## MODELO HÍBRIDO DE ESCRITURA

### a) Principio: Engram = índice, disco = contenido

- Engram guarda **qué pasó + dónde está el detalle**
- `.workspace/CA-{ID}/` guarda los documentos completos
- **NUNCA guardar contenido largo en Engram** — solo la ruta

### b) Formato oficial de `mem_save`

```
mem_save(
  type: "{type}",
  scope: "project",
  topic_key: "{key}",
  title: "{título corto y buscable}",
  content:
    What: {una línea — qué se hizo}
    Why: {motivación}
    Where: {rutas de archivos}
    Learned: {gotchas — omitir si no hay}
)
```

### c) Quién escribe qué

| Actor       | Escribe                                        | No escribe                    |
| ----------- | ---------------------------------------------- | ----------------------------- |
| Sub-agentes | Su propio snapshot en `flow-state/{ID}/{step}` | Nada de `project/*`           |
| Runner      | `mem_session_summary` al final del flujo       | Flow state de sub-agentes     |
| Initializer | `project/*` (exclusivo)                        | Flow state                    |

### d) Nadie guarda en Engram

- Discoveries intermedios de proceso
- Código fuente o fragmentos de código
- Contenido que solo sirve para auditoría → archivo en `.workspace/`

### e) Session summary — OBLIGATORIO

Solo el Runner. Usar el tool dedicado `mem_session_summary` (NO `mem_save`):

```
mem_session_summary(
  content: "Goal: ...\nAccomplished: ...\nDiscoveries: ...\nNext Steps: ...\nRelevant Files: ...",
  project: "{project-name}"
)
```

Los sub-agentes NO escriben session summaries.

***

## HOW TO SEARCH

**Protocolo:**

```
1. mem_context(limit: 20)                                              ← reciente, barato — siempre primero
2. mem_search(query: "keywords", type: "...", scope: "project")       ← con filtros nativos
3. mem_get_observation(id: N)                                          ← contenido completo si encontrás ID
```

**Queries por categoría:**

| Qué buscar        | Query                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| CA específico     | `mem_search(query: "CA-{ID}", type: "decision", scope: "project")`     |
| Plan específico   | `mem_search(query: "CA-{ID} plan", type: "decision", scope: "project")` |
| Flow state        | `mem_search(query: "CA-{ID}", type: "decision", scope: "project")`     |
| Convenciones      | `mem_search(query: "project conventions", scope: "project")`           |
| Layers            | `mem_search(query: "project layers", scope: "project")`                |
| Stack             | `mem_search(query: "project stack", type: "config", scope: "project")` |
| Patrones por capa | `mem_search(query: "project patterns {layer}", scope: "project")`      |

***

## AFTER COMPACTION

```
1. mem_session_summary(content: "contexto actual resumido", project: "{project-name}")
2. mem_context(limit: 20)
3. Continuar
```

***

## TOPIC KEYS Y OWNERSHIP

| Tipo                | Patrón                       | Owner                             |
| ------------------- | ---------------------------- | --------------------------------- |
| CA snapshot         | `ca/{id}`                    | ca-writer                         |
| Plan snapshot       | `plan/{id}`                  | planner                           |
| Flow state          | `flow-state/{id}/{step}`     | cada sub-agente escribe el suyo   |
| Audit review        | `flow-state/{id}/audit`      | plan-auditor                      |
| Validation report   | `validation/{id}`            | validator                         |
| Plan audit          | `plan-audit/{id}`            | plan-auditor                      |
| Project conventions | `project/conventions`        | **initializer only**              |
| Project layer       | `project/{layer}`            | **initializer only**              |
| Project stack       | `project/stack`              | **initializer only**              |
| Implementation      | `impl/{id}/{artifact}`       | constructor, logger, tester       |

**Critical**: `project/*` es exclusivo del Initializer. Para ownership completo → skill `topic-keys-convention`.

***

## IMPORTANTE

- `mem_*` tools no cuentan contra el límite de tool calls
- Siempre topic\_key para información de proyecto (habilita upsert)
- Documentos completos van a `.workspace/CA-{ID}/` con nombres canónicos: `ca.md` | `plan.md` | `validacion.md` — en Engram solo va la ruta, no el contenido.
- Search antes de actuar: `mem_search` es barato, las suposiciones son caras
