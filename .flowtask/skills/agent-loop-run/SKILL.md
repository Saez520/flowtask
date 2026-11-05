---
name: agent-loop-run
description: >-
  Contrato del controlador del Agent Loop: inicio explícito, rondas, pausa,
  reanudación y cierre de una ejecución; composición ordenada de los cinco
  contratos de control y freno duro por gasto declarado.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Skill: agent-loop-run — controlador de la ejecución

## Propósito

Esta skill define el contrato del **controlador de una ejecución**: el componente que
conduce un objetivo desde su señal de inicio hasta su cierre, con identidad propia, rondas
numeradas, pausa reversible, reanudación sin reinicio y veredicto de cierre.

El controlador **compone** cinco contratos ya existentes y los aplica en un orden fijo:
`agent-loop-progress`, `agent-loop-invariants`, `agent-loop-termination`,
`agent-loop-idempotency` y `agent-loop-budget`. No redefine ninguno de ellos, no copia sus
reglas y no los sustituye: los consulta como fuente vigente.

El controlador aporta tres cosas que ningún otro contrato aporta:

- **La identidad de la ejecución** y su registro durable propio, con el estado efectivo, el
  tope duro declarado y las pausas propias del controlador.
- **El orden de la ejecución**: qué se consulta, en qué orden y con qué confirmación por
  lectura antes de despachar una ronda.
- **El freno duro por gasto declarado**: un tope duro, cuando el trabajo lo declara, produce
  una **pausa reversible** en la misma ejecución. Nunca un cierre, nunca un abandono, nunca
  la terminación de procesos y nunca un cambio de modelo.

El alcance es puramente normativo. Esta skill **no** implementa comportamiento ejecutable,
no instrumenta nada y no enforcea por sí misma: describe el algoritmo, sus datos de entrada
y de salida y sus reglas de fallo.

## Alcance y fronteras

**Incluye:**

- La apertura de una ejecución a partir de una señal explícita de inicio.
- La identidad de la ejecución y la resolución del baseline y del tope duro.
- El registro de ejecución `AgentRunRecord v1` y su persistencia.
- El orden de la ejecución: orden de inicio y orden de ronda.
- La decisión del controlador: continuar, pausar o cerrar.
- La compuerta de gasto: tope duro declarado y, después, límite blando.
- La pausa del controlador, la pausa de terminación y la pausa de presupuesto, y sus
  condiciones de reanudación.
- El cierre con veredicto y la conservación de trabajo, historial y diagnóstico.

**Excluye:**

- Comportamiento ejecutable, arnes de pruebas, instrumentación, plugins, hooks, scripts,
  ganchos de sistema, configuración y cualquier código.
- El producto, el dominio y las superficies de negocio.
- La escalación de modelo por estancamiento o por cualquier otra causa.
- Tableros, visualizaciones, facturación y cálculo exacto de dinero.
- Multi-objetivo, lotes de trabajo y priorización entre ejecuciones.
- La terminación de procesos por consumo.
- Purga, retención y comparación entre ejecuciones.
- Archivos locales, copias de respaldo y fuentes paralelas de datos.
- Cualquier modificación de los cinco contratos de control que compone.
- Los checkpoints y la continuidad de subagentes.

**Relación con los cinco contratos.** El controlador los consulta; no los implementa. Si uno
de ellos no carga o si alguna de sus referencias está rota, la ejecución se detiene y se
informa: no se improvisa una regla sustituta.

## Términos

| Término | Significado |
|---------|-------------|
| **Ejecución** | Instancia del loop que conduce un único objetivo pedido, con identidad propia y ciclo de vida propio. |
| **Objetivo** | Trabajo documentado o corrección documentada que se pide llevar a su cierre. |
| **Ronda** | Ciclo que entrega trabajo, se comprueba y deja un resultado observado. Solo cuenta la ronda con resultado observado. |
| **Baseline** | Documento aprobado que delimita el trabajo autorizado: criterios y tareas de la ejecución. |
| **Registro de ejecución** | Documento durable con el estado efectivo del controlador, el tope duro y las pausas propias. |
| **Tope duro** | Umbral de consumo declarado por el trabajo que, al alcanzarse, produce una pausa reversible. |
| **Compuerta** | Punto de evaluación del gasto dentro del cierre de ronda. |
| **Pausa del controlador** | Detención reversible decidida por este contrato, con origen propio. |
| **Pausa de terminación** | Detención reversible decidida por el predicado de terminación. |
| **Pausa de presupuesto** | Detención reversible propuesta por el registro de gasto. |
| **Decisión** | Salida única del cierre de ronda: `continue`, `pause` o `close`. |
| **Reanudación** | Retomada de la misma ejecución tras una pausa, con señal explícita y causa resuelta. |
| **Cierre** | Fin de la ejecución con veredicto: `success`, `safe_abandonment` o `external_cause`. |

## Cuándo se carga

El controlador se carga:

- **Al inicio** de la ejecución, antes de crear el registro de ejecución.
- **Antes de la ronda 1**, para resolver identidad, baseline, tope duro y el orden de inicio.
- **Al cierre de cada ronda**, para aplicar el orden de ronda y decidir.
- **Al pausar**, para registrar la pausa y sus condiciones de reanudación.
- **Al reanudar**, para restaurar el estado conservado y evaluar la causa.
- **Al cerrar**, para escribir el veredicto y conservar el historial.

## Modelo de ejecución

- **Una ejecución por objetivo.** Un objetivo pedido se conduce como una sola ejecución. No
  hay lotes multi-objetivo ni trabajos mezclados en una misma ejecución.
- **Pausa y reanudación pertenecen a la misma ejecución.** Se conserva lo avanzado, la
  numeración de rondas y los contadores. Nada se reinicia.
- **Un nuevo inicio posterior al cierre es una ejecución nueva**, con registro propio,
  numeración propia y contadores propios.
- **La numeración de rondas es monotónica.** No se reinicia al reanudar, al cambiar la figura
  responsable de la inspección, al revisar el plan ni al reasignar el trabajo.
- **El trabajo previo no es ronda.** Lo hecho antes de la señal de inicio se refleja en los
  valores iniciales y no cuenta como ronda ni como avance de la ronda 1.
- **Sin señal de inicio no hay ejecución.** No se crea registro, no hay ronda y no hay gasto
  atribuido a una ejecución que nunca comenzó.
- **Ronda 0** es la ronda de inicialización del registro de progreso. No es una ronda
  funcional.
- **Una ronda sin resultado observado no es ronda.** No se confirma su instantánea, no
  evalúa la terminación y no incrementa ningún contador canónico.

**Estados.** La metadata de la ejecución (`execution.status`) admite `active`, `paused` y
`closed`. El estado efectivo del controlador (`state`) admite `running`, `paused` y `closed`.
La metadata describe el ciclo de vida; el estado efectivo describe la decisión vigente.

### Contexto de ejecución

El contexto de una ejecución reúne la identidad, el baseline, el tope duro, las referencias a
los registros y la política vigente. Es la entrada del protocolo de inicio y se materializa
como `RunContext v1`:

~~~json
{"schema":"agent-loop-run/context/v1","execution":{"id":"CA-ejemplo-20261020T001500Z","work_id":"CA-ejemplo","work_kind":"ca","status":"active"},"baseline":{"version":1,"ref":"baseline://approved/plan","approved_at":"2026-10-20T00:15:00Z"},"gate":{"id":"auto-0001","kind":"gate","policy":"execution_gate","outcome":"pass","verified":true,"reason":null,"command":"mem_search(query: \"CA-ejemplo plan\", type: \"ca-artifact\", scope: \"project\")","result":"plan final y auditoria verificados","evidence_refs":["ca/CA-ejemplo/artifact/plan","ca/CA-ejemplo/artifact/audit"],"at":"2026-10-20T00:15:00Z"},"autonomy":{"profile":"autonomous-dev","source":"project"},"hard_limit":{"declared":true,"tokens":500000,"active_time_ms":null,"effect":"pause","ref":"baseline://approved/hard-limit","declared_by":"authority","declared_at":"2026-10-20T00:15:00Z"},"records":{"progress":"flow-state/CA-ejemplo-20261020T001500Z/progress","termination":"flow-state/CA-ejemplo-20261020T001500Z/termination","idempotency":"flow-state/CA-ejemplo-20261020T001500Z/idempotency","budget":"flow-state/CA-ejemplo-20261020T001500Z/budget","run":"flow-state/CA-ejemplo-20261020T001500Z/run"},"invariants":{"catalog_version":1,"context_ref":"round-000-invariant-context"},"policy":{"profile":"development","max_retries_per_phase":2},"started_at":"2026-10-20T00:15:00Z"}
~~~

**Bloques del contexto de ejecución.**

| Bloque | Contenido |
|--------|-----------|
| `schema` | Siempre `agent-loop-run/context/v1`. |
| `execution` | `id`, `work_id`, `work_kind`, `status` y `started_at`. |
| `baseline` | Versión, referencia y aprobación del baseline vigente. |
| `gate` | Resultado del gate que habilita la ejecución, como objeto `PolicyDecision v1`. Es `null` mientras el gate no se evaluó. |
| `autonomy` | Capa de autonomía resuelta antes de abrir la ejecución: `profile` (valor vigente) y `source` (origen de la resolución). |
| `hard_limit` | Tope duro declarado, con `declared`, `tokens`, `active_time_ms`, `effect`, `ref`, `declared_by` y `declared_at`. |
| `records` | Referencias a los cinco registros operativos. |
| `invariants` | Versión del catálogo de invariantes y referencia del contexto de la ronda. |
| `policy` | Perfil vigente y máximo de reintentos por fase. |
| `started_at` | Instante de apertura de la ejecución. |

## Identidad y señal de inicio

### Identidad

| Campo | Regla |
|-------|-------|
| `execution.id` | `{work_id}-{YYYYMMDDTHHMMSSZ}` en UTC. Identificador único, distinto del identificador del trabajo. |
| `work_id` | `CA-{ID}` para un trabajo de requisito o `HF-{slug}` para un hotfix. |
| `work_kind` | `ca` o `hotfix`. |
| `execution.status` | `active`, `paused` o `closed`. Metadata de ciclo de vida; no decide transiciones. |

El identificador de ejecución se deriva del trabajo y del instante de la señal de inicio. No
se deduce del contenido de una sesión, del modelo, del agente ni de marcas de tiempo
ajenas a esa señal.

### Señal explícita de inicio

La señal de inicio es el evento único, explícito y observable que abre la ejecución.

- En un trabajo sujeto a gate, la señal es la **orden original del desarrollador que autoriza
  el trabajo** junto con el **resultado PASS del gate**. No se exige una segunda confirmación
  después del gate.
- En un hotfix, la señal es la **aceptación explícita del diagnóstico acordado**.

**Reglas de la señal:**

- **Sin señal no hay registro ni ronda.** La existencia de un artefacto, de un worktree o de
  un rechazo previo no abre la ejecución por sí sola.
- **La señal crea el registro antes de la primera ronda.** El registro de ejecución existe y
  está confirmado por lectura antes de despachar la ronda 1.
- **Una señal que encuentra una ejecución `active` o `paused` del mismo trabajo reanuda esa
  ejecución** y no crea una nueva: conserva la identidad, la numeración y los contadores.
- **Una señal posterior al cierre abre una ejecución nueva**, con identidad y contadores
  propios.

### Autonomía por política

La política vigente es `gate-then-auto`: el control técnico se verifica primero y, cuando
pasa, la construcción comienza sin espera rutinaria.

- **El avance automático solo omite la confirmación rutinaria posterior al gate.** No omite
  el gate, ni la auditoría del plan, ni la validación de la implementación.
- **Un indicador de invocación como `--auto` no altera el gate ni los consentimientos.**
  Solo declara que no hay espera rutinaria.
- **La capa de autonomía declara la iniciativa (`assistant`, `autonomous-dev`); no es un
  interruptor por flujo y no altera el gate, la auditoría, la validación ni los consentimientos.
  La política de ejecución sigue siendo `gate-then-auto`.**
- **La autonomía solo puede restringir dentro del sobre de permisos; nunca lo amplía.** La
  precedencia entre capas es `permisos > autonomía > persona`: la persona no autoriza ni
  restringe, y la autonomía no amplía el sobre técnico.
- **Las acciones de riesgo conservan su consentimiento explícito.** Preservar o descartar
  cambios del destino, publicar o mover trabajo a remoto, eliminar trabajo ajeno o pendiente
  manual y modificar archivos protegidos requieren consentimiento humano explícito.
- **La autonomía no sustituye la evidencia.** Toda decisión automática de avance o de pausa
  queda registrada como una decisión de política con su referencia verificable.
- **La evidencia material distingue lo verificado de lo no verificado.** Una decisión con
  `verified: false` no respalda un avance material ni un cierre; como máximo habilita una
  pausa. Una decisión material cita la fuente concreta y no presenta un dato no verificado
  como hecho.

## Baseline y tope duro

### Baseline

El baseline delimita el trabajo autorizado de la ejecución.

- Para un trabajo de tipo `ca`, el baseline se compone de los criterios de aceptación del
  trabajo aprobado y de las tareas del plan aprobado.
- Para un trabajo de tipo `hotfix`, el baseline se compone de las tareas del plan aprobado y
  la familia de criterios queda en `not_applicable`, con total cero.
- El baseline es **versionado**. Un cambio de baseline se registra antes de la ronda affected y
  nunca a mitad de ronda.
- El controlador **no redefine** el baseline: lo resuelve, lo referencia y lo respeta.

### Tope duro

El tope duro es un umbral de consumo **declarado por el trabajo** (por su requisito, por su
plan o por su hotfix). Se modela como `HardLimit v1`:

~~~json
{"schema":"agent-loop-run/hard-limit/v1","declared":true,"tokens":500000,"active_time_ms":null,"effect":"pause","ref":"baseline://approved/hard-limit","declared_by":"authority","declared_at":"2026-10-20T00:15:00Z"}
~~~

**Reglas del tope duro:**

- **Solo existe si el trabajo lo declara.** Sin declaración no hay tope duro, y por lo tanto
  no hay pausa por gasto.
- **No hay valores por defecto.** `tokens` y `active_time_ms` arrancan en `null`. Ningún
  número se inventa: lo no declarado no limita.
- **`effect` admite un solo valor: `pause`.** El tope duro nunca cierra, nunca abandona y
  nunca termina procesos por consumo.
- **`ref` es obligatoria** cuando `declared` es verdadero. Sin ella, la declaración es
  inválida.
- **`declared_by` declara la autoridad** que lo declara.
- **El tope duro vive en el registro de ejecución**, no en el registro de gasto. El registro
  de gasto conserva los límites blandos; el registro de ejecución conserva el tope duro.
- **La calibración no inventa topes.** Durante la ventana de calibración —las primeras 10 a
  20 ejecuciones reales por tipo de trabajo— no hay umbrales numéricos por defecto: solo se
  observa y se anota. Pasada la calibración, los topes se derivan de lo observado.
- **El tope duro no se infiere del consumo.** Solo lo declara el trabajo.

**Declaración inválida.** Un valor no numérico, un entero no positivo, un tipo incorrecto, un
`effect` distinto de `pause` o una `ref` ausente se **ignoran**: se informa
`hard_limit_invalid` y el tope se trata como no declarado. Una declaración inválida **no
pausa**.

## Registros de la ejecución

La ejecución se apoya en cinco registros operativos y un registro propio. El controlador
escribe **solo** el propio; los demás se consultan.

| Registro | Namespace | Owner | Lectores | Rol en la ejecución |
|----------|-----------|-------|----------|---------------------|
| `ProgressRecord` | `flow-state/{execution_id}/progress` | runner | Todos (solo lectura) | Fuente única del avance verificable por ronda. |
| `TerminationRecord` | `flow-state/{execution_id}/termination` | runner | Todos (solo lectura) | Predicado único de continuar, pausar o cerrar. |
| `IdempotencyRecord` | `flow-state/{execution_id}/idempotency` | runner y constructor (secuencial por ejecución) | Runner, Constructor, Validator, Inspector | Identidad de operación, intentos y constancias confirmadas. |
| `BudgetRecord` | `flow-state/{execution_id}/budget` | runner | Todos (solo lectura) | Gasto acumulado, aviso blando y propuestas de pausa. |
| Contexto, check y reporte de invariantes | Sin namespace propio: se adjuntan al resultado durable de la ronda | runner | Runner, Constructor, Validator | Verificación bloqueante del cierre de ronda. |
| `AgentRunRecord` | `flow-state/{execution_id}/run` | runner | Todos (solo lectura) | Estado efectivo del controlador, tope duro y pausas propias. |

**Reglas de los registros:**

- El registro de ejecución **referencia** los otros cuatro y **no los sustituye**: no
  duplica sus hechos, no redefine sus variables y no los reescribe.
- **Los invariantes se adjuntan al resultado durable** de la ronda, no a un namespace propio.
- **Ninguno de estos registros es un checkpoint.** No habilitan la reanudación de subagentes
  ni sustituyen el estado por subagente.
- **No hay otros namespaces.** El único namespace nuevo de este contrato es `run`.
- Si un registro contradice al registro de ejecución, se informa la contradicción, **no se
  sobrescribe** ninguno de los dos y no se avanza.

### Registro de ejecución

El registro de ejecución es un documento único, completo y durable:

~~~json
{"schema":"agent-loop-run/v1","execution":{"id":"CA-ejemplo-20261020T001500Z","work_id":"CA-ejemplo","work_kind":"ca","status":"active","started_at":"2026-10-20T00:15:00Z"},"baseline":{"version":1,"ref":"baseline://approved/plan","approved_at":"2026-10-20T00:15:00Z"},"hard_limit":{"declared":true,"tokens":500000,"active_time_ms":null,"effect":"pause","ref":"baseline://approved/hard-limit","declared_by":"authority","declared_at":"2026-10-20T00:15:00Z"},"round":{"number":3,"last_snapshot_id":"round-003-rev-1"},"records":{"progress":"flow-state/CA-ejemplo-20261020T001500Z/progress","termination":"flow-state/CA-ejemplo-20261020T001500Z/termination","idempotency":"flow-state/CA-ejemplo-20261020T001500Z/idempotency","budget":"flow-state/CA-ejemplo-20261020T001500Z/budget"},"autonomy":{"policy":"gate-then-auto","profile":"autonomous-dev","source":"project","decisions":[{"id":"auto-0001","kind":"gate","policy":"execution_gate","outcome":"pass","verified":true,"reason":null,"command":"mem_search(query: \"CA-ejemplo plan\", type: \"ca-artifact\", scope: \"project\")","result":"plan final y auditoria verificados","evidence_refs":["ca/CA-ejemplo/artifact/plan","ca/CA-ejemplo/artifact/audit"],"at":"2026-10-20T00:15:00Z"}]},"state":"running","pause":null,"closure":null,"budget_gate":{"outcome":"not_evaluated","reason":"termination_precedence","hard_limit_reached":false,"termination_ref":null,"budget_ref":"flow-state/CA-ejemplo-20261020T001500Z/budget","evaluated_at":"2026-10-20T00:30:00Z"},"integrity":{"record_version":1,"last_transition_id":"tr-run-0001","last_confirmed_at":"2026-10-20T00:15:00Z"},"created_at":"2026-10-20T00:15:00Z","updated_at":"2026-10-20T00:30:00Z"}
~~~

**Bloques del registro de ejecución.**

| Bloque | Contenido |
|--------|-----------|
| `schema` | Siempre `agent-loop-run/v1`. |
| `execution` | `id`, `work_id`, `work_kind`, `status` y `started_at`. |
| `baseline` | Versión, referencia y aprobación del baseline vigente. |
| `hard_limit` | Tope duro declarado, con `declared`, `tokens`, `active_time_ms`, `effect`, `ref`, `declared_by` y `declared_at`. |
| `round` | Número de ronda y última instantánea de progreso confirmada. |
| `records` | Referencias a los cuatro registros operativos. |
| `autonomy` | Política vigente, capa de autonomía resuelta y decisiones de política registradas. |
| `state` | Estado efectivo del controlador: `running`, `paused` o `closed`. |
| `pause` | Pausa vigente o `null`. |
| `closure` | Cierre vigente o `null`. |
| `budget_gate` | Última compuerta de gasto evaluada. |
| `integrity` | Versión del documento, última transición y última confirmación por lectura. |
| `created_at` / `updated_at` | Creación y última escritura confirmada. |

**Bloque `pause`.** Es `null` o un objeto con `source`, `reason`, `round`, `since`,
`record_ref`, `resume_conditions[]` y `evidence_refs[]`. `record_ref` apunta al registro de
origen (`termination` o `budget`) y es `null` cuando la pausa es propia del controlador.

**Bloque `closure`.** Es `null` o un objeto con `verdict`, `reason`, `round`, `closed_at`,
`record_ref` y `preserved_refs[]`.

**Bloque `budget_gate`.** Contiene `outcome`, `reason`, `hard_limit_reached`,
`termination_ref`, `budget_ref` y `evaluated_at`.

**Bloque `autonomy`.** Contiene `policy`, `profile`, `source` y `decisions[]`. La política vigente
es `gate-then-auto`. `profile` es el valor de la capa de autonomía resuelta
(`assistant` o `autonomous-dev`) y `source` es su origen (`team` o `project`).
`decisions[]` es una lista append-only de decisiones de política: cada gate PASS, cada pausa por
excepción y cada reanudación agregan **exactamente una** entrada.

### Decisión de política

La evidencia de las decisiones automáticas se modela como `PolicyDecision v1`:

~~~json
{"schema":"agent-loop-run/policy-decision/v1","id":"auto-0002","kind":"pause","policy":"exception_pause","outcome":"pause","verified":true,"reason":"authority_block","command":null,"result":"conservado worktree, artifacts y ronda 3","evidence_refs":["flow-state/CA-ejemplo-20261020T001500Z/progress","flow-state/CA-ejemplo-20261020T001500Z/termination"],"at":"2026-10-20T00:45:00Z"}
~~~

| Campo | Contenido |
|-------|-----------|
| `id` | Identidad de la decisión, `auto-{NNNN}` monotónico dentro de la ejecución. |
| `kind` | `gate`, `pause` o `resume`. |
| `policy` | Política que habilita la decisión: `execution_gate`, `exception_pause` o `resume_gate`. |
| `outcome` | Resultado observado: `pass`, `fail`, `pause`, `resume` o `reject`. |
| `verified` | `true` solo si la evidencia se leyó y confirmó; `false` si es parcial o no verificable. |
| `reason` | `null` o el motivo de pausa vigente. |
| `command` | Comando ejecutado cuando aplica; `null` en caso contrario. |
| `result` | Resultado resumido y verificable; `null` cuando no aplica. |
| `evidence_refs` | Referencias citable de la decisión. |
| `at` | Momento de la evaluación, en ISO-8601. |

**Reglas de la decisión de política:**

- **El registro es append-only.** Cada escritura reemplaza el documento completo, pero
  conserva todas las entradas anteriores de `decisions[]`.
- **Un gate FAIL no abre ejecución y no crea registro.** Se informa en una línea, no se
  construye nada y el plan conserva su `gate_status` como evidencia.
- **`verified: false` nunca autoriza un permiso de riesgo ni un cierre.** Una decisión no
  verificada habilita como máximo una pausa.
- **Una pausa por excepción registra el motivo vigente** y conserva el estado de la
  ejecución.

### Enumeraciones del contrato

| Campo | Valores |
|-------|---------|
| `execution.work_kind` | `ca`, `hotfix` |
| `execution.status` | `active`, `paused`, `closed` |
| `state` | `running`, `paused`, `closed` |
| `pause.source` | `termination`, `budget`, `controller` |
| `pause.reason` | `invariant_violation`, `explicit_limit`, `authority_block`, `no_verifiable_progress`, `progress_unavailable`, `soft_limit_exceeded`, `explicit_pause_decision`, `record_unavailable`, `data_unverified`, `hard_limit` |
| `budget_gate.outcome` | `continue`, `notify`, `pause`, `unverified`, `unavailable`, `not_evaluated` |
| `budget_gate.reason` | `none`, `observing`, `within_limits`, `tokens_soft_limit_exceeded`, `active_time_soft_limit_exceeded`, `both_soft_limits_exceeded`, `soft_limit_exceeded`, `explicit_pause_decision`, `record_unavailable`, `attribution_incomplete`, `data_unverified`, `termination_precedence`, `closed`, `hard_limit_exceeded`, `hard_limit_unverified` |
| `closure.verdict` | `success`, `safe_abandonment`, `external_cause` |
| `hard_limit.effect` | `pause` |
| `autonomy.policy` | `gate-then-auto` |
| `autonomy.profile` | `assistant`, `autonomous-dev` |
| `autonomy.source` | `team`, `project` |
| `PolicyDecision.kind` | `gate`, `pause`, `resume` |
| `PolicyDecision.policy` | `execution_gate`, `exception_pause`, `resume_gate` |
| `PolicyDecision.outcome` | `pass`, `fail`, `pause`, `resume`, `reject` |

### Persistencia y confirmación

| Elemento | Valor |
|----------|-------|
| `topic_key` | `flow-state/{execution_id}/run` |
| `type` | `decision` |
| `scope` | `project` |
| `title` | `Agent Loop run — {execution_id}` |
| Owner (único escritor) | Quien coordina la ejecución |
| Lectores | Todos los agentes, en modo solo lectura |

**Reglas de escritura:**

1. Cada escritura **reemplaza el documento completo**. Nunca se parchea ni se trunca el
   historial.
2. Después de escribir, se **confirma** la lectura de `integrity.record_version` y
   `integrity.last_transition_id` **antes de despachar la ronda siguiente**.
3. `record_version` es **monotónico**: cada escritura lo incrementa. Una versión que no
   avanza o que retrocede es un fallo operativo.
4. Si la confirmación no coincide con lo escrito, es un **fallo operativo**: no se
   sobrescribe, se conserva la última confirmación buena y se reintenta o se escala.
5. **No hay archivos locales de respaldo.** La única fuente es el registro durable.

## Orden de la ejecución

El orden es **fijo**. Un paso no se ejecuta antes de que el anterior esté confirmado por
lectura. La confirmación por lectura es obligatoria: sin ella no hay despacho.

**Antes de la ronda 1:**

| # | Paso | Confirmación por lectura |
|---|------|-------------------------|
| 1 | Recibir la señal explícita de inicio. | Señal registrada y legible. |
| 2 | Resolver la identidad de la ejecución, el baseline vigente y el tope duro. | Identidad, baseline y tope resueltos y verificables. |
| 3 | Inicializar el registro de progreso como ronda 0. | `integrity.last_snapshot_id` confirmado. |
| 4 | Crear el ledger de idempotencia en la fase `runner.intake`. | `record_version` y esquema del ledger confirmados. |
| 5 | Declarar y registrar el contexto de invariantes. | Contexto confirmado con `catalog_version` y `write_area`. |
| 6 | Crear el registro de gasto de la ejecución. | Totales iniciales y `integrity.state` confirmados. |
| 7 | Crear el registro de ejecución con las referencias y el tope duro. | `record_version` y `last_transition_id` confirmados. |
| 8 | Leer el registro de terminación. | Ausencia significa `running`; presencia significa que se restaura y se respeta. |
| 9 | Despachar la ronda 1. | Solo si las ocho confirmaciones anteriores están leídas. |

**En cada ronda:**

| # | Paso | Confirmación por lectura |
|---|------|-------------------------|
| 1 | Congelar el resultado y la evidencia de la ronda. | Resultado congelado con su evidencia. |
| 2 | Verificar los invariantes de forma bloqueante. | Check persistido y confirmado. |
| 3 | Registrar la instantánea de progreso. | `last_snapshot_id` confirmado. |
| 4 | Evaluar el predicado de terminación. | Decisión y `evaluation_key` confirmadas. |
| 5 | Evaluar la compuerta de gasto: primero el tope duro y después el límite blando. | `budget_gate` confirmado con `outcome` y `reason`. |
| 6 | Confirmar las fases de idempotencia de la ronda. | Constancias confirmadas por lectura. |
| 7 | Despachar la ronda siguiente. | Solo si la decisión es `continue` y todo lo anterior está leído. |

El registro de ejecución se actualiza con la ronda, el estado efectivo, la pausa o el cierre
y la última compuerta, y se confirma por lectura **antes** del despacho. Esa actualización
acompaña la decisión y no introduce un paso de orden nuevo.

**Sin confirmaciones por lectura no hay ronda.** Ninguna ronda se despacha con una
confirmación pendiente, y una ronda que no produjo resultado observado no avanza la
numeración.

## Protocolo de inicio

1. **Recibir y confirmar la señal explícita de inicio.** Sin ella el protocolo no arranca: no
   se crea registro, no hay ronda y no se atribuye gasto.
2. **Buscar una ejecución previa del mismo trabajo.** Si existe una ejecución `active` o
   `paused` para el mismo `work_id`, se reanuda: se restaura la última instantánea
   confirmada, se conservan la numeración y los contadores, y no se crea una ejecución nueva.
   Si la ejecución previa está `closed`, se abre una ejecución nueva.
3. **Resolver la identidad, el baseline y el tope duro.** Se compone `execution.id` con el
   formato `{work_id}-{YYYYMMDDTHHMMSSZ}` en UTC, se declara `work_kind` y se resuelve el
   baseline aprobado. Se lee la declaración de tope duro del trabajo: si es inválida, se
   ignora, se informa `hard_limit_invalid` y se trata como no declarada.
4. **Inicializar el registro de progreso como ronda 0** y confirmarlo por lectura. El trabajo
   previo al inicio se refleja en los valores iniciales y **no cuenta como ronda**.
5. **Crear el ledger de idempotencia** en la fase `runner.intake` y confirmarlo por lectura.
   La política de perfil y reintentos queda fijada en este paso.
6. **Declarar el contexto de invariantes** y confirmarlo por lectura.
7. **Crear el registro de gasto** y confirmarlo por lectura. En una ejecución nueva sus
   totales arrancan en cero; nunca se declara cero por falta de datos.
8. **Crear el registro de ejecución** con la identidad, el baseline, el tope duro y las
   referencias a los cuatro registros, y confirmarlo por lectura.
9. **Leer el registro de terminación y despachar la ronda 1.** Si el registro de terminación
   no existe, la ejecución está en estado `running`; si existe, se restaura y se respeta sin
   reevaluar. La ronda 1 se despacha solo con las ocho confirmaciones anteriores leídas.

Si falta cualquier confirmación, **no se inicia la ronda** y se reporta un fallo operativo
con el paso exacto que faltó. No se despacha con una confirmación pendiente.

## Protocolo de ronda

1. **Congelar** el resultado y la evidencia de la ronda. Sin resultado observado no hay
   ronda: no se confirma instantánea, no se evalúa la terminación y no se incrementa ningún
   contador canónico.
2. **Verificar los invariantes** de forma bloqueante y en orden. Un invariante violado deja
   reporte durable, no confirma la instantánea y frena en seguridad. Un invariante no
   evaluable se declara como tal y la ronda no se confirma.
3. **Registrar la instantánea de progreso** y confirmarla por lectura. La instantánea se
   registra **antes** de decidir.
4. **Evaluar el predicado de terminación** y registrar la decisión con su
   `evaluation_key`.
5. **Evaluar la compuerta de gasto** solo si la terminación dice `continue`: primero el
   **tope duro** y después el **límite blando**. Con tope duro alcanzado, la pausa es del
   controlador. Con límite blando y `notify`, hay aviso visible. Con límite blando y
   `pause`, la pausa es reversible. Si la terminación dice `pause` o `close`, la compuerta no
   se evalúa y el motivo visible es el de la terminación.
6. **Confirmar las fases de idempotencia** de la ronda.
7. **Actualizar el registro de ejecución** con la ronda, el estado efectivo, la pausa o el
   cierre, y la última compuerta; confirmarlo por lectura; y **despachar la ronda siguiente**
   solo si la decisión es `continue`. Con `pause` o `close` no se despacha nada.

**Reglas del protocolo de ronda:**

- Una ronda cuenta solo con **resultado observado**.
- Un fallo operativo **no es una ronda**: no confirma, no evalúa y no cuenta.
- Un invariante violado **no confirma la instantánea** aunque la terminación diga
  `continue`.
- La decisión se toma **después** de la instantánea y **antes** del despacho.
- La compuerta de gasto va **después** de la terminación y **antes** de la idempotencia.
- Reevaluar la misma ronda con los mismos hechos **no** crea una instantánea nueva, ni una
  transición, ni un cierre duplicado.

## Decisión del controlador

El controlador produce **exactamente una decisión** por ronda: `continue`, `pause` o `close`.

### Precedencia de la decisión

| Orden | Condición | Resultado | Motivo visible |
|-------|-----------|-----------|----------------|
| 1 | La terminación dice `close`. | Cierre con veredicto. | El de la terminación. |
| 2 | La terminación dice `pause`. | Pausa reversible. | El de la terminación. |
| 3 | La terminación dice `continue` y el tope duro está alcanzado. | Pausa del controlador. | `hard_limit`. |
| 4 | La terminación dice `continue`, el tope duro no está alcanzado y el límite blando pide pausa. | Pausa reversible. | El de la evaluación blanda. |
| 5 | La terminación dice `continue` y no hay tope duro. | Aviso blando como máximo; el trabajo sigue. | El de la evaluación blanda. |

**Reglas de precedencia:**

- **La terminación prevalece.** Si dice `pause` o `close`, la compuerta de gasto **no se
  evalúa**: el motivo visible de la parada es el de la terminación.
- **El gasto solo se evalúa con `continue`.** El gasto nunca anula una orden de parada ni
  fuerza continuar.
- **El tope duro se evalúa antes del límite blando.** Ambos son reversible.
- **El gasto nunca cierra ni abandona.** Ningún estado de gasto produce `close`.
- El resultado de la decisión se persiste en el registro de ejecución y se refleja en la
  salida de la ronda.

### Decisión del controlador

La decisión se materializa como `RunDecision v1`:

~~~json
{"schema":"agent-loop-run/decision/v1","execution_id":"CA-ejemplo-20261020T001500Z","round":3,"termination":{"outcome":"continue","reason":"none","precedence":null,"evaluation_key":"CA-ejemplo-20261020T001500Z:3:round-003-rev-1:1"},"budget":{"evaluated":true,"outcome":"pause","reason":"hard_limit_exceeded","hard_limit_reached":true,"evaluation_key":"CA-ejemplo-20261020T001500Z:3:round-003-rev-1:budget"},"decision":"pause","reason":"hard_limit","pause":{"source":"controller","reason":"hard_limit","round":3,"resume_conditions":["new_limit","authority_decision"]},"verdict":null,"evidence_refs":["flow-state/CA-ejemplo-20261020T001500Z/budget#tokens.total","baseline://approved/hard-limit"]}
~~~

**Bloques de la decisión.**

| Bloque | Contenido |
|--------|-----------|
| `schema` | Siempre `agent-loop-run/decision/v1`. |
| `execution_id` | Identificador de la ejecución. |
| `round` | Número de ronda. |
| `termination` | Salida del predicado: `outcome`, `reason`, `precedence`, `evaluation_key`. |
| `budget` | Resultado de la compuerta: `evaluated`, `outcome`, `reason`, `hard_limit_reached`, `evaluation_key`. |
| `decision` | `continue`, `pause` o `close`. |
| `reason` | Motivo de la decisión vigente. |
| `pause` | Pausa resultante, o `null`. |
| `verdict` | Veredicto de cierre, o `null`. |
| `evidence_refs` | Referencias citable de los hechos que sostienen la decisión. |

## Freno duro por gasto

La compuerta de gasto se evalúa **únicamente** cuando la terminación dice `continue`. La
secuencia es: **tope duro primero, límite blando después**.

### Algoritmo de la compuerta

1. **Leer el registro de gasto.** De él se toman los totales: `tokens.total` y
   `time.active_time_ms`. Las rondas son de solo lectura y el dinero estimado es
   orientativo: **ninguno de los dos frena**.
2. **Si no hay tope duro declarado**, la compuerta no puede pausar por gasto. Se registra la
   observación, y como máximo se emite el aviso del límite blando. La ejecución continúa.
3. **Si hay tope duro declarado**:
   1. Si el registro de gasto es **ilegible o contradictorio**, la compuerta produce
      `pause` con `reason: record_unavailable`. No se sobrescribe el registro ni se inventa
      un cero.
   2. Si la **atribución está incompleta** o los datos son **parciales y no prueban el
      cumplimiento** del tope, la compuerta produce `pause` con `reason: data_unverified`.
      El gasto no atribuido se informa aparte y **nunca** se suma a esta ejecución.
   3. Si el **subconjunto conocido ya supera** el tope, la superación está probada: el tope
      está **alcanzado**.
   4. Si **todos los datos conocidos están por debajo** del tope, el tope **no está
      alcanzado** y la evaluación continúa con el límite blando.
4. **Tope alcanzado** → la ejecución **pausa**. La pausa es del controlador:
   `source: controller`, `reason: hard_limit`. No hay cierre, no hay abandono, no hay
   terminación de procesos y no hay cambio de modelo.
5. **Tope no alcanzado** → se evalúa el límite blando, que puede avisar, proponer pausa
   reversible o continuar.

### Reglas del freno duro

| Situación | Con tope duro declarado | Sin tope duro declarado |
|-----------|-------------------------|-------------------------|
| Tope alcanzado y terminación `continue`. | Pausa del controlador con `reason: hard_limit`. | No aplica: no hay tope. |
| Registro de gasto ilegible o contradictorio. | `pause` con `reason: record_unavailable`. | `unavailable` visible; el trabajo continúa en modo degradado. |
| Atribución incompleta o datos parciales que no prueban cumplimiento. | `pause` con `reason: data_unverified`. | `unverified` visible; el trabajo continúa. |
| Gasto alto por debajo del tope. | No alcanzado: se evalúa el límite blando. | Aviso blando como máximo; el trabajo continúa. |
| Tope declarado e inválido. | Se ignora, se informa y se trata como no declarado: no pausa. | Sin efecto. |
| Terminación en `pause` o `close`. | La compuerta no se evalúa: motivo `termination_precedence`. | La compuerta no se evalúa: motivo `termination_precedence`. |

**Prohibiciones del freno duro:**

- **Nunca hay cierre ni abandono por gasto.** Toda pausa por gasto es reversible.
- **Nunca se terminan procesos por consumo.** El freno es una pausa.
- **Nunca se cambia de modelo.** La escalación de modelo por estancamiento o por consumo no
  es parte de este contrato.
- **No se frena por rondas.** El número de rondas es un hecho de estancamiento, no de gasto.
- **No se frena por dinero estimado.** El costo es orientativo y puede ser cero.
- **No se frena por consumo de un participante aislado.** La unidad es la ejecución completa.
- **No se usa el conteo de caracteres de admisión de contexto** como presupuesto del
  objetivo.
- **El gasto no atribuido no se reparte.** No se imputa a la ejecución más cercana.

## Pausa y reanudación

Toda pausa es **reversible** y pertenece a la **misma ejecución**.

### Fuentes de pausa

| Fuente | `pause.source` | Motivo (`pause.reason`) | Registro de origen | Condiciones de reanudación |
|--------|-----------------|--------------------------|---------------------|----------------------------|
| Terminación | `termination` | `invariant_violation` | `termination` | `resolution_record` y `signal_lifted` |
| Terminación | `termination` | `explicit_limit` | `termination` | `new_limit` o `authority_decision` |
| Terminación | `termination` | `authority_block` | `termination` | `authority_decision` |
| Terminación | `termination` | `no_verifiable_progress` | `termination` | `new_hypothesis`, `new_baseline` o `authority_decision` |
| Terminación | `termination` | `progress_unavailable` | `termination` | `progress_readable` |
| Presupuesto | `budget` | `soft_limit_exceeded` | `budget` | `authority_decision` o `new_limit` |
| Presupuesto | `budget` | `explicit_pause_decision` | `budget` | `authority_decision` |
| Presupuesto | `budget` | `record_unavailable` | `budget` | `record_readable`, `data_complete` o `authority_decision` |
| Presupuesto | `budget` | `data_unverified` | `budget` | `data_complete`, `record_readable` o `authority_decision` |
| Controlador | `controller` | `hard_limit` | Ninguno: pausa propia | `new_limit` o `authority_decision` |

**Qué conserva la pausa:** la última instantánea confirmada, la numeración de rondas, los
contadores, el motivo, la ronda en la que se pausó, la evidencia y las condiciones de
reanudación.

**Una pausa por excepción deja una decisión de política.** Registra una entrada con
`kind: pause`, `policy: exception_pause` y el motivo vigente, y conserva el estado de la
ejecución para poder reanudarla.

**Mientras dura la pausa no se despachan rondas.** No hay trabajo en curso y no se avanza
ningún contador.

**Pausar dos veces por la misma causa y la misma evaluación no duplica registros:** la
segunda evaluación devuelve la pausa existente sin transición nueva.

### Reanudación

Reanudar exige, **en conjunto**:

1. Una **señal explícita** de reanudación.
2. La **misma ejecución**: el `execution_id` no cambia.
3. Una **causa resuelta**, conforme a la fila que corresponde al motivo de la pausa.
4. **No reiniciar**: se conservan la numeración, los contadores y lo avanzado.

**La reanudación reutiliza la evidencia y no repite comprobaciones ya verificadas.** Lee la
última decisión de política y la evidencia de la última ronda, conserva la numeración y no
vuelve a ejecutar una comprobación ya confirmada. Deja una decisión de política con
`kind: resume` y `policy: resume_gate`.

**La reanudación reutiliza la evidencia material verificada** y no repite su comprobación.
Si un dato material sigue sin confirmarse, la pausa se mantiene y la ronda siguiente no se
despacha.

**Causas por motivo de pausa:**

| Motivo | Causa admitida | Resultado sin causa |
|---------|----------------|---------------------|
| `hard_limit` | `new_limit` (presupuesto nuevo declarado) o `authority_decision` (re-definición del trabajo, con baseline nuevo) | **Rechazo**: la pausa se mantiene y el registro no muta. |
| `soft_limit_exceeded` | `authority_decision` o `new_limit` | Rechazo. |
| `record_unavailable` | `record_readable`, `data_complete` o `authority_decision` | Rechazo. |
| `data_unverified` | `data_complete`, `record_readable` o `authority_decision` | Rechazo. |
| `invariant_violation` | `resolution_record` y `signal_lifted` | Rechazo. |
| `explicit_limit` | `new_limit` o `authority_decision` | Rechazo. |
| `authority_block` | `authority_decision` | Rechazo. |
| `no_verifiable_progress` | `new_hypothesis`, `new_baseline` o `authority_decision` | Rechazo. |
| `progress_unavailable` | `progress_readable` | Rechazo. |

**Una re-definición del trabajo es una `authority_decision` con baseline nuevo.** No es una
causa independiente ni reinicia la ejecución.

**Un rechazo no muta el registro.** La pausa se conserva tal como estaba, con su motivo, su
ronda y sus condiciones.

## Cierre y veredictos

**Solo la terminación cierra la ejecución.** El controlador no cierra por su cuenta y el
gasto nunca cierra.

| Veredicto | Significado | Origen |
|-----------|-------------|--------|
| `success` | El objetivo se cumplió con evidencia vigente. | Condición de objetivo cumplido de la terminación. |
| `safe_abandonment` | Cierre sin objetivo cumplido y sin pérdida. | Límite expreso con efecto de cierre, decisión de autoridad o invariante sin resolución con abandono final declarado. |
| `external_cause` | Fallo irrecuperable declarado con evidencia. | Condición de fallo irrecuperable de la terminación. |

**Reglas del cierre:**

- El cierre **escribe** el registro de ejecución con el veredicto, el motivo, la ronda, el
  instante y las referencias preservadas, y **actualiza** el registro de progreso, el
  registro de gasto y el ledger de idempotencia.
- El cierre **conserva** el trabajo, el historial, la evidencia y el diagnóstico.
- El cierre **no se reabre**. Reevaluar una ejecución cerrada devuelve el veredicto
  existente sin transición nueva.
- El gasto **nunca** produce `success`, `safe_abandonment` ni `external_cause`.
- El estancamiento **nunca** cierra: pausa y propone.

## Fallos operativos

Un fallo operativo es un incidente que impide verificar un hecho. No se sustituye por una
regla improvisada, no se anuncian avances y no se despacha la ronda siguiente.

| Situación | Con tope duro declarado | Sin tope duro declarado | Efecto sobre la ejecución |
|-----------|-------------------------|--------------------------|----------------------------|
| Registro de progreso ausente, ilegible o contradictorio. | Se aplica la regla de su propio contrato. | Igual. | No se confirma instantánea; no se despacha. |
| Registro de terminación ausente en ejecución nueva. | — | — | La ejecución está en estado `running`. |
| Registro de terminación ilegible o contradictorio. | — | — | Fallo operativo `termination_unavailable`; no se sobrescribe; no se despacha. |
| Ledger de idempotencia ilegible. | — | — | No se ejecuta ninguna fase no idempotente sin constancia; la ejecución se detiene. |
| Registro de gasto ilegible o contradictorio. | `pause` con `reason: record_unavailable`. | `unavailable` visible; el trabajo continúa en modo degradado. | No se sobrescribe ni se inventa un cero. |
| Atribución incompleta o datos parciales. | `pause` con `reason: data_unverified`. | `unverified` visible; el trabajo continúa. | El gasto no atribuido se informa aparte. |
| Registro de ejecución ausente, ilegible o sin confirmar. | Pausa de seguridad del controlador. | Pausa de seguridad del controlador. | No se despacha; se conserva la última confirmación. |
| Registro de ejecución contradictorio con otro registro. | — | — | Se informa la contradicción, **no se sobrescribe** y no se avanza. |
| Contexto, check o reporte de invariantes no disponible. | — | — | El invariante afectado queda `not_evaluable`; la ronda no se confirma. |
| Una de las cinco skills no carga o una referencia está rota. | — | — | La ejecución se detiene y se informa; no se improvisa una regla sustituta. |
| Mecanismo de memoria no disponible. | Bloqueo según el contrato de memoria. | Degradación según el contrato de memoria, declarada en el reporte de ronda. | Sin archivos locales de respaldo. |
| Tope duro declarado e inválido. | Se ignora, se informa `hard_limit_invalid` y se trata como no declarado. | Sin efecto. | No pausa. |

**Reglas permanentes de los fallos:**

- **Nunca se declara cero** por falta de datos. Lo desconocido no es cero.
- **Nunca se sobrescribe** un registro ilegible o contradictorio.
- **Nunca se persiste** un archivo local de respaldo: la única fuente es el registro durable.
- Un fallo operativo **no es una ronda**: no incrementa la numeración ni los contadores.

## Configuración

La capa de autonomía se resuelve antes de abrir la ejecución y su valor queda registrado en el
registro de ejecución (`autonomy.profile` y `autonomy.source`). Los parámetros propios del
controlador no tienen archivos ni claves de entorno. Los valores por defecto son documentales y
viven en los datos de la ejecución.

### Tope duro

| Elemento | Dónde | Valor por defecto | Regla |
|----------|-------|-------------------|-------|
| `hard_limit.declared` | `HardLimit v1` | `false` | Sin declaración no hay tope duro ni pausa por gasto. |
| `hard_limit.tokens` | `HardLimit v1` | `null` | Entero mayor que cero o `null`; sin valor por defecto. Se compara con `tokens.total`. |
| `hard_limit.active_time_ms` | `HardLimit v1` | `null` | Entero mayor que cero o `null`; sin valor por defecto. Se compara con `time.active_time_ms`. |
| `hard_limit.effect` | `HardLimit v1` | `pause` | Único valor admitido. Nunca cierre ni abandono. |
| `hard_limit.ref` | `HardLimit v1` | `null` | Obligatoria si `declared` es verdadero; sin ella la declaración es inválida. |
| `hard_limit.declared_by` | `HardLimit v1` | `authority` | Referencia de quién declara el tope. |

### Resto de la configuración de la ejecución

| Elemento | Dónde | Valor por defecto | Regla |
|----------|-------|-------------------|-------|
| `limits.soft` | `BudgetRecord` | `null` | Límite blando; se evalúa **después** del tope duro. |
| `stagnation.pause_threshold` | Predicado de terminación | `3` | Rondas sin progreso verificable que disparan la pausa. |
| `stagnation.abandonment_proposal_threshold` | Predicado de terminación | `6` | Rondas sin progreso desde las cuales se propone el abandono. |
| `policy.profile` | Ledger de idempotencia | `development` | `development` o `production`; se fija en `runner.intake`. |
| `policy.max_retries_per_phase` | Ledger de idempotencia | `2` | `2` en `development`, `3` en `production`. |

### Calibración

Durante la ventana de calibración —las primeras **10 a 20** ejecuciones reales por tipo de
trabajo y tamaño— **no hay topes numéricos por defecto**. Sin declaración explícita, el
controlador solo observa y anota. Pasada la calibración, los topes se derivan de lo
observado, no se inventan.

### Valores inválidos

Un valor no numérico, un entero no positivo, un tipo incorrecto, un `effect` distinto de
`pause` o una `ref` ausente en una declaración de tope duro se **ignoran**: se informa
`hard_limit_invalid` y el tope se trata como no declarado. Una declaración inválida **no
pausa** ni habilita ningún freno.

## Garantías del contrato

1. **Una ejecución por objetivo.** Un objetivo pedido tiene una sola ejecución; no hay lotes
   multi-objetivo ni trabajos mezclados.
2. **Una sola señal de inicio.** Sin señal explícita no hay registro, ni ronda, ni gasto
   atribuido.
3. **Un registro de ejecución por ejecución.** Existe un único `AgentRunRecord` por
   `execution_id`.
4. **Numeración monotónica.** La numeración de rondas no se reinicia al reanudar, al cambiar
   la figura responsable ni al reasignar el trabajo.
5. **Los cinco contratos se componen, no se redefinen.** El controlador los consulta como
   fuente vigente y no copia ni reinterpreta sus reglas.
6. **La terminación prevalece.** Si dice `pause` o `close`, la compuerta de gasto no se
   evalúa y el motivo visible es el de la terminación.
7. **El gasto solo se evalúa con `continue`.** El gasto nunca anula una orden de parada ni
   fuerza continuar.
8. **El tope duro se evalúa antes del límite blando.**
9. **El tope duro nunca cierra ni abandona.** Su único efecto es una pausa reversible.
10. **El tope duro nunca termina procesos por consumo.**
11. **El tope duro nunca cambia de modelo.** La escalación de modelo no pertenece a este
    contrato.
12. **Sin tope duro no hay pausa por gasto.** Solo observación y, como máximo, aviso blando.
13. **Sin namespaces nuevos.** El único namespace propio es
    `flow-state/{execution_id}/run`; no hay namespace para invariantes ni para la compuerta.
14. **Sin archivos locales.** No hay copias de respaldo ni fuentes paralelas de datos.
15. **Escritura confirmada.** Toda escritura se confirma por lectura antes de despachar la
    ronda siguiente.
16. **La pausa es reversible.** Conserva instantánea, numeración, contadores, motivo,
    evidencia y condiciones.
17. **La reanudación no reinicia.** Continúa la misma ejecución desde la última anotación
    confirmada.
18. **Una reanudación sin causa resuelta se rechaza** y no muta el registro.
19. **El cierre es solo de la terminación.** El controlador y el gasto nunca cierran.
20. **Una ejecución cerrada no se reabre.**
21. **Reevaluar la misma ronda no duplica** transiciones, instantáneas ni cierres.
22. **El registro de ejecución referencia los otros cuatro** y no los sustituye.
23. **El registro de ejecución no es un checkpoint** y no habilita la reanudación de
    subagentes.
24. **El gasto no atribuido no se suma** a ninguna ejecución.
25. **Nunca se declara cero** por falta de datos ni se infiere un límite desde el consumo.
26. **Toda decisión automática deja evidencia.** Cada avance o pausa por excepción deja
    exactamente una entrada en `autonomy.decisions`, con su referencia verificable.
27. **La reanudación reutiliza la evidencia.** No repite comprobaciones ya verificadas ni
    reinicia contadores.
28. **La autonomía no concede permisos.** No sustituye consentimientos ni habilita
    preservaciones, descartes, publicaciones, borrados ni cambios en archivos protegidos.

## Matriz de aceptación

| ID | Criterio | Regla | Sección |
|----|----------|-------|---------|
| AC-01 | La señal de inicio con un objetivo documentado crea el registro de ejecución antes de la primera ronda; el trabajo previo no cuenta como ronda. | La señal abre la ejecución y el registro se confirma por lectura antes del despacho. | Identidad y señal de inicio; Protocolo de inicio |
| AC-02 | Sin señal explícita no hay registro ni ronda. | El protocolo de inicio no arranca sin señal. | Protocolo de inicio |
| AC-03 | Una señal que encuentra una ejecución `active` o `paused` del mismo trabajo reanuda y no crea una nueva. | Se restaura la última instantánea y se conservan numeración y contadores. | Protocolo de inicio |
| AC-04 | Un nuevo inicio posterior al cierre es una ejecución nueva con contadores propios. | Identidad, numeración y contadores nuevos. | Modelo de ejecución |
| AC-05 | Una ronda con resultado observado y reglas cumplidas se confirma, se evalúa la parada y solo entonces se despacha la siguiente. | La instantánea se registra antes de decidir; el despacho exige `continue`. | Protocolo de ronda |
| AC-06 | Una ronda sin resultado observado no cuenta como ronda completada, no evalúa la parada y no actualiza contadores. | El fallo operativo no confirma ni incrementa. | Protocolo de ronda; Fallos operativos |
| AC-07 | Una regla violada con evidencia detiene en seguridad, no declara éxito y deja reporte durable. | El invariante violado no confirma la instantánea. | Protocolo de ronda |
| AC-08 | El objetivo cumplido con evidencia vigente cierra con `success` aunque queden bloqueos registrados. | El cierre lo decide la terminación; los bloqueos restantes no impiden el éxito. | Cierre y veredictos |
| AC-09 | Un invariante vigente impide declarar éxito. | La seguridad prevalece sobre el éxito aparente. | Decisión del controlador |
| AC-10 | Un bloqueo que requiere decisión de autoridad pausa y espera; no continúa por cuenta propia. | Motivo `authority_block` con condición `authority_decision`. | Pausa y reanudación |
| AC-11 | Un fallo declarado irrecuperable con evidencia cierra por causa externa conservando trabajo, historial y diagnóstico. | Veredicto `external_cause` sin reintento. | Cierre y veredictos |
| AC-12 | Un límite expreso del trabajo se aplica con su efecto declarado, sin sustitución. | Se respeta el efecto declarado; nunca se reemplaza. | Decisión del controlador |
| AC-13 | La ausencia de avance verificable pausa y propone el abandono; nunca cierra. | Motivo `no_verifiable_progress`; el cierre exige señal de autoridad. | Pausa y reanudación |
| AC-14 | Cuando la terminación dice parar, el gasto no anula la parada. | La compuerta no se evalúa; motivo `termination_precedence`. | Decisión del controlador |
| AC-15 | Con terminación `continue` y tope duro alcanzado, la ejecución pausa de forma reversible en la misma ejecución. | Pausa del controlador con `reason: hard_limit`. | Freno duro por gasto |
| AC-16 | El tope duro no cierra, no abandona, no termina procesos y no cambia de modelo. | La pausa del controlador es el único efecto. | Freno duro por gasto |
| AC-17 | La pausa conserva instantánea, numeración, contadores, motivo, evidencia y condiciones. | Nada se reinicia al pausar. | Pausa y reanudación |
| AC-18 | Reanudar sin causa resuelta se rechaza y no muta el registro. | Señal más causa es requisito conjunto. | Pausa y reanudación |
| AC-19 | Sin tope duro no hay pausa por gasto; como máximo hay aviso blando. | La compuerta sin tope no puede pausar. | Freno duro por gasto |
| AC-20 | El límite blando con aviso avisa una vez por tope y ejecución y el trabajo sigue. | Aviso visible, sin pausa. | Freno duro por gasto |
| AC-21 | El límite blando con pausa propone una pausa reversible. | La pausa blanda no cierra ni abandona. | Freno duro por gasto |
| AC-22 | Con tope duro, el registro de gasto ilegible pausa en seguridad y pide decisión. | `reason: record_unavailable`; no se inventa un cero. | Freno duro por gasto |
| AC-23 | Sin tope duro, el registro ilegible solo se informa y el trabajo continúa en modo degradado. | `unavailable` visible, sin pausa. | Freno duro por gasto |
| AC-24 | Con tope duro, la atribución incompleta pausa con `data_unverified`; sin tope, se informa y se continúa. | El gasto no atribuido se informa aparte. | Freno duro por gasto |
| AC-25 | El gasto de una sesión no atribuible queda marcado como no atribuido y no se suma a otro objetivo. | Nunca se reparte ni se imputa al más cercano. | Freno duro por gasto |
| AC-26 | Un tope duro inválido se ignora, se informa y se trata como no declarado; no pausa. | `hard_limit_invalid` sin efecto de freno. | Baseline y tope duro; Configuración |
| AC-27 | Reevaluar la misma ronda no crea transición ni cierre duplicado. | La reevaluación no duplica. | Protocolo de ronda |
| AC-28 | Muchas rondas no cambian el modelo ni pausan por conteo de rondas. | Las rondas son un hecho de estancamiento, no de gasto. | Freno duro por gasto |
| AC-29 | Existe un único registro de ejecución por ejecución, con referencias a los cuatro registros y sin sustituirlos. | `run` referencia; no duplica ni reescribe. | Registros de la ejecución |
| AC-30 | Toda escritura se confirma por lectura antes de despachar; sin confirmación no hay despacho. | `record_version` monotónico y confirmación obligatoria. | Registros de la ejecución; Orden de la ejecución |
| AC-31 | En un trabajo sujeto a gate, la señal de inicio es la orden original del desarrollador más el resultado PASS del gate; no se exige una segunda confirmación. | La señal abre la ejecución sin espera rutinaria posterior al gate. | Identidad y señal de inicio; Autonomía por política |
| AC-32 | Cada gate PASS, cada pausa por excepción y cada reanudación dejan exactamente una entrada append-only en `autonomy.decisions`. | El registro de decisiones conserva todas las entradas y no las reescribe. | Decisión de política; Registro de ejecución |
| AC-33 | La autonomía no concede permisos ni sustituye consentimientos; una decisión con `verified: false` no autoriza un permiso de riesgo ni un cierre. | `verified: false` habilita como máximo una pausa. | Decisión de política; Autonomía por política |

## Ejemplos canónicos

| ID | Entrada | Decisión | Pausa o cierre | Efecto en los contadores |
|----|---------|----------|----------------|---------------------------|
| E-01 | Señal de inicio; objetivo documentado; sin ejecución previa; sin tope duro. | `continue` | Ninguna | Ronda 1 despachada; el registro de ejecución queda en `running`. |
| E-02 | Trabajo previo a la señal (material escrito antes del inicio). | `continue` | Ninguna | El trabajo previo no cuenta como ronda; solo alimenta los valores iniciales. |
| E-03 | Ronda 1 con avance verificable y cinco invariantes en `pass`. | `continue` | Ninguna | La instantánea queda confirmada; el contador de rondas sin avance no se incrementa. |
| E-04 | Ronda 2 sin avance verificable, con invariantes en `pass`. | `continue` | Ninguna | El contador de rondas sin avance pasa a 1; la numeración de rondas avanza. |
| E-05 | Ronda 2 con el invariante de alcance violado y evidencia. | `pause` | Pausa de terminación con `reason: invariant_violation` | La instantánea **no** se confirma; no se incrementa ningún contador de avance. |
| E-06 | Bloqueo abierto que requiere decisión de autoridad. | `pause` | Pausa de terminación con `reason: authority_block` | La ronda queda registrada; no se despacha la siguiente. |
| E-07 | Fallo declarado irrecuperable con diagnóstico. | `close` | Cierre con veredicto `external_cause` | Se conservan trabajo, historial y diagnóstico. |
| E-08 | Límite expreso del trabajo alcanzado con efecto declarado de pausa. | `pause` | Pausa de terminación con `reason: explicit_limit` | Se aplica el efecto declarado; no se sustituye. |
| E-09 | Límite expreso del trabajo alcanzado con efecto declarado de cierre. | `close` | Cierre con veredicto `safe_abandonment` | Se conserva el historial y se citan motivo y evidencia. |
| E-10 | Objetivo cumplido con evidencia vigente y dos bloqueos abiertos. | `close` | Cierre con veredicto `success` | Los bloqueos quedan registrados y no impiden el éxito. |
| E-11 | Terminación `continue`; tokens acumulados 520000; tope duro declarado de 500000. | `pause` | Pausa del controlador con `reason: hard_limit` | No se cierra, no se abandona, no se terminan procesos y no se cambia de modelo. |
| E-12 | Terminación `continue`; tokens 520000; sin tope duro; límite blando declarado con aviso. | `continue` | Ninguna; aviso blando visible | Avisa una vez por tope y ejecución; los contadores siguen. |
| E-13 | Terminación `continue`; tokens 520000; sin tope duro; límite blando declarado con pausa. | `pause` | Pausa de presupuesto con `reason: soft_limit_exceeded` | Pausa reversible; el trabajo continúa al reanudar. |
| E-14 | Terminación `continue`; tope duro declarado; registro de gasto ilegible. | `pause` | Pausa del controlador con `reason: record_unavailable` | No se sobrescribe el registro ni se inventa un cero. |
| E-15 | Terminación `continue`; sin tope duro; registro de gasto ilegible. | `continue` | Ninguna; `unavailable` visible | El trabajo continúa en modo degradado y la limitación se declara. |
| E-16 | Terminación `continue`; tope duro declarado; atribución incompleta y una sesión hija no atribuida. | `pause` | Pausa del controlador con `reason: data_unverified` | El gasto no atribuido se informa aparte y no se suma a la ejecución. |
| E-17 | Pausa por tope duro y señal de reanudación sin presupuesto nuevo, sin decisión de autoridad y sin re-definición. | `pause` | La pausa se mantiene | La reanudación se rechaza; el registro no muta. |
| E-18 | Doce rondas seguidas sin cambio de modelo; y luego una señal de inicio nueva después del cierre. | `continue` y luego `continue` | Ninguna en la primera; la segunda abre una ejecución nueva | Las rondas no pausan ni cambian el modelo; la nueva ejecución tiene contadores propios. |
