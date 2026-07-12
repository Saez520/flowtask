---
name: handshake-protocol
description: >-
  Protocolo de handshake para asignar nombres de instancia, gestionar task_id
  y determinar escenario de invocación (nuevo hilo vs reanudación). Agnóstico
  de orquestador — asume Engram como storage. Cargar antes de invocar
  subagentes.
---

# Handshake Protocol — Asignación de Identidad y Contexto

## Propósito

Esta skill implementa el **Handshake Protocol core** que todo orquestador debe ejecutar antes de invocar un subagente. Sus responsabilidades son:

1. **Asignar identidad**: determinar o recuperar el `BaseName` y construir el `instance_name` correcto.
2. **Gestionar `task_id`**: verificar si el agente ya tiene una sesión activa en Engram y recuperar su `task_id`.
3. **Determinar escenario**: decidir si la invocación es un hilo nuevo (Escenario A) o una reanudación (Escenario B).
4. **Inyectar contexto**: consultar la memoria del proyecto y entregar los hallazgos en un bloque `<project_context>`.

La skill es **agnóstica de orquestador**: no dicta cómo invocar al subagente ni qué formato de llamada usar. El orquestador recibe el contrato de salida y decide.

> **Dependencia**: esta skill asume **Engram** como storage de memoria y handshake. Si el orquestador no tiene Engram, la skill no puede funcionar (ver Limitaciones conocidas).

---

## Parámetros de entrada

El orquestador debe proveer a la skill los siguientes parámetros:

| Parámetro | Tipo | Descripción | Ejemplo |
|-----------|------|-------------|---------|
| `ca_id` | string | ID del CA en curso | `"CA-onboarder-agent"` |
| `agent_type` | string | Tipo de agente a invocar | `"planner"`, `"constructor"`, `"ca-writer"` |
| `base_names` | string[] | Lista de nombres base disponibles | `["Aitana", "Kael", "Lyra", ...]` |

> Los `base_names` NO están hardcodeados en esta skill. El orquestador provee su propia lista, permitiendo que distintos orquestadores usen sus propios nombres.

---

## Handshake Protocol (getOrCreateInstance)

El protocolo se ejecuta en 4 pasos. Si cualquiera de los pasos que dependen de Engram falla (porque Engram no está disponible), todo se trata como **Caso C (Nuevo CA)** y **Escenario A (Initial Prompt)**.

### Paso 1 — Check Engram Handshake

```
mem_search(query: "flow-state/{ca_id}/instances")
```

- **Resultado esperado**: una observación en Engram con el mapa de instancias del CA.
- **Si `mem_search` falla** (Engram no disponible): tratar como **Caso C (Nuevo CA)** y **Escenario A (Initial Prompt)**. No hay mecanismo alternativo de discovery — esta limitación está aceptada.

### Paso 2 — Determinar BaseName

- **Caso A (Mapa existe con `base_name`)**: Usar el `base_name` persistido en el mapa de instancias.
- **Caso B (Mapa existe sin `base_name` — Normalización)**: Extraer el prefijo (antes del primer `-`) del `instance_name` del primer agente en el mapa y persistirlo como `base_name`.
- **Caso C (Nuevo CA)**: Asignar el **siguiente nombre base disponible** de la lista `base_names` provista por el orquestador. Verificar los mapas de instancias de otros CAs en Engram (`mem_search(query: "flow-state/*/instances")`) para detectar `baseNames` en uso. **Excluir** aquellos CAs cuyo contenido contenga `ca_status: "closed"` — solo los CAs sin ese campo (o con valor distinto de `"closed"`) se consideran "activos" y su `baseName` está ocupado. Si Engram no está disponible, asignar por orden secuencial sin verificación de colisiones (limitación preexistente).

### Paso 3 — Construir instance_name

El nombre de instancia se construye concatenando el `BaseName` con el `agent_type`:

```
instance_name = "{BaseName}-{agent_type}"
```

Ejemplos: `Aitana-planner`, `Lyra-constructor`, `Kael-ca-writer`.

### Paso 4 — Persistir Handshake

```
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{ca_id}/instances",
  title: "Handshake {ca_id}: {agent_type}",
  content: {
    "base_name": "{BaseName}",
    "agents": {
      "{agent_type}": {
        "task_id": "...",
        "instance_name": "{BaseName}-{agent_type}",
        "last_resume": "{timestamp}",
        "worktree": {
          "path": ".worktrees/{ca_id}/",
          "branch": "worktree/{ca_id}",
          "base_branch": "development"
        }
      }
    }
  }
)
```

Estructura del mapa de instancias:

```json
{
  "base_name": "Aitana",
  "agents": {
    "ca-writer": {
      "task_id": "...",
      "instance_name": "Aitana-ca-writer",
      "last_resume": "2026-04-28T...",
      "worktree": {
        "path": ".worktrees/CA-010/",
        "branch": "worktree/CA-010",
        "base_branch": "development"
      }
    },
    "planner": {
      "task_id": "...",
      "instance_name": "Aitana-planner",
      "last_resume": "..."
    }
  }
}
```

> **Importante**: El `task_id` se captura y persiste **después** de la primera respuesta exitosa del subagente. En el momento del handshake, el `task_id` es `null` para agentes nuevos.

> **Compatibilidad**: `worktree` es opcional. Los mapas anteriores siguen siendo válidos si solo tienen `task_id`, `instance_name` y `last_resume`.

> **Ubicación esperada**: cuando el agente es `constructor`, el runner guarda `worktree` en `agents.constructor.worktree`.

---

## Context Injection

Antes de entregar el prompt al subagente, la skill consulta la memoria del proyecto:

1. `mem_context(project: "{project-name}")` — contexto reciente de sesiones previas.
2. `mem_search(query: "{términos relevantes al CA y al agente}")` — decisiones y patrones relevantes.

Los hallazgos se inyectan en un bloque `<project_context>` dentro del prompt:

```xml
<project_context>
[Hallazgos de mem_context y mem_search]
</project_context>
```

El orquestador recibe este bloque y lo incorpora al prompt que entregará al subagente.

---

## Determinación de escenario

La skill determina si la invocación es un hilo nuevo o una reanudación:

- **Escenario A (Initial Prompt)**: No existe `task_id` válido para el `agent_type` en el mapa de instancias, o Engram no está disponible. Se debe invocar al subagente con un prompt nuevo (sin `task_id`).
- **Escenario B (Resume Prompt)**: Existe `task_id` activo en el mapa de instancias para el `agent_type`. Se debe invocar al subagente reanudando la sesión existente (usando el `task_id` persistido).

---

## Contrato de salida

La skill entrega al orquestador un objeto con exactamente 3 campos:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `task_id` | `string \| null` | `task_id` existente para reanudación (Escenario B), o `null` para nuevo hilo (Escenario A) |
| `instance_name` | `string` | Nombre de instancia asignado (ej: `Lyra-planner`) |
| `scenario` | `string` | `"A"` para nuevo hilo (Initial Prompt), `"B"` para reanudación (Resume Prompt) |

> **La skill NO dicta cómo invocar al subagente.** El orquestador recibe este contrato y decide el formato de llamada (`task()`, API REST, CLI, etc.).

---

## Limitaciones conocidas

- **Dependencia de Engram**: Si Engram no está disponible (`mem_search` falla), la skill trata todo como Caso C (Nuevo CA) y Escenario A (Initial Prompt). No existe mecanismo de fallback alternativo. Los `task_id` y `instance_name` no se persisten hasta que Engram vuelva a estar disponible.
- **Sin cobertura operacional**: Esta skill NO implementa Checkpoint Protocol, Self-Healing ante `task_id` expirados, ni purga de `task_id` huérfanos. Esas responsabilidades son del orquestador.
- **Colisión potencial de BaseNames entre orquestadores**: La skill recibe `base_names` como parámetro externo. Si dos orquestadores distintos usan la misma skill sobre el mismo Engram, podrían asignar el mismo `BaseName` a CAs diferentes. El caso de uso actual asume un solo orquestador por proyecto.
- **Sin abstracción de storage**: La skill está acoplada a Engram. Si aparece un orquestador sin Engram, la skill debe versionarse con abstracción de storage.
- **Carga de heurísticas**: Si Engram no está disponible, las heurísticas no se cargan (degradación graceful). No hay mecanismo de fallback local para heurísticas.
