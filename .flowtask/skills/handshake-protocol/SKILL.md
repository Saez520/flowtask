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
| `topic_signature` | `{ids: string[], keywords: string[]} \| null` | Firma del tema actual extraída del prompt del desarrollador | `{ids: ["CA-topic-validation"], keywords: ["handshake", "sesiones"]}` |

> El parámetro `topic_signature` es opcional — si el orquestador no lo provee (porque la extracción falló o no está implementada), la skill lo trata como `null`. Ver Paso 5 (Topic Validation) para el comportamiento con `topic_signature` null.

> Los `base_names` NO están hardcodeados en esta skill. El orquestador provee su propia lista, permitiendo que distintos orquestadores usen sus propios nombres.

---

## Handshake Protocol (getOrCreateInstance)

El protocolo se ejecuta en 5 pasos. Si cualquiera de los pasos que dependen de Engram falla (porque Engram no está disponible), todo se trata como **Caso C (Nuevo CA)** y **Escenario A (Initial Prompt)**.

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
        "topic_signature": {topic_signature},
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
      "topic_signature": {
        "ids": ["CA-010"],
        "keywords": ["onboarding", "agente"]
      },
      "worktree": {
        "path": ".worktrees/CA-010/",
        "branch": "worktree/CA-010",
        "base_branch": "development"
      }
    },
    "planner": {
      "task_id": "...",
      "instance_name": "Aitana-planner",
      "last_resume": "...",
      "topic_signature": {
        "ids": ["CA-010"],
        "keywords": ["plan", "tareas"]
      }
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

## Paso 5 — Topic Validation

Antes de determinar el escenario, la skill valida si el nuevo prompt del desarrollador trata del mismo tema que la sesión anterior del agente.

### Algoritmo

1. **Recuperar último checkpoint**: `cp_get("flow-state/{ca_id}/{agente}")` desde Engram.
2. **Si no hay checkpoint previo**: Asumir mismo tema → continuar a Escenario B (conservador). Un agente recién creado no tiene historial contra qué comparar.
3. **Si el checkpoint NO tiene `topic_signature`**: Es un checkpoint antiguo (pre-Topic Validation). Forzar **Escenario A** — no podemos adivinar el tema anterior. El `task_id` se marca como `abandoned` en el mapa de instancias.
4. **Si ambos tienen `topic_signature`**: Comparar `topic_signature` actual (del prompt) vs `topic_signature` del checkpoint:

   a. **Matching exacto de IDs**: Si hay al menos un ID coincidente entre `ids_actual` y `ids_checkpoint` → **mismo tema** (Escenario B). Los IDs incluyen: CA-ID, nombres de archivo (sin extensión), nombres de skill.

   b. **Si no hay IDs coincidentes → overlap de keywords**: Calcular:
      ```
      overlap = |keywords_actual ∩ keywords_checkpoint| / min(|keywords_actual|, |keywords_checkpoint|)
      ```
      - Si `overlap >= 0.5` (50%, umbral configurable) → **mismo tema** (Escenario B)
      - Si `overlap < 0.5` → **tema diferente** (Escenario A)

   c. **Si el tema cambió**: Marcar `task_id` como `abandoned` en el mapa de instancias (no eliminar — el runner lo purga después). Forzar Escenario A con `task_id = null`.

### Ejemplos

| Prompt actual | Último checkpoint | IDs coincidentes | Keywords overlap | Resultado |
|---------------|-------------------|-------------------|-------------------|-----------|
| `CA-topic-validation`, keywords: `handshake, sesiones, validacion` | `CA-topic-validation`, keywords: `handshake, protocolo, identidad` | ✅ `CA-topic-validation` | — | **Mismo tema** → Escenario B |
| `CA-ferris-validation`, keywords: `ferris, search, agents` | `CA-topic-validation`, keywords: `handshake, sesiones, validacion` | ❌ | 0% | **Tema diferente** → Escenario A |
| Sin IDs, keywords: `runner, identidad, nombre` | Sin IDs, keywords: `runner, instancia, base` | ❌ (sin IDs) | `runner` → 1/3 = 33% | **Tema diferente** → Escenario A |
| Sin IDs, keywords: `runner, checkpoint, estado, flujo` | Sin IDs, keywords: `runner, checkpoint, flujo, persistencia` | ❌ (sin IDs) | `runner, checkpoint, flujo` → 3/4 = 75% | **Mismo tema** → Escenario B |

> **Nota sobre el contrato de salida**: La skill NO modifica su contrato. El runner sigue recibiendo `{task_id, instance_name, scenario}`. Si el tema cambió, `task_id` será `null` y `scenario` será `"A"`. La skill no notifica explícitamente "tema cambiado" — es transparente para el orquestador.

---

## Determinación de escenario

La skill determina si la invocación es un hilo nuevo o una reanudación, considerando tanto la existencia de `task_id` como la validación de tema (ver Paso 5):

- **Escenario A (Initial Prompt)**: No existe `task_id` válido para el `agent_type` en el mapa de instancias, Engram no está disponible, **o el Topic Validation determinó que el tema cambió**. Se debe invocar al subagente con un prompt nuevo (sin `task_id`).
- **Escenario B (Resume Prompt)**: Existe `task_id` activo en el mapa de instancias para el `agent_type` **y el Topic Validation confirmó que es el mismo tema** (o no había checkpoint previo). Se debe invocar al subagente reanudando la sesión existente (usando el `task_id` persistido).

> **Nota — Relevo por capacidad**: Si el runner detecta `[FLOWTASK_CHECKPOINT_CAPACITY: X%]` en la respuesta del subagente, el runner maneja el relevo por su cuenta: crea una nueva instancia vía Escenario A e incluye en el prompt instrucciones para restaurar el estado desde el checkpoint en Engram. Esto no requiere un escenario nuevo en esta skill — el contrato de salida sigue siendo A o B.

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
- **Topic Validation con keyword extraction delegada**: La skill no extrae el `topic_signature` del prompt — recibe el valor ya calculado como parámetro desde el orquestador. Si el orquestador no provee `topic_signature` (porque la extracción falló o no está implementada), la skill trata `topic_signature` como `null`. En ese caso, si hay un checkpoint con `topic_signature`, se fuerza Escenario A (no se puede validar). Si el checkpoint tampoco tiene `topic_signature`, se asume mismo tema (degradación graceful, Escenario B).
- **Falsos positivos/negativos**: El matching por keywords con umbral 50% puede producir falsos positivos (temas distintos con vocabulario similar) o falsos negativos (mismo tema con vocabulario diferente). Aceptado como trade-off del enfoque determinístico sin embeddings.
