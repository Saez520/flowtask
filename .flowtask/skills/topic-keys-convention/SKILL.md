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

Ownership rules for Engram topic_keys in FlowTask. Load this skill before `mem_save` if you're unsure which topic_key to use.

---

## Tabla de Ownership

Cada topic_key tiene un **owner** que es el único agente (o grupo) autorizado a escribir en él. Otros agentes pueden LEER pero nunca ESCRIBIR.

| Topic Key Pattern | Owner | Qué escribe | Lectores |
|-------------------|-------|-------------|----------|
| `ca/{ID}` | CA-Writer | Requisito aprobado del CA | Runner, Planner, Constructor, Validator |
| `ca/evolve-*` | CA-Writer | Requisito de evolución de agente | Runner, Planner, Constructor |
| `plan/{ID}` | Planner | Plan de implementación completo | Runner, Plan-Auditor, Constructor, Validator |
| `plan/evolve-*` | Planner | Plan de evolución de agente | Runner, Constructor |
| `plan-audit/{ID}` | Plan-Auditor | Review y verificación del plan | Runner, Validator |
| `validation/{ID}` | Validator | Reporte de validación del CA | Runner |
| `flow-state/{ID}/create` | CA-Writer | Estado del flujo CA-Writer | Runner |
| `flow-state/{ID}/plan` | Planner | Estado del flujo Planner | Runner |
| `flow-state/{ID}/audit` | Plan-Auditor | Estado del flujo Plan-Auditor | Runner |
| `flow-state/{ID}/construct` | Constructor | Estado del flujo Constructor | Runner |
| `flow-state/{ID}/validate` | Validator | Estado del flujo Validator | Runner |
| `impl/{ID}/{artifact}` | Constructor | Artefacto implementado (qué, dónde, patrones) | Validator, Planner |
| `impl/{ID}/patterns` | Constructor, Tester, Logger | Patrones técnicos descubiertos durante implementación | Validator |
| `impl/{ID}/decisions` | Constructor, Planner | Decisiones de diseño (qué se eligió, por qué) | Validator |
| `impl/{ID}/logging` | Logger | Descubrimientos de logging e instrumentación | — |
| `impl/{ID}/tests` | Tester | Descubrimientos de testing | — |
| `project/stack` | Initializer | Stack tecnológico del proyecto | Todos (read-only) |
| `project/conventions` | Initializer | Convenciones generales del proyecto | Todos (read-only) |
| `project/naming` | Initializer | Convenciones de nombrado | Todos (read-only) |
| `project/layers` | Initializer | Capas arquitectónicas y dirección de dependencias | Todos (read-only) |
| `project/{layer}` | **Initializer ONLY** | Patrones por capa (api, data, business, config, types, etc.) | Todos (read-only) |
| `project/protected-files` | Initializer | Archivos protegidos que no deben modificarse | Todos (read-only) |
| `project/config` | Initializer | Configuración detectada del proyecto | Todos (read-only) |
| `project/patterns` | Initializer | Patrones generales del proyecto | Todos (read-only) |
| `project/heuristics/*` | **Todos los agentes** (escritura compartida) | Heurísticas idiomáticas del desarrollador para este proyecto | Todos los agentes |
| `personal/heuristics/*` | **Todos los agentes** (escritura compartida, scope: personal) | Heurísticas cross-proyecto del desarrollador | Todos los agentes |
| `pending/*` | Runner, CA-Writer e Inspector (escritura compartida) | Runner: detección de pendientes; CA-Writer: clarificación previa a un CA; Inspector: hallazgos de auditoría | Agentes que necesiten conocer pendientes antes de formalizar un CA |

> **Nota — Modelo de escritura compartida para heurísticas**: A diferencia de otros topic_keys que tienen owner único, `project/heuristics/*` y `personal/heuristics/*` usan **escritura compartida**: cualquier agente puede escribir en estos namespaces. No hay owner único. La detección de colisiones se maneja por key normalizada (misma key normalizada = upsert, último escribe gana). Las heurísticas en `project/heuristics/*` NO son un `project/{layer}` — es un namespace nuevo con ownership compartido que convive sin conflicto con los `project/*` existentes del Initializer.

> **Nota — Pendientes**: La escritura compartida de `pending/*` es cooperativa por responsabilidad. Cada escritor actualiza únicamente el slug que creó o que está tratando en su contexto; no se sobreescriben pendientes ajenos sin coordinación explícita. Al promover un pendiente a un CA, se conserva `pending/{slug}` como registro separado y se crea o actualiza el artifacto canónico `ca/CA-{ID}/artifact/{filename}`; la promoción no elimina ni migra el registro pendiente.

---

## flow-state Sub-namespaces

`flow-state/{ID}` **NUNCA** se usa directamente. SIEMPRE se usa con un sub-namespace del agente:

| Sub-namespace | Agente que escribe | Ejemplo |
|---------------|--------------------|---------|
| `flow-state/{ID}/create` | CA-Writer | `flow-state/021/create` |
| `flow-state/{ID}/plan` | Planner | `flow-state/021/plan` |
| `flow-state/{ID}/audit` | Plan-Auditor | `flow-state/021/audit` |
| `flow-state/{ID}/construct` | Constructor | `flow-state/021/construct` |
| `flow-state/{ID}/validate` | Validator | `flow-state/021/validate` |

**Regla**: Cada agente escribe SOLO a su sub-namespace. Runner lee todos.

---

## project/{layer} — Initializer ONLY

> **Regla absoluta**: Solo el agente **Initializer** puede escribir en `project/{layer}`.

- `project/api`, `project/data`, `project/business`, `project/config`, `project/types`, etc.
- Otros agentes que descubran patrones durante implementación los guardan en `impl/{ID}/patterns`, NO en `project/{layer}`.
- Initializer es el único que puede consolidar patrones del proyecto.

---

## impl/{ID}/patterns vs impl/{ID}/decisions

Dos namespaces distintos con propósitos diferentes:

| Namespace | Quién escribe | Qué guarda | Ejemplo |
|-----------|---------------|-----------|---------|
| `impl/{ID}/patterns` | Constructor, Tester, Logger | Descubrimientos técnicos: convenciones encontradas, configuraciones, estructuras | "Los endpoints usan router.mount() con prefijo /api" |
| `impl/{ID}/decisions` | Constructor, Planner | Decisiones de diseño: por qué se eligió X sobre Y | "Usé PostgreSQL porque el proyecto ya tiene ORM configurado" |

---

## Resolución de Colisiones

### CA-018: validation/{ID} vs plan-audit/{ID}

**Problema**: Plan-Auditor y Validator compartían `validation/{ID}`, generando sobreescrituras.

**Solución**: Separación definitiva:
- `plan-audit/{ID}` → Solo Plan-Auditor escribe su review del plan
- `validation/{ID}` → Solo Validator escribe su reporte de validación

### CA-019: flow-state/{ID} sin sub-namespace

**Problema**: Agentes escribían directamente a `flow-state/{ID}`, causando que un agente sobreescribiera el estado de otro.

**Solución**: Sub-namespaces obligatorios:
- Cada agente escribe SOLO a `flow-state/{ID}/[su-agente]`
- Runner lee todos los sub-namespaces para obtener el estado completo

### CA-020: project/{layer} multi-escritor

**Problema**: Constructor, Planner e Initializer escribían a `project/{layer}`, causando inconsistencias.

**Solución**: Solo Initializer escribe a `project/{layer}`:
- Constructor y Planner guardan sus descubrimientos en `impl/{ID}/patterns`
- Initializer es el consolidador único de patrones del proyecto

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
Consulta la **Tabla de Ownership** arriba. ¿Eres el owner de ese topic_key? Si no lo eres, NO escribas ahí.

### 3. Resolver dudas
Si no estás seguro de qué topic_key usar:
```
mem_suggest_topic_key(title: "descripción del contenido", type: "pattern|decision|etc")
```
La herramienta te sugerirá un topic_key estable y apropiado.

---

## Restricciones

- **NUNCA** escribas a `project/{layer}` si no eres Initializer
- **NUNCA** uses `flow-state/{ID}` sin sub-namespace
- **NUNCA** compartas un topic_key entre agentes sin verificar ownership primero
- **SIEMPRE** busca (`mem_search`) antes de asumir que un topic_key está libre
- **SIEMPRE** usa `mem_suggest_topic_key` cuando tengas dudas sobre la key correcta
- **SIEMPRE** usa backticks al referenciar topic_keys en documentación (para grep-abilidad)
