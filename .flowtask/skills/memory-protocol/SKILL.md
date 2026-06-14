---
name: memory-protocol
description: "Guía práctica de uso de memoria Engram para agentes FlowTask. Cuándo guardar, cómo buscar y protocolos de sesión. Carga `memory-contract` transitivamente para contratos estructurales."
license: MIT
compatibility: opencode
metadata:
  category: memory
  scope: flowtask
---

skill({ name: "memory-contract" })

# Engram Memory Protocol

## Propósito

Este skill es la guía práctica diaria para usar Engram. Para los contratos de datos, categorías, formato de `topic_key`, artifact protocol y resiliencia, consultá `memory-contract` (cargado transitivamente). Para ownership de `topic_key`, consultá `topic-keys-convention`.

---

## Herramientas Disponibles

| Tool | Propósito |
|------|-----------|
| `mem_save` | Persiste observaciones estructuradas (decisiones, bugfixes, patrones) |
| `mem_search` | Búsqueda full-text en todas las memorias |
| `mem_context` | Contexto reciente de sesiones anteriores |
| `mem_get_observation` | Contenido completo sin truncar por ID |
| `mem_update` | Actualiza una observación existente por ID |
| `mem_timeline` | Contexto cronológico alrededor de una observación |
| `mem_suggest_topic_key` | Sugiere un topic_key estable para temas evolutivos |
| `mem_session_summary` | Guarda resumen completo de fin de sesión |
| `mem_session_start` | Registra inicio de sesión |
| `mem_session_end` | Marca sesión como completada |
| `mem_capture_passive` | Extrae aprendizajes estructurados del output (busca `## Key Learnings:`) |
| `mem_save_prompt` | Guarda el prompt del usuario para contexto futuro |
| `mem_compare` | Persiste veredicto de comparación semántica entre dos memorias |
| `mem_judge` | Registra veredicto sobre conflictos de memoria pendientes |
| `mem_delete` | Elimina una observación por ID (soft-delete por defecto) |
| `mem_doctor` | Diagnóstico operacional de solo lectura |
| `mem_current_project` | Detecta el proyecto actual desde el working directory |
| `mem_merge_projects` | Fusiona memorias de múltiples variantes de nombre de proyecto |
| `mem_stats` | Estadísticas del sistema de memoria |

---

## WHEN TO SAVE (obligatorio)

Llamá a `mem_save` INMEDIATAMENTE después de cualquiera de estos eventos:

- Decisión de arquitectura o diseño tomada
- Bugfix completado
- Descubrimiento no obvio sobre el código base
- Cambio de configuración o setup de entorno
- Patrón establecido (naming, estructura, convención)
- Preferencia o restricción del usuario aprendida
- Implementación de un artifacto de plan completada

**Formato de `mem_save`:**
- `title`: corto y buscable
- `type`: categoría oficial (`ca-artifact | decision | architecture | bugfix | pattern | config | discovery`)
- `scope`: `project` por defecto o `personal`
- `topic_key`: clave estable opcional para upsert
- `content`: estructurado con `**What**`, `**Why**`, `**Where**`, `**Learned**`

Reglas de `topic_key`:
- Distintos topics no deben sobreescribirse entre sí
- Reutilizá el mismo `topic_key` para actualizar un tema evolutivo
- Si no estás seguro de la key, usá `mem_suggest_topic_key` primero
- Usá `mem_update` cuando tengas un observation ID exacto para corregir

---

## HOW TO SEARCH

`mem_search` es búsqueda full-text (FTS5). Busca en título y contenido de las observaciones. No soporta filtro por metadata (`topic_key`, `type`, `scope`). Usá keywords naturales.

### Reglas

1. **NUNCA uses `topic_key:` como prefix** — FTS5 no lo interpreta como filtro
2. **NUNCA uses `type:` como prefix** — FTS5 no filtra por metadata
3. **Busca por keywords del título/contenido** de la observación que querés encontrar
4. **Primero `mem_context`** (barato), luego `mem_search` si no encontrás
5. **Si encontrás un ID**, usá `mem_get_observation(id: N)` para contenido completo

### Queries correctas por categoría

| Qué buscar | Query correcta | Ejemplo |
|-----------|---------------|---------|
| CA específico | `"CA-{ID}"` | `mem_search(query: "CA-018")` |
| Plan específico | `"Plan CA-{ID}"` | `mem_search(query: "Plan CA-018")` |
| Flow-state | `"Flow State: CA-{ID}"` | `mem_search(query: "Flow State: CA-018")` |
| Validación | `"Validation Report: CA-{ID}"` | `mem_search(query: "Validation Report: CA-018")` |
| Plan-Audit | `"Plan-Auditor Review: CA-{ID}"` | `mem_search(query: "Plan-Auditor Review: CA-018")` |
| Convenciones | `"project conventions"` | `mem_search(query: "project conventions")` |
| Naming | `"project naming"` | `mem_search(query: "project naming")` |
| Layers | `"project layers"` | `mem_search(query: "project layers")` |
| Patrones por capa | `"project patterns {layer}"` | `mem_search(query: "project patterns api")` |
| Protected files | `"project protected-files"` | `mem_search(query: "project protected-files")` |
| Config | `"project config"` | `mem_search(query: "project config")` |
| Decisiones impl | `"Decisiones"` + `"CA-{ID}"` | `mem_search(query: "Decisiones CA-018")` |
| Patrones impl | `"Patrón descubierto"` | `mem_search(query: "Patrón descubierto")` |
| Stack | `"project stack"` | `mem_search(query: "project stack")` |
| CAs anteriores | `"CA-"` + dominio | `mem_search(query: "CA- dominio proyecto")` |

### Protocolo de búsqueda

```
1. `mem_context(limit: 20)`
2. `mem_search(query: "keywords")`
3. `mem_get_observation(id: N)`
```

### Búsqueda proactiva

Buscá en Engram cuando:
- El usuario pide "recordar", "recall", "qué hicimos", "recordar", "acordate" o referencia trabajo pasado
- Empezás un trabajo que podría haberse hecho antes
- El usuario menciona un tema del que no tenés contexto
- El PRIMER mensaje del usuario referencia el proyecto, una feature o un problema

---

## SESSION CLOSE PROTOCOL (obligatorio)

Antes de terminar una sesión o decir "done" / "listo" / "that's it", DEBÉS llamar a `mem_session_summary` con esta estructura:

```
## Goal
[En qué estuvimos trabajando en esta sesión]

## Instructions
[Preferencias o restricciones del usuario descubiertas — omitir si no hay]

## Discoveries
- [Hallazgos técnicos, gotchas, aprendizajes no obvios]

## Accomplished
- [Tareas completadas con detalles clave]

## Next Steps
- [Lo que queda por hacer — para la próxima sesión]

## Relevant Files
- path/to/file — [qué hace o qué cambió]
```

Esto NO es opcional. Si lo omitís, la siguiente sesión empieza a ciegas.

---

## AFTER COMPACTION

Si ves un mensaje sobre compactación o reseteo de contexto, o si ves "FIRST ACTION REQUIRED" en tu contexto:

1. INMEDIATAMENTE llamá `mem_session_summary` con el resumen compactado — esto persiste lo que se hizo antes de la compactación
2. Luego llamá `mem_context` para recuperar contexto adicional de sesiones previas
3. Solo ENTONCES continuá trabajando

No saltees el paso 1. Sin él, todo lo hecho antes de la compactación se pierde de la memoria.

---

## Protocolo Pre-Write

Antes de ejecutar `mem_save`, seguí estos pasos:

1. **Buscar**: `mem_search(query: "{título o contenido esperado}")` — verificá si ya existe contenido similar.
2. **Verificar ownership**: consultá `topic-keys-convention`. ¿Sos el dueño del namespace? Si no lo sos, NO escribas ahí.
3. **Resolver dudas**: si no estás seguro del `topic_key`, usá `mem_suggest_topic_key(title: "...", type: "...")`.

---

## IMPORTANT

- Las tools `mem_*` NO cuentan contra el límite de tool calls
- Usá siempre `topic_key` para información con scope de proyecto (habilita upsert)
- Nunca guardes código fuente en memoria — solo convenciones, patrones, decisiones
- Buscá antes de actuar: `mem_search` es barato, asumir es caro

---

## Referencias

- Para contratos de datos, categorías oficiales, formato de `topic_key`, artifact protocol y resiliencia: consultá `memory-contract`.
- Para la tabla completa de ownership de `topic_key`: consultá `topic-keys-convention`.
