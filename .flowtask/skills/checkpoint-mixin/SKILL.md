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

Este skill consume `memory-contract` como autoridad normativa para namespaces, ownership,
types, scopes, payloads y excepciones. El contenido propio de este skill es únicamente
el protocolo de uso específico de checkpoints.

Define el contrato único de persistencia de estado para subagentes usando Engram.
Cada agente guarda y restaura su estado mediante `mem_save` y `mem_search` directos,
con un schema normativo y namespaces que distinguen operaciones con CA de operaciones sin CA.

## Clase de tratamiento

El comportamiento de continuidad depende de la clase de tratamiento del agente:

| Clase | Agentes | Comportamiento |
|-------|---------|----------------|
| **Completo** | `ca-writer`, `planner` | Continuidad vía checkpoint del mismo CA. Si existe checkpoint activo y `state != "completed"`, se intenta la continuidad de la sesión previa (Escenario B). Si la herramienta rechaza la relación de padre (`is not a child of the current session`), la continuidad se materializa en un child nuevo con restauración del checkpoint. |
| **Ligero** | `inspector`, `constructor`, `validator`, `tester`, `review-orchestrator`, `logger`, `initializer` | Por defecto, hilo nuevo. Excepción: constructor puede reanudar automáticamente un fallo/interrupción recuperable si identidad, `task_id` y checkpoint siguen válidos; en relevo/rechazo usa hilo nuevo con restauración explícita. Los demás ligeros nunca reanudan automáticamente. |

Los registros de ejecución del Agent Loop (`progress`, `termination`, `idempotency`, `budget` y `run`) no forman parte de esta clasificación y no son checkpoints.

## Schema normativo del checkpoint

El schema `CheckpointPayload` v2 está definido en `memory-contract` (sección "Excepciones Tipadas").
Toda observación de checkpoint en Engram usa ese schema. Los campos clave son:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `version` | string | Versión del contrato (`"2.0"`). |
| `treatment_class` | `"complete"` \| `"light"` | Clase de tratamiento. Determina la bifurcación de continuidad. |
| `state` | `"active"` \| `"paused"` \| `"completed"` | Estado del checkpoint. `"completed"` marca de cierre — conserva la observación como traza (no se borra). |
| `sequence` | entero | Contador monotónico incremental por agente. |
| `topic_signature` | objeto \| ausente | Firma del tema (opcional, backward-compatible). Si el checkpoint no lo trae, se asume mismo tema (degradación explícita). |
| `flow_state` | objeto | Estado específico del agente. |
| `resume_ref` | string (opcional) | Referencia de reanudación. **Obligatorio en tratamiento completo** (ca-writer, planner). |
| `fresh_thread_marker` | boolean (opcional) | Marcador de hilo nuevo. Solo en tratamiento ligero sin CA. |

## Protocolo de uso

### Tratamiento completo (ca-writer, planner)

**Al inicio:**

```
1. Verificar checkpoint: mem_search(query: "flow-state/{CA-ID}/{sufijo}")
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
  topic_key: "flow-state/{CA-ID}/{sufijo}",
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
  topic_key: "flow-state/{CA-ID}/{sufijo}",
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

Constructor conserva `treatment_class: "light"`. Ante fallo operativo/interrupción recuperable, la continuidad automática es únicamente restaurar su misma sesión cuando identidad y `task_id` están disponibles y el checkpoint es válido; si no, informar pérdida y detener, sin sustituto silencioso. Un relevo por capacidad o recuperación tras rechazo inicia hilo nuevo y restaura explícitamente el checkpoint, artifact y motivo. Registrar en `flow_state` fase, acciones confirmadas, resultados, siguiente acción segura, efectos externos inciertos y motivo de bloqueo. No repetir una acción cuyo efecto sea incierto y no idempotente. Esta excepción no modifica la política de los demás agentes ligeros.

**Al inicio:**

```
1. Verificar checkpoint: mem_search(query: "flow-state/{CA-ID}/{sufijo}")
   (o flow-state/no-ca/{agente}/{operation-id} si no hay CA)
2. Para `constructor`, reanudar la misma sesión automáticamente únicamente si identidad, `task_id` y checkpoint válido están disponibles; si falta cualquiera, informar pérdida de continuidad y detenerse. En relevo por capacidad o rechazo, iniciar hilo nuevo y restaurar explícitamente checkpoint, artifact y motivo.
3. Para los demás agentes ligeros, si existe checkpoint previo:
   - Restaurar explícitamente el estado como insumo (temas explorados, tradeoffs, gaps)
   - La nueva ejecución NO es continuación técnica de la anterior
4. Para los demás agentes ligeros, siempre crear hilo nuevo (Escenario A, task_id = null)
```

**Durante ejecución — guardar checkpoint (con CA):**

```javascript
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{CA-ID}/{sufijo}",
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
  topic_key: "flow-state/{CA-ID}/{sufijo}",
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

El `topic_key` sigue uno de tres patrones según el contexto operacional:

| Contexto | Patrón | Ejemplo |
|----------|--------|---------|
| Con CA | `flow-state/{CA-ID}/{sufijo}` | `flow-state/CA-onboarder-agent/create` |
| Sin CA | `flow-state/no-ca/{agente}/{operation-id}` | `flow-state/no-ca/inspect/query-auth-flow` |
| Ejecución del Agent Loop | `flow-state/{execution_id}/{sufijo}` | `flow-state/CA-onboarder-agent-20261019T193000Z/progress` |

Los sufijos `progress`, `termination`, `idempotency`, `budget` y `run` pertenecen a registros de ejecución, no al mapeo de sufijos por agente, y no son checkpoints.

### Mapeo de sufijos por agente

| Agente | Sufijo canónico |
|--------|--------|
| ca-writer | `create` |
| planner | `plan` |
| constructor | `construct` |
| inspector | `inspect` |
| validator | `validate` |
| tester | `tests` |
| review-orchestrator | `review` |
| logger | `logging` |
| initializer | `init` |

> Los sufijos canónicos están declarados en `memory-contract` (tabla de Namespaces Canónicos).
> Este skill los aplica; no los redefine.

> Mapeo de sufijos legacy a canónico: `ca` → `create`, `planning` → `plan`, `initialize` → `init`. `inspect` se mantiene.

## Registros de ejecución que no son checkpoints

Los registros de ejecución del Agent Loop son estructuras distintas de los checkpoints: tienen su propia persistencia, su propio ciclo de vida y su propia ownership. Este skill no los redefine; los distingue.

| Registro | Namespace | Contenido | Qué no es |
|----------|-----------|-----------|-----------|
| `ProgressRecord` | `flow-state/{execution_id}/progress` | Hechos, evidencia y clasificación por ronda | No decide continuidad, no transporta estado interno de un agente y no habilita reanudación. |
| `TerminationRecord` | `flow-state/{execution_id}/termination` | Pausas, reanudaciones y cierres | No es estado de agente y no reemplaza el checkpoint. |
| `IdempotencyRecord` | `flow-state/{execution_id}/idempotency` | Identidad de operación, intentos y constancias | No habilita por sí mismo la reanudación del Constructor; esta sigue exigiendo identidad y checkpoint restaurable. |
| `BudgetRecord` | `flow-state/{execution_id}/budget` | Gasto acumulado, avisos y propuestas de pausa | No cierra, no abandona y no reemplaza el checkpoint. |
| `AgentRunRecord` | `flow-state/{execution_id}/run` | Estado del controlador, tope duro y pausas propias | No es checkpoint, no transporta estado de agente y no reemplaza los otros registros. |
| Contexto, check y reporte de invariantes | Se adjuntan al resultado durable de la ronda, sin `topic_key` propio | Contexto, veredictos y violaciones | No son checkpoint ni registro de progreso. |

El `CheckpointPayload` v2 sigue siendo la única estructura que habilita la continuidad de un subagente según su clase de tratamiento. Un registro de ejecución no suplanta el estado por subagente, y un checkpoint no suplanta un registro de ejecución.

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
- Ejecutar el handshake para agentes completos y evaluar la excepción acotada del
  Constructor. Esta evaluación no habilita continuidad automática para los demás
  agentes ligeros, que conservan su política de hilo fresco.
- Detectar el tag `[FLOWTASK_CHECKPOINT_CAPACITY: X%]` y gestionar el relevo.
- Purgar `task_id` huérfanos (solo tratamiento completo).
- Mantener separados los registros de ejecución (`progress`, `termination`, `idempotency`, `budget`, `run`) de los checkpoints por subagente.
- No usar un registro de ejecución como sustituto de un checkpoint ni un checkpoint como sustituto de un registro de ejecución.

El agente solo ejecuta `mem_save` con el schema definido en `memory-contract`. No gestiona el mapa de instancias ni la lógica de reanudación.
