---
name: agent-loop-termination
description: >-
  Predicado determinístico de terminación del Agent Loop: seis condiciones con
  precedencia fija, pausa reversible, reanudación, abandono seguro y veredictos
  de cierre. Consume el progreso en modo lectura y no define presupuesto.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Skill: agent-loop-termination

## Propósito

Esta skill define el contrato determinístico con el que una ejecución del Agent Loop decide su
próximo paso a partir de hechos verificables. La decisión es una de tres: **continuar**, **pausar**
(detención reversible de la misma ejecución) o **cerrar** (cierre con veredicto: éxito, abandono
seguro o cierre por causa externa).

El predicado es una función pura: mismos hechos de entrada y mismo baseline producen la misma
decisión. Cada evaluación produce exactamente una salida.

El alcance es puramente normativo. Esta skill **no** implementa runtime, harness, invariantes,
idempotencia, presupuesto ni ningún componente de producto ajeno al loop. Describe el algoritmo y
sus datos de entrada y salida; no los ejecuta.

## Fronteras

- **No define ni detecta invariantes.** Consume la señal externa de violación con su referencia.
- **No define política de reintentos ni de recuperación.** Solo garantiza que reevaluar no duplique
  transiciones ni cierres.
- **No implementa el controlador de ejecución** ni su ciclo de vida runtime.
- **No mide recursos.** No mide tokens, tiempo, costo, CPU, memoria, llamadas ni almacenamiento, y
  no fija topes de ninguno de ellos.
- **No escribe en el registro de progreso** ni redefine sus variables, contadores, clasificaciones
  o evidencia.
- **No modifica el harness.**
- **No notifica a humanos** ni abre canales de notificación.
- **No incorpora artefactos de producto externos al loop.**
- **No purga** historial, registros ni evidencia; la retención es la de la ejecución.
- **No modifica `runner.md`, `memory-contract`, `topic-keys-convention` ni `checkpoint-mixin`.**

## Cuándo se carga y cuándo se evalúa

- **Carga:** se carga al activarse el Loop de validación de una ejecución.
- **Evaluación por ronda:** al cierre de cada ronda funcional completada, después de confirmada la
  instantánea de progreso y **antes** de despachar la siguiente ronda.
- **Evaluación por evento externo:** ante invariante, decisión de autoridad, fallo declarado
  irrecuperable, límite alcanzado o solicitud de reanudación, aunque no haya ninguna ronda en
  curso.
- **Un fallo operativo sin resultado observado no es ronda funcional** y no evalúa el predicado.
- **Reevaluación:** reevaluar la misma ronda usa la misma `evaluation_key` y no crea una transición
  nueva.

## Entradas y salida del predicado

El predicado consume una entrada y devuelve una decisión. Los tipos son normativos: describen la
forma de los datos, no código ejecutable.

~~~ts
type Outcome = "continue" | "pause" | "close";
type Verdict = "success" | "safe_abandonment" | "external_cause";
type Reason =
  | "none"
  | "invariant_violation"
  | "irrecoverable_failure"
  | "objective_met"
  | "explicit_limit"
  | "authority_block"
  | "no_verifiable_progress"
  | "progress_unavailable";

type ResumeCondition = {
  kind:
    | "new_hypothesis"
    | "new_baseline"
    | "authority_decision"
    | "resolution_record"
    | "signal_lifted"
    | "progress_readable"
    | "new_limit";
  satisfied: boolean;
  ref: string | null;
};

type ProgressFacts = {
  round: {
    number: number;
    classification:
      | "with_verifiable_progress"
      | "without_verifiable_progress"
      | "not_evaluable";
  };
  baseline_version: number;
  criteria: {
    met: number;
    evidenced_met: number;
    total: number;
    state: "known" | "not_applicable" | "unknown";
    evidence_refs: string[];
  };
  tasks: {
    completed: number;
    evidenced_completed: number;
    total: number;
    state: "known" | "not_applicable" | "unknown";
    evidence_refs: string[];
  };
  blockers: {
    open: number;
    authority_open: number;
    resolved: number;
    evidence_refs: string[];
  };
  rounds_without_verifiable_progress: number;
  evidence_state: "sufficient" | "partial" | "insufficient" | "unknown";
};

type TerminationInput = {
  execution: {
    id: string;
    work_id: string;
    round_number: number;
    snapshot_id: string;
    baseline_version: number;
    state: "running" | "paused" | "closed";
  };
  progress:
    | ProgressFacts
    | { state: "absent" | "unavailable" | "contradictory"; detail: string };
  signals: {
    invariant: {
      active: boolean;
      ref: string | null;
      resolution_ref: string | null;
      lifted: boolean;
    };
    irrecoverable_failure: {
      declared: boolean;
      ref: string | null;
      diagnosis_ref: string | null;
    };
    authority: {
      open: boolean;
      refs: string[];
      decision_ref: string | null;
    };
    explicit_limit:
      | {
          declared: boolean;
          kind: string;
          ref: string | null;
          reached: boolean;
          effect: "pause" | "close";
        }
      | null;
    objective_confirmation: { present: boolean; ref: string | null } | null;
    resume:
      | {
          signal_ref: string | null;
          basis_kind:
            | "new_hypothesis"
            | "new_baseline"
            | "authority_decision"
            | "resolution_record"
            | "signal_lifted"
            | "progress_readable"
            | "new_limit";
          basis_ref: string | null;
        }
      | null;
  };
  config: {
    stagnation: {
      pause_threshold: number;
      abandonment_proposal_threshold: number;
    };
  };
};

type TerminationDecision = {
  outcome: Outcome;
  reason: Reason;
  precedence: 1 | 2 | 3 | 4 | 5 | 6 | null;
  verdict: Verdict | null;
  evaluation_key: string;
  round: number;
  baseline_version: number;
  evidence_refs: string[];
  resume_conditions: ResumeCondition[];
  proposed_abandonment: boolean;
};
~~~

**Identificadores deterministas.**

- `evaluation_key` identifica una evaluación. Se deriva de `execution.id`, `round.number`,
  `snapshot_id` y `baseline_version`. No contiene marcas de tiempo ni valores aleatorios: la misma
  ronda con los mismos hechos produce siempre la misma clave.
- `transition_id` identifica una transición. Se deriva de `execution.id`, `evaluation_key`, estado
  de origen y estado de destino. Por construcción, la misma transición no puede escribirse dos
  veces.
- Si la misma `evaluation_key` vuelve a producir un resultado distinto del ya registrado, se
  informa un **fallo operativo** y el registro existente **no** se sobrescribe.

**Invariante de salida.** Una evaluación devuelve exactamente una salida. `verdict` es distinto de
`null` solo cuando `outcome == "close"`. `precedence` es `null` únicamente para
`progress_unavailable`. `proposed_abandonment` es `true` solo en la pausa por estancamiento cuando
el contador alcanza el umbral de propuesta.

## Contrato de lectura del progreso

El predicado lee el registro de progreso `flow-state/{execution_id}/progress` en **modo de solo
lectura**, conforme al contrato de progreso vigente. La lectura no escribe, no redefine variables,
contadores ni clasificaciones, y no depende de la forma interna del registro: si el contrato de
progreso evoluciona por dentro, este contrato solo exige los hechos mínimos de la tabla siguiente.

| Hecho | Fuente | Regla si falta |
|-------|--------|----------------|
| `execution.id`, `snapshot_id`, `round.number`, `baseline_version` | identidad del registro | `progress_unavailable` |
| `round.classification` | última instantánea | `progress_unavailable` |
| `rounds_without_verifiable_progress` | contador | `progress_unavailable` |
| `criteria.met`, `criteria.evidenced_met`, `criteria.total`, `criteria.state`, `criteria.evidence_refs` | registro de criterios | `progress_unavailable` |
| `tasks.completed`, `tasks.evidenced_completed`, `tasks.total`, `tasks.state`, `tasks.evidence_refs` | registro de tareas | `progress_unavailable` |
| `blockers.open`, `blockers.authority_open`, `blockers.resolved`, `blockers.evidence_refs` | registro o señal del Runner | `progress_unavailable` si hay bloqueos abiertos sin marca |
| `evidence_state` | última instantánea | `progress_unavailable` |

**Reglas de la lectura.**

- `absent`, `unavailable` o `contradictory` producen `progress_unavailable`.
- `criteria.state == "unknown"` impide declarar éxito.
- `criteria.total == 0` con `criteria.state == "known"` impide declarar éxito (baseline vacío).
- `evidenced_met < met` o `evidenced_completed < completed` es contradictorio: pausa por seguridad.
- `criteria.state == "not_applicable"` exige el camino alternativo de la condición 3: tareas
  completas con evidencia y `objective_confirmation` con referencia.
- El adaptador verifica evidencia vigente por elemento y **nunca** escribe.

## Precedencia de las condiciones

| Orden | Condición | Reason | Efecto |
|-------|-----------|--------|--------|
| 1 | Invariante violado | `invariant_violation` | `pause` de seguridad; cierre solo si la autoridad declara abandono final sin resolución |
| 2 | Fallo irrecuperable | `irrecoverable_failure` | `close` con `external_cause` |
| 3 | Objetivo cumplido | `objective_met` | `close` con `success` |
| 4 | Límite expreso | `explicit_limit` | Efecto declarado: `pause` o `close` con `safe_abandonment` |
| 5 | Bloqueo de autoridad | `authority_block` | `pause` y espera |
| 6 | Ausencia de progreso | `no_verifiable_progress` | `pause` y propuesta; nunca cierra |
| — | Progreso no disponible | `progress_unavailable` | `pause` de seguridad; no es séptima condición |

**Reglas de precedencia.**

- La primera condición verdadera gana. La precedencia es total, estable y no depende del orden de
  llegada de las señales.
- La seguridad (1 y 2) prevalece sobre el éxito aparente (3).
- Varias señales de la misma condición se resuelven por `ref` lexicográficamente menor y **todas**
  se citan en `evidence_refs`.
- `progress_unavailable` es una compuerta de seguridad con `precedence: null`, **no** una séptima
  condición. Se emite solo si no aplica 1, 2, 4 ni 5 y no se puede evaluar 3 ni 6.

## Algoritmo de evaluación

~~~text
1. Leer el registro de terminación. Si es ilegible o contradictorio → fallo operativo "termination_unavailable".
2. Si state == "closed" → devolver el cierre existente, sin transición.
3. Si state == "paused":
   a. Si invariant.active y el motivo no es invariant_violation → pausa de seguridad (1).
   b. Si irrecoverable_failure.declared → cierre external_cause (2).
   c. Si no hay resume → devolver la pausa existente.
   d. Si hay resume → evaluate_resume.
4. Si invariant.active → pausa invariant_violation (1).
5. Si irrecoverable_failure.declared → cierre external_cause (2).
6. Leer progreso. Si falta o es contradictorio:
   a. Si explicit_limit.reached → apply_limit.
   b. Si authority.open → pausa authority_block (5).
   c. Si no → pausa progress_unavailable (null).
7. Si objective_met → cierre success (3).
8. Si explicit_limit.reached → apply_limit.
9. Si authority.open → pausa authority_block (5).
10. Si rounds_without_verifiable_progress >= pause_threshold → pausa no_verifiable_progress (6), con proposed_abandonment desde abandonment_proposal_threshold.
11. Si no → continue (none, null).
~~~

**`apply_limit`** — aplica el límite expreso alcanzado.

- `effect == "pause"` → `outcome: "pause"`, `reason: "explicit_limit"`, `precedence: 4`, con
  condiciones de reanudación `new_limit` y `authority_decision`.
- `effect == "close"` → `outcome: "close"`, `reason: "explicit_limit"`, `precedence: 4`,
  `verdict: "safe_abandonment"`.

**`objective_met`** — reglas de la condición 3.

- Con `criteria.state == "known"`: exige `total > 0`, `met == total`, `evidenced_met == total` y
  `evidence_state == "sufficient"`.
- Con `criteria.state == "not_applicable"`: exige `tasks.state == "known"`, `tasks.total > 0`,
  `tasks.completed == tasks.total`, `tasks.evidenced_completed == tasks.total`,
  `evidence_state == "sufficient"` y `objective_confirmation` presente con referencia no vacía.
- Con `criteria.state == "unknown"` o `criteria.total == 0`: nunca se cumple.

**`evaluate_resume`** — evalúa una solicitud de reanudación sobre una ejecución pausada.

| Motivo de la pausa | Causa exigida | Resultado |
|---------------------|---------------|-----------|
| `no_verifiable_progress` | `new_hypothesis`, `new_baseline` o `authority_decision` | Con causa válida → `continue`; sin causa nueva → **rechazo**, la pausa se mantiene |
| `authority_block` | `authority_decision` | Con decisión registrada → `continue`; si la decisión ordena cerrar o declara fuera de alcance → `close` con `safe_abandonment` |
| `invariant_violation` | `resolution_record` **y** `signal_lifted` | Con ambas → `continue`; sin ambas → **rechazo**; si nunca se resuelve y la autoridad declara abandono final → `close` con `safe_abandonment` |
| `progress_unavailable` | `progress_readable` y última instantánea confirmada | Con ambas → `continue`; sin ellas → **rechazo** |
| `explicit_limit` (pausa) | `new_limit` o `authority_decision` | Con causa válida → `continue`; sin causa → **rechazo** |

Un rechazo no muta el registro: la pausa se conserva tal como estaba.

## Condiciones de terminación

### 1. Invariante violado

Se activa cuando `signals.invariant.active == true`. La señal es externa y trae su referencia.

- Efecto: `pause` con `reason: "invariant_violation"` y `precedence: 1`.
- **No se declara éxito** aunque los criterios estén completos: la seguridad prevalece.
- Reanudación: `resolution_record` (constancia registrada de resolución) **y** `signal_lifted`
  (señal externa levantada). Sin ambas, la reanudación se rechaza.
- Si nunca se resuelve y la autoridad declara abandono final → `close` con `safe_abandonment` y
  `reason: "invariant_violation"`.

### 2. Fallo irrecuperable

Se activa cuando `signals.irrecoverable_failure.declared == true`, con `ref` y `diagnosis_ref` no
vacíos.

- Efecto: `close` con `verdict: "external_cause"` y `precedence: 2`.
- Conserva trabajo, historial y diagnóstico (`diagnosis_ref`).
- No se reintenta ni se reanuda. Una ejecución cerrada no se reabre.
- **Sin diagnóstico verificable el fallo no se declara irrecuperable.** Si falta `ref` o
  `diagnosis_ref`, o si el diagnóstico no es verificable, el hecho es un **fallo operativo**:
  produce una pausa (`progress_unavailable` o `authority_block`), nunca un cierre por causa
  externa y nunca un rechazo funcional.

### 3. Objetivo cumplido

Se activa según las reglas de `objective_met` (ver «Algoritmo de evaluación»).

- Efecto: `close` con `verdict: "success"` y `precedence: 3`.
- Los bloqueos restantes se registran pero **no impiden** el éxito.
- No hay éxito con invariante vigente (precedencia 1), con fallo irrecuperable (precedencia 2), con
  evidencia insuficiente, con algún criterio sin evidencia, ni con baseline vacío.
- La vía alternativa (`not_applicable`) exige tareas completas con evidencia y `objective_confirmation`
  con referencia.

### 4. Límite expreso

Se activa cuando `signals.explicit_limit.declared == true` **y** `reached == true`, con `ref` no
vacío.

- El límite lo declara el negocio en el trabajo (CA, plan u hotfix). **No se infiere del consumo** de
  recursos.
- Se aplica el efecto declarado: `pause` (precedencia 4) o `close` con `safe_abandonment`
  (precedencia 4).
- Sin `ref`, el límite se ignora y se informa configuración inválida.
- Varios límites alcanzados: gana el `ref` lexicográficamente menor y todos se citan.

### 5. Bloqueo de autoridad

Se activa cuando `signals.authority.open == true` con `refs` no vacío, o cuando
`progress.blockers.authority_open > 0`.

- Efecto: `pause` con `reason: "authority_block"` y `precedence: 5`.
- No cierra ni continúa por sí sola: espera la decisión externa.
- La decisión puede resolver el bloqueo (reanuda), aprobar un baseline nuevo (reanuda), ordenar el
  cierre (abandono seguro) o declarar el trabajo fuera de alcance (abandono seguro).

### 6. Ausencia de progreso verificable

Se activa cuando `progress.rounds_without_verifiable_progress >= config.stagnation.pause_threshold`.

- Efecto: `pause` con `reason: "no_verifiable_progress"` y `precedence: 6`.
- `proposed_abandonment` pasa a `true` cuando el contador alcanza
  `config.stagnation.abandonment_proposal_threshold`.
- **Nunca cierra.** El estancamiento solo pausa y propone el abandono a la autoridad.
- Las rondas clasificadas `not_evaluable` no incrementan el contador: se consumen tal cual del
  registro.

## Pausa

La pausa es **reversible** y pertenece a la misma ejecución.

| Motivo | Precedencia | Reanudación |
|--------|-------------|-------------|
| `invariant_violation` | 1 | `resolution_record` + `signal_lifted` |
| `explicit_limit` (pausa) | 4 | `new_limit` o `authority_decision` |
| `authority_block` | 5 | `authority_decision` |
| `no_verifiable_progress` | 6 | `new_hypothesis`, `new_baseline` o `authority_decision` |
| `progress_unavailable` | null | `progress_readable` |

**Reglas de la pausa.**

- Conserva la última instantánea confirmada, la numeración de rondas, el motivo, la ronda en que se
  pausó, la evidencia y las condiciones de reanudación.
- Mientras dura la pausa **no se despachan rondas**.
- Pausar dos veces por la misma causa y la misma evaluación **no** duplica registros: la segunda
  evaluación devuelve la pausa existente sin transición nueva.
- `progress_unavailable` no declara éxito ni abandono por estancamiento: es una pausa de seguridad
  que informa la limitación.
- El estancamiento **propone** el abandono; el cierre requiere una señal explícita de la autoridad
  o un límite expreso con efecto de cierre.

### Informe al operador

Toda pausa informa al operador. El informe describe el motivo, el estado conservado y la
condición de reanudación, y esos tres datos son obligatorios:

1. **Motivo** — el motivo de pausa vigente.
2. **Estado conservado** — la última instantánea confirmada, la numeración de rondas, los
   contadores, la evidencia y el trabajo preservado.
3. **Condición de reanudación** — la causa que habilita la reanudación, conforme a la fila que
   corresponde al motivo de la pausa.

El **detalle** del informe se ajusta al perfil vigente de la ejecución: el perfil de
desarrollo agrega referencias de evidencia y el último comando verificado; el perfil de
producción mantiene el informe conciso. La **verificación técnica para reanudar es la misma**
en ambos perfiles: cambia la profundidad del detalle, nunca el requisito.

**Un fallo operativo no es un rechazo funcional.** No es una ronda, no incrementa la
numeración de rondas ni el contador de estancamiento y no pide correcciones al Constructor.

## Reanudación

La reanudación pertenece a la **misma ejecución**.

- **Restauración:** restaura la última instantánea confirmada, conserva la numeración de rondas y
  los contadores, y **no reinicia** nada.
- **Requisito general:** exige señal explícita (`resume.signal_ref` no vacío) más causa resuelta
  (`resume.basis_kind` y `resume.basis_ref`), conforme a la tabla de `evaluate_resume`.
- **Estancamiento (`no_verifiable_progress`):** solo `new_hypothesis`, `new_baseline` o
  `authority_decision`. Sin base nueva la reanudación se **rechaza** y la pausa se mantiene.
- **Autoridad (`authority_block`):** solo `authority_decision`. Si la decisión ordena cerrar o
  declara el trabajo fuera de alcance → `close` con `safe_abandonment`.
- **Invariante (`invariant_violation`):** `resolution_record` **y** `signal_lifted`. Sin ambas se
  rechaza. Si nunca se resuelve y la autoridad declara abandono final → `close` con
  `safe_abandonment`.
- **Progreso no disponible (`progress_unavailable`):** solo `progress_readable` y última
  instantánea confirmada.
- **Límite expreso con pausa (`explicit_limit`):** `new_limit` o `authority_decision`.
- **Prohibiciones:** no se reanuda una ejecución ya cerrada ni una con invariante vigente.
- Un rechazo **no** muta el registro.

## Cierre y abandono seguro

Los veredictos de cierre son tres: `success`, `safe_abandonment` y `external_cause`.

- **`success`** — el objetivo se cumplió con evidencia vigente. Cierra la ejecución.
- **`safe_abandonment`** — cierre sin objetivo cumplido pero sin pérdida. Ocurre por límite expreso
  con efecto de cierre, por decisión de autoridad (cierre o fuera de alcance) o por invariante sin
  resolución con abandono final declarado.
- **`external_cause`** — fallo irrecuperable declarado; conserva el diagnóstico del detector con su
  referencia (`diagnosis_ref`).

**Garantías del abandono seguro.**

- El trabajo y el historial completo quedan **conservados**; no hay purga.
- El motivo y su evidencia quedan **citados** (`reason`, `evidence_refs`).
- **Ningún criterio figura como cumplido sin evidencia**: `criteria_summary.evidenced_met` nunca
  excede `criteria_summary.met`.
- Exige `preserved_refs` no vacío: la lista de referencias preservadas.
- Una consulta posterior devuelve el veredicto con su motivo.
- El estancamiento por sí solo **nunca** cierra.

**Reglas de cierre.**

- Una ejecución cerrada **no se reabre**. Reevaluarla devuelve el cierre existente **sin**
  transición nueva.
- El cierre por causa externa conserva el diagnóstico.

## Persistencia y consulta

- **Topic key:** `flow-state/{execution_id}/termination`. Es el **único** sub-namespace que este
  contrato escribe.
- **Tipo y alcance:** `type: "decision"`, `scope: "project"`.
- **Título:** `Agent Loop termination — {execution_id}`.
- **Escritura:** solo en transiciones `pause`, `resume` y `close`. La salida `continue` **no** se
  persiste.
- **Ausencia de registro:** significa `running`.
- **Lectura previa:** el registro de terminación se lee **antes** de evaluar, con una consulta de
  solo lectura al mismo topic key `flow-state/{execution_id}/termination`.
- **Registro ilegible o contradictorio:** es un fallo operativo; no se despacha ninguna ronda y no
  se sobrescribe el registro.
- **Escritura condicionada:** la escritura compara `integrity.record_version` con el valor leído.
  Si cambió, se relee y se reevalúa; no se pisa el trabajo de otro escritor.
- **Payload:** se guarda el documento completo, con el array `transitions` completo. No se trunca el
  historial; si el payload excede el límite, es un fallo operativo y no se crea una fuente paralela.
- **Consulta:** devuelve `state`, `pause` (motivo, ronda y condiciones de reanudación), `closure`
  (veredicto, motivo, evidencia y `preserved_refs`) y la última transición.
- **Mecanismo de memoria no disponible:** la operación queda bloqueada, sin despacho de rondas y
  **sin** archivos locales de respaldo.

## Schema TerminationRecord v1

El registro de terminación es un documento completo y durable con esta forma canónica. El ejemplo
siguiente muestra una ejecución pausada por estancamiento.

~~~json
{
  "schema": "agent-loop-termination/v1",
  "execution_id": "exec-20260115T093000Z",
  "work_id": "CA-0000",
  "state": "paused",
  "round": {
    "number": 7,
    "last_evaluated_snapshot_id": "snap-0007-r1"
  },
  "baseline_version": 3,
  "pause": {
    "reason": "no_verifiable_progress",
    "precedence": 6,
    "round": 7,
    "since": "2026-01-15T09:35:00Z",
    "facts_ref": "progress://exec-20260115T093000Z/snapshot/snap-0007-r1",
    "evidence_refs": [
      "evidence://exec-20260115T093000Z/round-7/no-verifiable-progress"
    ],
    "resume_conditions": [
      { "kind": "new_hypothesis", "satisfied": false, "ref": null },
      { "kind": "new_baseline", "satisfied": false, "ref": null },
      { "kind": "authority_decision", "satisfied": false, "ref": null }
    ],
    "proposed_abandonment": true
  },
  "closure": null,
  "transitions": [
    {
      "transition_id": "tr-exec-20260115T093000Z-0007-pause",
      "at": "2026-01-15T09:35:00Z",
      "from": "running",
      "to": "paused",
      "outcome": "pause",
      "reason": "no_verifiable_progress",
      "precedence": 6,
      "verdict": null,
      "round": 7,
      "snapshot_id": "snap-0007-r1",
      "evidence_refs": [
        "evidence://exec-20260115T093000Z/round-7/no-verifiable-progress"
      ]
    }
  ],
  "integrity": {
    "record_version": 3,
    "last_transition_id": "tr-exec-20260115T093000Z-0007-pause"
  },
  "created_at": "2026-01-15T08:50:00Z",
  "updated_at": "2026-01-15T09:35:00Z"
}
~~~

Ejemplo compacto del bloque `closure` para un cierre por abandono seguro:

~~~json
{
  "verdict": "safe_abandonment",
  "reason": "explicit_limit",
  "precedence": 4,
  "round": 12,
  "closed_at": "2026-01-15T11:02:00Z",
  "facts_ref": "progress://exec-20260115T093000Z/snapshot/snap-0012-r1",
  "evidence_refs": [
    "evidence://exec-20260115T093000Z/limit/declared-limit-001"
  ],
  "diagnosis_ref": null,
  "preserved_refs": [
    "progress://exec-20260115T093000Z",
    "history://exec-20260115T093000Z/rounds"
  ],
  "criteria_summary": {
    "met": 4,
    "evidenced_met": 4,
    "total": 9
  }
}
~~~

## Configuración

No hay archivos de configuración ni claves de entorno. Los valores por defecto son documentales y
viven en la entrada `config` del predicado.

| Clave | Valor por defecto | Descripción |
|-------|-------------------|-------------|
| `stagnation.pause_threshold` | `3` | Rondas sin progreso verificable que disparan la pausa. Entero ≥ 1. |
| `stagnation.abandonment_proposal_threshold` | `6` | Rondas sin progreso desde las cuales la pausa propone el abandono. Entero ≥ `pause_threshold`. |
| `stagnation.auto_close` | `false` | No configurable. El estancamiento nunca cierra la ejecución. |

**Valores inválidos.** Un valor no numérico, no entero, menor que 1 o un
`abandonment_proposal_threshold` menor que `pause_threshold` se rechaza: se usa el valor por
defecto y se informa configuración inválida.

**Límite expreso.** No es configuración global: lo declara el negocio por trabajo en su CA, plan u
hotfix, con su referencia y su efecto declarado (`pause` o `close`).

## Distinción respecto del presupuesto

- El predicado **no** tiene entradas ni salidas de tokens, tiempo, costo, CPU, memoria, llamadas ni
  almacenamiento.
- **Ninguna condición se infiere del consumo** de recursos.
- Consumo alto sin ninguna de las seis condiciones cumplidas → la decisión es `continue` con
  `reason: "none"` y `precedence: null`.
- El **límite expreso** es una regla de negocio declarada por el trabajo, con su referencia y su
  efecto declarado. No es una medición.
- La terminación por costo pertenece a otro contrato y no se implementa aquí.

## Invariantes de aceptación

1. Una evaluación produce exactamente una salida: `continue`, `pause` o `close`.
2. La precedencia de condiciones es total y estable: la primera condición verdadera gana.
3. La misma entrada con el mismo baseline produce la misma salida.
4. Reevaluar la misma `evaluation_key` no crea una transición nueva ni duplica un cierre.
5. El cierre es final e irreversible: una ejecución cerrada no se reabre.
6. La pausa es reversible y pertenece a la misma ejecución.
7. El estancamiento solo pausa y propone; nunca cierra por sí solo.
8. Un invariante vigente impide declarar éxito.
9. Un progreso no disponible impide declarar éxito y preclude el abandono por estancamiento.
10. La lectura del registro de progreso no escribe, no redefine variables y no altera contadores,
    clasificaciones, evidencia ni numeración.
11. La reanudación exige señal explícita y causa resuelta según el motivo de la pausa.
12. La reanudación restaura la última instantánea y conserva numeración y contadores: no reinicia.
13. El abandono seguro conserva trabajo e historial, cita motivo y evidencia y no pierde nada.
14. Ningún criterio figura como cumplido sin evidencia.
15. El predicado no acepta entradas ni salidas de tokens, tiempo, costo, CPU, memoria, llamadas ni
    almacenamiento.
16. El límite expreso cuenta solo si el negocio lo declaró con referencia y efecto; no se infiere
    del consumo.
17. Las rondas clasificadas `not_evaluable` no incrementan el contador de estancamiento.
18. La persistencia es durable en el mecanismo de memoria del proyecto; no hay archivos locales de
    respaldo.
19. La salida `continue` no se persiste; la ausencia de registro significa `running`.
20. El contrato no modifica `runner.md`, `memory-contract`, `topic-keys-convention` ni
    `checkpoint-mixin`.
21. La lectura del registro de terminación ocurre antes de evaluar y una escritura solo procede si
    `integrity.record_version` no cambió.
22. `progress_unavailable` no es una séptima condición: tiene `precedence: null` y solo se emite
    cuando no aplica 1, 2, 4 ni 5 y no se puede evaluar 3 ni 6.
23. Varias señales de la misma condición se resuelven por `ref` lexicográficamente menor y todas se
    citan en la evidencia.
