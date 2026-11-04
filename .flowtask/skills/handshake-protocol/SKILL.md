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
2. **Gestionar `task_id`**: recuperar el identificador histórico del hilo registrado en Engram y distinguirlo de un `sessionID` que la herramienta de subagentes admita desde el padre actual.
3. **Determinar escenario**: decidir si la invocación es un hilo nuevo (Escenario A) o una reanudación (Escenario B).
4. **Inyectar contexto**: consultar la memoria del proyecto y entregar los hallazgos en un bloque `<project_context>`.
5. **Verificar la identidad**: validar que la identidad de la capa invocada coincide con la registrada y detener ante identidad faltante o distinta.

La skill es **agnóstica de orquestador**: no dicta cómo invocar al subagente ni qué formato de llamada usar. El orquestador recibe el contrato de salida y decide.

> **Dependencia**: esta skill asume **Engram** como storage de memoria y handshake. Si el orquestador no tiene Engram, la skill no puede funcionar (ver Limitaciones conocidas).

---

## Modelo de identidad por capas

La identidad de una invocación vive en dos capas separadas. Cada capa tiene su nombre propio y ninguna capa puede presentarse como otra.

| Capa | Etiqueta visible | Nombre de instancia | Alcance |
|------|------------------|---------------------|---------|
| `orchestrator` | `orquestador` | `{BaseName}` | El orquestador del trabajo: su nombre es el `BaseName` del trabajo en curso. |
| `subagent` | `subagente` | `{BaseName}-{agent_type}` | Cada subagente invocado dentro del trabajo. |

Reglas vigentes:

- **Una capa no se presenta como otra**: toda identidad se valida contra la combinación capa/nombre. Una identidad de subagente con nombre de orquestador, o viceversa, se rechaza y se informa.
- **Capa desconocida**: una capa fuera de `orchestrator` o `subagent` se rechaza con `layer_unknown` y el mensaje genérico de función no reconocida, sin alias ni redirección.
- **Formato de visualización**: `[capa: {layer_label}] {instance_name}`.
- **Aviso y detención**: si la capa no puede mostrarse, el sistema avisa y no presenta el trabajo como identificado.
- **Detención fail-closed**: si la identidad falta o no coincide, el sistema informa qué esperaba y qué encontró, conserva lo previamente registrado y se detiene. No continúa como si la identidad fuera válida.

El contrato ejecutable de este modelo vive en
`skills/handshake-protocol/scripts/agent-identity.js`. La skill lo usa como
fuente de verdad para construir, asignar y verificar identidades.

---

## Parámetros de entrada

El orquestador debe proveer a la skill los siguientes parámetros:

| Parámetro | Tipo | Descripción | Ejemplo |
|-----------|------|-------------|---------|
| `ca_id` | string | ID del CA en curso | `"CA-onboarder-agent"` |
| `agent_type` | string | Tipo de agente a invocar | `"planner"`, `"constructor"`, `"ca-writer"` |
| `base_names` | string[] | Lista de nombres base disponibles | `["Aitana", "Kael", "Lyra", ...]` |
| `work_kind` | `"new" \| "existing"` | Si el trabajo en curso es nuevo o ya existía con registro previo. El runner lo determina; la skill no lo adivina. | `"existing"` |
| `topic_signature` | `{ids: string[], keywords: string[]} \| null` | Firma del tema actual extraída del prompt del desarrollador | `{ids: ["CA-ejemplo-uno"], keywords: ["handshake", "sesiones"]}` |

> El parámetro `work_kind` es obligatorio: con `"existing"` la skill exige un mapa de instancias previo; con `"new"` arranca la asignación de un nombre libre. La skill no infiere el tipo de trabajo a partir del tema.

> El parámetro `topic_signature` es opcional — si el orquestador no lo provee (porque la extracción falló o no está implementada), la skill lo trata como `null`. Ver Paso 5 (Topic Validation) para el comportamiento con `topic_signature` null.

> Los `base_names` NO están hardcodeados en esta skill. El orquestador provee su propia lista, permitiendo que distintos orquestadores usen sus propios nombres.

### Elegibilidad de agentes

Este protocolo aplica a los agentes de tratamiento completo (`ca-writer` y `planner`) y, con una excepción acotada, al `constructor`. Constructor puede reanudar automáticamente solo un fallo operativo o interrupción recuperable si su identidad, `task_id` y checkpoint siguen disponibles y válidos. Los demás agentes ligeros (`inspector`, `validator`, `tester`, `review-orchestrator`, `logger`, `initializer`) siempre reciben hilo fresco; sus checkpoints no habilitan continuidad automática. El contrato de checkpoint está definido en `.flowtask/skills/checkpoint-mixin/SKILL.md`.

---

## Handshake Protocol (getOrCreateInstance)

El protocolo se ejecuta en 5 pasos. Si cualquiera de los pasos que dependen de Engram falla (porque Engram no está disponible), el protocolo se detiene informando qué esperaba y qué encontró.

### Paso 1 — Check Engram Handshake

```
mem_search(query: "flow-state/{ca_id}/instances")
```

- **Resultado esperado**: una observación en Engram con el mapa de instancias del CA.
- **Si `mem_search` falla** (Engram no disponible): **detenerse**. Informar qué se esperaba y qué se encontró —el mapa de instancias en `flow-state/{ca_id}/instances` frente a la indisponibilidad de Engram— y conservar lo previamente registrado. Sin registro verificable no hay identidad: no se asigna nombre, no se abre hilo y no se continúa.
- **Si el mapa no existe y `work_kind` es `"existing"`**: **detenerse**. El trabajo existe y su identidad registrada no está disponible: no se sustituye el nombre, no se inventa un `base_name` y no se abre un hilo sustituto.
- **Si el mapa no existe y `work_kind` es `"new"`**: continuar al Paso 2 para asignar un nombre libre.

### Paso 2 — Determinar BaseName

- **Trabajo existente (`work_kind: "existing"`)**: usar el `base_name` persistido en el mapa de instancias. Si el mapa no trae `base_name`, **detenerse**: la identidad del trabajo no es verificable.
- **Trabajo nuevo (`work_kind: "new"`)**: asignar un nombre con `allocateBaseName` del contrato ejecutable, que toma el primer nombre libre de la lista `base_names` provista por el orquestador.
  1. Consultar los mapas de instancias de los demás trabajos: `mem_search(query: "flow-state instances", scope: "project")`. Considerar solo observaciones cuyo `topic_key` termina en la sección `instances`.
  2. **Excluir** los mapas cuyo contenido contenga `ca_status: "closed"` — sus nombres quedan libres.
  3. Un trabajo ocupa su nombre mientras no esté cerrado. Los nombres se comparan por trim y sin distinguir mayúsculas; se conserva la capitalización de la lista.
  4. **Detenerse** si un nombre está duplicado entre trabajos activos, si el nombre pedido está ocupado o si la lista se agota. No se reutiliza el nombre de un trabajo activo ni se sustituye en silencio.

### Paso 3 — Construir la identidad

La identidad se construye con `buildIdentity` del contrato ejecutable. Cada capa tiene su regla de nombre y ninguna se presenta como otra:

| Capa | Regla de nombre |
|------|-----------------|
| `orchestrator` | `instance_name = "{BaseName}"` |
| `subagent` | `instance_name = "{BaseName}-{agent_type}"` |

Ejemplos: `Aitana` (orquestador), `Aitana-planner` (subagente).

Una capa fuera de `orchestrator` o `subagent` se rechaza con `layer_unknown` y el mensaje genérico, sin alias.

La identidad construida se valida contra la capa invocada: una capa no puede presentarse como otra. Si la capa y el nombre no coinciden, la identidad se rechaza, se informa qué se esperaba y qué se encontró y se detiene.

### Paso 4 — Persistir Handshake

```
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{ca_id}/instances",
  title: "Handshake {ca_id}: {agent_type}",
  content: {
    "base_name": "{BaseName}",
    "orchestrator": {
      "instance_name": "{BaseName}",
      "layer": "orchestrator",
      "layer_label": "orquestador"
    },
    "agents": {
      "{agent_type}": {
        "layer": "subagent",
        "layer_label": "subagente",
        "base_name": "{BaseName}",
        "agent_type": "{agent_type}",
        "instance_name": "{BaseName}-{agent_type}",
        "task_id": "...",
        "last_resume": "{timestamp}",
        "topic_signature": {topic_signature},
        "worktree": {
          "path": ".worktrees/{ca_id}/",
          "branch": "worktree/{ca_id}",
          "base_branch": "{base_branch_detectado}"
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
  "orchestrator": {
    "instance_name": "Aitana",
    "layer": "orchestrator",
    "layer_label": "orquestador"
  },
  "agents": {
    "ca-writer": {
      "layer": "subagent",
      "layer_label": "subagente",
      "base_name": "Aitana",
      "agent_type": "ca-writer",
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
        "base_branch": "{base_branch_detectado}"
      }
    },
    "planner": {
      "layer": "subagent",
      "layer_label": "subagente",
      "base_name": "Aitana",
      "agent_type": "planner",
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

> **Capa ausente**: los mapas antiguos sin `layer` se leen como capa `subagent` y se completan en el próximo upsert. El upsert conserva los campos existentes y no borra historial ante un conflicto.

> **Ubicación esperada**: cuando el agente es `constructor`, el runner guarda `worktree` en `agents.constructor.worktree`.

> **Detección dinámica**: El valor de `base_branch` se detecta dinámicamente en tiempo de ejecución según el orden canónico `development → main → trunk → main`. El runner resuelve la rama base al momento de ejecutar `worktree.sh create` y la persiste en el mapa de instancias.

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

1. **Recuperar último checkpoint**: `mem_search(query: "flow-state/{ca_id}/{agente}")` desde Engram. Si el agente es de tratamiento ligero y no hay CA, el namespace alternativo es `flow-state/no-ca/{agente}/{operation-id}`.
2. **Trabajo nuevo (`work_kind: "new"`)**: no hay tema previo que validar. Se continúa con la asignación de nombre y la construcción de identidad.
3. **Trabajo existente sin checkpoint previo**: para `constructor`, informar pérdida de continuidad y detenerse; no asignar Escenario B ni reanudar sin estado restaurable. Para los agentes de tratamiento completo, el Escenario B exige identidad válida y `task_id` válido: sin ellos se informa y se detiene. Un agente recién creado no tiene historial contra qué comparar.
4. **Si el checkpoint NO tiene `topic_signature`**: la identidad del tema no puede validarse. Se informa qué se esperaba y qué se encontró y se detiene con `topic_unverifiable`. No se asume mismo tema, no se abre un Escenario A en su lugar y el `task_id` previo se conserva sin alterarse.
5. **Si ambos tienen `topic_signature`**: Comparar `topic_signature` actual (del prompt) vs `topic_signature` del checkpoint (según el schema definido en `.flowtask/skills/checkpoint-mixin/SKILL.md`):

   a. **Matching exacto de IDs**: Si hay al menos un ID coincidente entre `ids_actual` y `ids_checkpoint` → **mismo tema** (Escenario B). Los IDs incluyen: CA-ID, nombres de archivo (sin extensión), nombres de skill.

   b. **Si no hay IDs coincidentes → overlap de keywords**: Calcular:
      ```
      overlap = |keywords_actual ∩ keywords_checkpoint| / min(|keywords_actual|, |keywords_checkpoint|)
      ```
      - Si `overlap >= 0.5` (50%, umbral configurable) → **mismo tema** (Escenario B)
      - Si `overlap < 0.5` → **tema diferente** (detención con `topic_mismatch`)

   c. **Si el tema cambió**: **detenerse** con `topic_mismatch`. Se informa qué se esperaba y qué se encontró, se conserva el mapa previo sin borrarlo y no se abre un hilo sustituto. No se abre un Escenario A en su lugar y el `task_id` previo se conserva sin alterarse.

### Ejemplos

| Prompt actual | Último checkpoint | IDs coincidentes | Keywords overlap | Resultado |
|---------------|-------------------|-------------------|-------------------|-----------|
| `CA-ejemplo-uno`, keywords: `handshake, sesiones, validacion` | `CA-ejemplo-uno`, keywords: `handshake, protocolo, identidad` | ✅ `CA-ejemplo-uno` | — | **Mismo tema** → Escenario B |
| `CA-ejemplo-dos`, keywords: `ferris, search, agents` | `CA-ejemplo-uno`, keywords: `handshake, sesiones, validacion` | ❌ | 0% | **Tema diferente** → detención con `topic_mismatch` |
| Sin IDs, keywords: `runner, identidad, nombre` | Sin IDs, keywords: `runner, instancia, base` | ❌ (sin IDs) | `runner` → 1/3 = 33% | **Tema diferente** → detención con `topic_mismatch` |
| Sin IDs, keywords: `runner, checkpoint, estado, flujo` | Sin IDs, keywords: `runner, checkpoint, flujo, persistencia` | ❌ (sin IDs) | `runner, checkpoint, flujo` → 3/4 = 75% | **Mismo tema** → Escenario B |

> **Nota sobre el contrato de salida**: la skill no entrega contrato cuando la identidad o el tema no son verificables: informa qué esperaba y qué encontró, conserva lo previamente registrado y se detiene. Cuando sí entrega contrato, el runner recibe `{task_id, instance_name, scenario, layer, layer_label, identity_display}`.

---

## Determinación de escenario

La skill determina si la invocación es un hilo nuevo o una reanudación, considerando la identidad registrada, la validez del `task_id` y la validación de tema (ver Paso 5):

- **Escenario A (Initial Prompt)**: solo para un trabajo nuevo (`work_kind: "new"`) o para una restauración explícita autorizada por el flujo. No sustituye una continuidad que perdió sus prerrequisitos: la identidad faltante o distinta no sale por Escenario A.
- **Escenario B (Resume Prompt)**: existe `task_id` activo en el mapa de instancias para el `agent_type`, la identidad coincide con la registrada, el tema está verificado y, cuando aplica, el checkpoint es restaurable. Para `constructor`, además deben existir identidad y checkpoint válido/restaurable; sin cualquiera de ellos se informa pérdida de continuidad y se detiene, nunca se reanuda sin checkpoint. La ausencia de checkpoint nunca habilita Escenario B para Constructor.
- **Detención fail-closed**: si la identidad falta o no coincide, o si el tema no es verificable o cambió, la skill informa qué esperaba y qué encontró, conserva el registro previo y se detiene. No abre un hilo sustituto ni presenta un hilo nuevo como reanudación lograda.

**Parent mismatch — clase de error propia**: el `task_id` identifica el hilo histórico; solo se pasa como `sessionID` si la herramienta admite la relación con el padre actual. Si la herramienta informa que la sesión no es hija del padre actual (`is not a child of the current session`), el rechazo es un parent mismatch y no una sesión inexistente o expirada: el orquestador abre un child nuevo en Escenario A y restaura el estado desde el checkpoint de Engram, sin reintentar el mismo `sessionID` y sin presentar el child nuevo como reanudación literal.

**Parent mismatch con la identidad intacta**: si la identidad registrada coincide con la presentada y el checkpoint es restaurable, el orquestador abre un child nuevo con restauración explícita del checkpoint y declara que no hubo reanudación literal. Si la identidad falta o no coincide, o si el checkpoint no es restaurable, la skill informa qué esperaba y qué encontró, conserva lo previamente registrado y se detiene. El Constructor nunca recibe una identidad sustituta.

> **Nota — Relevo por capacidad**: Si el runner detecta `[FLOWTASK_CHECKPOINT_CAPACITY: X%]` en la respuesta del subagente, el runner maneja el relevo por su cuenta: crea una nueva instancia vía Escenario A e incluye en el prompt instrucciones para restaurar el estado desde el checkpoint en Engram. Esto no requiere un escenario nuevo en esta skill — el contrato de salida sigue siendo A o B.

**Cierre de Escenario A para Constructor:** Escenario A solo es admisible cuando el flujo
autoriza una ejecución nueva o un relevo/restauración en hilo nuevo; no sustituye una
continuidad automática que perdió sus prerrequisitos. Si Constructor está en una ruta de
reanudación y falta cualquiera de estos elementos —identidad existente, `task_id` válido
o checkpoint válido/restaurable—, no se reanuda ni se crea un hilo sustituto: informar
bloqueo/pérdida de continuidad y detenerse. No asignar una identidad alternativa ni
inventar un `task_id`. Los demás agentes ligeros conservan su comportamiento de hilo
fresco; esta excepción aplica únicamente a Constructor.

---

## Contrato de salida

La skill entrega al orquestador un objeto con exactamente 6 campos:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `task_id` | `string \| null` | Identificador histórico del hilo (Escenario B), o `null` para nuevo hilo (Escenario A). No garantiza que la herramienta lo admita como `sessionID` desde el padre actual. |
| `instance_name` | `string` | Nombre de instancia asignado (ej: `Lyra-planner`) |
| `scenario` | `string` | `"A"` para nuevo hilo (Initial Prompt), `"B"` para reanudación (Resume Prompt) |
| `layer` | `string` | Capa de identidad de la invocación (`"orchestrator"` o `"subagent"`) |
| `layer_label` | `string` | Etiqueta visible de la capa (`"orquestador"` o `"subagente"`) |
| `identity_display` | `string` | Identidad en formato visible: `[capa: {layer_label}] {instance_name}` |

> **La skill NO dicta cómo invocar al subagente.** El orquestador recibe este contrato y decide el formato de llamada (`task()`, API REST, CLI, etc.).

> **Agentes ligeros sin excepción**: no ejecutan handshake para continuidad; reciben `instance_name` como traza, con `task_id = null` y `scenario = "A"`.

---

## Verificación ejecutable

El operador verifica la distinción de capas ejecutando el contrato, no solo leyendo
documentos. Desde la raíz del repositorio:

```
node .flowtask/skills/handshake-protocol/scripts/agent-identity.js check --names Aitana,Kael
```

El comando imprime una línea por capa y una por subagente, valida la unicidad de nombres
entre trabajos en paralelo y comprueba las detenciones fail-closed. Sale 1 ante cualquier
violación. Para ver solo las identidades:

```
node .flowtask/skills/handshake-protocol/scripts/agent-identity.js roles --names Aitana,Kael
```

---

## Limitaciones conocidas

- **Dependencia de Engram**: Si Engram no está disponible (`mem_search` falla), el protocolo se detiene informando qué esperaba y qué encontró. No existe mecanismo de fallback alternativo. Los `task_id` y `instance_name` no se persisten hasta que Engram vuelva a estar disponible.
- **Sin cobertura operacional**: Esta skill NO implementa Checkpoint Protocol, Self-Healing ante `task_id` expirados, el fallback por parent mismatch, ni purga de `task_id` huérfanos. Esas responsabilidades son del orquestador.
- **Unicidad de orquestador**: La skill asume un único orquestador por proyecto sobre el mismo Engram.
- **Acoplamiento a Engram**: La skill usa Engram como storage exclusivo.
- **Topic Validation con keyword extraction delegada**: La skill no extrae el `topic_signature` del prompt — recibe el valor ya calculado como parámetro desde el orquestador. Si el orquestador no provee `topic_signature` (porque la extracción falló o no está implementada), la skill trata `topic_signature` como `null`. En ese caso, un checkpoint sin `topic_signature` deja la identidad sin validar y el protocolo se detiene con `topic_unverifiable`; para `constructor` ese requisito no elimina el de checkpoint válido, identidad y `task_id` disponibles.
- **Matching por keywords**: El matching con umbral 50% puede producir falsos positivos (temas distintos con vocabulario similar) o falsos negativos (mismo tema con vocabulario diferente).
