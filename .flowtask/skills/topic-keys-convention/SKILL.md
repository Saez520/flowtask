---
name: topic-keys-convention
description: "Topic_key ownership and collision prevention rules for Engram. Load before writing to Engram to know which keys exist, who owns them, and how to prevent collisions."
license: MIT
compatibility: opencode
metadata:
  category: memory
  scope: flowtask
---

# Topic Keys Convention

Este skill es una **vista derivada** de `memory-contract`. No es una fuente normativa independiente.
Para namespaces canónicos, ownership, types, scopes, payloads, excepciones y degradación,
consultá `memory-contract` como autoridad.

Ownership rules for Engram topic_keys in FlowTask. Load this skill before `mem_save` if you're unsure which topic_key to use.

---

## Tabla de Ownership

Cada topic_key tiene un **owner** que es el único agente (o grupo) autorizado a escribir en él. Otros agentes pueden LEER pero nunca ESCRIBIR.

| Topic Key Pattern | Owner | Qué escribe | Lectores |
|-------------------|-------|-------------|----------|
| `ca/CA-{ID}/artifact/ca` | CA-Writer | Requisito aprobado del CA | Runner, Planner, Constructor, Validator |
| `ca/CA-{ID}/artifact/plan` | Planner | Plan de implementación completo | Runner, Plan-Auditor, Constructor, Validator |
| `ca/CA-{ID}/artifact/audit` | Plan-Auditor | Review y verificación del plan | Runner, Validator |
| `ca/CA-{ID}/artifact/validacion` | Validator | Reporte de validación del CA | Runner |
| `ca/CA-{ID}/artifact/logging-report` | Logger | Reporte de instrumentación | — |
| `ca/CA-{ID}/artifact/tests-report` | Tester | Reporte de tests generados | — |
| `flow-state/CA-{ID}/create` | CA-Writer | Estado del flujo CA-Writer | Runner |
| `flow-state/CA-{ID}/plan` | Planner | Estado del flujo Planner | Runner |
| `flow-state/CA-{ID}/audit` | Plan-Auditor | Estado del flujo Plan-Auditor | Runner |
| `flow-state/{execution_id}/construct` | Constructor | Estado del flujo Constructor | Runner |
| `flow-state/{execution_id}/validate` | Validator | Estado del flujo Validator | Runner |
| `flow-state/{ID}/tests` | Tester | Estado del flujo Tester | Runner |
| `flow-state/{CA-ID}/review` | Review-Orchestrator | Estado del flujo Review | Runner |
| `flow-state/{ID}/logging` | Logger | Estado del flujo Logger | Runner |
| `flow-state/{ID}/init` | Initializer | Estado del flujo Initializer | Runner |
| `flow-state/CA-{ID}/inspect` | Inspector | Estado del flujo Inspector | Runner |
| `flow-state/CA-{ID}/instances` | Runner | Mapa de instancias del CA | Runner (escritura exclusiva) |
| `flow-state/no-ca/{agente}/{operation-id}` | Agentes ligeros sin CA | Estado de operación independiente | Runner |
| `project/stack` | Initializer (owner) / onboarder (excepción) | Stack tecnológico del proyecto | Todos (read-only) |
| `project/conventions` | Initializer | Convenciones generales del proyecto | Todos (read-only) |
| `project/naming` | Initializer | Convenciones de nombrado | Todos (read-only) |
| `project/layers` | Initializer | Capas arquitectónicas y dirección de dependencias | Todos (read-only) |
| `project/{layer}` | **Initializer ONLY** | Patrones por capa (api, data, business, config, types, etc.) | Todos (read-only) |
| `project/protected-files` | Initializer | Archivos protegidos que no deben modificarse | Todos (read-only) |
| `project/config` | Initializer | Configuración detectada del proyecto | Todos (read-only) |
| `project/patterns` | Initializer | Patrones generales del proyecto | Todos (read-only) |
| `project/heuristics/*` | **Todos los agentes** (escritura compartida) | Heurísticas idiomáticas del desarrollador para este proyecto | Todos los agentes |
| `personal/heuristics/*` | **Todos los agentes** (escritura compartida, scope: personal) | Heurísticas cross-proyecto del desarrollador | Todos los agentes |
| `pending/{slug}` | Runner, CA-Writer e Inspector (escritura compartida) | Runner: detección de pendientes; CA-Writer: clarificación previa a un CA; Inspector: hallazgos de auditoría | Agentes que necesiten conocer pendientes antes de formalizar un CA |

> **Nota — Modelo de escritura compartida para heurísticas**: A diferencia de otros topic_keys que tienen owner único, `project/heuristics/*` y `personal/heuristics/*` usan **escritura compartida**: cualquier agente puede escribir en estos namespaces. No hay owner único. La detección de colisiones se maneja por key normalizada (misma key normalizada = upsert, último escribe gana). Las heurísticas en `project/heuristics/*` NO son un `project/{layer}` — es un namespace nuevo con ownership compartido que convive sin conflicto con los `project/*` existentes del Initializer.

> **Nota — Pendientes**: La escritura compartida de `pending/*` es cooperativa por responsabilidad. Cada escritor actualiza únicamente el slug que creó o que está tratando en su contexto; no se sobreescriben pendientes ajenos sin coordinación explícita. Al promover un pendiente a un CA, se conserva `pending/{slug}` como registro separado y se crea o actualiza el artifacto canónico `ca/CA-{ID}/artifact/{filename}`; la promoción no elimina ni migra el registro pendiente.

---

## Excepción de Ownership: `project/stack` para Onboarder

El **onboarder** puede escribir `project/stack` SOLO cuando detecta diff en archivos de dependencias del proyecto.
El contenido es un snapshot vigente del stack técnico, no reglas de configuración.
Esta excepción está documentada en `memory-contract` y el onboarder la referencia al escribir.

---

## flow-state Sub-namespaces

`flow-state/{CA-ID}` **NUNCA** se usa directamente. SIEMPRE se usa con un sub-namespace del agente:

| Sub-namespace | Agente que escribe | Ejemplo |
|---------------|--------------------|---------|
| `flow-state/CA-{ID}/create` | CA-Writer | `flow-state/CA-021/create` |
| `flow-state/CA-{ID}/plan` | Planner | `flow-state/CA-021/plan` |
| `flow-state/CA-{ID}/audit` | Plan-Auditor | `flow-state/CA-021/audit` |
| `flow-state/{execution_id}/construct` | Constructor | `flow-state/CA-021/construct` |
| `flow-state/{execution_id}/validate` | Validator | `flow-state/CA-021/validate` |
| `flow-state/{ID}/tests` | Tester | `flow-state/CA-021/tests` |
| `flow-state/{CA-ID}/review` | Review-Orchestrator | `flow-state/CA-021/review` |
| `flow-state/{ID}/logging` | Logger | `flow-state/CA-021/logging` |
| `flow-state/{ID}/init` | Initializer | `flow-state/CA-021/init` |
| `flow-state/CA-{ID}/inspect` | Inspector | `flow-state/CA-021/inspect` |

**Regla**: Cada agente escribe SOLO a su sub-namespace. Runner lee todos.

---

## project/{layer} — Initializer ONLY

> **Regla absoluta**: Solo el agente **Initializer** puede escribir en `project/{layer}`.

- `project/api`, `project/data`, `project/business`, `project/config`, `project/types`, etc.
- Otros agentes que descubran patrones durante implementación los guardan en `impl/{ID}/patterns`, NO en `project/{layer}`.
- Initializer es el único que puede consolidar patrones del proyecto.

---

## Prevención de Colisiones — Protocolo

Antes de escribir a cualquier topic_key, sigue estos 3 pasos:

### 1. Buscar

Usa keywords del título o contenido esperado de la observación:
```
mem_search(query: "{título o contenido esperado}", scope: "project")
```
Verifica si ya existe contenido similar.

### 2. Verificar ownership

Consultá la **Tabla de Ownership** arriba. ¿Eres el owner de ese topic_key? Si no lo eres, NO escribas ahí.

### 3. Resolver dudas

Si no estás seguro de qué topic_key usar:
```
mem_suggest_topic_key(title: "descripción del contenido", type: "pattern|decision|etc")
```
La herramienta te sugerirá un topic_key estable y apropiado.

---

## Restricciones

- **NUNCA** escribas a `project/{layer}` si no eres Initializer
- **NUNCA** uses `flow-state/{CA-ID}` sin sub-namespace de agente
- **NUNCA** compartas un topic_key entre agentes sin verificar ownership primero
- **SIEMPRE** busca (`mem_search`) antes de asumir que un topic_key está libre
- **SIEMPRE** usa `mem_suggest_topic_key` cuando tengas dudas sobre la key correcta
- **SIEMPRE** usa backticks al referenciar topic_keys en documentación (para grep-abilidad)
