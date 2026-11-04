---
name: runner-flow-delegacion
description: >-
  Flujo del runner — handshake, checkpoint, reanudación, relevo por capacidad y
  formato canónico de `subagent()`. Se carga solo ante el disparador
  `evento:delegacion`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Handshake Protocol

El runner utiliza la skill `handshake-protocol` para gestionar la asignación de nombres de instancia, `task_id` y determinación de escenario (nuevo hilo vs reanudación). La skill es agnóstica de orquestador — cualquier herramienta puede cargarla y obtener el contrato de handshake.

El runner determina `work_kind` (`"new"` o `"existing"`) según el estado del trabajo y lo pasa a la skill: la skill no lo adivina. Con `work_kind: "existing"` la skill exige el mapa de instancias previo; con `work_kind: "new"` asigna un nombre libre de la lista.

### Naming Prioritario

Lista de nombres base disponibles que el runner provee a la skill: `['Aitana', 'Kael', 'Lyra', 'Zev', 'Thalía', 'Iago', 'Elowen', 'Mael']`.

### Matriz de elegibilidad

Los agentes de tratamiento completo (`ca-writer` y `planner`) ejecutan el
Handshake Protocol vía la skill `handshake-protocol`: getOrCreateInstance +
Context Injection, con Escenario A/B según `task_id` y Topic Validation.

Constructor conserva tratamiento ligero, pero puede reanudar automáticamente
un fallo operativo o interrupción recuperable con identidad, `task_id` válido
y checkpoint restaurable. Si falta cualquiera, informa pérdida de continuidad
y se detiene; no usa sustituto silencioso. Relevo por capacidad y recuperación
tras rechazo usan hilo nuevo con restauración explícita del checkpoint, artifact
y motivo. Los demás agentes ligeros (`inspector`, `validator`, `tester`,
`review-orchestrator`, `logger` e `initializer`) siguen siempre en Escenario A:
sin reutilizar `task_id`, Topic Validation ni contexto de sesión anterior.
Sus checkpoints son históricos y no habilitan continuidad automática.

Una solicitud explícita del usuario tiene prioridad para una invocación puntual:
cuando identifica el agente y pide reutilizar un `task_id` concreto disponible,
El Runner pasa exactamente ese `task_id` como `sessionID` a `subagent()` para cualquier agente,
incluidos los de tratamiento ligero. Si ese identificador exacto no existe o
expiró, informar la pérdida y detener; nunca sustituirlo. Si OpenCode rechaza la
relación de padre (`is not a child of the current session`), el Runner conserva
el identificador como referencia histórica, abre un child nuevo con el prompt
delegable y la restauración explícita del checkpoint, declara que la sesión no
se reutilizó literalmente y no reintenta el mismo `sessionID`. Esta rama evita el
filtro normal de elegibilidad, el handshake y Topic Validation únicamente para
esa invocación; no convierte la continuidad explícita en comportamiento
automático.

### Uso

Antes de invocar `ca-writer`, `planner` o `constructor` cuando se evalúe continuidad,
el runner DEBE cargar la skill:
```
skill({ name: "handshake-protocol" })
```

La skill recibe como parámetros desde el runner:
- `ca_id` — ID del CA actual (ej: `"CA-onboarder-agent"`)
- `agent_type` — tipo de agente a invocar (ej: `"planner"`, `"constructor"`, `"ca-writer"`)
- `base_names` — lista de nombres base disponibles (provista por el runner)
- `work_kind` — `"new"` o `"existing"`: si el trabajo es nuevo o ya existía con registro previo. El runner lo determina; la skill no lo adivina

La skill ejecuta el **Handshake Protocol (getOrCreateInstance)** y **Context Injection**, y devuelve un contrato de 6 campos:
- `task_id` (string | null) — el `task_id` existente para reanudación, o `null` para nuevo hilo
- `instance_name` (string) — nombre de instancia asignado (ej: `Lyra-planner`)
- `scenario` (string) — `"A"` para nuevo hilo, `"B"` para reanudación
- `layer` (string) — capa de identidad de la invocación (`"orchestrator"` o `"subagent"`)
- `layer_label` (string) — etiqueta visible de la capa (`"orquestador"` o `"subagente"`)
- `identity_display` (string) — identidad visible: `[capa: {layer_label}] {instance_name}`

El runner recibe este contrato y procede con el Checkpoint Protocol según el `scenario` y usando `task_id`, `instance_name` e `identity_display`.

Si la identidad falta o no coincide, o si el tema no es verificable, la skill se detiene informando qué esperaba y qué encontró y conserva el registro previo. El runner no continúa como si la identidad fuera válida.

> **Importante**: La skill NO dicta cómo invocar al subagente. El formato canónico de `subagent()` permanece en este archivo como fuente única de verdad para el runner.

***


## Checkpoint Protocol (Vía Engram)

### Antes de invocar sub-agente (Handshake & Context)

1. **Selección**:
   - Si existe una solicitud explícita del desarrollador que identifica el agente
     y pide reutilizar un `task_id` concreto, pasar ese identificador exactamente
     a `subagent()` para cualquier agente. Esta rama puntual no ejecuta la elegibilidad
     normal, el handshake ni Topic Validation.
   - Para `ca-writer` y `planner`, cargar `handshake-protocol` y obtener
     `{ task_id, instance_name, scenario, layer, layer_label, identity_display }` desde la skill.
   - Para `constructor`, evaluar la continuidad acotada mediante handshake y
     checkpoint. Para los demás agentes ligeros, conservar/derivar `instance_name`
     como traza y forzar Escenario A con `task_id = null`.
2. **Bifurcación de Escenario**:

**Rama prioritaria — solicitud explícita de continuidad**

Cuando el desarrollador nombra un agente y solicita reutilizar un `task_id`
concreto, el Runner invoca `subagent()` pasando ese identificador como `sessionID`, sin
aplicar la elegibilidad normal de la clase de tratamiento y sin ejecutar
handshake ni Topic Validation para esa invocación puntual. La llamada usa el
formato de reanudación únicamente como mecánica de `subagent()`; el prompt mantiene
el contrato de ensamblado y no incorpora `task_id`, `scenario` ni instrucciones
internas del Runner. Si OpenCode responde que la sesión no es hija del padre
actual (`is not a child of the current session`), el rechazo es un parent
mismatch: el Runner conserva el identificador como referencia histórica, abre un
child nuevo con el prompt delegable y la restauración explícita del checkpoint,
comunica que no hubo reanudación literal y no reintenta el mismo `sessionID`.
Esta excepción no habilita reanudación automática para
agentes ligeros ni cambia el comportamiento por defecto cuando no existe una
instrucción explícita.

**Escenario A: Initial Prompt (Nuevo hilo)**
Si NO existe un `task_id` válido para el agente en el mapa de instancias, o si el trabajo es nuevo (`work_kind: "new"`):
- **Identidad faltante o distinta:** no tratar la ausencia de identidad, la
  discrepancia entre la identidad registrada y la presentada, ni la
  indisponibilidad de Engram como autorización para Escenario A. Reportar qué se
  esperaba y qué se encontró, conservar el registro previo y detener; no crear
  una identidad sustituta ni abrir un hilo sustituto.
- **Constructor en ruta de reanudación:** no tratar la ausencia/indisponibilidad de
  identidad, `task_id` válido o checkpoint válido/restaurable como autorización para
  Escenario A. Reportar pérdida de continuidad/bloqueo y detener; no reanudar, no crear
  identidad sustituta ni inventar `task_id`. Escenario A para Constructor solo procede
  cuando el flujo autoriza una tarea realmente nueva o un relevo con restauración
  explícita del checkpoint.
- Invocar `subagent()` con: input literal del desarrollador, referencias citables, hechos de coordinación y todas las heurísticas del Paso 0 (bloque `## Heurísticas del desarrollador`), sin filtrar por tarea — según el Contrato de ensamblado de prompts de delegación.
- Instrucción: "Tu identidad es {identity_display}. Iniciá cada respuesta con esa línea y registrala en tu checkpoint."

**Escenario B: Resume Prompt (Hilo existente)**
Si existe un `task_id` activo en el mapa de instancias:
- Construir `Resume Prompt` incluyendo:
  - Notificación de reanudación: "Reanudando sesión para {identity_display}."
  - **Puntero a checkpoint**: "Tu estado previo está en tu checkpoint en Engram (`flow-state/{CA-ID}/{agente}`). Consúltalo al iniciar."
  - Todas las heurísticas del Paso 0 (bloque `## Heurísticas del desarrollador`), sin filtrar por tarea.
  - Input Usuario: Texto original del desarrollador.
  - **Sincronización Obligatoria**: "Antes de actuar, sincroniza tu contexto local usando `git status/diff` y consulta las últimas decisiones en Engram (`mem_context`)."
- Invocar `subagent()` usando el `task_id` persistido como `sessionID`.
- Si OpenCode rechaza la relación de padre (`is not a child of the current
  session`), el rechazo es un parent mismatch: `ca-writer` y `planner` abren un
  child nuevo en Escenario A y restauran el estado desde el checkpoint de Engram;
  `constructor` solo continúa con un child nuevo cuando su checkpoint es
  restaurable; en cualquier otro caso informar pérdida de continuidad y detener.
  Conservar el `task_id` como referencia histórica, no reintentar el mismo
  `sessionID` y no presentar el child nuevo como reanudación literal. Esta rama
  no habilita Escenario B para los demás agentes ligeros.

> **Nota — Relevo por capacidad**: Si el runner detecta `[FLOWTASK_CHECKPOINT_CAPACITY: X%]` en la respuesta del subagente, maneja el relevo usando Escenario A normal. Ver "Detección de checkpoint por capacidad" en este flujo.

### Después de que sub-agente responde (Persist & Cleanup)

1. Si el flujo NO terminó:
    a. El sub-agente ya debe haber ejecutado `mem_save` siguiendo el schema definido por `skill({ name: "checkpoint-mixin" })`.
    b. Runner asegura que el topic esté en Engram para futuras sesiones.
2. Si el flujo SÍ terminó:
   a. El sub-agente marca estado como 'completed' en su topic.
   b. Ejecutar mem_session_summary.
3. **Verificar la identidad de la respuesta**: si la respuesta del subagente no trae la línea de identidad esperada o no coincide con la registrada, informa qué esperabas y qué encontraste, conserva el registro previo y detente. No continúes como si la identidad fuera válida.

### Detección de checkpoint por capacidad

Después de que un subagente responde, el runner DEBE verificar si la respuesta contiene el tag `[FLOWTASK_CHECKPOINT_CAPACITY: X%]`.

**Si detecta el tag:**
1. Extraer el porcentaje X del tag.
2. Verificar que el checkpoint existe en Engram: `mem_search(query: "flow-state/{CA-ID}/{agente}")`. Para agentes ligeros sin CA, el namespace alternativo es `flow-state/no-ca/{agente}/{operation-id}`.
3. Si el checkpoint NO existe: el subagente notificó pero no guardó. Ignorar y continuar normalmente.
4. Si el checkpoint SÍ existe: proceder al relanzamiento:

#### Relanzamiento por capacidad

Antes de relanzar, recuperá y declará el contexto durable según `### Recuperación
tras compactación o relevo`.

Para `constructor`, crear hilo fresco con restauración explícita del checkpoint,
artifact y motivo del relevo. No presentarlo como continuidad técnica. Los demás
agentes ligeros conservan el checkpoint como traza y reciben hilo fresco. Para
los agentes completos rigen sus reglas de continuidad.

1. **Recuperar mapa**: `mem_search(query: "flow-state/{CA-ID}/instances")`.
2. **Contar relanzamientos previos**: leer `relaunch_count` del agente en el mapa. Si no existe, asumir 0.
3. **Evaluar límite**:
   - **0-2 relanzamientos previos**:
     a. Incrementar `relaunch_count` en el mapa y persistir.
     b. Usar Escenario A normal (nuevo `task_id`), con el mismo prompt que originó la tarea, anteponiendo:
        ```
        [Nueva instancia por relevo de capacidad ({X}%). Hay checkpoint previo en Engram.]
        ```
     c. Mostrar: `🔄 {agente} relanzado ({X}% contexto → nueva instancia)`.
   - **3 relanzamientos previos** (4to intento):
     a. NO relanzar.
     b. Mostrar: `⚠️ {agente} alcanzó 3 relanzamientos en {CA-ID}. ¿Dividir la tarea?`
     c. Detener el flujo hasta que el desarrollador responda.

### Recuperación ante Fallos (Self-Healing)

Si la herramienta `subagent` (o `Agent` en Claude) retorna el error de OpenCode
`is not a child of the current session`, la sesión existe pero no es hija del
padre actual: es un parent mismatch, no una sesión inexistente o expirada.
Conservar el `task_id` como referencia histórica, no purgar el identificador y
no reintentar el mismo `sessionID`. `ca-writer` y `planner` abren un child nuevo
y restauran el estado desde el checkpoint de Engram; `constructor` solo continúa
con un child nuevo cuando su checkpoint es restaurable; en los demás casos
informar pérdida de continuidad y detener. El child nuevo no se comunica como
reanudación literal.

Si la herramienta `subagent` (o `Agent` en Claude) retorna un error indicando que el hilo no existe o ha expirado:
1. **Solicitud explícita**: Si el `task_id` provenía de una instrucción explícita
   del desarrollador, informar que la conversación no está disponible. No limpiar
   el identificador, no relanzar Escenario A ni afirmar una continuidad lograda.
2. **Limpieza normal**: Para `ca-writer` y `planner`, ejecutar `mem_save` para
   eliminar el `task_id` fallido del mapa de instancias en
   `flow-state/{CA-ID}/instances`. En el tratamiento ligero (`inspector`,
   `validator`, `tester`, `review-orchestrator`, `logger` e `initializer`) no
   se reutiliza ni se purga un `task_id`; se conserva el registro histórico.
3. **Reintento normal**: Para `ca-writer` y `planner`, relanzar automáticamente usando
   el flujo del **Escenario A (Initial Prompt)**. Para agentes de tratamiento
   `constructor`, reanudar la misma sesión solo cuando identidad, `task_id` y
   checkpoint sean recuperables; si no, informar pérdida y detener. Los demás
   ligeros reciben hilo fresco.
4. No es necesario pedir confirmación al desarrollador para este reintento técnico
   cuando se trata de la recuperación normal; la rama de solicitud explícita no
   se reintenta con un hilo sustituto.

La rama prioritaria de revisión de un CA formalizado definida en el Paso 1
prevalece sobre esta recuperación normal: ante pérdida o rechazo de su hilo,
se informa la pérdida de continuidad y se detiene sin Escenario A ni Self-Healing
de sustitución.

### Formato canónico de `subagent()` (fuente única de verdad)

Los templates de flujo referencian este formato en prosa. No duplican la sintaxis.

**Escenario A — Initial Prompt (sin `task_id`):**

```
subagent(
  agent: "[tipo]",
  prompt: "[prompt completo del usuario + contexto inyectado]",
  description: "[opcional, para trazabilidad]"
)
```

**Escenario B — Resume Prompt (con `task_id`):**

```
subagent(
  agent: "[tipo]",
  prompt: "[prompt de reanudación + contexto inyectado]",
  sessionID: "ses_...",
  description: "[opcional, para trazabilidad]"
)
```

**Solicitud explícita de reutilización:**

```
subagent(
  agent: "[tipo solicitado explícitamente]",
  prompt: "[prompt conforme al contrato + contexto inyectado]",
  sessionID: "[task_id solicitado exactamente]",
  description: "[opcional, para trazabilidad]"
)
```

La solicitud explícita se aplica a cualquier agente. Si `subagent()` rechaza el
identificador porque la conversación no está disponible o expiró, el Runner
informa esa imposibilidad real, conserva el identificador registrado, no crea ni
presenta un hilo nuevo como reutilización lograda y no comunica continuidad
exitosa.

**Despacho en paralelo (background):**

```
subagent(
  agent: "[tipo]",
  prompt: "[prompt conforme al contrato + contexto inyectado]",
  description: "[work_id] [fase]",
  background: true
)
```

El `background` no cambia la identidad, el handshake, el checkpoint ni el contrato de
ensamblado; solo cambia la mecánica de espera. El runner registra el `sessionID` devuelto
y hace join antes de avanzar la fase.

> **Regla**: Los templates de flujo referencian este formato. No duplican la sintaxis.

***
