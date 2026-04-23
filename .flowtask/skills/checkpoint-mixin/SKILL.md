---
name: checkpoint-mixin
description: >-
  Persistencia de contexto entre ejecuciones de subagentes. Cargar cuando
  el agente necesita restaurar estado previo o guardar checkpoint para
  continuar después. Define protocolo de checkpoint y funciones cp_save/cp_get.
---

# CheckpointMixin — Persistencia de Contexto

## Propósito

Permite que un subagente persista su estado entre ejecuciones separadas.
Un usuario puede interrumpir una conversación y continuarla después, o un
agente puede recibir múltiples mensajes que deben mantener contexto.

## Estructura de Checkpoint

```
Checkpoint File: .flowtask/checkpoints/{CA-ID}-{agente}.json
```

```json
{
  "topic_key": "flow-state/{CA-ID}/{agente}",
  "ca_id": "CA-{ID}",
  "agente": "{agente}",
  "estado": "active|paused|completed",
  "created_at": "timestamp",
  "updated_at": "timestamp",
  "flow_state": {
    // Estado específico del agente
  }
}
```

## Funciones de Checkpoint

### cp_save(topic_key, ca_id, agente, flow_state)

Guarda el estado actual del agente.

```
checkpoint_file = `.flowtask/checkpoints/${ca_id}-${agente}.json`
write_file(path: checkpoint_file, content: {
  topic_key, ca_id, agente,
  estado: 'active',
  updated_at: now(),
  flow_state
})
```

### cp_get(ca_id, agente)

Recupera el estado guardado.

```
checkpoint_file = `.flowtask/checkpoints/${ca_id}-${agente}.json`
if exists(checkpoint_file):
  return read_file(checkpoint_file)
return null
```

### cp_delete(ca_id, agente)

Limpia el checkpoint cuando el flujo termina.

```
checkpoint_file = `.flowtask/checkpoints/${ca_id}-${agente}.json`
if exists(checkpoint_file):
  rm_file(checkpoint_file)
```

## Protocolo de Uso

### Al inicio de ejecución

```
1. Verificar checkpoint: cat .flowtask/checkpoints/{CA-ID}-{agente}.json
2. Si existe:
   - Leer flow_state del checkpoint
   - Continuar desde donde quedó
3. Si no existe: comenzar desde cero
```

### Durante ejecución

```
1. Después de cada interacción significativa, guardar checkpoint:
   cp_save(topic_key, ca_id, agente, {
     // estado actual del agente
   })
```

### Al completar

```
1. Marcar checkpoint como completed (opcional)
2. Limpiar checkpoint: cp_delete(ca_id, agente)
```

## topic_key

El topic_key sigue el patrón: `flow-state/{CA-ID}/{agente}`

| Agente | topic_key ejemplo |
|--------|-------------------|
| ca-writer | `flow-state/CA-001/ca` |
| planner | `flow-state/CA-001/planning` |
| constructor | `flow-state/CA-001/construct` |
| inspector | `flow-state/CA-001/inspect` |
| logger | `flow-state/CA-001/logging` |
| tester | `flow-state/CA-001/tests` |
| plan-auditor | `flow-state/CA-001/audit` |

## Prioridades

| Prioridad | Agente | Razón |
|-----------|--------|-------|
| **ALTA** | ca-writer | Conversación multi-mensaje |
| **ALTA** | inspector | Preguntas secuenciales del usuario |
| **MEDIA** | planner | Decisiones pendientes antes de finalizar |
| **BAJA** | logger, tester, plan-auditor | Típicamente una sola ejecución |

## Integración con TopicManager del Runner

El runner mantiene un TopicManager que sincroniza con los checkpoints:

```
topicManager = {
  topics: Map<topic_key, {
    ca_id: string,
    agente: string,
    estado: 'active' | 'paused' | 'completed',
    checkpoint_file: string
  }>
}
```

El checkpointMixin trabaja en conjunto con TopicManager:
- Al guardar checkpoint → actualizar TopicManager
- Al cargar checkpoint → verificar estado en TopicManager
- Al completar → limpiar ambos

## Archivos de Checkpoint

Los archivos de checkpoint se guardan en: `.flowtask/checkpoints/`

No deben commitearse al repositorio — agregar a .gitignore si existe.