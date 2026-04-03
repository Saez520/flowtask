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

***

## PREFIJOS OBLIGATORIOS EN TÍTULO

Engram usa FTS5 — no soporta filtro por metadata. Los prefijos simulan categorías buscables:

| Prefijo | Uso                                                                         | Buscable por agentes         |
| ------- | --------------------------------------------------------------------------- | ---------------------------- |
| `[OPS]` | Memoria operativa: snapshots, flow states, decisiones críticas cross-agente | ✅ Sí                         |
| `[ARC]` | Archivo histórico: sessions, análisis, discoveries intermedios              | ❌ No — solo auditoría humana |

**Regla**: todo `mem_save` debe comenzar el título con `[OPS]` o `[ARC]`.

Los agentes SIEMPRE buscan con prefijo `[OPS]`:

```
mem_search(q: "[OPS] classifier")    ← correcto
mem_search(q: "classifier")          ← incorrecto, trae ruido
```

***

## MODELO HÍBRIDO DE ESCRITURA

La responsabilidad de escritura en Engram está dividida. No se solapan.

### Sub-agentes escriben: flow state únicamente

Cada sub-agente es responsable de registrar su propio cambio de estado al completar su tarea.

```
mem_save(
  type: "decision",
  topic_key: "flow-state/{ID}/[namespace]",
  title: "[OPS] Flow State: CA-{ID} — {agente}",
  content:          ← máximo 5 líneas
    state: {estado}
    timestamp: {ahora}
    agent: {nombre-agente}
    result: {completado / bloqueado / fallido}
    note: {una línea si hay algo relevante, omitir si no}
)
```

### Runner escribe: snapshots y decisiones críticas

El Runner es quien tiene visión completa del pipeline. Escribe después de que un sub-agente completa su tarea, basándose en el resumen que el sub-agente devuelve.

```
mem_save(
  type: "decision",
  topic_key: "{tipo}/{ID}",
  title: "[OPS] {título searchable}",
  content:          ← máximo 10 líneas
    state: {estado actual}
    what: {1-2 líneas qué hace o qué cambió}
    constraints: {qué no debe romperse}
    files: {archivos clave si aplica}
    file: {ruta al documento completo si existe}
)
```

### Nadie guarda en Engram:

- Discoveries intermedios del proceso
- Decisiones de diseño internas de un solo agente
- Contenido que solo sirve para auditoría humana → va a archivo en `.workspace/`
- Código fuente o fragmentos de código

### Session summary

Solo el Runner escribe `mem_session_summary`, y solo si hubo decisiones críticas o cambios de estado relevantes para la próxima sesión. Usar título `[ARC] Session summary: {tema}`.

Los sub-agentes NO escriben session summaries — solo ven su fragmento del pipeline, no la sesión completa.

***

## HOW TO SEARCH

`mem_search` es FTS5. Busca en título y contenido. NO filtra por metadata.

**Protocolo:**

```
1. mem_context(limit: 20)            ← reciente, barato — siempre primero
2. mem_search(q: "[OPS] keywords")   ← FTS5 con prefijo
3. mem_get_observation(id: N)        ← contenido completo si encontrás ID
```

**Queries por categoría:**

| Qué buscar        | Query                              |
| ----------------- | ---------------------------------- |
| CA específico     | `"[OPS] CA-{ID}"`                  |
| Plan específico   | `"[OPS] Plan CA-{ID}"`             |
| Flow state        | `"[OPS] Flow State CA-{ID}"`       |
| Convenciones      | `"[OPS] project conventions"`      |
| Layers            | `"[OPS] project layers"`           |
| Stack             | `"[OPS] project stack"`            |
| Patrones por capa | `"[OPS] project patterns {layer}"` |

**Nunca uses** **`topic_key:`** **o** **`type:`** **como prefix** — FTS5 no los interpreta como filtros.

***

## AFTER COMPACTION

```
1. mem_context(limit: 20)
2. mem_search(q: "[OPS] {tema actual}")
3. Continuar
```

***

## TOPIC KEYS Y OWNERSHIP

| Tipo                | Patrón                        | Owner                       |
| ------------------- | ----------------------------- | --------------------------- |
| CA snapshot         | `ca/{id}`                     | ca-writer (vía Runner) |
| Plan snapshot       | `plan/{id}`                   | planner (vía Runner)   |
| Flow state          | `flow-state/{id}/[namespace]` | sub-agente que ejecutó      |
| Project conventions | `project/conventions`         | **initializer only**        |
| Project layer       | `project/{layer}`             | **initializer only**        |
| Project stack       | `project/stack`               | **initializer only**        |
| Implementation      | `impl/{id}/{artifact}`        | constructor (flow state)    |

**Critical**: `project/{layer}`, `project/conventions`, `project/stack` son exclusivos del Initializer. Otros agentes NO escriben en estas keys directamente. Patrón nuevo descubierto por constructor → `impl/{ID}/patterns`. Convención descubierta por planner → `impl/{ID}/decisions`.

***

## IMPORTANTE

- `mem_*` tools no cuentan contra el límite de tool calls
- Siempre topic\_key para información de proyecto (habilita upsert)
- Documentos completos van a `.workspace/CA-{ID}/` con nombres canónicos: `ca.md` | `plan.md` | `validacion.md` — en Engram solo va la ruta, no el contenido.
- Search antes de actuar: `mem_search` es barato, las suposiciones son caras

