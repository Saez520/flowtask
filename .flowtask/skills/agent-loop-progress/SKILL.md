---
name: agent-loop-progress
description: >-
  Contrato durable y de solo lectura del progreso verificable por ronda del
  Agent Loop. Define identidad de ejecución, baseline versionado, variables
  observables, evidencia, inicialización, actualización, clasificación,
  persistencia abstracta y consulta.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Agent Loop Progress — Contrato de progreso verificable por ronda

## Propósito

Este contrato define el **registro de progreso** de una ejecución del Agent Loop: el documento durable, único y canónico que registra, ronda por ronda, qué hechos de avance quedaron verificados, con qué evidencia y con qué clasificación.

El registro es la única fuente para consultar el avance de una ejecución. No existen contadores paralelos, resúmenes alternativos ni estimaciones fuera de él.

El contrato produce **hechos y clasificaciones**. No produce decisiones de continuidad: no decide si una ejecución continúa, se interrumpe o concluye, ni cuánto recurso consume. Quien consume el registro lee hechos y decide por separado.

Cada valor del registro debe poder reproducirse a partir de las referencias de evidencia que lo sustentan. La ausencia de evidencia no se rellena con suposiciones: se declara como estado `unknown`.

## Alcance y fronteras

Incluye la identidad de la ejecución y de la ronda, el baseline versionado y sus totales, las cinco familias de variables observables y su derivación, la evidencia citable por valor, la inicialización, la actualización por ronda, la clasificación, la persistencia abstracta, la consulta de solo lectura y el historial completo de instantáneas y revisiones.

**No define condiciones de terminación**, ni límites o reglas de presupuesto, ni la verificación o el cumplimiento de invariantes, ni la idempotencia general de las operaciones, de los reintentos o de la recuperación.

Las fronteras se expresan como exclusiones genéricas:

- No define runtime, controlador, harness ni ciclo de vida ejecutable de una ejecución.
- No define instrumentación automática de la captura de tests o validaciones: se usan las evidencias existentes del flujo.
- No define interfaz, panel, tendencias, comparación entre ejecuciones, retención ni purga.
- No define ponderación entre familias ni un índice compuesto de progreso.
- No define archivos locales, copias de respaldo ni fuentes paralelas al registro.
- No define la continuidad de subagentes ni la reanudación de agentes.
- No mide la novedad de una hipótesis: esa es una precondición de ronda y una condición de continuidad ajenas a este contrato.

El registro no es un checkpoint: no transporta el estado interno de un agente, no habilita la reanudación de subagentes y no suplanta a un mecanismo de estado por subagente.

## Modelo de ejecución y ronda

- **Ejecución**: la instancia del loop que comienza con la señal explícita de inicio para un trabajo ya documentado. Una pausa y su reanudación pertenecen a la misma ejecución.
- **Señal explícita de inicio**: el evento único y explícito que abre la ejecución. Sin esa señal no hay registro ni ronda.
- **work_id**: identificador del trabajo, con la forma `CA-{ID}` o `HF-{slug}`.
- **work_kind**: `ca` o `hotfix`.
- **execution.id**: identificador único de la ejecución, distinto del work ID, con la forma `{work_id}-{YYYYMMDDTHHMMSSZ}` en UTC.
- **execution.status**: `active`, `paused` o `closed`. Es metadata de ciclo de vida y no decide transiciones.
- **Ronda**: el ciclo en que se entrega trabajo, se ejecuta la comprobación aplicable y se obtiene un resultado observado. Una ronda que no llegó a producir un resultado observado no es una ronda funcional completada.
- **Ronda 0**: la ronda de inicialización del registro. No es una ronda funcional.
- **Primera ronda funcional**: la ronda 1.
- **Ronda no observada**: un ciclo sin resultado observado. No se registra como ronda funcional y no altera la numeración.

Una señal de inicio que encuentra una ejecución `active` o `paused` para el mismo work ID reanuda esa ejecución y no crea una nueva. La numeración de rondas es monotónica: no se reinicia al reanudar la ejecución, al cambiar la figura responsable de la inspección, al revisar el plan ni al reasignar el trabajo.

Un nuevo inicio posterior al cierre constituye una ejecución nueva, con registro propio y numeración propia.

## Schema ProgressRecord v1

El registro completo de una ejecución se representa con un único documento. El bloque siguiente es el ejemplo canónico y define la forma del schema: sus valores son de ejemplo y las referencias de baseline son opacas.

```json
{
  "schema": "agent-loop-progress/v1",
  "execution": {
    "id": "CA-ejemplo-20261019T193000Z",
    "work_kind": "ca",
    "work_id": "CA-ejemplo",
    "status": "active"
  },
  "baseline": {
    "version": 1,
    "approved_at": "2026-10-19T19:30:00Z",
    "criteria_source": "baseline://approved/criteria",
    "tasks_source": "baseline://approved/tasks",
    "criteria_total": 2,
    "tasks_total": 2,
    "initial_evidence_origin": ["EV-000"]
  },
  "baseline_history": [],
  "round": {
    "number": 0,
    "state": "initialized",
    "classification": null
  },
  "variables": {
    "criteria": { "met": 0, "total": 2, "state": "known" },
    "tests": { "passed": 0, "executed": 0, "state": "unknown" },
    "blockers": { "resolved": 0, "open": 0, "state": "known" },
    "tasks": { "completed": 0, "total": 2, "state": "known" },
    "rounds_without_verifiable_progress": 0
  },
  "registries": {
    "criteria": [
      { "id": "AC-1", "status": "not_met", "evidence_refs": [] },
      { "id": "AC-2", "status": "not_met", "evidence_refs": [] }
    ],
    "tests": [
      {
        "id": "test-ejemplo",
        "status": "not_run",
        "run_id": null,
        "planned": true,
        "canonical": true
      }
    ],
    "blockers": [],
    "tasks": [
      { "id": "T-1", "status": "incomplete", "evidence_refs": [] },
      { "id": "T-2", "status": "incomplete", "evidence_refs": [] }
    ]
  },
  "test_runs": [],
  "evidence": [
    {
      "id": "EV-000",
      "kind": "initial_state",
      "ref": "sin evidencia previa",
      "round": 0,
      "observed_at": "2026-10-19T19:30:00Z",
      "canonical": true
    }
  ],
  "incidents": [],
  "snapshots": [
    {
      "snapshot_id": "round-000-rev-1",
      "kind": "initialization",
      "round": 0,
      "revision": 1,
      "supersedes": null,
      "revision_reason": null,
      "recorded_at": "2026-10-19T19:30:00Z",
      "baseline_version": 1,
      "variables": {
        "criteria": { "met": 0, "total": 2, "state": "known" },
        "tests": { "passed": 0, "executed": 0, "state": "unknown" },
        "blockers": { "resolved": 0, "open": 0, "state": "known" },
        "tasks": { "completed": 0, "total": 2, "state": "known" },
        "rounds_without_verifiable_progress": 0
      },
      "evidence_ids": ["EV-000"],
      "evidence_state": "sufficient",
      "classification": null,
      "advanced": [],
      "regressed": [],
      "summary": "Inicialización sin evidencia previa."
    }
  ],
  "integrity": {
    "record_version": 1,
    "last_snapshot_id": "round-000-rev-1"
  },
  "created_at": "2026-10-19T19:30:00Z",
  "updated_at": "2026-10-19T19:30:00Z"
}
```

### Bloques del documento

| Bloque | Contenido | Obligatoriedad |
|---|---|---|
| `schema` | Identificador de versión del contrato. | Obligatorio |
| `execution` | Identidad de la ejecución: `id`, `work_kind`, `work_id`, `status`. | Obligatorio |
| `baseline` | Versión vigente del baseline aprobado y sus totales. | Obligatorio |
| `baseline_history` | Historial de versiones de baseline aprobadas. | Obligatorio |
| `round` | Ronda actual (`number`, `state`) y su `classification`. | Obligatorio |
| `variables` | Valores vigentes de las cinco familias. | Obligatorio |
| `registries` | Inventario de criterios, tests, bloqueos y tareas con su estado. | Obligatorio |
| `test_runs` | Corridas de tests observadas. | Obligatorio |
| `evidence` | Referencias de evidencia citable. | Obligatorio |
| `incidents` | Fallos operativos y limitaciones registradas. | Obligatorio |
| `snapshots` | Historial completo de instantáneas y revisiones. | Obligatorio |
| `integrity` | Versión del documento y última instantánea confirmada. | Obligatorio |
| `created_at` | Instante de creación del registro. | Obligatorio |
| `updated_at` | Instante de la última escritura confirmada. | Obligatorio |

### Enums

| Clave | Valores admitidos |
|---|---|
| `execution.work_kind` | `ca` \| `hotfix` |
| `execution.status` | `active` \| `paused` \| `closed` |
| `round.state` | `initialized` \| `completed` |
| `round.classification` | `null` \| `with_verifiable_progress` \| `without_verifiable_progress` \| `not_evaluable` |
| `variables.*.state` | `known` \| `not_applicable` \| `unknown` |
| `registries.criteria[].status` | `not_met` \| `met` |
| `registries.tests[].status` | `not_run` \| `passed` \| `failed` \| `skipped` |
| `registries.blockers[].status` | `open` \| `resolved` |
| `registries.tasks[].status` | `incomplete` \| `completed` |
| `evidence.kind` | `criterion` \| `test_run` \| `test_result` \| `blocker` \| `task` \| `round` \| `initial_state` |
| `snapshot.kind` | `initialization` \| `round` \| `revision` \| `baseline_change` |
| `evidence_state` | `sufficient` \| `partial` \| `insufficient` |
| `incidents[].kind` | `operational_failure` \| `limitation` |

### Formas de los bloques

`baseline_history[]` — una entrada por versión de baseline aprobada, con `version`, `approved_at`, `criteria_source`, `tasks_source`, `criteria_total`, `tasks_total`, `reason` y `recorded_at`.

`test_runs[]` — una entrada por corrida observada, con `id`, `command`, `executed_at`, `planned`, `canonical`, `passed`, `executed` e `interrupted`.

`registries.criteria[]` — una entrada por criterio del baseline vigente, con `id`, `status` (`not_met` \| `met`) y `evidence_refs` (array de `evidence.id`).

`registries.tests[]` — una entrada por test previsto, con `id`, `status` (`not_run` \| `passed` \| `failed` \| `skipped`), `run_id` (id de la corrida o `null`), `planned` y `canonical`.

`registries.blockers[]` — una entrada por bloqueo identificado, con `id`, `status` (`open` \| `resolved`), `cause` (texto o `null`) y `evidence_refs`.

`registries.tasks[]` — una entrada por tarea del baseline vigente, con `id`, `status` (`incomplete` \| `completed`) y `evidence_refs`.

`evidence[]` — una entrada por evidencia observada, con `id`, `kind`, `ref`, `round`, `observed_at` y `canonical`.

`incidents[]` — una entrada por fallo operativo o limitación, con `id`, `kind`, `round` (número de ronda o `null`), `detail` y `observed_at`.

`snapshots[]` — una entrada por instantánea registrada, con `snapshot_id`, `kind`, `round`, `revision`, `supersedes`, `revision_reason`, `recorded_at`, `baseline_version`, `variables`, `evidence_ids`, `evidence_state`, `classification`, `advanced`, `regressed` y `summary`.

`snapshot_id` sigue el formato `round-{NNN}-rev-{R}`: `NNN` es el número de ronda con al menos tres dígitos y `R` es el número de revisión. `revision` comienza en 1. `supersedes` contiene el `snapshot_id` de la revisión anterior o `null` cuando la instantánea no reemplaza a otra. `revision_reason` es obligatorio cuando `revision` es mayor que 1.

`advanced` y `regressed` son arrays de strings con el formato `{familia}:{id}`: `criterion:{id}`, `test:{id}`, `blocker:{id}` o `task:{id}`.

## Variables observables y derivación

El registro expone cinco familias de variables. Cada valor se deriva de los `registries` y de la evidencia; ninguno se declara sin respaldo.

| Nombre del requisito | Clave del schema | Qué expresa |
|---|---|---|
| criterios cumplidos / criterios total | `criteria.met` / `criteria.total` | Criterios del baseline vigente verificados con evidencia citable, y total de criterios de ese baseline. |
| tests que pasan / tests ejecutados | `tests.passed` / `tests.executed` | Tests que pasan en la última corrida completa y comparable, y total ejecutado en esa corrida. |
| bloqueos resueltos / bloqueos abiertos | `blockers.resolved` / `blockers.open` | Bloqueos que dejaron de impedir el avance con evidencia, y bloqueos que siguen impidiéndolo. |
| tareas completadas / tareas total | `tasks.completed` / `tasks.total` | Tareas del baseline vigente con evidencia de finalización, y total de tareas de ese baseline. |
| rondas sin progreso verificable | `rounds_without_verifiable_progress` | Rondas efectivas consecutivas clasificadas `without_verifiable_progress` desde la última ronda `with_verifiable_progress`. |

### Estados de cada familia

Cada familia expone un `state` con tres valores:

| Estado | Significado |
|---|---|
| `known` | El valor es verificable a partir de la evidencia disponible y es reproducible. |
| `not_applicable` | La familia no aplica a esta ejecución. No equivale a cero ni a ausencia de progreso. |
| `unknown` | No hay evidencia suficiente para fijar el valor. No se estima ni se rellena con suposiciones. |

### Reglas de derivación

- `criteria.total` y `tasks.total` solo cambian cuando cambia `baseline.version`. Ningún otro hecho altera los totales.
- `registries.criteria` y `registries.tasks` listan exactamente los criterios y las tareas del baseline vigente; un ítem que no pertenece al baseline no se registra.
- Un criterio o una tarea sin evidencia canónica no cuenta: `criteria.met` y `tasks.completed` solo incluyen ítems con evidencia vigente y citable.
- Un test procedente de una corrida no canónica no actualiza `tests.passed` ni `tests.executed`.
- `not_applicable` no se interpreta como cero: un trabajo sin tests aplicables no se registra como "cero tests ejecutados".
- `unknown` no se completa con estimaciones, inferencias ni declaraciones de intención.
- Si la evidencia que sostenía un valor queda invalidada, el valor disminuye y el retroceso queda registrado como hecho; no se oculta ni se compensa.

### Qué no es progreso

No cuentan como avance: la actividad en general, el tiempo transcurrido, la cantidad de tokens o de mensajes, el volumen de código, la cantidad de intentos, la cantidad de revisiones de inspección convocadas, la cantidad de documentos editados, la cantidad de tests escritos que todavía no pasan, ni la repetición de una descripción de trabajo anterior.

Esos datos pueden pertenecer a la narración operativa o al consumo de recursos, pero no sustituyen evidencia de avance.

## Evidencia

Cada valor del registro se sustenta en referencias de evidencia citable. Una entrada de `evidence` describe `id`, `kind`, `ref`, `round`, `observed_at` y `canonical`.

El `kind` de evidencia es uno de: `criterion`, `test_run`, `test_result`, `blocker`, `task`, `round`, `initial_state`.

El estado de la evidencia de la ronda (`evidence_state`) es:

| Estado | Definición |
|---|---|
| `sufficient` | La evidencia cubre el estado actual de las cuatro familias de progreso y permite afirmar fundadamente que no hubo avance. |
| `partial` | Falta evidencia relevante en al menos una familia que podría contener un avance no detectado. |
| `insufficient` | No es posible fundar una conclusión sobre la ronda. |

Reglas de evidencia:

- Una corrida de tests parcial, interrumpida o no comparable se registra con `canonical: false` como evidencia auxiliar y no actualiza los contadores canónicos.
- Solo los tests previstos por el plan o por el baseline cuentan para declarar avance. Un test nuevo que pasa, agregado fuera de la verificación prevista, no se usa para declarar avance.
- Repetir evidencia ya contabilizada no produce un avance nuevo: una segunda observación de la misma corrida no vuelve a contar.
- Cada valor debe poder reproducirse desde sus referencias: quien lee el registro puede reconstruir el número a partir de la evidencia citada.

## Inicialización

**Precondición**: existe una señal explícita de inicio para un trabajo documentado. Sin esa señal, el trabajo previo no crea registro ni se contabiliza como ronda.

**Resolución del baseline**: para un trabajo de tipo `ca`, el baseline se compone de los criterios de aceptación del trabajo aprobado y de las tareas del plan aprobado. Para un trabajo de tipo `hotfix`, el baseline se compone de las tareas del plan aprobado y la familia de criterios queda en `not_applicable` con `criteria.total` en cero y `criteria.state` en `not_applicable`.

**Reanudación**: si ya existe una ejecución `active` o `paused` para el mismo work ID, se reanuda esa ejecución y no se crea una nueva.

**Creación**: si no existe una ejecución previa, se crea el registro con `execution.id` nuevo, `round.number` en 0 (ronda 0), `baseline.version` en 1, los totales del baseline, los valores iniciales calculados a partir de la evidencia existente en ese momento, `rounds_without_verifiable_progress` en cero y las referencias de la evidencia inicial en `evidence` y `baseline.initial_evidence_origin`.

**Confirmación**: la inicialización se persiste y se confirma por lectura de verificación **antes de despachar la primera ronda**. Si no puede confirmarse, no se inicia la ronda y se reporta un fallo operativo.

La evidencia previa al inicio se refleja en los valores iniciales y se registra como evidencia inicial: no cuenta como avance de la ronda 1. El trabajo previo al inicio no crea registro ni cuenta como ronda.

## Actualización por ronda

Cada ronda funcional completada produce **exactamente una instantánea** de progreso. La instantánea se registra después de observar el resultado de la ronda y **antes de decidir o despachar la siguiente**.

- Los valores se recalculan desde la evidencia acumulada. No se incrementan por suposición, por actividad ni por el hecho de haber ejecutado una ronda.
- La numeración de rondas es monotónica. No se reinicia al reanudar, al cambiar la figura responsable de la inspección, al revisar el plan ni al reasignar el trabajo.
- La instantánea incluye `round`, `recorded_at`, `baseline_version`, los valores de las cinco familias, `evidence_ids`, `evidence_state`, `classification`, `advanced`, `regressed` y un `summary` breve de qué avanzó o retrocedió.
- Al persistir y confirmar la lectura antes de despachar la ronda siguiente, la ronda queda registrada antes de cualquier decisión posterior.

**Revisión de la misma ronda**: si se vuelve a registrar la misma ronda, se conserva su identidad. La nueva entrada incrementa `revision`, apunta `supersedes` al `snapshot_id` de la revisión anterior y declara `revision_reason`. No se crea una ronda nueva, no se duplican valores y la revisión anterior se preserva en el historial.

**Cambio de baseline**: un cambio de baseline dentro del alcance aprobado agrega una entrada a `baseline_history`, incrementa `baseline.version`, actualiza los totales, recalcula los valores y registra una instantánea con `kind: baseline_change`. Ese cambio no incrementa la ronda, no cuenta como progreso y no reinicia ni incrementa `rounds_without_verifiable_progress`.

**Fallo operativo**: un fallo que impide observar el resultado de la ronda no es una ronda funcional. Se registra en `incidents` con `round: null` o la ronda en curso, no incrementa `round.number` ni `rounds_without_verifiable_progress` y no se interpreta como aprobación ni como avance.

## Clasificación de ronda

El algoritmo de clasificación es determinístico y se aplica en este orden:

1. Comparar los hechos actuales contra la última instantánea confirmada.
2. Determinar los avances verificados: un criterio que pasa de `not_met` a `met`; un test que fallaba y pasa en una corrida canónica completa y comparable; un bloqueo que pasa de `open` a `resolved`; una tarea que pasa de `incomplete` a `completed`.
3. Si hay al menos un avance verificado, la ronda se clasifica `with_verifiable_progress` y el contador vuelve a cero.
4. Si no hay avance verificado y `evidence_state` es `sufficient`, la ronda se clasifica `without_verifiable_progress` y el contador aumenta en uno.
5. Si no hay avance verificado y `evidence_state` es `partial` o `insufficient`, la ronda se clasifica `not_evaluable` y el contador no cambia.
6. Los retrocesos —un criterio que pasa de `met` a `not_met`, un test que pasa y deja de pasar, un bloqueo que pasa de `resolved` a `open`, una tarea que pasa de `completed` a `incomplete`— se registran en `regressed` y no cuentan como avance.
7. Una ronda con avance verificado y con retroceso se clasifica `with_verifiable_progress`. Ambos hechos quedan visibles: el avance en `advanced` y el retroceso en `regressed`.
8. La repetición de evidencia ya contabilizada no es un avance nuevo.

El contador `rounds_without_verifiable_progress` cuenta las rondas efectivas consecutivas clasificadas `without_verifiable_progress` desde la última ronda `with_verifiable_progress`. Las rondas `not_evaluable` no cortan ni incrementan la secuencia. La clasificación `not_evaluable` no modifica el contador: no reinicia ni incrementa.

## Persistencia

El contrato de persistencia es abstracto: define el comportamiento exigido, no el mecanismo.

- Un **documento durable único** por ejecución, identificado por `execution.id`. La unicidad se garantiza por esa identidad.
- Cada escritura reemplaza el documento completo e incluye el array completo `snapshots`. El historial completo no se trunca.
- La escritura se confirma con una **lectura de verificación** de `integrity.record_version` e `integrity.last_snapshot_id` antes de despachar la ronda siguiente. Si la versión confirmada no coincide con la escrita, la escritura falla como fallo operativo y no se sobrescribe el documento.
- Un fallo de persistencia no se considera registrado: se conserva la última instantánea confirmada y se informa el fallo operativo sin anunciar progreso.
- Como respaldo del registro no se usan archivos locales ni fuentes paralelas. La indisponibilidad del mecanismo durable se trata como fallo operativo.
- El binding concreto —medio, ubicación, namespace, owner y operaciones— lo define la implementación que integre este contrato. Este documento no lo declara.
- El historial se conserva durante toda la ejecución. Este contrato no define purga ni retención posterior.

## Consulta de solo lectura

La consulta se dirige por `execution.id` y devuelve la última instantánea confirmada, los valores vigentes de las cinco familias, el historial completo y, cuando se pide, una ronda determinada.

| Situación | Respuesta |
|---|---|
| No existe registro para esa ejecución | `sin registro` |
| El registro existe pero no puede leerse o parsearse | `no disponible` |
| El registro contradice las reglas de coherencia del contrato | `contradictorio` |

El registro se considera contradictorio cuando el `execution.id` no coincide con el consultado, `integrity.record_version` no es monotónica, existen `snapshot_id` duplicados, `integrity.last_snapshot_id` no coincide con el último snapshot o los conteos de `variables` no derivan de los `registries`.

La consulta es de **solo lectura**: nunca escribe ni **no modifica** valores, clasificaciones, evidencia ni numeración. Los consumidores de decisión leen el registro como insumo y no escriben en él.

Ninguna de las respuestas anteriores se interpreta como cero progreso ni como ausencia de avance. Si la resolución de la ejecución activa por work ID es ambigua, la consulta informa `no disponible` y no elige por conveniencia.

## Reanudación y fallos

**Reanudación**: se restaura la última instantánea confirmada, conservando la numeración de rondas y el valor vigente de `rounds_without_verifiable_progress`. Una reanudación no reinicializa el registro ni pone el contador en cero.

**Nuevo inicio**: un nuevo inicio posterior al cierre constituye una ejecución nueva, con registro, numeración y contador propios.

**Registro ausente, ilegible o contradictorio**: no se inventan valores, no se reinician contadores a cero y no se habilita una decisión de progreso basada en datos no verificados. Se conserva la última información confirmada disponible y se informa la limitación operativa.

**Fallo de persistencia**: la actualización no se considera registrada, se conserva la última instantánea confirmada y se informa el fallo operativo sin anunciar progreso.

**Fallo operativo de la ronda**: se registra en `incidents` con `kind: operational_failure` o `kind: limitation`. No es una ronda funcional: no incrementa `round.number` ni el contador de estancamiento.

En ningún caso se usan archivos locales ni fuentes paralelas para suplentar un registro ausente o ilegible.

## Garantías del contrato

1. **Un registro por ejecución**: cada `execution.id` tiene exactamente un documento durable.
2. **Fuente única**: el registro es la única fuente del avance; no hay contadores paralelos ni resúmenes alternativos.
3. **Numeración monotónica**: `round.number` solo crece dentro de una ejecución.
4. **Ronda 0 de inicialización**: la inicialización es la ronda 0 y la primera ronda funcional es la ronda 1.
5. **Una instantánea por ronda**: cada ronda funcional completada produce exactamente una instantánea; las revisiones de la misma ronda preservan la anterior.
6. **Valores derivados**: los valores de `variables` se derivan de `registries` y de la evidencia; no hay estimaciones.
7. **Totales estables**: `criteria.total` y `tasks.total` solo cambian con `baseline.version`.
8. **Clasificación determinista**: la clasificación y el contador se calculan con el algoritmo de la sección de clasificación, sin criterio subjetivo.
9. **Fallos operativos fuera de la numeración**: un fallo operativo no es una ronda ni un avance.
10. **Historial completo y escritura confirmada**: el historial no se trunca y cada escritura se confirma por lectura de verificación.
11. **Consulta de solo lectura**: consultar nunca modifica el registro.
12. **Determinismo**: con los mismos hechos y mismo baseline, dos reconstrucciones producen los mismos valores, las mismas clasificaciones y las mismas referencias de evidencia.

## Matriz de aceptación

Cada fila declara la regla aplicable y la sección del contrato que la contiene.

| ID | Regla | Sección |
|---|---|---|
| AC-01 | Con señal explícita de inicio, existe un registro confirmado antes de la primera ronda, con baseline, totales, valores iniciales y contador en cero. | Inicialización |
| AC-02 | Sin señal explícita de inicio, el trabajo previo no crea registro ni se contabiliza como ronda. | Inicialización |
| AC-03 | Si al inicio ya hay evidencia previa, los valores iniciales la reflejan y esa evidencia no cuenta como avance de la ronda 1. | Inicialización |
| AC-04 | Un criterio que pasa de no verificado a verificado con evidencia citable aumenta `criteria.met` en exactamente ese criterio, y `criteria.total` no cambia sin una nueva versión de baseline. | Variables observables y derivación |
| AC-05 | Un criterio previamente cumplido cuya evidencia queda invalidada disminuye `criteria.met`, registra el retroceso y no cuenta como avance. | Clasificación de ronda |
| AC-06 | Un test que fallaba y pasa en una corrida completa y comparable se refleja en `tests.passed` y `tests.executed`, con una referencia que identifica la ejecución de los tests. | Evidencia |
| AC-07 | Una corrida parcial, interrumpida o no comparable deja los contadores canónicos sin cambios y queda registrada como evidencia auxiliar. | Evidencia |
| AC-08 | Un trabajo sin tests aplicables informa `not_applicable` y no usa el valor cero. | Variables observables y derivación |
| AC-09 | Un bloqueo abierto que deja de impedir el avance con evidencia aumenta `blockers.resolved` y disminuye `blockers.open`; evitarlo o ignorarlo no cuenta como resolución. | Variables observables y derivación |
| AC-10 | Un bloqueo nuevo aumenta `blockers.open` y no cuenta como avance. | Variables observables y derivación |
| AC-11 | Una tarea completada con evidencia aumenta `tasks.completed`; una marca de completada sin evidencia no modifica el valor. | Variables observables y derivación |
| AC-12 | Una ronda con al menos un avance verificado se clasifica `with_verifiable_progress` y el contador vuelve a cero. | Clasificación de ronda |
| AC-13 | Una ronda con solo actividad, repetición de cambios o tests escritos que no pasan, y con evidencia suficiente, se clasifica `without_verifiable_progress` y el contador aumenta en uno. | Clasificación de ronda |
| AC-14 | Una ronda sin evidencia relevante se clasifica `not_evaluable`, el contador no aumenta ni se reinicia y la limitación queda registrada. | Clasificación de ronda |
| AC-15 | Un fallo operativo que impide observar el resultado no incrementa `round.number` ni el contador, y queda registrado como incidente. | Reanudación y fallos |
| AC-16 | Una ejecución reanudada restaura la última instantánea confirmada, la numeración continúa y el contador no se reinicia. | Reanudación y fallos |
| AC-17 | Un registro ausente, ilegible o contradictorio no permite inventar valores ni reiniciar el contador a cero: se informa la limitación y se conserva la última información confirmada. | Consulta de solo lectura |
| AC-18 | Un cambio de baseline crea una nueva versión con los nuevos totales, preserva el historial anterior y no cuenta como progreso. | Actualización por ronda |
| AC-19 | Volver a registrar la misma ronda no crea una ronda nueva ni duplica valores: queda como revisión con la revisión anterior preservada. | Actualización por ronda |
| AC-20 | Un fallo al persistir deja la actualización sin registrar, conserva la última instantánea confirmada e informa el fallo operativo sin anunciar progreso. | Persistencia |
| AC-21 | Una consulta de solo lectura recupera instantánea e historial sin cambiar valores, clasificaciones ni numeración. | Consulta de solo lectura |
| AC-22 | Una ronda con avance verificado y con retroceso registra ambos por separado, se clasifica `with_verifiable_progress` y el retroceso permanece visible en los valores actuales. | Clasificación de ronda |
| AC-23 | Dados los mismos hechos y el mismo baseline, dos reconstrucciones obtienen los mismos resultados y las mismas referencias de evidencia. | Garantías del contrato |
| AC-24 | Los consumidores de decisión leen hechos y referencias sin que el registro decida la continuidad de la ejecución ni el consumo de recursos, y sin que esas decisiones modifiquen el registro. | Garantías del contrato |

## Ejemplos canónicos

| ID | Entrada | Valores esperados | Clasificación | `advanced` / `regressed` | Efecto en el contador |
|---|---|---|---|---|---|
| E-01 | El criterio `AC-1` pasa de `not_met` a `met` con evidencia citable. | `criteria.met` 1 → 2; `criteria.total` sin cambios. | `with_verifiable_progress` | `advanced: ["criterion:AC-1"]` | Vuelve a 0 |
| E-02 | La ronda solo aporta actividad: reescritura de un diagnóstico y un test escrito que todavía no pasa. | Sin cambios en las cinco familias. | `without_verifiable_progress` | `advanced: []` | Aumenta en 1 |
| E-03 | Falta evidencia relevante de una de las familias y no se detecta avance. | Sin cambios; `evidence_state: partial`. | `not_evaluable` | `advanced: []` | Sin cambios |
| E-04 | El test previsto `test-ejemplo` falla y pasa en una corrida canónica completa y comparable. | `tests.passed` 0 → 1; `tests.executed` 1. | `with_verifiable_progress` | `advanced: ["test:test-ejemplo"]` | Vuelve a 0 |
| E-05 | La corrida de tests se interrumpe y no es comparable. | `tests.passed` y `tests.executed` sin cambios; corrida registrada con `canonical: false`. | `not_evaluable` | `advanced: []` | Sin cambios |
| E-06 | El bloqueo `B-1` pasa de `open` a `resolved` con evidencia. | `blockers.resolved` 0 → 1; `blockers.open` 1 → 0. | `with_verifiable_progress` | `advanced: ["blocker:B-1"]` | Vuelve a 0 |
| E-07 | Aparece un bloqueo nuevo `B-2` que impide avanzar. | `blockers.open` 1 → 2; `blockers.resolved` sin cambios. | `without_verifiable_progress` | `advanced: []` | Aumenta en 1 |
| E-08 | Una tarea se marca como completada pero sin evidencia de resultado. | `tasks.completed` sin cambios; la tarea sigue `incomplete`. | `without_verifiable_progress` | `advanced: []` | Aumenta en 1 |
| E-09 | Se aprueba una nueva versión del baseline con otros totales. | `baseline.version` 1 → 2; `baseline_history` con una entrada; `criteria.total` y `tasks.total` recalculados; instantánea con `kind: baseline_change`; `round.number` sin cambios. | No se clasifica: no es una ronda funcional | `advanced: []` | Sin cambios: no reinicia ni incrementa |
| E-10 | Se vuelve a registrar la ronda 1 con una corrección. | Instantánea `round-001-rev-2` con `supersedes: "round-001-rev-1"` y `revision_reason`; `round.number` sigue en 1; la revisión anterior se preserva. | `with_verifiable_progress` (recalculada) | `advanced: ["criterion:AC-1"]` | Vuelve a 0 |
| E-11 | La consulta apunta a una ejecución sin registro. | Respuesta `sin registro`; ningún valor inventado y ningún contador reiniciado. | No aplica: no hay ronda | `advanced: []` | Sin cambios |
| E-12 | Se consulta la última instantánea confirmada y el historial. | Valores, clasificaciones, numeración e historial idénticos antes y después de la consulta. | No aplica: la consulta no clasifica | `advanced: []` | Sin cambios |
| E-13 | En la misma ronda, `AC-2` se cumple y la evidencia de `AC-1` queda invalidada. | `criteria.met` refleja el nuevo estado; el retroceso queda visible en los valores actuales. | `with_verifiable_progress` | `advanced: ["criterion:AC-2"]` / `regressed: ["criterion:AC-1"]` | Vuelve a 0 |
| E-14 | Un fallo operativo impide observar el resultado de la ronda. | `round.number` sin cambios; incidente registrado con `kind: operational_failure`; `rounds_without_verifiable_progress` sin cambios. | No aplica: no es una ronda funcional | `advanced: []` | Sin cambios |
