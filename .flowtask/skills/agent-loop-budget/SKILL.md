---
name: agent-loop-budget
description: >-
  Contrato de observabilidad del gasto por ejecución del Agent Loop: registro
  durable por objetivo, señales de tokens, tiempo activo, rondas y costo
  estimado, aviso suave y pausa reversible solo con límites declarados.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

skill({ name: "memory-protocol" })

# Skill: agent-loop-budget — observabilidad del gasto por ejecución

## Propósito

Esta skill es la fuente canónica de los hechos de gasto de una ejecución: cuánto
texto se procesó, cuánto tiempo efectivo se consumió, en qué ronda va el trabajo y a
cuánto dinero aproximado equivale ese consumo.

Produce tres cosas y nada más:

- **Observaciones**: el registro durable del gasto acumulado de una ejecución.
- **Avisos**: la señal visible de que un límite blando declarado fue superado.
- **Propuestas de pausa**: la petición reversible de frenar ante una condición
  de gasto que lo habilite.

Lo que **no** hace:

- No decide la terminación de la ejecución. La precedencia es siempre de la
  terminación hacia el presupuesto.
- No cierra ni abandona un objetivo por su cuenta.
- No es un checkpoint: no reemplaza ni escribe en el registro de progreso.
- No es un runtime: no ejecuta, no instrumenta y no enforcea.

El gasto se observa **por objetivo**, no por participante. Quien pide un trabajo
necesita saber cuánto costó conseguirlo, sumando todo lo que consumieron sus
rondas y sesiones hijas.

---

## Fronteras

| Capacidad | ¿Está en este contrato? | Nota |
|-----------|------------------------|------|
| Registrar gasto acumulado por ejecución | Sí | Señales de tokens, tiempo activo, rondas y costo estimado. |
| Atribuir sesiones a la ejecución | Sí | Mapa del Runner, herencia por sesión padre y no atribución explícita. |
| Avisar al superar un límite blando declarado | Sí | Aviso visible, una vez por límite y ejecución. |
| Proponer pausa reversible ante un límite blando declarado | Sí | Solo con `on_soft: pause` o decisión explícita de la autoridad. |
| Escribir el registro de gasto | Sí | Un solo escritor: quien coordina la ejecución. |
| Definir o evaluar un **tope duro** | No | El freno irreversible pertenece a otro contrato. |
| Definir una **pausa dura** | No | Solo existe la pausa blanda, reversible y sin reinicio. |
| Provocar **cierre automático** | No | Ningún estado de gasto cierra el objetivo. |
| Provocar **abandono automático** | No | Ningún estado de gasto abandona el objetivo. |
| Ejecutar `kill` o terminar procesos por consumo | No | Fuera del alcance de la observabilidad. |
| Cambiar de modelo por estancamiento | No | La escalación de modelo es una decisión de la autoridad, no un efecto del presupuesto. |
| Aplicar topes por agente, por sesión o por objetivo | No | La unidad es la ejecución completa. |
| Cortar el trabajo por costo estimado | No | El costo es una cifra orientativa, jamás una factura. |
| Usar el límite de lecturas por llamada como presupuesto | No | Un acota lo leído en una llamada; este cuenta el total de la ejecución. |
| Proveer un panel visual, tendencias o retención | No | La consulta es puntual y de solo lectura. |
| Enviar notificaciones fuera del sistema | No | El aviso vive en el reporte de ronda. |
| Instrumentar el runtime o agregar plugins | No | El contrato se cumple con el registro y el reporte. |
| Escribir código, scripts o archivos de configuración | No | El schema y los algoritmos son bloques normativos, no código ejecutable. |
| Mantener archivos locales de respaldo | No | La persistencia es durable y única en Engram. |
| Escribir en el registro de progreso | No | Se lee; nunca se escribe ni se redefine. |
| Habilitar la reanudación de subagentes | No | La reanudación de subagentes tiene su propio contrato. |
| Guardar prompts, mensajes, código o contenido de herramientas | No | Solo conteos, tiempos, modelos, referencias de sesión y eventos. |

La frontera es deliberada: este contrato **mira** el gasto y **avisa**. No frena
por su cuenta y no toma decisiones de terminación.

---

## Unidad de gasto e identidad de ejecución

La unidad de gasto es **una ejecución completa de un objetivo**, identificada por
su `execution_id`. Nunca una sesión, nunca un agente, nunca un fragmento de
trabajo.

### Identidad

| Campo | Significado |
|-------|-------------|
| `execution_id` | Identificador único de la ejecución. Es la clave de todo el registro. |
| `work_id` | Identificador del objetivo: `CA-{ID}` o `HF-{slug}`. |
| `work_kind` | `ca` o `hotfix`. |
| `started_at` | Momento de inicio explícito de la ejecución. Se declara siempre; nunca se infiere del primer evento. |
| `round.number` | `0` en la inicialización y el número de ronda en cada anotación posterior. |

El `execution_id` y el `work_id` provienen del registro de progreso. Si el
progreso no los expone, quien coordina aporta la identidad; nunca se deduce del
contenido, del modelo, del agente ni de marcas de tiempo.

### Ejecución nueva y ejecución reanudada

| Situación | Resultado esperado |
|-----------|--------------------|
| Ejecución nueva | Registro nuevo, totales en cero, `last_recorded_moment: initialization`. |
| Ejecución reanudada con registro presente | Se continúa el mismo registro: se conservan anotación, ronda, totales y eventos previos. |
| Ejecución reanudada sin registro | Registro nuevo con totales `unknown`, `integrity.state: incomplete` y un `gap` declarado. **Nunca se declara cero.** |

### Identidad contradictoria

Si el `execution_id` del registro de progreso difiere del `execution_id` del
registro de gasto, el estado es **contradictorio**: no se fusionan los dos
registros, no se promedia nada y no se sobrescribe el registro existente. Se
informa la contradicción y se espera una decisión de la autoridad.

---

## Señales y precedencia

El gasto se expresa con cuatro señales. Cada una tiene un rol distinto y una
precedencia distinta.

| Señal | Rol | Puede disparar aviso | Puede pausar | Notas |
|-------|-----|----------------------|--------------|-------|
| `tokens` | **Primaria** | Sí | Sí | Señal principal para comparar ejecuciones. |
| `time.active_time_ms` | **Secundaria** | Sí | Sí | Decide cuando no hay límite de tokens o cuando es el único límite declarado. |
| `round.number` | Solo lectura | No | No | Se copia del registro de progreso. No se cuenta, no se incrementa, no dispara acción. |
| `cost.estimated_usd` | Observacional | No | No | Cifra orientativa de la plataforma. Puede ser cero o desconocida. |

### Precedencia entre señales

1. **Tokens decide si hay evaluación por tokens.** Si existe un límite de tokens
   declarado, la evaluación de tokens manda.
2. **El tiempo activo decide cuando no hay límite de tokens**, o cuando el
   único límite declarado es de tiempo activo.
3. **Si ambos límites son superados**, el outcome es el más fuerte de los dos y
   el `reason` es `both_soft_limits_exceeded`, citando **ambos** límites en
   `limit_refs` y usando `signal: both`.
4. **Las rondas y el costo nunca disparan** una acción, ni aviso ni pausa. Se
   registran y se muestran.

### Datos parciales y desconocidos

Un valor `partial` o `unknown` **no es cero** y **no prueba cumplimiento**.

- El subconjunto **conocido** puede **probar** que un límite fue superado: si
  lo conocido ya excede el límite, la superación está probada.
- El subconjunto conocido **no puede probar** que el límite se cumple: si lo
  conocido está por debajo del límite y hay datos faltantes, el cumplimiento no
  queda probado.
- En ese caso, con exigencia declarada el outcome es `pause` con reason
  `data_unverified`; sin exigencia declarada el outcome es `unverified` con
  reason `data_unverified`, visible en el reporte de ronda, y el trabajo
  continúa.

### Normalización de tokens

Las categorías de tokens son **mutuamente excluyentes** en `v1`:

```text
total = input + output + reasoning + cache_read + cache_write
```

Si el proveedor reporta el cache **incluido** dentro de `input`, se resta
`cache_read` de `input` antes de sumar y el campo `tokens.normalization` registra
la variante aplicada. La normalización elegida queda declarada en el registro:
`provider_reported_v1` para categorías disjuntas, `cache_subtracted_v1` cuando se
restó el cache del input.

Cuando el total no puede calcularse con confianza, `tokens.state` es `partial` o
`unknown` y `tokens.total` no se rellena con una estimación.

### Tiempo activo

`time.active_time_ms` es la **suma de los intervalos efectivos** de las sesiones
atribuidas. Excluye esperas humanas, pausas y el tiempo entre sesiones.

- Las sesiones concurrentes **se suman**: no es tiempo de reloj.
- Si no se mide, `time.active_state` es `unknown` y el valor **no se estima**.
- `time.paused_time_ms` acumula el tiempo en pausa de la ejecución; no cuenta
  como tiempo activo.

---

## Schema BudgetRecord v1

El registro de gasto es un documento único y completo. Cada anotación reemplaza
el documento completo, nunca lo parchea.

### Registro canónico

El siguiente bloque es el registro completo con valores de ejemplo. Muestra un
límite declarado; el default documentado es `limits.soft: null`.

```json
{
  "schema": "agent-loop-budget/v1",
  "execution_id": "CA-ejemplo-20261019T193000Z",
  "work_id": "CA-ejemplo",
  "work_kind": "ca",
  "status": "active",
  "started_at": "2026-10-19T19:30:00Z",
  "updated_at": "2026-10-19T20:10:00Z",
  "closed_at": null,
  "last_recorded_moment": "round_close",
  "round": {
    "number": 3,
    "source": "progress",
    "state": "known",
    "observed_at": "2026-10-19T20:09:30Z"
  },
  "tokens": {
    "input": 120000,
    "output": 18000,
    "reasoning": 4000,
    "cache_read": 90000,
    "cache_write": 12000,
    "total": 244000,
    "state": "known",
    "normalization": "provider_reported_v1"
  },
  "time": {
    "active_time_ms": 2400000,
    "active_state": "known",
    "paused_time_ms": 300000
  },
  "cost": {
    "estimated_usd": 1.23,
    "state": "estimated",
    "currency": "USD",
    "price_snapshot": {
      "source": "provider",
      "captured_at": "2026-10-19T19:30:00Z",
      "models": [
        {
          "model": "provider/model",
          "input_per_mtok": 3,
          "output_per_mtok": 15,
          "reasoning_per_mtok": 15,
          "cache_read_per_mtok": 0.3,
          "cache_write_per_mtok": 3.75
        }
      ]
    }
  },
  "attribution": {
    "state": "complete",
    "basis": "runner_session_map",
    "unattributed": {
      "tokens_total": 0,
      "active_time_ms": 0,
      "cost_estimated_usd": 0,
      "sessions": []
    }
  },
  "sessions": [
    {
      "session_id": "ses_ejemplo",
      "parent_session_id": null,
      "agent": "runner",
      "role": "orchestrator",
      "model": "provider/model",
      "attribution": "direct",
      "tokens": {
        "input": 60000,
        "output": 9000,
        "reasoning": 2000,
        "cache_read": 45000,
        "cache_write": 6000,
        "total": 122000
      },
      "active_time_ms": 1200000,
      "cost": {
        "estimated_usd": 0.62,
        "state": "estimated"
      }
    },
    {
      "session_id": "ses_ejemplo_hijo",
      "parent_session_id": "ses_ejemplo",
      "agent": "constructor",
      "role": "worker",
      "model": "provider/model",
      "attribution": "parent_session",
      "tokens": {
        "input": 60000,
        "output": 9000,
        "reasoning": 2000,
        "cache_read": 45000,
        "cache_write": 6000,
        "total": 122000
      },
      "active_time_ms": 1200000,
      "cost": {
        "estimated_usd": 0.61,
        "state": "estimated"
      }
    }
  ],
  "limits": {
    "soft": {
      "tokens": 200000,
      "active_time_ms": 3600000,
      "on_soft": "notify",
      "declared_at": "2026-10-19T19:29:00Z",
      "declared_by": "authority",
      "ref": "work-plan"
    }
  },
  "acknowledged_limit_refs": [],
  "evaluation": {
    "outcome": "notify",
    "reason": "tokens_soft_limit_exceeded",
    "signal": "tokens",
    "limit_refs": ["soft.tokens:200000"],
    "termination_outcome": "continue",
    "evaluated_at": "2026-10-19T20:09:30Z",
    "evaluation_key": "CA-ejemplo-20261019T193000Z:3:round_close",
    "signals": [
      {
        "kind": "tokens",
        "value": 244000,
        "limit": 200000,
        "exceeded": true,
        "state": "known"
      },
      {
        "kind": "active_time_ms",
        "value": 2400000,
        "limit": 3600000,
        "exceeded": false,
        "state": "known"
      },
      {
        "kind": "cost",
        "value": 1.23,
        "limit": null,
        "exceeded": null,
        "state": "estimated"
      },
      {
        "kind": "rounds",
        "value": 3,
        "limit": null,
        "exceeded": null,
        "state": "known"
      }
    ]
  },
  "events": [
    {
      "event_id": "budget-ev-0001",
      "at": "2026-10-19T20:09:30Z",
      "kind": "soft_limit_exceeded",
      "signal": "tokens",
      "value": 244000,
      "limit": 200000,
      "action": "notify",
      "round": 3,
      "ref": "soft.tokens:200000"
    }
  ],
  "pause": null,
  "gaps": [],
  "integrity": {
    "record_version": 2,
    "last_event_id": "budget-ev-0001",
    "state": "complete",
    "last_confirmed_at": "2026-10-19T20:09:30Z"
  },
  "created_at": "2026-10-19T19:30:00Z"
}
```

### Bloques del registro

**Raíz**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `schema` | string | Sí | Siempre `agent-loop-budget/v1`. |
| `execution_id` | string | Sí | Identificador de la ejecución; clave primaria del registro. |
| `work_id` | string | Sí | `CA-{ID}` o `HF-{slug}`. |
| `work_kind` | enum | Sí | `ca` o `hotfix`. |
| `status` | enum | Sí | `active`, `paused` o `closed`. |
| `started_at` | timestamp | Sí | Inicio explícito de la ejecución. |
| `updated_at` | timestamp | Sí | Última anotación escrita. |
| `closed_at` | timestamp \| null | Sí | `null` mientras la ejecución no está cerrada. |
| `last_recorded_moment` | enum | Sí | `initialization`, `round_close`, `pause` o `close`. |
| `round` | objeto | Sí | Bloque de ronda (copia de lectura del progreso). |
| `tokens` | objeto | Sí | Bloque de tokens normalizados. |
| `time` | objeto | Sí | Bloque de tiempo. |
| `cost` | objeto | Sí | Bloque de costo estimado. |
| `attribution` | objeto | Sí | Bloque de atribución. |
| `sessions` | array | Sí | Desglose por sesión atribuida. |
| `limits` | objeto | Sí | Límites declarados. `soft` puede ser `null`. |
| `acknowledged_limit_refs` | array de string | Sí | Referencias de límites ya reconocidos; vacío mientras no haya ninguno. |
| `evaluation` | objeto \| null | Sí | Última evaluación del presupuesto. |
| `events` | array | Sí | Historial completo de eventos; nunca truncado. |
| `pause` | objeto \| null | Sí | Bloque de pausa; `null` si no hay pausa activa. |
| `gaps` | array | Sí | Huecos declarados; vacío si no hubo interrupciones. |
| `integrity` | objeto | Sí | Bloque de integridad y confirmación. |
| `created_at` | timestamp | Sí | Creación del registro. |

**`round`** — `number` (integer \| null), `source` (`progress` \| `unavailable`),
`state` (`known` \| `unknown`), `observed_at` (timestamp).

**`tokens`** — `input`, `output`, `reasoning`, `cache_read`, `cache_write`,
`total` (integer \| null), `state` (`known` \| `partial` \| `unknown`),
`normalization` (`provider_reported_v1` \| `cache_subtracted_v1`).

**`time`** — `active_time_ms` (integer \| null), `active_state` (`known` \|
`partial` \| `unknown`), `paused_time_ms` (integer \| null).

**`cost`** — `estimated_usd` (number \| null), `state` (`estimated` \| `zero` \|
`unknown`), `currency` (string), `price_snapshot` (objeto \| null) con `source`,
`captured_at` y `models[]` (`model`, `input_per_mtok`, `output_per_mtok`,
`reasoning_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok`).

**`attribution`** — `state` (`complete` \| `incomplete` \| `unverifiable`),
`basis` (`runner_session_map` \| `parent_session` \| `mixed` \| `none`),
`unattributed` (objeto) con `tokens_total`, `active_time_ms`,
`cost_estimated_usd` y `sessions[]` (cada una con `session_id` y `reason`).

**`sessions[]`** — `session_id`, `parent_session_id` (string \| null), `agent`,
`role`, `model`, `attribution` (`direct` \| `parent_session`), `tokens` (objeto
sin `state` ni `normalization`), `active_time_ms`, `cost` (objeto con
`estimated_usd` y `state`).

**`limits`** — `soft` (objeto \| null) con `tokens` (integer \| null),
`active_time_ms` (integer \| null), `on_soft` (`notify` \| `pause`),
`declared_at` (timestamp \| null), `declared_by` (string), `ref` (string \| null).

**`evaluation`** — `outcome`, `reason`, `signal`, `limit_refs` (array),
`termination_outcome`, `evaluated_at`, `evaluation_key`, `signals[]` (objetos con
`kind`, `value`, `limit`, `exceeded`, `state`).

**`events[]`** — `event_id`, `at`, `kind`, `signal`, `value`, `limit`, `action`,
`round`, `ref`.

**`pause`** — `source` (`budget` \| `authority` \| `termination`), `reason`
(`soft_limit_exceeded` \| `explicit_decision` \| `record_unavailable` \|
`data_unverified` \| `none`), `resume_conditions[]` (`authority_decision` \|
`new_limit` \| `record_readable` \| `data_complete`), `declared_at`.

**`gaps[]`** — `reason` (`interruption` \| `process_restart` \|
`persistence_failure`), `state` (`unrecorded`), `from_round` (integer \| null),
`to_round` (integer \| null), `detected_at` (timestamp).

**`integrity`** — `record_version` (integer), `last_event_id` (string \| null),
`state` (`complete` \| `incomplete` \| `unreadable` \| `contradictory`),
`last_confirmed_at` (timestamp \| null).

### Enums

| Campo | Valores |
|-------|---------|
| `work_kind` | `ca`, `hotfix` |
| `status` | `active`, `paused`, `closed` |
| `last_recorded_moment` | `initialization`, `round_close`, `pause`, `close` |
| `round.source` | `progress`, `unavailable` |
| `round.state` | `known`, `unknown` |
| `tokens.state` | `known`, `partial`, `unknown` |
| `tokens.normalization` | `provider_reported_v1`, `cache_subtracted_v1` |
| `time.active_state` | `known`, `partial`, `unknown` |
| `cost.state` | `estimated`, `zero`, `unknown` |
| `attribution.state` | `complete`, `incomplete`, `unverifiable` |
| `attribution.basis` | `runner_session_map`, `parent_session`, `mixed`, `none` |
| `sessions[].attribution` | `direct`, `parent_session` |
| `limits.soft.on_soft` | `notify`, `pause` |
| `evaluation.outcome` | `continue`, `notify`, `pause`, `unverified`, `unavailable`, `not_evaluated` |
| `evaluation.reason` | `none`, `observing`, `within_limits`, `tokens_soft_limit_exceeded`, `active_time_soft_limit_exceeded`, `both_soft_limits_exceeded`, `soft_limit_exceeded`, `explicit_pause_decision`, `record_unavailable`, `attribution_incomplete`, `data_unverified`, `termination_precedence`, `closed` |
| `evaluation.signal` | `tokens`, `active_time_ms`, `both`, `none` |
| `evaluation.signals[].kind` | `tokens`, `active_time_ms`, `cost`, `rounds` |
| `evaluation.signals[].state` | `known`, `partial`, `unknown`, `estimated`, `zero` |
| `evaluation.termination_outcome` | `continue`, `pause`, `close` |
| `events[].kind` | `initialized`, `soft_limit_exceeded`, `warning_emitted`, `pause_proposed`, `pause_applied`, `resumed`, `data_unverified`, `record_unavailable`, `attribution_correction`, `limit_declared`, `limit_changed`, `gap_detected`, `closed` |
| `events[].action` | `record`, `notify`, `pause`, `resume`, `close`, `none` |
| `pause.source` | `budget`, `authority`, `termination` |
| `pause.reason` | `soft_limit_exceeded`, `explicit_decision`, `record_unavailable`, `data_unverified`, `none` |
| `pause.resume_conditions[]` | `authority_decision`, `new_limit`, `record_readable`, `data_complete` |
| `gaps[].reason` | `interruption`, `process_restart`, `persistence_failure` |
| `gaps[].state` | `unrecorded` |
| `integrity.state` | `complete`, `incomplete`, `unreadable`, `contradictory` |
| `attribution.unattributed.sessions[].reason` | `no_execution_match`, `parent_unattributed`, `mapping_unavailable` |

El algoritmo de `v1` produce `none`, `observing`, `within_limits`,
`tokens_soft_limit_exceeded`, `active_time_soft_limit_exceeded`,
`both_soft_limits_exceeded`, `soft_limit_exceeded`, `explicit_pause_decision`,
`record_unavailable`, `data_unverified`, `termination_precedence` y `closed`.
`attribution_incomplete` queda declarado para el caso en que la atribución
incompleta se distinga de la incompletitud general de los datos.

### Ejemplo compacto: pausa por límite blando

```json
{
  "acknowledged_limit_refs": [],
  "evaluation": {
    "outcome": "pause",
    "reason": "soft_limit_exceeded",
    "signal": "tokens",
    "limit_refs": ["soft.tokens:100000"],
    "termination_outcome": "continue",
    "evaluation_key": "CA-ejemplo-20261019T193000Z:2:round_close",
    "signals": [
      { "kind": "tokens", "value": 120000, "limit": 100000, "exceeded": true, "state": "known" }
    ]
  },
  "events": [
    {
      "event_id": "budget-ev-0007",
      "at": "2026-10-19T19:55:00Z",
      "kind": "pause_proposed",
      "signal": "tokens",
      "value": 120000,
      "limit": 100000,
      "action": "pause",
      "round": 2,
      "ref": "soft.tokens:100000"
    }
  ],
  "pause": {
    "source": "budget",
    "reason": "soft_limit_exceeded",
    "resume_conditions": ["authority_decision", "new_limit"],
    "declared_at": "2026-10-19T19:55:00Z"
  }
}
```

### Ejemplo compacto: hueco declarado

```json
{
  "gaps": [
    {
      "reason": "interruption",
      "state": "unrecorded",
      "from_round": 3,
      "to_round": 4,
      "detected_at": "2026-10-19T20:05:00Z"
    }
  ],
  "integrity": {
    "record_version": 5,
    "last_event_id": "budget-ev-0009",
    "state": "incomplete",
    "last_confirmed_at": "2026-10-19T20:05:00Z"
  }
}
```

---

## Atribución de sesiones

El gasto de una ejecución incluye el de todas las sesiones que participaron en
ella. La atribución tiene **una sola fuente**: el mapa
`session_id → execution_id` que mantiene quien coordina la ejecución.

### Reglas

1. **El mapa del Runner es la única fuente.** La atribución no se deduce del
   modelo, del agente, del texto de la sesión ni de las marcas de tiempo.
2. **Una sesión hija sin entrada propia hereda la ejecución de su padre**, si el
   padre está atribuido. La herencia se marca con `attribution: parent_session`.
3. **Una sesión sin entrada y con padre no atribuido queda no atribuida**, con
   `reason: parent_unattributed`.
4. **Una sesión sin coincidencia en el mapa queda no atribuida**, con
   `reason: no_execution_match`. Si el mapa no está disponible en absoluto, la
   atribución completa queda `unverifiable` y las sesiones se listan con
   `reason: mapping_unavailable`.
5. **El gasto no atribuido nunca se suma.** Se informa aparte, en
   `attribution.unattributed`, con su propio total de tokens, tiempo activo y
   costo estimado. Jamás se reparte entre objetivos ni se imputa al más cercano.
6. **Una corrección de atribución se registra como evento
   `attribution_correction`** y ajusta los totales una sola vez. Nunca duplica
   consumo: la corrección mueve, no suma.

### Estados de atribución

| `attribution.state` | Significado |
|---------------------|-------------|
| `complete` | Todas las sesiones del periodo tienen ejecución asignada y el total atribuido es confiable. |
| `incomplete` | Hay sesiones no atribuidas: el total atribuido es una cota inferior. |
| `unverifiable` | El mapa de atribución no está disponible: no se puede afirmar qué es del objetivo. |

Un registro con `attribution.state` distinto de `complete` **no declara que el
gasto esté bajo control**: el estado `incomplete` o `unverifiable` se muestra en
el reporte de ronda.

---

## Límites declarados y configuración

Los límites se **declaran por ejecución**. Este contrato los consume, los
registra y los evalúa: no crea archivos de configuración, no los persiste fuera
del registro y no impone límites por defecto.

### Defaults

| Clave | Default | Descripción |
|-------|---------|-------------|
| `limits.soft.tokens` | `null` | Techo blando de tokens. Entero mayor que cero o `null`. Sin default numérico. |
| `limits.soft.active_time_ms` | `null` | Techo blando de tiempo activo. Entero mayor que cero o `null`. Sin default numérico. |
| `limits.soft.on_soft` | `notify` | `notify` o `pause`. `pause` exige al menos un límite no nulo. |
| `limits.soft.declared_by` | `authority` | Referencia de quién declara el límite. |
| `limits.soft.ref` | `null` | Referencia al trabajo, al plan o a la decisión que declara el límite. |

El default global es `limits.soft: null`: sin límites declarados, el registro
solo observa.

### Comportamiento según la declaración

| Declaración | Comportamiento |
|-------------|----------------|
| Sin límites (`limits.soft: null`) | Modo `observing`: se registra y se muestra, sin aviso y sin pausa. |
| Límite con `on_soft: notify` | Al superarse, se emite aviso visible y el trabajo sigue. |
| Límite con `on_soft: pause` | Al superarse, se propone una pausa reversible. |
| `on_soft: pause` sin ningún límite no nulo | Declaración **inválida**: se degrada a `notify`, se informa y no pausa. |
| Valor inválido (no entero, entero `<= 0`, tipo incorrecto) | Se **ignora**, se informa y no pausa. |

### Qué no se admite como límite

Este contrato no admite un umbral irreversible, ni topes por agente, por sesión
o por objetivo, ni topes por costo estimado, ni umbrales por ronda. Solo
`limits.soft.tokens` y `limits.soft.active_time_ms` son límites evaluables, y
ambos son blandos.

---

## Evaluación del presupuesto

La evaluación es **determinista**: las mismas entradas producen la misma
decisión, y la misma clave de evaluación no produce dos eventos distintos.

### Algoritmo

1. **Leer el registro.** Si está ausente en una ejecución nueva, se crea con
   totales en cero. Si está ausente en una ejecución reanudada, se crea con
   totales `unknown`, `integrity.state: incomplete` y un `gap` declarado. Nunca
   con cero.
2. **Registro ilegible o contradictorio:** no se sobrescribe ni se inventa. Con
   exigencia declarada, `pause` con reason `record_unavailable`. Sin exigencia
   declarada, `unavailable` visible y se continúa en modo degradado.
3. **`status: closed`:** se devuelve el cierre sin reabrir la ejecución.
4. **`status: paused`:** se devuelve la pausa sin reevaluar, hasta que llegue
   una señal explícita de reanudación.
5. **Precedencia de terminación:** si la terminación dice `pause` o `close`, el
   outcome es `not_evaluated` con reason `termination_precedence` y solo se
   registran totales del momento.
6. **Actualizar totales:** se suman los totales atribuidos, se agrega el gasto no
   atribuido por separado y se detectan huecos.
7. **Calcular señales:** tokens normalizados, tiempo activo, ronda copiada del
   progreso y costo estimado; cada señal se marca con su estado declarado
   (`known`, `partial`, `unknown`, `estimated`, `zero`).
8. **Sin límites soft y sin decisión explícita:** `continue` con reason
   `observing`, sin aviso.
9. **Decisión explícita de pausa:** `pause` con reason `explicit_pause_decision`
   y `pause.source: authority`, aunque no exista ningún límite.
10. **Con límites y datos insuficientes:** si el subconjunto conocido supera un
    límite, se trata como superado; si no se puede probar el cumplimiento, el
    outcome es `unverified` con reason `data_unverified`. Con exigencia
    declarada, `pause` con reason `data_unverified`; sin exigencia declarada,
    `unverified` visible y se continúa.
11. **Evaluar tokens y luego tiempo activo:**
    - Tokens superado y `on_soft: pause` → `pause` con reason
      `soft_limit_exceeded`, `signal: tokens`.
    - Tokens superado y `on_soft: notify` → `notify` con reason
      `tokens_soft_limit_exceeded`.
    - Tokens no superado y tiempo activo superado → misma regla con
      `active_time_soft_limit_exceeded` y `signal: active_time_ms`.
    - Ambos superados → se aplica la acción más fuerte, reason
      `both_soft_limits_exceeded`, `signal: both` y **ambos** límites citados en
      `limit_refs`.
12. **Ningún límite superado:** `continue` con reason `within_limits`.
13. **Clave de evaluación:** `evaluation_key` es la composición de
    `execution_id`, la ronda y el momento. La misma clave con el mismo resultado
    no duplica eventos. La misma clave con un resultado distinto es una
    contradicción: no se sobrescribe.
14. **Cierre por terminación:** `not_evaluated` con reason `closed`,
    `status: closed`, `closed_at` y totales finales.

### Interfaz BudgetDecision v1

```text
BudgetOutcome = continue | notify | pause | unverified | unavailable | not_evaluated

BudgetReason = none | observing | within_limits | tokens_soft_limit_exceeded
             | active_time_soft_limit_exceeded | both_soft_limits_exceeded
             | soft_limit_exceeded | explicit_pause_decision | record_unavailable
             | attribution_incomplete | data_unverified | termination_precedence | closed

BudgetSignal = tokens | active_time_ms | both | none

BudgetDecision {
  outcome, reason, signal, limit_refs, termination_outcome, evaluation_key,
  round, pause: { source, reason, resume_conditions } | null, evidence_refs
}
```

### Outcomes

| Outcome | Significado | Efecto observable |
|---------|-------------|-------------------|
| `continue` | El trabajo sigue sin objeción de gasto. | Se registra la anotación y el trabajo continúa. |
| `notify` | Un límite blando declarado fue superado. | Aviso visible en el reporte de ronda y evento `warning_emitted`. El trabajo sigue. |
| `pause` | Una condición habilitada pide frenar. | Pausa reversible propuesta, con motivo y condiciones de reanudación. |
| `unverified` | No se puede verificar el cumplimiento. | Se declara visible que no se verificó; sin exigencia, el trabajo continúa. |
| `unavailable` | El registro no se pudo leer. | Se declara visible; sin exigencia, el trabajo continúa en modo degradado. |
| `not_evaluated` | La terminación tiene precedencia. | Solo se registran totales del momento. |

### Aviso

El aviso por límite es **una vez por límite y ejecución**. Mientras el mismo
límite siga superado, no se repite: se registra `soft_limit_exceeded` y
`warning_emitted` una sola vez y se mantiene el estado visible en el reporte de
ronda. Un límite nuevo o un rearmado explícito vuelven a habilitar el aviso.

---

## Condiciones de pausa

### Tabla D5

| D5 | Condición | ¿Aplica? | Efecto |
|----|-----------|----------|--------|
| 1 | Límite blando superado con `on_soft: pause` | Sí | Pausa reversible; `pause.source: budget`; reason `soft_limit_exceeded`. |
| 2 | Decisión explícita de la autoridad | Sí | Pausa reversible; `pause.source: authority`; reason `explicit_decision`. |
| 3 | Registro ilegible con exigencia declarada | Sí | Pausa de seguridad; reason `record_unavailable`. |
| 4 | Atribución incompleta o datos parciales con exigencia declarada | Sí | Pausa de seguridad; reason `data_unverified`. Sin exigencia: `unverified` y se continúa. |
| 5 | Tope duro alcanzado si la terminación dice continuar | No | Diferido al controlador de ejecución; no se evalúa. |
| 6 | Registro ilegible con tope duro | No | Diferido al controlador de ejecución; no se evalúa. |
| 7 | Atribución incompleta con tope duro | No | Diferido al controlador de ejecución; no se evalúa. |
| 8 | Consumo alto sin límite | No | Nunca pausa; solo observación. |
| 9 | Costo estimado alto | No | Nunca pausa; solo observación. |
| 10 | Muchas rondas o anomalía de un agente | No | Nunca pausa; las rondas son solo lectura. |

**Exigencia declarada** = existe un límite blando no nulo **o** existe una
decisión explícita de pausa. Sin exigencia declarada no hay pausa por gasto.

### Reglas de la tabla

- Sin límite declarado y sin decisión explícita **no hay pausa**: solo
  observación.
- **No hay pausa** por consumo alto sin límite, por costo estimado, por número de
  rondas ni por una anomalía de un agente.
- Toda pausa por gasto es **reversible**: al reanudar, la ejecución continúa
  donde quedó.
- **Nunca** hay cierre ni abandono por gasto.
- Con exigencia declarada, un registro ilegible o una atribución incompleta
  pausan. Sin exigencia declarada, quedan `unverified` o `unavailable` visibles
  y el trabajo continúa.

---

## Precedencia respecto de la terminación

La decisión de terminación **va primero**. El presupuesto nunca anula, nunca
sustituye y nunca fuerza una terminación.

| Terminación | Outcome del presupuesto | Reason | Registro |
|-------------|-------------------------|--------|----------|
| `pause` | `not_evaluated` | `termination_precedence` | Solo totales del momento. |
| `close` | `not_evaluated` | `termination_precedence` | Solo totales del momento. |
| `continue` | Se evalúa normalmente | según el algoritmo | Totales, evaluación y, si corresponde, aviso o pausa. |

Cuando la terminación dice `pause` o `close`, el motivo visible de la parada es
la terminación, **no** el gasto. El presupuesto solo se evalúa si la terminación
dice `continue`.

Al cerrar por terminación, el registro queda con `status: closed`, `closed_at` y
los totales finales, y la evaluación queda en `not_evaluated` con reason
`closed`.

---

## Pausa y reanudación

### Qué conserva la pausa

Una pausa **no reinicia ni pierde** lo avanzado. Al pausar, el registro conserva:

- La última anotación y sus totales acumulados.
- La ronda en la que se pausó.
- El motivo de la pausa y sus condiciones de reanudación.
- Los eventos y los límites ya reconocidos.

Una pausa **no despacha rondas**: el trabajo queda detenido hasta la señal de
reanudación.

### Reanudación

Reanudar exige, en conjunto:

1. Una **señal explícita** de reanudación.
2. La **misma ejecución**: el `execution_id` no cambia.
3. **No reiniciar**: los totales, la ronda y los eventos se conservan.

Una ejecución con `status: closed` **no se reanuda**.

### Tipos de pausa y sus condiciones de reanudación

| Tipo de pausa | `pause.source` | Condiciones de reanudación | Efecto al reanudar |
|---------------|-----------------|----------------------------|---------------------|
| Pausa blanda | `budget` | `authority_decision` o `new_limit` | El límite reconocido queda en `acknowledged_limit_refs` y **no vuelve a pausar** por ese mismo límite. Un límite nuevo o un rearmado explícito pueden volver a pausar. |
| Pausa de seguridad | `authority` | `record_readable` o `data_complete`, o decisión explícita de continuar en estado `unverified` | Se continúa solo si el registro vuelve a ser legible o los datos quedan completos, o si la autoridad decide continuar asumiendo lo no verificado. |
| Pausa de terminación | `termination` | Condiciones de la terminación | La decisión de terminación **no** la toma este contrato. |

### Reincidencia

Tras una reanudación explícita, el mismo límite queda registrado en
`acknowledged_limit_refs` y **no vuelve a pausar** mientras siga siendo el mismo
límite y siga superado. Un límite nuevo, o un rearmado explícito del mismo
límite, habilitan nuevamente la pausa.

---

## Momentos de registro

El registro de gasto se escribe en **cuatro momentos definidos**:

| Momento | `last_recorded_moment` | Qué ocurre |
|---------|------------------------|------------|
| Inicialización | `initialization` | Se crea el registro con `round.number: 0`, `status: active` y evento `initialized`. |
| Cierre de ronda | `round_close` | Tras confirmar el progreso y evaluar la terminación. Si la terminación dice `continue`, el presupuesto se evalúa **antes** de despachar la ronda siguiente. |
| Pausa | `pause` | Se anotan los totales del momento, el motivo y las condiciones de reanudación. |
| Cierre | `close` | Se anotan los totales finales, `status: closed` y `closed_at`. |

### Lo que nunca se anota

- **Nunca por paso**, por herramienta ni por mensaje. El registro no se escribe
  durante la ejecución de una ronda.
- Solo quien coordina la ejecución escribe el registro. Los demás leen.

### Interrupción entre anotaciones

Si la ejecución se interrumpe entre una anotación y la siguiente, al retomar se
parte de la **última anotación guardada** y se declara un `gap` con su `reason`
(`interruption`, `process_restart` o `persistence_failure`) y estado `unrecorded`.
**No se inventa** el tramo perdido ni se estima su consumo.

---

## Persistencia y consulta

### Namespace, tipo y título

| Elemento | Valor |
|----------|-------|
| `topic_key` | `flow-state/{execution_id}/budget` |
| `type` | `decision` |
| `scope` | `project` |
| `title` | `Agent Loop budget — {execution_id}` |
| Owner (único escritor) | Quien coordina la ejecución |
| Lectores | Todos los agentes, en modo solo lectura |

El namespace sigue el patrón `flow-state/{execution_id}/{sufijo}` con el sufijo
`budget`. No colisiona con el sufijo `progress`: son registros distintos, con
propiedades distintas y ciclos de vida distintos.

El registro de progreso vive en `flow-state/{execution_id}/progress`: desde este
contrato se **lee** y nunca se escribe.

### Escritura

```text
mem_save(
  type: "decision",
  scope: "project",
  topic_key: "flow-state/{execution_id}/budget",
  title: "Agent Loop budget — {execution_id}",
  content: {BudgetRecord v1 completo, con el array events completo}
)
```

Reglas de escritura:

1. Cada escritura **reemplaza el documento completo**, con el array `events`
   completo. Nunca se parchea ni se trunca el historial.
2. Después de escribir, se **confirma** la lectura de `integrity.record_version` y
   `integrity.last_event_id`. La confirmación ocurre **antes** de despachar la
   ronda siguiente.
3. `record_version` es **monotónico**: cada escritura lo incrementa. Una versión
   que no avanza o que retrocede es un fallo operativo.
4. Si la confirmación no coincide con lo escrito, es un **fallo operativo**: no se
   sobrescribe, se conserva la última confirmación buena y se reintenta o se
   escala.
5. El registro de progreso **nunca** se escribe desde aquí.

### Consulta

La consulta es de **solo lectura** y nunca escribe. Por `execution_id` devuelve:

| Elemento | Contenido |
|----------|----------|
| `status` | Estado de la ejecución. |
| Totales | Tokens, tiempo activo y costo estimado. |
| Ronda | Número de ronda, origen y estado. |
| Límites | Límites blandos declarados y sus referencias. |
| Evaluación | Outcome, reason, signal y `limit_refs`. |
| Pausa | Motivo, origen y condiciones de reanudación, si hay pausa. |
| Eventos | Historial completo de eventos. |
| Atribución | Estado de la atribución y gasto no atribuido. |
| Integridad | `record_version`, `last_event_id`, estado y última confirmación. |

### Respuestas a situaciones de consulta

| Situación | Respuesta |
|-----------|-----------|
| Sin registro para el `execution_id` | Se informa que no hay registro de gasto. No se crea nada en una consulta. |
| Registro no disponible | Se informa que el registro no está disponible. No se inventa un cero. |
| Registro contradictorio | Se informa la contradicción y se escala. No se fusiona ni se sobrescribe. |

---

## Integridad, datos faltantes y fallos

### Estados de integridad

| `integrity.state` | Significado |
|-------------------|-------------|
| `complete` | Registro legible, coherente y confirmado. |
| `incomplete` | Registro legible pero con datos faltantes, huecos declarados o totales desconocidos. |
| `unreadable` | El registro no se puede leer. |
| `contradictory` | El registro contradice otro dato de la ejecución (por ejemplo, un `execution_id` distinto al del progreso). |

### Matriz de respuesta a fallos

| Situación | Con exigencia declarada | Sin exigencia declarada |
|-----------|--------------------------|--------------------------|
| Registro ausente en ejecución nueva | Se crea con totales en cero. | Igual: se crea con totales en cero. |
| Registro ausente en ejecución reanudada | Se crea con totales `unknown`, `integrity: incomplete` y `gap` declarado. | Igual: nunca se declara cero. |
| Registro ilegible | `pause` con reason `record_unavailable`. No se sobrescribe ni se inventa. | `unavailable` visible; se continúa en modo degradado. |
| Registro contradictorio | `pause` con reason `record_unavailable`. No se fusiona ni se sobrescribe. | `unavailable` visible; se escala la contradicción. |
| Atribución incompleta o datos parciales | `pause` con reason `data_unverified`. | `unverified` visible; el trabajo continúa. |
| Escritura fallida | El evento **no** queda registrado; se conserva la última confirmación buena; `pause` con reason `record_unavailable`. | `unavailable` visible; se conserva la última confirmación buena. |
| Engram no disponible | Bloqueo y degradación según el contrato de memoria: **sin** archivos locales de respaldo. | Quien coordina puede continuar degradado y **debe declararlo** en el reporte de ronda. |
| Hueco detectado | Se declara el `gap`; con datos faltantes aplica la regla de datos parciales. | Se declara el `gap`; el trabajo continúa. |

### Reglas permanentes de integridad

- **Un hueco es un hueco.** Un `gap` significa tramo no registrado: no se estima,
  no se rellena y no se infiere su contenido.
- **Nunca se declara cero** por falta de datos. `unknown` no es `0`.
- **Nunca se sobrescribe** un registro ilegible o contradictorio.
- **Nunca se persisten** archivos locales de respaldo: la única fuente es el
  registro durable.

---

## Distinciones explícitas

| Concepto | Qué es | Cómo se relaciona con el registro de gasto |
|----------|--------|---------------------------------------------|
| `ProgressRecord` | Registro de avance: ronda, estado y avance del trabajo. | Es una fuente **de solo lectura** para el número de ronda. No comparte campos, no se escribe desde aquí y no se redefine. Romper uno no rompe el otro. |
| `TerminationRecord` | Decisión de terminación de la ejecución. | Tiene **precedencia**: si dice `pause` o `close`, el presupuesto no se evalúa. |
| Checkpoint | Estado de continuidad de un agente, con su propio esquema y su propio namespace. | No es un checkpoint: el registro de gasto no lleva contador de secuencia de agente ni semántica de reanudación de agente. |
| Límite de lecturas por llamada | Acota lo que se lee en una sola llamada de herramienta. | No es un presupuesto: no acumula entre llamadas, no mide tokens ni tiempo y no se pausa por superarlo. |
| Tope por agente, por sesión o por objetivo | Un umbral aplicado a una unidad distinta de la ejecución. | No existe: la unidad es la ejecución completa. |
| Costo como factura | Un cargo económico real. | No existe: el costo es una estimación orientativa de la plataforma, puede ser cero o desconocido y nunca frena el trabajo. |
| Panel visual | Visualización agregada, con tendencias y retención. | No existe: la consulta es puntual y de solo lectura sobre el registro. |

### Qué datos contiene y qué no

El registro contiene **solo** conteos, tiempos, modelos, referencias de sesión,
identificadores de evento y marcas de tiempo. **Nunca** guarda prompts,
mensajes, código, contenido de herramientas, credenciales ni secretos.

---

## Invariantes de aceptación

1. Existe **un solo registro** por `execution_id`.
2. El registro de gasto es **independiente** del registro de progreso: no
   comparte campos, no escribe en él y no lo redefine.
3. La unidad de gasto es la **ejecución completa del objetivo**, nunca una
   sesión, un agente o un fragmento.
4. Los tokens son la señal **primaria**; el tiempo activo es **secundario**; las
   rondas son **solo lectura**; el costo es **observacional**.
5. Las rondas y el costo **nunca** disparan aviso ni pausa.
6. No hay **límites numéricos por defecto**: `limits.soft.tokens` y
   `limits.soft.active_time_ms` arrancan en `null` y `on_soft` en `notify`.
7. El contrato **no define ni evalúa** un umbral irreversible, y **no** provoca
   cierre ni abandono del objetivo por gasto.
8. No hay pausa sin un límite blando declarado **o** una decisión explícita de
   pausa.
9. La terminación tiene **precedencia**: el presupuesto no anula, no sustituye
   y no fuerza una terminación.
10. El presupuesto **solo** se evalúa si la terminación dice `continue`.
11. El gasto **no atribuido** se informa aparte y **nunca** se suma a otra
    ejecución.
12. Un valor `partial` o `unknown` **no prueba cumplimiento**; el subconjunto
    conocido sí puede probar superación.
13. La pausa es **reversible**: al reanudar se continúa sin reiniciar ni perder
    lo avanzado.
14. El mismo límite, una vez reconocido, **no vuelve a pausar** hasta que se
    declare un límite nuevo o un rearmado explícito.
15. La escritura ocurre **solo** en los cuatro momentos definidos: inicialización,
    cierre de ronda, pausa y cierre.
16. Cada escritura se **confirma** leyendo `integrity.record_version` e
    `integrity.last_event_id` antes de despachar la ronda siguiente, y
    `record_version` es monotónico.
17. Las interrupciones se registran como **gaps declarados**, sin estimaciones
    ni tramos inventados.
18. La consulta es de **solo lectura** y nunca escribe.
19. No existen **archivos locales** de respaldo ni fuentes paralelas de datos.
20. El registro **no contiene** prompts, mensajes, código, contenido de
    herramientas ni secretos.

---

## Matriz de aceptación y ejemplos canónicos

### Matriz de aceptación

| ID | Criterio | Sección |
|----|----------|---------|
| AC-01 | Sin límites: observa tokens, tiempo, ronda y costo, sin aviso ni pausa. | Señales y precedencia; Límites declarados y configuración; Evaluación del presupuesto |
| AC-02 | Límite de tokens con `notify`: aviso visible, sigue, no cierra ni abandona. | Condiciones de pausa; Evaluación del presupuesto |
| AC-03 | Límite con `on_soft: pause`: pausa reversible; al retomar continúa. | Pausa y reanudación |
| AC-04 | Terminación dice parar y gasto sobre techo: el motivo es la terminación. | Precedencia respecto de la terminación |
| AC-05 | Terminación dice continuar y gasto debajo: sin aviso ni pausa. | Evaluación del presupuesto |
| AC-06 | Registro ilegible o atribución incompleta: no verificable; ni cero ni control. | Integridad, datos faltantes y fallos |
| AC-07 | Muchas rondas: no pausa ni cambia de modelo. | Señales y precedencia; Condiciones de pausa |
| AC-08 | Sin techos declarados: nunca pausa por gasto. | Límites declarados y configuración; Condiciones de pausa |
| AC-09 | Cierre de ronda, pausa o cierre: acumulado separado del progreso, sin paso a paso. | Momentos de registro; Persistencia y consulta |
| AC-10 | Sin umbral irreversible, cierre ni abandono por gasto. | Fronteras; Condiciones de pausa |
| AC-11 | El costo estimado nunca pausa. | Señales y precedencia; Condiciones de pausa |
| AC-12 | Sin topes por agente, por sesión ni por objetivo. | Unidad de gasto e identidad de ejecución; Límites declarados y configuración |

### Ejemplos canónicos

| ID | Entrada | Resultado | Outcome | Reason | Pausa |
|----|---------|-----------|---------|--------|-------|
| E-01 | Sin límites; ronda normal. | Observa y registra; sin aviso. | `continue` | `observing` | No |
| E-02 | Tokens 120k; límite 100k; `notify`. | Aviso; sigue. | `notify` | `tokens_soft_limit_exceeded` | No |
| E-03 | Tiempo 1h20m; límite 1h; `notify`. | Aviso; sigue. | `notify` | `active_time_soft_limit_exceeded` | No |
| E-04 | Tokens 120k; límite 100k; `pause`. | Pausa reversible; retoma. | `pause` | `soft_limit_exceeded` | Sí |
| E-05 | Sin límites; decisión explícita. | Pausa reversible por autoridad. | `pause` | `explicit_pause_decision` | Sí |
| E-06 | Registro ilegible con límite. | Pausa de seguridad; no sobrescribe. | `pause` | `record_unavailable` | Sí |
| E-07 | Registro ilegible sin límite. | `unavailable` visible; sigue degradado. | `unavailable` | `record_unavailable` | No |
| E-08 | Sesión sin mapa ni padre atribuido. | Gasto no atribuido; no se suma. | `continue` | `observing` | No |
| E-09 | Tokens parciales; conocido 120k; límite 100k. | Superación probada; aviso o pausa. | `pause` o `notify` | `tokens_soft_limit_exceeded` | Según `on_soft` |
| E-10 | Tokens parciales; conocido 80k; límite 100k; con exigencia. | No se prueba cumplimiento; pausa. | `pause` | `data_unverified` | Sí |
| E-11 | Terminación `pause`; gasto sobre techo. | No se evalúa el presupuesto. | `not_evaluated` | `termination_precedence` | No por gasto |
| E-12 | Muchas rondas; sin límites. | No pausa; no cambia de modelo. | `continue` | `observing` | No |
| E-13 | Interrupción entre anotaciones. | Gap declarado; no se inventa. | `continue` o `unverified` | `observing` o `data_unverified` | Según exigencia |
