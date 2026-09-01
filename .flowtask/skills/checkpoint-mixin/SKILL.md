---
name: checkpoint-mixin
description: >-
  Persistencia de contexto entre ejecuciones de subagentes. Cargar cuando
  el agente necesita restaurar estado previo o guardar checkpoint. Define el
  contrato normativo de mem_save para checkpoints con schema enriquecido,
  bifurcación por clase de tratamiento y namespaces con/sin CA.
---

# CheckpointMixin — Persistencia de Contexto

## Propósito

Define el contrato único de persistencia de estado para subagentes usando Engram.
Cada agente guarda y restaura su estado mediante `mem_save` y `mem_search` directos,
con un schema normativo y namespaces que distinguen operaciones con CA de operaciones sin CA.

## Clase de tratamiento

El comportamiento de continuidad depende de la clase de tratamiento del agente:

| Clase | Agentes | Comportamiento |
|-------|---------|----------------|
| **Completo** | `ca-writer`, `planner` | Continuidad vía checkpoint del mismo CA. Si existe checkpoint activo y `state != "completed"`, se reanuda la sesión previa (Escenario B). |
| **Ligero** | `inspector`, `constructor`, `validator`, `tester`, `review-orchestrator`, `logger`, `initializer` | Hilo nuevo siempre. Si existe checkpoint previo, se restaura explícitamente el estado como insumo, pero la ejecución NO es continuación técnica de la anterior. Nunca se reutiliza `task_id` ni identidad previa. |

## Schema normativo del checkpoint

Toda observación de checkpoint en Engram usa este schema:

```json
{
  "version": "2.0",
  "topic_key": "flow-state/{CA-ID}/{agente}",
  "type": "decision",
  "scope": "project",
  "title": "Checkpoint {agente}: {instance_name}",
  "treatment_class": "complete | light",
  "state": "active | paused | completed",
  "updated_at": "timestamp",
  "sequence": 1,
  "topic_signature": {
    "ids": ["CA-topic-validation", "handshake-protocol"],
    "keywords": ["validación", "tema"]
  },
  "flow_state": {
    "estado": "activo",
    "ca_id": "CA-{ID}",
    "agente": "{agente}",
    "instance_name": "{Name}"
  }
}
```

### Campos del schema

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `version` | string | Versión del contrato (`"2.0"`). |
| `treatment_class` | `"complete"` \| `"light"` | Clase de tratamiento. Determina la bifurcación de continuidad. |
| `state` | `"active"` \| `"paused"` \| `"completed"` | Estado del checkpoint. `"completed"` marca de cierre — conserva la observación como traza (no se borra). |
| `sequence` | entero | Contador monotónico incremental por agente. |
| `topic_signature` | objeto \| ausente | Firma del tema (opcional, backward-compatible). Si el checkpoint no lo trae, se asume mismo tema (degradación explícita). |
| `flow_state` | objeto | Estado específico del agente. |

### Campos adicionales por tratamiento

- **Completo**: `flow_state.ca_id` (obligatorio) + `flow_state.resume_ref` (referencia de reanudación).
- **Ligero sin CA**: `flow_state.operation_id` (obligatorio) + `flow_state.fresh_thread_marker: true`.

## Protocolo de uso

### Tratamiento completo (ca-writer, planner)

**Al inicio:**

```
1. Verificar checkpoint: mem_search(query: "flow-state/{CA-ID}/{agente}")
2. Si existe y state != "completed":
   - Restaurar flow_state (tradeoffs, gaps, decisiones pendientes)
   - Continuar desde donde quedó (Escenario B)
3. Si no existe o está "completed": comenzar desde cero (Escenario A)
```

**Durante ejecución — guardar checkpoint:**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{CA-ID}/{agente}",
  title: "Checkpoint {agente}: {instance_name}",
  content: {
    version: "2.0",
    treatment_class: "complete",
    state: "active",
    updated_at: now(),
    sequence: N,
    topic_signature: { ids: [...], keywords: [...] },  // opcional
    flow_state: {
      ca_id: "CA-{ID}",
      agente: "{agente}",
      instance_name: "{Name}",
      resume_ref: "{task_id}",
      // estado específico del agente
    }
  }
)
```

**Al completar — cerrar checkpoint:**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{CA-ID}/{agente}",
  title: "Checkpoint {agente}: {instance_name}",
  content: {
    version: "2.0",
    treatment_class: "complete",
    state: "completed",
    updated_at: now(),
    sequence: N,
    flow_state: {
      ca_id: "CA-{ID}",
      agente: "{agente}",
      instance_name: "{Name}"
    }
  }
)
```

> `state: "completed"` marca el cierre y conserva la observación como traza consultable. No se elimina.

### Tratamiento ligero (inspector, constructor, validator, tester, review-orchestrator, logger, initializer)

**Al inicio:**

```
1. Verificar checkpoint: mem_search(query: "flow-state/{CA-ID}/{agente}")
   (o flow-state/no-ca/{agente}/{operation-id} si no hay CA)
2. Si existe checkpoint previo:
   - Restaurar explícitamente el estado como insumo (temas explorados, tradeoffs, gaps)
   - La nueva ejecución NO es continuación técnica de la anterior
3. Siempre crear hilo nuevo (Escenario A, task_id = null)
```

**Durante ejecución — guardar checkpoint (con CA):**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{CA-ID}/{agente}",
  title: "Checkpoint {agente}: {instance_name}",
  content: {
    version: "2.0",
    treatment_class: "light",
    state: "active",
    updated_at: now(),
    sequence: N,
    flow_state: {
      ca_id: "CA-{ID}",
      agente: "{agente}",
      instance_name: "{Name}",
      // estado específico del agente
    }
  }
)
```

**Durante ejecución — guardar checkpoint (sin CA):**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/no-ca/{agente}/{operation-id}",
  title: "Checkpoint {agente}: {instance_name}",
  content: {
    version: "2.0",
    treatment_class: "light",
    state: "active",
    updated_at: now(),
    sequence: N,
    fresh_thread_marker: true,
    flow_state: {
      operation_id: "{operation-id}",
      agente: "{agente}",
      instance_name: "{Name}",
      // estado específico del agente
    }
  }
)
```

**Al completar — cerrar checkpoint:**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{CA-ID}/{agente}",
  title: "Checkpoint {agente}: {instance_name}",
  content: {
    version: "2.0",
    treatment_class: "light",
    state: "completed",
    updated_at: now(),
    sequence: N,
    flow_state: {
      ca_id: "CA-{ID}",
      agente: "{agente}",
      instance_name: "{Name}"
    }
  }
)
```

## Namespaces de topic_key

El `topic_key` sigue uno de dos patrones según el contexto operacional:

| Contexto | Patrón | Ejemplo |
|----------|--------|---------|
| Con CA | `flow-state/{CA-ID}/{agente}` | `flow-state/CA-onboarder-agent/ca` |
| Sin CA | `flow-state/no-ca/{agente}/{operation-id}` | `flow-state/no-ca/inspect/query-auth-flow` |

### Mapeo de sufijos por agente

| Agente | Sufijo |
|--------|--------|
| ca-writer | `ca` |
| planner | `planning` |
| constructor | `construct` |
| inspector | `inspect` |
| validator | `validate` |
| tester | `tests` |
| review-orchestrator | `review` |
| logger | `logging` |
| initializer | `initialize` |

> Nunca se exige un `{CA-ID}` inexistente. Nunca se mezclan operaciones sin CA en el namespace de un CA.

## Prioridades

| Prioridad | Agente | Razón |
|-----------|--------|-------|
| **ALTA** | ca-writer | Conversación multi-mensaje, tratamiento completo |
| **ALTA** | planner | Decisiones pendientes antes de finalizar, tratamiento completo |
| **MEDIA** | inspector | Preguntas secuenciales, tratamiento ligero |
| **BAJA** | constructor, validator, tester, review-orchestrator, logger, initializer | Típicamente una sola ejecución, tratamiento ligero |

## Integración con el Runner

El runner es responsable de:
- Mantener el mapa de instancias en `flow-state/{CA-ID}/instances`.
- Ejecutar el handshake (solo para agentes de tratamiento completo).
- Detectar el tag `[FLOWTASK_CHECKPOINT_CAPACITY: X%]` y gestionar el relevo.
- Purgar `task_id` huérfanos (solo tratamiento completo).

El agente solo ejecuta `mem_save` con el schema definido en esta skill. No gestiona el mapa de instancias ni la lógica de reanudación.
