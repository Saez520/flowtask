---
name: checkpoint-mixin
description: >-
  Persistencia de contexto entre ejecuciones de subagentes. Cargar cuando
  el agente necesita restaurar estado previo o guardar checkpoint para
  continuar después. Define protocolo de checkpoint y funciones cp_save/cp_get.
---

# CheckpointMixin — Persistencia de Contexto

## Propósito

Permite que un subagente persista su estado entre ejecuciones separadas usando Engram.
Un usuario puede interrumpir una conversación y continuarla después, o un
agente puede recibir múltiples mensajes que deben mantener contexto.

## Estructura de Checkpoint (en Engram)

```json
{
  "topic_key": "flow-state/{CA-ID}/{agente}",
  "ca_id": "CA-{ID}",
  "agente": "{agente}",
  "estado": "active|paused|completed",
  "instance_name": "{Name}",
  "updated_at": "timestamp",
  "flow_state": {
    // Estado específico del agente
  }
}
```

## Funciones de Checkpoint

### cp_save(topic_key, ca_id, agente, flow_state, instance_name)

Guarda el estado actual del agente en Engram con fallback local.

```
try {
  mem_save(
    type: "decision",
    scope: "project",
    topic_key: topic_key,
    title: `Checkpoint ${agente}: ${instance_name}`,
    content: {
      ca_id, agente, instance_name,
      estado: 'active',
      updated_at: now(),
      flow_state
    }
  )
} catch (error) {
  // Fallback local CA-005
  const timestamp = Date.now();
  const filePath = `.flowtask/.temp/operation-checkpoint-${timestamp}.json`;
  write(filePath, JSON.stringify({
    type: "decision",
    topic_key,
    title: `Checkpoint ${agente}: ${instance_name} (BUFFERED)`,
    content: { ca_id, agente, flow_state, buffered: true }
  }));
}
```

### cp_get(topic_key)

Recupera el estado guardado desde Engram.

```
observation = mem_search(query: topic_key, limit: 1)
if observation:
  return observation.content
return null
```

### cp_delete(topic_key)

Marca el checkpoint como completado o lo elimina lógicamente.

```
mem_save(
  type: "decision",
  scope: "project",
  topic_key: topic_key,
  title: `Checkpoint ${agente}: Completed`,
  content: { estado: 'completed', updated_at: now() }
)
```

## Protocolo de Uso

### Al inicio de ejecución

```
1. Verificar checkpoint: mem_search(query: "flow-state/{CA-ID}/{agente}")
2. Si existe y estado != 'completed':
   - Leer flow_state del contenido de la observación
   - Continuar desde donde quedó
3. Si no existe o está 'completed': comenzar desde cero
```

### Durante ejecución

```
1. Después de cada interacción significativa, guardar checkpoint:
   cp_save(topic_key, ca_id, agente, {
     // estado actual del agente
   }, instance_name)
```

### Al completar

```
1. Marcar checkpoint como completed: cp_delete(topic_key)
```

## topic_key

El topic_key sigue el patrón: `flow-state/{CA-ID}/{agente}`

| Agente | topic_key ejemplo |
|--------|-------------------|
| ca-writer | `flow-state/CA-onboarder-agent/ca` |
| planner | `flow-state/CA-onboarder-agent/planning` |
| constructor | `flow-state/CA-onboarder-agent/construct` |
| inspector | `flow-state/CA-onboarder-agent/inspect` |
| logger | `flow-state/CA-onboarder-agent/logging` |
| tester | `flow-state/CA-onboarder-agent/tests` |
| plan-auditor | `flow-state/CA-onboarder-agent/audit` |

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