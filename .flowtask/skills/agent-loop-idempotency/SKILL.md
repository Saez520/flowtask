---
name: agent-loop-idempotency
description: >-
  Contrato de idempotencia para el loop y el Constructor: identidad estable de
  operación, constancias confirmadas por fase, reintentos controlados,
  reanudación sin duplicar efectos y tratamiento de efectos externos inciertos.
  Cargar al iniciar o reanudar una ejecución con efectos observables.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Idempotencia del Loop — Repetir sin duplicar efectos

## Propósito

Este contrato define cómo el Runner y el Constructor repiten una operación sin duplicar su efecto. Cada operación con efecto observable tiene una identidad estable; cada fase deja una constancia durable de lo confirmado; reintentar o reanudar continúa desde lo último confirmado.

Los dos actores que quedan bajo este contrato son:

- **Runner** — orquesta el loop: intake, dispatch, collect, validate, decide, integrate y close.
- **Constructor** — da continuidad a su trabajo por fases. Solo opera con identidad válida y constancia restaurable; una identidad ausente o una constancia ilegible detienen el trabajo en lugar de habilitar un sustituto.

Repetir una operación con la misma identidad nunca produce un efecto adicional: el sistema la reconoce como el mismo trabajo, reutiliza su evidencia y devuelve `already_confirmed`.

Este contrato no define qué se mide como avance, cuándo detenerse, qué reglas siempre se cumplen, cuánto recurso puede consumirse, cómo se modela la ejecución completa ni ningún producto generalista. Cada uno de esos aspectos tiene su propio contrato, paralelo a este.

## Cuándo se carga

| Actor | Momento de carga |
|-------|------------------|
| Runner | Antes de `runner.intake`, antes de cada fase con efecto observable, antes de un reintento y al reanudar una ejecución. |
| Constructor | Al iniciar su trabajo, antes de cada efecto no idempotente y al reanudar. |

Las consultas de solo lectura que no avanzan una fase no requieren una operación propia. Si una consulta alimenta una confirmación, se registra como evidencia de esa operación y no como una operación independiente.

## Fronteras

- No reemplaza `checkpoint-mixin` ni es un `CheckpointPayload`: el ledger de idempotencia y el checkpoint de agente son estructuras distintas con ciclos de vida distintos.
- No habilita por sí mismo la continuidad de un subagente: la reanudación del Constructor sigue exigiendo identidad de sesión y checkpoint restaurable según su propio contrato.
- No escribe en el registro de progreso, no lo redefine y no deriva identidades que ese registro no exponga.
- No modifica `runner.md`, `constructor.md`, `memory-contract`, `topic-keys-convention` ni `checkpoint-mixin`.
- No implementa runtime, hooks, scripts ni tests ejecutables: el contrato es documental y normativo.
- No cubre concurrencia simultánea, deduplicación distribuida, locks, consenso ni transacciones globales.
- No cubre retención, purga, métricas, tendencias ni comparación entre ejecuciones.
- No define el controlador de ejecución, el presupuesto, la terminación, los invariantes del producto ni el modelo de ejecución completa.

## Modelo conceptual

| Concepto | Definición |
|----------|------------|
| **Ejecución** | Un intento de llevar un trabajo hasta su cierre, con identidad propia (`execution.id`). Una ejecución terminada y cerrada no se reutiliza: la siguiente corre con identidad nueva. |
| **Operación** | Una unidad de trabajo con efecto observable dentro de una ejecución. Es la unidad a la que se aplica la identidad estable y la constancia. |
| **Fase** | El tipo de operación, identificado por `phase_id` dentro del catálogo canónico. Determina la clase de efecto, el verificador y la exigencia de constancia. |
| **Unidad lógica** | La porción estable y derivada del trabajo que una operación cubre: una ronda, una tarea del plan, un subpaso, un commit a integrar o una fase única. Es parte de la identidad. |
| **Intento** | La ejecución física de la operación. Un reintento incrementa `attempt.number`; nunca cambia la unidad lógica ni la identidad. |
| **Efecto** | Lo que la operación produce en el exterior: una escritura, un despacho, una integración, una transición de estado. Se clasifica en idempotente, no idempotente o incierto. |
| **Constancia** | El registro durable que declara qué operación quedó confirmada, en qué fase, con qué efecto y con qué evidencia. Es lo único que habilita a continuar. |
| **Evidencia** | La observación que respalda una confirmación: un SHA, un hash de contenido, el resultado de una corrida, una referencia de artifact o de instancia, una decisión humana. |
| **Confirmación** | El paso por el que una operación pasa a `confirmed`: se verifica el efecto con su verificador, se registra la evidencia y se confirma el guardado de la constancia. |
| **Reanudación** | Retomar una ejecución interrumpida desde la última constancia confirmada, sin reiniciar numeración ni repetir efectos confirmados. |

Distinción esencial: el **intento físico** (`attempt.number`) y la **unidad lógica** (`logical_unit`) son cosas distintas. Reintentar incrementa el intento; la unidad lógica permanece igual porque describe *qué* trabajo se está haciendo, no *cuántas veces* se intentó.

## Identidad de operación

Formato canónico:

```text
operation_id = "{work_id}:{execution_id}:{phase_id}:{logical_unit}"
```

Reglas:

- **`work_id`**: `CA-{ID}` para un trabajo de requisito o `HF-{slug}` para un hotfix. `work_kind` es `ca` o `hotfix`.
- **`execution_id`**: `{work_id}-{YYYYMMDDTHHMMSSZ}` en UTC. Si existe un registro de progreso que exponga `execution.id`, ese valor se reutiliza; si no existe, el Runner lo crea en `runner.intake`. El identificador no cambia entre reintentos, reanudaciones, cambios de instancia ni revisiones de plan.
- **`phase_id`**: uno de los valores del catálogo canónico de la sección siguiente.
- **`logical_unit`**: `round-{NNN}` para rondas, `task-{NN}` para tareas del plan, `step-{NN}` para subpasos, `commit-{12-hex}` para la integración de un commit y `single-1` para fases únicas. Es un valor estable derivado del trabajo, no un contador aleatorio: no se usan identificadores aleatorios, marcas de tiempo como identidad ni contadores no persistidos.
- **Cada componente** cumple `[a-z0-9][a-z0-9._-]*`. Si un componente contiene `:`, la identidad se rechaza con `identity_unavailable`: no se normaliza ni se recorta.
- **El número de intento no forma parte de la identidad.** Un reintento conserva el mismo `operation_id`; solo incrementa `attempt.number` y `retry.count`.
- **Dos operaciones con distinto `phase_id` o distinta `logical_unit` son operaciones distintas**, aunque su efecto observable se parezca. No comparten identidad ni evidencia.

Ejemplos:

| Caso | `operation_id` | `phase_id` | `logical_unit` |
|------|----------------|------------|----------------|
| Operación de Runner | `CA-ejemplo:CA-ejemplo-20261020T001500Z:runner.dispatch:round-001` | `runner.dispatch` | `round-001` |
| Operación de Constructor | `CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.commit:task-02` | `constructor.commit` | `task-02` |
| Integración por commit | `CA-ejemplo:CA-ejemplo-20261020T001500Z:runner.integrate:commit-3f2a1b9c4d5e` | `runner.integrate` | `commit-3f2a1b9c4d5e` |

## Catálogo de fases

Catálogo canónico de fases. `Clase` describe la naturaleza del efecto; `Constancia` indica si la fase exige una constancia confirmada antes de avanzar.

| Actor | `phase_id` | Efecto observable | Clase | Verificador | Unidad lógica | Depende de | Constancia |
|-------|------------|-------------------|-------|-------------|---------------|------------|------------|
| Runner | `runner.intake` | crear el ledger de la ejecución | idempotente | lectura de verificación del ledger (`schema`, `execution.id`, `record_version`) | `single-1` | — | sí |
| Runner | `runner.dispatch` | despachar una ronda o agente | no idempotente | `flow-state/{work_id}/instances`: `task_id` no nulo y `last_resume >= attempt.started_at` | `round-{NNN}` | `runner.intake` y ronda anterior integrada | sí |
| Runner | `runner.collect` | leer el resultado de la ronda | idempotente de solo lectura | referencia del resultado | `round-{NNN}` | `runner.dispatch` y `constructor.report` de la misma ronda | no; evidencia para `runner.decide` |
| Runner | `runner.validate` | despachar la validación | no idempotente | instancia o resultado del validador con `task_id` y timestamp | `round-{NNN}` | `runner.collect` | sí |
| Runner | `runner.decide` | registrar el veredicto | idempotente por identidad | referencia al veredicto | `round-{NNN}` | `runner.validate` | sí |
| Runner | `runner.integrate` | integrar un commit validado | no idempotente | `git merge-base --is-ancestor {commit} {base}` | `commit-{12-hex}` | `runner.decide` aprobado | sí |
| Runner | `runner.close` | cerrar la ejecución | no idempotente por transición de estado | estado de cierre consultable | `single-1` | `runner.integrate` y veredicto final | sí |
| Constructor | `constructor.prepare` | crear o reutilizar worktree y rama | no idempotente | `git worktree list --porcelain` contiene path y branch | `single-1` | `runner.dispatch` | sí |
| Constructor | `constructor.implement` | escribir o modificar artifacts del plan | no idempotente | hash de contenido de cada artifact o `git diff` esperado | `task-{NN}` | `constructor.prepare` y tarea anterior confirmada | sí |
| Constructor | `constructor.verify` | ejecutar verificación o tests | idempotente de solo lectura, ligado al hash del árbol | resultado de la corrida y hash del árbol | `task-{NN}` | `constructor.implement` | no; evidencia para `constructor.commit` |
| Constructor | `constructor.commit` | crear commit local | no idempotente | `git rev-parse HEAD` o SHA esperado y árbol limpio | `task-{NN}` | `constructor.verify` | sí |
| Constructor | `constructor.report` | reportar al Runner | no idempotente | referencia de reporte o checkpoint del Constructor | `round-{NNN}` | todos los `constructor.commit` de la ronda | sí |

**Orden de fases.** Runner: `intake → dispatch → collect → validate → decide → integrate → close`. Constructor: `prepare → implement → verify → commit → report`.

La siguiente operación pendiente es la primera del orden del actor cuyas `depends_on` estén todas confirmadas. Una fase está confirmada cuando todas sus operaciones requeridas están confirmadas.

Las fases de solo lectura (`runner.collect` y `constructor.verify`) no crean una operación de efecto: aportan evidencia a la operación que las consume.

El catálogo es extensible: una fase nueva debe declarar su clase de efecto y su verificador. Una fase no listada no puede produzir un efecto no idempotente sin verificador declarado.

## Política configurable

| Clave | Valores | Regla |
|-------|---------|-------|
| `policy.profile` | `development` (por defecto) o `production` | Perfil de la ejecución. |
| `policy.max_retries_per_phase` | `2` en `development`, `3` en `production` | Máximo de reintentos por fase ante fallo operativo. |
| `policy.backoff_ms` | `[250, 500, 1000, 2000]` | Espera entre reintentos en milisegundos, sin jitter. Se usa el índice del reintento y el tope es 2000 ms. |
| `policy.confirmation_required` | sí para toda fase con efecto observable; no para `runner.collect` ni `constructor.verify` | Qué fases exigen constancia confirmada antes de avanzar. |

La política se fija en `runner.intake` y no cambia durante la ejecución. Cambiar de perfil exige una ejecución nueva.

## Clases de efecto y tratamiento

| Clase | Acciones | Tratamiento |
|-------|----------|-------------|
| Idempotente | consultar estado, leer la última constancia, re-registrar la misma operación con la misma identidad y evidencia, confirmar una operación ya confirmada | Se pueden repetir sin riesgo: devuelven lo ya confirmado sin crear un efecto nuevo. |
| No idempotente | integrar, publicar, notificar, escribir un artifact nuevo, despachar, mover el estado de una fase a la siguiente | Solo se ejecutan si la constancia demuestra que aún no están confirmadas para esa identidad. |
| Incierto | caída a mitad de un efecto externo sin confirmación | Se verifica antes de decidir; si no se puede verificar, el flujo se detiene y no se repite a ciegas. |

**Protocolo de incertidumbre (cuatro pasos).**

1. Verificar por consulta: leer el estado real del efecto con su verificador.
2. Si el efecto ocurrió, registrar la operación como `confirmed` y no repetirlo.
3. Si el efecto no ocurrió, ejecutarlo una vez con la misma identidad.
4. Si no se puede verificar, detenerse y reportar `uncertain_external_effect_unresolved` con la identidad y la evidencia disponible, sin repetir a ciegas.

**Prohibición.** No se reintenta un efecto no idempotente sin verificador declarado. Un efecto no idempotente sin verificador no puede salir del estado `uncertain`: se mantiene detenido hasta que exista una forma de verificarlo.

## Schema IdempotencyRecord v1

Payload canónico completo. Se escribe en una sola observación de Engram y se reescribe íntegro en cada actualización.

```json
{
  "schema": "agent-loop-idempotency/v1",
  "execution": {
    "id": "CA-ejemplo-20261020T001500Z",
    "work_id": "CA-ejemplo",
    "work_kind": "ca",
    "status": "active",
    "started_at": "2026-10-20T00:15:00Z"
  },
  "policy": {
    "profile": "development",
    "max_retries_per_phase": 2,
    "backoff_ms": [250, 500, 1000, 2000],
    "backoff_cap_ms": 2000
  },
  "operations": [
    {
      "operation_id": "CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.commit:task-02",
      "phase_id": "constructor.commit",
      "actor": "constructor",
      "logical_unit": "task-02",
      "depends_on": [
        "CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.verify:task-02"
      ],
      "effect": {
        "class": "non_idempotent",
        "description": "create the local commit for task 02",
        "verifier": {
          "kind": "git_commit",
          "ref": "HEAD",
          "expected": "HEAD == 3f2a1b9c4d5e6f708192a3b4c5d6e7f8091a2b3c"
        }
      },
      "state": "confirmed",
      "attempts": [
        {
          "number": 1,
          "started_at": "2026-10-20T00:30:00Z",
          "ended_at": "2026-10-20T00:31:00Z",
          "outcome": "confirmed",
          "note": null
        }
      ],
      "retry": {
        "count": 0,
        "next_at": null,
        "exhausted": false
      },
      "confirmation": {
        "confirmed_at": "2026-10-20T00:31:00Z",
        "evidence": [
          {
            "id": "EV-001",
            "kind": "git_commit",
            "ref": "3f2a1b9c4d5e6f708192a3b4c5d6e7f8091a2b3c",
            "observed_at": "2026-10-20T00:31:00Z",
            "canonical": true
          }
        ],
        "summary": "Commit local creado y verificado."
      },
      "resume": {
        "count": 0,
        "last_resumed_at": null
      }
    }
  ],
  "uncertain_effects": [],
  "integrity": {
    "record_version": 3,
    "last_operation_id": "CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.commit:task-02",
    "last_phase_id": "constructor.commit",
    "last_writer": "constructor",
    "last_write_at": "2026-10-20T00:31:00Z",
    "last_confirmed_operation_id": "CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.commit:task-02",
    "last_confirmed_at": "2026-10-20T00:31:00Z"
  },
  "created_at": "2026-10-20T00:15:00Z",
  "updated_at": "2026-10-20T00:31:00Z"
}
```

**Campos top-level**: `schema`, `execution`, `policy`, `operations`, `uncertain_effects`, `integrity`, `created_at`, `updated_at`.

**Enums.**

| Enum | Valores |
|------|---------|
| `state` (operación) | `pending`, `in_progress`, `confirmed`, `failed`, `rejected`, `uncertain`, `blocked` |
| `attempts[].outcome` | `confirmed`, `operational_failure`, `interruption`, `functional_rejection`, `verification_failed`, `uncertain` |
| `effect.class` | `idempotent`, `non_idempotent` |
| `uncertain_effects[].state` | `pending_verification`, `confirmed_present`, `confirmed_absent`, `unresolvable` |
| `execution.status` | `active`, `paused`, `closed` |
| `evidence.kind` | `git_ref`, `git_commit`, `file_hash`, `test_run`, `artifact_ref`, `instance_ref`, `progress_ref`, `command_output`, `human_decision` |

## Persistencia y confirmación

**Medio y namespace.** Una única observación de Engram con `type: "decision"`, `scope: "project"`, `topic_key: "flow-state/{execution_id}/idempotency"` y título `Idempotency ledger — {execution_id}`. Ese namespace es propio de este contrato: lo escriben el Runner y el Constructor de forma secuencial por ejecución, y lo leen el Runner, el Constructor, el Validator y el Inspector. No se usan archivos locales ni fuentes paralelas.

**Leer antes de escribir.** `mem_search(query: "flow-state/{execution_id}/idempotency", type: "decision", scope: "project")` y luego `mem_get_observation(id)` sobre el resultado.

**Creación.** Si el ledger no existe y la ejecución es nueva, `runner.intake` lo crea con `record_version: 1`. Si existe, se fusiona; nunca se recrea. No se crea un ledger nuevo para una ejecución en curso.

**Escritura.** Cada actualización reescribe el payload completo e incrementa `record_version` en 1. El historial no se trunca.

**Confirmación de persistencia.** Una escritura solo se considera guardada cuando una lectura de verificación posterior coincide en `schema`, `execution.id`, `integrity.record_version` e `integrity.last_operation_id`. Si no coincide, no se avanza: se reporta `persistence_unconfirmed` y se conserva `last_confirmed_operation_id`.

**Registro ausente, ilegible o contradictorio.** Se reporta `record_unavailable` o `record_contradictory`. No se inventa estado, no se reinician conteos y no se avanza sobre datos no verificados.

**Contradicciones detectadas.**

- `execution.id` distinto del esperado.
- `record_version` no monotónica.
- `operation_id` duplicado con distinta fase o distinta unidad lógica.
- `last_confirmed_operation_id` que no existe en `operations`.
- Más de un ledger activo para el mismo `work_id`.
- `last_writer` incompatible con el estado de la última operación.

**Escritura concurrente.** Antes de escribir, el actor compara `integrity.last_writer` y el estado de la última operación. Si sospecha una escritura concurrente, se detiene con `concurrent_write_suspected` y no sobrescribe. La deduplicación en carrera simultánea queda fuera de alcance.

**Degradación sin Engram.** Si el proveedor de memoria no está disponible, se sigue el contrato de memoria compartido: detener, informar y no persistir en archivos locales ni fuentes paralelas.

**Consumo de progreso.** El registro de progreso es un insumo de solo lectura cuando existe. Esta skill no escribe en él, no lo redefine y no deriva de él identidades que el propio registro no exponga.

## Protocolo de ejecución

1. **Resolver la identidad.** Calcular `work_id`, `execution_id`, `phase_id` y `logical_unit`. Si un componente es inválido o contiene `:`, detenerse con `identity_unavailable`.
2. **Leer el ledger.** Si no existe, no puede leerse o es contradictorio, detenerse con `record_unavailable` o `record_contradictory`.
3. **Si la operación está confirmada**, reutilizar su evidencia y devolver `already_confirmed` sin ejecutar el efecto.
4. **Si la operación está incierta**, aplicar el protocolo de cuatro pasos de la sección de clases de efecto.
5. **Si falló por causa operativa y quedan reintentos**, esperar el backoff y ejecutar solo lo pendiente de esa fase.
6. **Si la operación no existe**, registrar la intención con estado `in_progress` y el intento 1.
7. **Ejecutar el efecto.**
8. **Verificar** con el verificador declarado para la fase.
9. **Registrar la confirmación** con la evidencia observada.
10. **Escribir y confirmar la persistencia** mediante una lectura de verificación.
11. **Avanzar** solo después de ese paso.

Un fallo funcional o de verificación cierra la unidad lógica como `rejected` o `failed` y no se reintenta como idempotencia: el rework abre una unidad lógica nueva.

## Reintentos

- Solo un `operational_failure` o una `interruption` habilitan un reintento. Un `functional_rejection` o un `verification_failed` no son reintentos: siguen su propio flujo de revisión y de rework.
- Máximo: 2 reintentos por fase en `development`, 3 en `production`.
- Espera entre reintentos: `250`, `500`, `1000`, `2000` ms, sin jitter, con tope de 2000 ms. Se usa el índice del reintento.
- Antes de reintentar, se verifica que el efecto no esté confirmado. Si lo está, no se reintenta: se reutiliza la evidencia.
- El reintento conserva `operation_id` y `logical_unit`, e incrementa `attempt.number` y `retry.count`.
- Al agotar los reintentos: estado `blocked`, `retry.exhausted: true` y reporte `retry_exhausted`. No se reintenta hasta una instrucción explícita o una ejecución nueva.
- Si el guardado de la constancia falla, el reintento no se considera registrado: se conserva lo último confirmado y se informa el fallo operativo.

## Reanudación

1. **Resolver `execution_id`** desde el contexto inyectado.
2. **Si falta**, buscar ledgers por `work_id` y exigir exactamente uno en estado `active` o `paused`. Cero candidatos → `no_resumable_execution`. Más de uno → `ambiguous_execution`.
3. **Restaurar** la última operación confirmada, con su evidencia.
4. **Continuar** por la primera operación pendiente cuyas dependencias estén confirmadas.
5. **No reiniciar** fases, unidades lógicas, intentos, reintentos ni rondas.

La reanudación automática del Constructor sigue exigiendo identidad y checkpoint restaurable según su propio contrato. Este ledger no sustituye ese requisito: solo indica qué operación quedó confirmada.

Una ejecución nueva después del cierre usa un `execution.id` nuevo y no reutiliza constancias ni evidencia de la ejecución anterior.

Una revisión de plan no renumera: conserva lo confirmado, agrega operaciones nuevas y marca lo invalidado como `rejected` o `superseded` sin reutilizar su evidencia para otro efecto.

## Matriz de acciones

| Acción | Clase | Verificador | Confirmación | Reintento | Al reanudar |
|--------|-------|-------------|--------------|-----------|-------------|
| Leer el ledger | idempotente | lectura del registro y de `record_version` | no requiere constancia propia | no aplica | se relee; no muta |
| Leer el registro de progreso | idempotente | referencia del registro | no requiere constancia propia | no aplica | se relee; no muta |
| Leer el mapa de instancias | idempotente | `flow-state/{work_id}/instances` | no requiere constancia propia | no aplica | se relee; no muta |
| Leer el estado de git | idempotente | `git rev-parse`, `git status` | no requiere constancia propia | no aplica | se relee; no muta |
| Leer un artifact | idempotente | hash de contenido del archivo | no requiere constancia propia | no aplica | se relee; no muta |
| Re-registrar la misma operación | idempotente | identidad y evidencia idénticas | confirma la constancia existente | no aplica | devuelve `already_confirmed` |
| Confirmar una operación ya confirmada | idempotente | verificador de la fase | confirma sin efecto nuevo | no aplica | reutiliza la evidencia |
| Despachar una ronda | no idempotente | `task_id` no nulo y `last_resume >= attempt.started_at` | exige constancia confirmada | solo ante fallo operativo | se reanuda la ronda si su evidencia está confirmada; si no, se despacha una vez |
| Escribir un artifact | no idempotente | hash de contenido o `git diff` esperado | exige constancia confirmada | solo ante fallo operativo | se escribe solo lo pendiente de la tarea |
| Ejecutar tests | idempotente de solo lectura | resultado de la corrida y hash del árbol | evidencia para `constructor.commit` | no aplica | se reejecuta como evidencia; no crea efecto |
| Crear un commit | no idempotente | `git rev-parse HEAD` o SHA esperado y árbol limpio | exige constancia confirmada | solo ante fallo operativo | se crea solo si la tarea pendiente no está confirmada |
| Integrar un commit | no idempotente | `git merge-base --is-ancestor {commit} {base}` | exige constancia confirmada | solo ante fallo operativo | se integra solo lo no confirmado |
| Notificar o publicar | no idempotente | referencia del destino publicado | exige constancia confirmada | solo ante fallo operativo | no se republica lo ya confirmado |
| Cerrar la ejecución | no idempotente por transición de estado | estado de cierre consultable | exige constancia confirmada | solo ante fallo operativo | se cierra solo si el cierre no consta |

Las lecturas y los re-registros son idempotentes. Los efectos externos son no idempotentes. Las acciones que quedan sin confirmación tras una caída son inciertas: se verifican antes de cualquier decisión.

## Evidencia

- Cada confirmación cita al menos una evidencia **canónica**.
- `ref` debe ser una de estas formas: una ruta relativa al repo, un SHA, un `topic_key#campo`, un ID externo o un comando con hash de salida.
- `canonical: false` marca las evidencias auxiliares: corridas parciales, interrumpidas o no comparables. No habilitan por sí solas una confirmación.
- Repetir evidencia ya contabilizada no produce un efecto nuevo.
- Una confirmación sin evidencia canónica no es válida: la operación no pasa a `confirmed`.

## Fallos, estados y códigos de reporte

**Códigos de reporte.**

| Código | Significado |
|--------|-------------|
| `identity_unavailable` | No se puede formar una identidad válida de operación. |
| `record_unavailable` | El ledger no existe o no puede leerse. |
| `record_contradictory` | El ledger contiene contradicciones internas. |
| `persistence_unconfirmed` | La escritura del ledger no quedó confirmada por lectura de verificación. |
| `retry_exhausted` | Se agotaron los reintentos permitidos para la fase. |
| `ambiguous_execution` | Hay más de una ejecución activa o pausada para el mismo `work_id`. |
| `no_resumable_execution` | No hay ninguna ejecución reanudable para el `work_id`. |
| `concurrent_write_suspected` | Se sospecha una escritura concurrente del ledger. |
| `uncertain_external_effect_unresolved` | Un efecto externo incierto no se puede verificar. |

**Máquina de estados.** Transiciones permitidas:

| Desde | Hacia | Condición |
|-------|-------|-----------|
| `pending` | `in_progress` | Se registra la intención de la operación. |
| `in_progress` | `confirmed` | El efecto se verificó y la constancia quedó confirmada. |
| `in_progress` | `failed` | El intento terminó con `operational_failure` o `verification_failed`. |
| `failed` | `pending` | Quedan reintentos y la espera de backoff ya transcurrió. |
| `failed` | `blocked` | Se agotaron los reintentos (`retry_exhausted`). |
| `in_progress` | `uncertain` | El efecto externo no pudo confirmarse tras la caída. |
| `uncertain` | `confirmed` | El verificador demuestra que el efecto ocurrió. |
| `uncertain` | `pending` | El verificador demuestra que el efecto no ocurrió. |
| `uncertain` | `blocked` | El verificador no puede determinar el resultado (`uncertain_external_effect_unresolved`). |
| `in_progress` | `rejected` | El intento terminó con `functional_rejection`. |
| `blocked` | `pending` | Solo con autoridad explícita o con una ejecución nueva. |

**Transiciones prohibidas.**

- `confirmed → in_progress`: una operación confirmada no vuelve a ejecutarse.
- `rejected → confirmed`: un rechazo funcional no se convierte en confirmación.
- Cualquier avance desde `blocked` sin resolución registrada.
- Cualquier transición que agregue estados fuera de la lista canónica.

## Invariantes

| # | Invariante | Método de verificación |
|---|------------|----------------------|
| I-01 | La identidad de operación es la misma en todos los reintentos de una unidad lógica. | Comparar `operation_id` entre los intentos registrados de la misma operación. |
| I-02 | Operaciones distintas tienen identidades distintas, incluso con efectos parecidos. | Comparar `phase_id` y `logical_unit` de cada operación registrada; ninguna pareja se repite. |
| I-03 | Un efecto confirmado nunca se vuelve a ejecutar. | Buscar operaciones en `confirmed` y comprobar que no tienen intentos posteriores con `outcome: confirmed` tras la confirmación. |
| I-04 | No se avanza sin persistencia confirmada. | Toda transición a `confirmed` tiene `confirmation.confirmed_at` y una lectura de verificación coincidente en `record_version`. |
| I-05 | Un reintento solo ocurre ante `operational_failure` o `interruption`. | Revisar `attempts[].outcome` de las operaciones con `retry.count > 0`. |
| I-06 | Un efecto incierto no se repite a ciegas. | Toda operación en `uncertain` tiene entrada en `uncertain_effects[]` con `state` distinto de `unresolvable` antes de reintentarse. |
| I-07 | La reanudación no reinicia la numeración. | Comparar `attempt.number`, `retry.count` y `logical_unit` antes y después del corte. |
| I-08 | Una ejecución nueva no reutiliza evidencia de una ejecución anterior. | Comparar `execution.id` y el prefijo de los `operation_id` entre ejecuciones. |
| I-09 | Un registro ausente o contradictorio no genera estado inventado. | Verificar que el ledger no cambia cuando el actor reporta `record_unavailable` o `record_contradictory`. |
| I-10 | Un rechazo funcional no se trata como reintento. | Toda operación con `outcome: functional_rejection` tiene `retry.count` igual al de su entrada y abre una unidad lógica nueva. |
| I-11 | Toda confirmación cita al menos una evidencia canónica. | Contar evidencias con `canonical: true` en cada `confirmation.evidence`. |
| I-12 | Solo se avanza a una fase cuando todas sus dependencias están confirmadas. | Resolver el grafo de `depends_on` contra los estados de `operations[]`. |

## Checklist de aceptación

| # | Criterio | Regla que lo satisface |
|---|----------|------------------------|
| AC-01 | Una operación repetida con la misma identidad tras un fallo operativo se reconoce como el mismo trabajo y no crea una operación nueva. | `## Identidad de operación` (el intento no forma parte de la identidad) y `## Reintentos` (el reintento conserva `operation_id` y `logical_unit`). |
| AC-02 | Una fase con efecto confirmado no vuelve a ejecutar el efecto al reintentarse o reanudarse, y reutiliza su evidencia. | `## Protocolo de ejecución` paso 3 (`already_confirmed`) y `## Reanudación` paso 3. |
| AC-03 | Ante un efecto no confirmado, el reintento ejecuta solo lo pendiente de esa fase, no toda la ejecución. | `## Protocolo de ejecución` paso 5 y `## Catálogo de fases` (unidades lógicas por fase). |
| AC-04 | Ante un guardado no confirmado, no se avanza, se conserva lo último confirmado y se informa el fallo operativo. | `## Persistencia y confirmación` (confirmación de persistencia y `persistence_unconfirmed`). |
| AC-05 | Un rechazo funcional no se trata como reintento idempotente y sigue su flujo de revisión. | `## Reintentos` (primera regla) y `## Fallos, estados y códigos de reporte` (`in_progress → rejected`). |
| AC-06 | Una pausa y reanudación con identidad válida y constancia restaurable continúa desde la fase siguiente pendiente sin reiniciar numeración ni repetir efectos confirmados. | `## Reanudación` (pasos 3 a 5). |
| AC-07 | Ante un efecto externo incierto no verificable, el flujo se detiene, informa el efecto con su identidad y no lo repite a ciegas. | `## Clases de efecto y tratamiento` (protocolo de cuatro pasos) y el código `uncertain_external_effect_unresolved`. |
| AC-08 | Si el registro de constancias no existe, no puede leerse o es contradictorio, se informa la limitación y se conserva lo último confirmado. | `## Persistencia y confirmación` (registro ausente, ilegible o contradictorio). |
| AC-09 | Dos operaciones distintas con efectos parecidos mantienen identidades distintas y no reutilizan evidencia. | `## Identidad de operación` (última regla) e invariante I-02. |
| AC-C01 | Reintentos por fase: cuántas veces se reintenta una fase ante fallo operativo antes de informar bloqueo. | `## Política configurable` (`policy.max_retries_per_phase`: 2 en `development`, 3 en `production`) y `## Reintentos`. |
| AC-C02 | Espera entre reintentos: cuánto espera el sistema entre un intento fallido y el siguiente. | `## Política configurable` (`policy.backoff_ms`: `[250, 500, 1000, 2000]`, sin jitter, tope 2000 ms). |
| AC-C03 | Exigencia de constancia por fase: qué fases requieren constancia confirmada antes de avanzar. | `## Política configurable` (`policy.confirmation_required`) y la columna `Constancia` de `## Catálogo de fases`. |

## Ejemplos

### Ejemplo 1 — Reintento tras fallo operativo en `runner.integrate`

- **Identidad**: `CA-ejemplo:CA-ejemplo-20261020T001500Z:runner.integrate:commit-3f2a1b9c4d5e`.
- **Estado inicial**: `state: "in_progress"`, un intento con `outcome: "operational_failure"`, `retry.count: 0`, `logical_unit: "commit-3f2a1b9c4d5e"`.
- **Acción**: el Runner reintenta la fase. `retry.count` es 1 y `attempt.number` pasa a 2. El `operation_id` no cambia. Se espera el primer valor de `backoff_ms` (250 ms).
- **Resultado esperado**: la operación sigue siendo la misma. Si la integración se verifica con `git merge-base --is-ancestor`, pasa a `confirmed`; si vuelve a fallar por causa operativa y se agotan los reintentos del perfil, pasa a `blocked` con `retry.exhausted: true` y se reporta `retry_exhausted`.
- **Evidencia**: `kind: "git_ref"`, `ref: "3f2a1b9c4d5e6f708192a3b4c5d6e7f8091a2b3c"`, `canonical: true`.

### Ejemplo 2 — Reanudación con una tarea confirmada y la siguiente pendiente

- **Identidad**: `CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.implement:task-03`.
- **Estado inicial**: `constructor.implement:task-02` está `confirmed` con su evidencia; `constructor.implement:task-03` está `pending` y depende de `constructor.prepare` (confirmada) y de la tarea anterior confirmada.
- **Acción**: el Constructor reanuda la ejecución con `execution.id` inyectado. Se restaura la última constancia confirmada y se busca la primera operación pendiente del orden del actor cuyas dependencias estén confirmadas.
- **Resultado esperado**: se ejecuta `constructor.implement:task-03` únicamente. `task-02` no se vuelve a escribir; su evidencia se reutiliza. `attempt.number`, `retry.count` y `logical_unit` no se reinician. `resume.count` de la reanudada queda registrado.
- **Evidencia**: la confirmación de `task-02` se conserva con `canonical: true`; la nueva confirmación de `task-03` cita `kind: "file_hash"` sobre el artifact producido.

### Ejemplo 3 — Efecto incierto de commit con verificación presente, ausente o desconocida

- **Identidad**: `CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.commit:task-04`.
- **Estado inicial**: `state: "uncertain"`, `attempts[].outcome: "uncertain"`, y una entrada en `uncertain_effects[]` con `state: "pending_verification"`.
- **Acción**: se verifica con `git rev-parse HEAD` antes de decidir cualquier cosa.
- **Resultado esperado**: si el commit existe, la operación pasa a `confirmed` y `uncertain_effects[].state` pasa a `confirmed_present`; no se repite. Si el commit no existe, se ejecuta una sola vez con la misma identidad y `uncertain_effects[].state` pasa a `confirmed_absent`. Si el verificador no puede determinar el resultado, el flujo se detiene, `uncertain_effects[].state` pasa a `unresolvable` y se reporta `uncertain_external_effect_unresolved` con la identidad y la evidencia disponible.
- **Evidencia**: `kind: "git_commit"`, `ref: "HEAD"`, `canonical: true` cuando la verificación es concluyente; `canonical: false` cuando la corrida fue interrumpida.

### Ejemplo 4 — Rechazo funcional que abre una unidad lógica nueva

- **Identidad**: `CA-ejemplo:CA-ejemplo-20261020T001500Z:constructor.implement:task-05`.
- **Estado inicial**: `state: "in_progress"`, un intento con `outcome: "functional_rejection"`, `retry.count: 0`.
- **Acción**: el Constructor recibe un desacuerdo sobre el contenido producido. No reintenta la misma operación.
- **Resultado esperado**: la operación `task-05` pasa a `rejected` con `retry.count` en 0 y `retry.exhausted: false`. El rework abre una unidad lógica nueva, por ejemplo `task-06`, con su propio `operation_id`, su propio `attempt.number` en 1 y su propio contador de reintentos. La evidencia de `task-05` no se reutiliza para `task-06`.
- **Evidencia**: `kind: "human_decision"`, `ref` con el identificador de la decisión de revisión, `canonical: true`.
