---
name: agent-loop-invariants
description: "Catálogo versionado y verificación bloqueante de los cinco invariantes de cada ronda del Agent Loop: alcance, archivos protegidos, no-diseño-en-ejecución, evidencia persistida y aislamiento del área de trabajo."
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Invariantes del Agent Loop

## Propósito

Esta skill define las reglas que se mantienen en cada ronda funcional completada —una entrega, su comprobación aplicable y el resultado observado— y el procedimiento para declararlas, verificarlas de forma bloqueante al cierre de ronda y reportar sus violaciones.

El catálogo vigente es la única fuente de lo que significa cada invariante. Si dos partes discrepan sobre una regla, vale lo declarado en el catálogo, no la interpretación de la ronda.

Esta skill no mide el avance de la ronda, no decide su cierre, no administra el consumo de recursos, no garantiza la repetición segura de una acción, no controla la ejecución del loop y no implementa productos derivados del loop.

## Fronteras

- No implementa el mecanismo interno de vuelta atrás: declara cuándo invocarlo y qué reportar.
- No crea, modifica ni reinterpreta las reglas de `runner`, `memory-contract`, `topic-keys-convention` ni `checkpoint-mixin`.
- No define espacios de nombres, claves de topicado ni reglas de propiedad de registros.
- No reemplaza el baseline, el plan, la validación ni el registro de avance.
- No agrega código, scripts, plugins, configuración ni hooks.
- No define los pasos manuales del operador para corregir una causa ni el procedimiento operativo posterior a una pausa.

## Términos

- **Ronda funcional**: unidad de trabajo del loop con entrega, comprobación aplicable y resultado observado.
- **Función de control**: la que dirige el loop, declara el contexto de la ronda, verifica los invariantes y decide la confirmación. Verifica; no ejecuta.
- **Ejecutor**: quien realiza el trabajo de la ronda.
- **Área asignada** (`write_area`): lista cerrada de paths y globs donde la ronda puede escribir.
- **Baseline**: documento vigente que delimita el trabajo autorizado de la ejecución.
- **Instantánea confirmada**: estado durable aceptado de una ronda previa de la misma ejecución, citado como `base_snapshot_ref`.
- **Catálogo vigente**: versión activa del catálogo de invariantes, identificada por `catalog_version`.

## Cuándo se carga

La carga la función de control:

- antes de declarar el contexto de la ronda 1;
- en cada cierre de ronda, antes de clasificar o confirmar la instantánea de esa ronda.

El ejecutor no la usa para autocertificarse.

## Autoridad de verificación

- Verifica la función de control, nunca el ejecutor. Si el mismo rol ejecuta y verifica, el check es inválido y se trata como `not_evaluable`.
- Sin un check persistido y confirmado por lectura no hay confirmación, ni clasificación, ni despacho de la ronda siguiente.
- Un check no se reutiliza para otra ronda ni para otra ejecución.

## Catálogo de invariantes — versión 1

`catalog_version: 1`. Estado `active`. El bloque JSON es la representación canónica y la tabla siguiente es derivada: si la tabla y el JSON discrepan, prevalece el JSON y esta skill es inválida hasta corregir la tabla.

| id | code | nombre | enunciado | condición de violación | acción | evidencia requerida |
|---|---|---|---|---|---|---|
| 1 | INV-1 | scope — No ampliar el alcance | La ronda trabaja únicamente sobre el trabajo documentado y la versión vigente de su baseline; no introduce criterios, tareas ni entregables fuera de ese baseline. | La ronda produce o intenta producir un criterio, tarea, entregable o cambio de alcance que no figura en el baseline vigente. | `pause` | `baseline_ref`, `round_deliverables`, `out_of_scope_findings` |
| 2 | INV-2 | protected — No tocar lo protegido | La ronda no escribe fuera de su área de trabajo asignada ni modifica archivos protegidos o compartidos; toda escritura ocurre dentro del aislamiento asignado. | Existe al menos una escritura cuyo path no pertenece al write_area o coincide con un path de la lista de protegidos vigente. | `rollback_and_pause` | `write_area`, `protected_profile`, `changed_paths`, `worktree_path` |
| 3 | INV-3 | no_design — No decidir diseño en la ejecución | Quien ejecuta el trabajo no redefine criterios de aceptación, no rediseña la solución ni sustituye decisiones del plan vigente por criterio propio. | La ronda altera un criterio de aceptación, una decisión de diseño o una interfaz aprobada, o implementa una solución distinta del plan vigente sin reportarlo como bloqueo. | `pause` | `plan_ref`, `decision_refs`, `deviation_report` |
| 4 | INV-4 | evidence — Persistir la evidencia | Ningún avance invocado en la ronda cuenta como tal sin su referencia de evidencia durable y citable, registrada antes de cerrar la ronda. | La ronda declara un avance sin una referencia de evidencia durable que lo respalde, o la referencia no puede consultarse. | `pause` | `evidence_refs`, `observed_at`, `advance_claims` |
| 5 | INV-5 | isolation — Mantener el aislamiento del área de trabajo | Una ejecución no lee ni escribe áreas de trabajo ajenas, no contamina la línea principal de trabajo ni mezcla estados de dos ejecuciones; opera solo sobre su área asignada y parte de la última instantánea confirmada de esa misma ejecución. | La ronda lee o escribe el área de otra ejecución, escribe en la línea principal de trabajo, o inicia desde un estado que no es la última instantánea confirmada de la misma ejecución. | `rollback_and_pause` | `execution_id`, `worktree_path`, `base_snapshot_ref`, `accessed_paths` |

La columna `nombre` muestra el identificador técnico (`name`) y la etiqueta de negocio (`label`) de cada entrada del JSON.

~~~json
{
  "schema": "agent-loop-invariants/catalog/v1",
  "catalog_version": 1,
  "status": "active",
  "effective_from": "2026-10-20",
  "invariants": [
    {
      "id": 1,
      "code": "INV-1",
      "name": "scope",
      "label": "No ampliar el alcance",
      "statement": "La ronda trabaja únicamente sobre el trabajo documentado y la versión vigente de su baseline; no introduce criterios, tareas ni entregables fuera de ese baseline.",
      "violation_condition": "La ronda produce o intenta producir un criterio, tarea, entregable o cambio de alcance que no figura en el baseline vigente.",
      "violation_action": "pause",
      "required_evidence": ["baseline_ref", "round_deliverables", "out_of_scope_findings"]
    },
    {
      "id": 2,
      "code": "INV-2",
      "name": "protected",
      "label": "No tocar lo protegido",
      "statement": "La ronda no escribe fuera de su área de trabajo asignada ni modifica archivos protegidos o compartidos; toda escritura ocurre dentro del aislamiento asignado.",
      "violation_condition": "Existe al menos una escritura cuyo path no pertenece al write_area o coincide con un path de la lista de protegidos vigente.",
      "violation_action": "rollback_and_pause",
      "required_evidence": ["write_area", "protected_profile", "changed_paths", "worktree_path"]
    },
    {
      "id": 3,
      "code": "INV-3",
      "name": "no_design",
      "label": "No decidir diseño en la ejecución",
      "statement": "Quien ejecuta el trabajo no redefine criterios de aceptación, no rediseña la solución ni sustituye decisiones del plan vigente por criterio propio.",
      "violation_condition": "La ronda altera un criterio de aceptación, una decisión de diseño o una interfaz aprobada, o implementa una solución distinta del plan vigente sin reportarlo como bloqueo.",
      "violation_action": "pause",
      "required_evidence": ["plan_ref", "decision_refs", "deviation_report"]
    },
    {
      "id": 4,
      "code": "INV-4",
      "name": "evidence",
      "label": "Persistir la evidencia",
      "statement": "Ningún avance invocado en la ronda cuenta como tal sin su referencia de evidencia durable y citable, registrada antes de cerrar la ronda.",
      "violation_condition": "La ronda declara un avance sin una referencia de evidencia durable que lo respalde, o la referencia no puede consultarse.",
      "violation_action": "pause",
      "required_evidence": ["evidence_refs", "observed_at", "advance_claims"]
    },
    {
      "id": 5,
      "code": "INV-5",
      "name": "isolation",
      "label": "Mantener el aislamiento del área de trabajo",
      "statement": "Una ejecución no lee ni escribe áreas de trabajo ajenas, no contamina la línea principal de trabajo ni mezcla estados de dos ejecuciones; opera solo sobre su área asignada y parte de la última instantánea confirmada de esa misma ejecución.",
      "violation_condition": "La ronda lee o escribe el área de otra ejecución, escribe en la línea principal de trabajo, o inicia desde un estado que no es la última instantánea confirmada de la misma ejecución.",
      "violation_action": "rollback_and_pause",
      "required_evidence": ["execution_id", "worktree_path", "base_snapshot_ref", "accessed_paths"]
    }
  ],
  "action_severity": { "pause": 1, "rollback_and_pause": 2 },
  "change_policy": {
    "versioning": "monotonic_integer",
    "requires_new_version": true,
    "removal_requires_explicit_approval": true,
    "production_downgrade_forbidden": ["INV-2", "INV-5"]
  }
}
~~~

Regla: si tabla y JSON discrepan, prevalece el JSON y la skill es inválida hasta corregir la tabla.

## Declaración de la ronda

Antes de la ronda 1 la función de control resuelve y registra, junto al baseline, un contexto de ronda (`RoundInvariantContext`):

~~~json
{
  "schema": "agent-loop-invariants/context/v1",
  "catalog_version": 1,
  "execution_id": "ejemplo-20261020T001500Z",
  "worktree_path": ".worktrees/ejemplo",
  "base_snapshot_ref": "round-000-rev-1",
  "write_area": ["src/**", "tests/**"],
  "protected_profile": "development",
  "protected_paths": [".git/**", ".opencode/**", "main"],
  "protected_source": ["skill-default", "project/protected-files"],
  "resolved_at": "2026-10-20T00:15:00Z"
}
~~~

Reglas:

- `execution_id` no se reutiliza entre ejecuciones.
- `worktree_path` no es la raíz del repositorio.
- `base_snapshot_ref` es la última instantánea confirmada de la misma ejecución o la instantánea inicial.
- `write_area` es una lista cerrada, no vacía, y no puede contener `**` solo, la raíz, `.git/**`, worktrees ajenos ni el padre del worktree.
- `protected_profile` es `development` o `production`; el valor por defecto es `development`.
- El contexto se persiste y se confirma por lectura antes de la ronda 1.
- Si falta un campo, los invariantes afectados son `not_evaluable` y la ronda no se confirma.
- Cada ronda hereda el contexto. Cambiar el contexto es un cambio de baseline registrado antes de la ronda, nunca a mitad de ronda.

## Verificación al cierre de ronda

Algoritmo:

1. Precondición: ronda funcional terminada y resultado observado.
2. Congelar resultado y evidencia.
3. Evaluar los cinco invariantes en orden 1 a 5 con veredicto `pass`, `violated` o `not_evaluable`, cada uno con su evidencia.
4. Agregar: cualquier `violated` produce `violated`; si no hay violaciones y hay algún `not_evaluable`, produce `not_evaluable`; solo cinco `pass` producen `pass`.
5. Persistir el `RoundInvariantCheck` junto al resultado y confirmar la lectura antes de actuar o clasificar.
6. `pass`: estado `confirmed`; la ronda queda habilitada para clasificación e instantánea según el loop.
7. `violated`: construir y persistir el `InvariantViolationReport`; aplicar la acción de mayor severidad; estado `paused` o `rolled_back_and_paused`; no se confirma ni cuenta como avance.
8. `not_evaluable`: registrar la información faltante; estado `not_confirmed`; sin avance, sin reporte de violación y sin pausa ni vuelta atrás por esta skill.
9. Si falla la persistencia: no confirmar, no despachar la ronda siguiente, pausar y elevar un fallo operativo; reintentar; no aplicar una vuelta atrás destructiva hasta que el reporte sea durable.
10. Un check no se reutiliza para otra ronda ni para otra ejecución.

Schema del check:

~~~json
{
  "schema": "agent-loop-invariants/check/v1",
  "catalog_version": 1,
  "check_id": "CHK-ejemplo-R001",
  "execution_id": "ejemplo-20261020T001500Z",
  "round": 1,
  "checked_at": "2026-10-20T00:20:00Z",
  "checked_by": "control",
  "executor": "constructor",
  "verdict": "pass",
  "invariants": [
    { "id": 1, "code": "INV-1", "verdict": "pass", "evidence_refs": ["EV-1"], "observed_fact": null },
    { "id": 2, "code": "INV-2", "verdict": "pass", "evidence_refs": ["EV-2"], "observed_fact": null },
    { "id": 3, "code": "INV-3", "verdict": "pass", "evidence_refs": ["EV-3"], "observed_fact": null },
    { "id": 4, "code": "INV-4", "verdict": "pass", "evidence_refs": ["EV-4"], "observed_fact": null },
    { "id": 5, "code": "INV-5", "verdict": "pass", "evidence_refs": ["EV-5"], "observed_fact": null }
  ],
  "violation_report_id": null,
  "action": "none",
  "resulting_state": "confirmed",
  "missing_information": []
}
~~~

Reglas del check:

- `invariants` tiene exactamente cinco entradas, en orden, con `id` 1 a 5 y su `code` correspondiente.
- `checked_by` es siempre `control` y distinto de `executor`.
- `pass` exige evidencia no vacía.
- `violated` exige `observed_fact` y evidencia.
- `not_evaluable` exige `missing_information`.
- `action` es `none` para `pass` y para `not_evaluable`, y la acción de mayor severidad para `violated`.

## Reporte y acción ante violaciones

~~~json
{
  "schema": "agent-loop-invariants/violation/v1",
  "report_id": "VIO-ejemplo-R001",
  "catalog_version": 1,
  "execution_id": "ejemplo-20261020T001500Z",
  "round": 1,
  "reported_at": "2026-10-20T00:20:00Z",
  "checked_by": "control",
  "violations": [
    {
      "invariant_id": 2,
      "invariant_code": "INV-2",
      "observed_fact": "La ronda escribió un path fuera del write_area.",
      "evidence_refs": ["EV-2"],
      "affected_scope": "path/no/autorizado"
    }
  ],
  "action": "rollback_and_pause",
  "action_rationale": "La integridad del área compartida está en juego.",
  "resulting_state": "rolled_back_and_paused",
  "requires_operator_signal": true,
  "resume_condition": "El operador confirma la corrección de la causa y el control re-verifica los invariantes violados.",
  "supersedes": null
}
~~~

Reglas del reporte:

- Hay un reporte por check y `violations` lista todas las violaciones detectadas.
- `action` es la de mayor severidad entre las violaciones.
- `affected_scope` describe paths, criterios, tareas o worktrees afectados.
- `requires_operator_signal` es siempre `true` y `resume_condition` no está vacío.
- El reporte se persiste antes de aplicar la acción y no se edita después: una corrección es un reporte nuevo que declara `supersedes`.
- Si el reporte no puede persistirse, no se confirma, no se despacha la ronda siguiente, se pausa y se eleva un fallo operativo.

Tabla de acción:

| Violación | Acción |
|-----------|--------|
| `INV-1` No ampliar el alcance | `pause` |
| `INV-2` No tocar lo protegido | `rollback_and_pause` |
| `INV-3` No decidir diseño en la ejecución | `pause` |
| `INV-4` Persistir la evidencia | `pause` |
| `INV-5` Mantener el aislamiento del área de trabajo | `rollback_and_pause` |
| Varias | La de mayor severidad; `rollback_and_pause` prevalece; el reporte lista todas |

- `pause`: detiene nuevas rondas, conserva el estado y espera la señal del operador. Nada de la ronda violadora se confirma.
- `rollback_and_pause`: descarta los efectos, restaura la última instantánea confirmada y pausa. El mecanismo de vuelta atrás es externo a esta skill.
- En `production` no se degradan `INV-2` ni `INV-5` a una pausa simple.

## Evidencia requerida por invariante

| Invariante | Evidencia | Cómo se observa |
|------------|-----------|-----------------|
| `INV-1` | `baseline_ref`, `round_deliverables`, `out_of_scope_findings` | Comparar entregables y afirmaciones contra el baseline; todo hallazgo nuevo se registra como observación o bloqueo. |
| `INV-2` | `write_area`, `protected_profile`, `changed_paths`, `worktree_path` | `git diff --name-only`, `git status --porcelain`, `git worktree list --porcelain`. |
| `INV-3` | `plan_ref`, `decision_refs`, `deviation_report` | Comparar diff y decisiones contra el plan; toda desviación se reporta como bloqueo. |
| `INV-4` | `evidence_refs`, `observed_at`, `advance_claims` | Cada avance mapea a una referencia durable y resoluble. |
| `INV-5` | `execution_id`, `worktree_path`, `base_snapshot_ref`, `accessed_paths` | Registro de instancias, `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`, `git rev-parse HEAD`, `git worktree list --porcelain`. |

La evidencia se registra antes de cerrar la ronda. Una referencia no resoluble produce `not_evaluable`, nunca `pass`. Cada ronda cita la evidencia de su propio resultado y la evidencia de escritura incluye el path exacto y el comando.

### Evidencia material y herencia

Una referencia que sostiene un avance material debe ser resoluble y declarar su estado: `verified`, `unverified` o `discrepant`.

| Estado de la referencia | Efecto sobre la ronda |
|-------------------------|-----------------------|
| `verified` | La referencia respalda el avance y la ronda puede confirmarse. |
| `unverified` | No respalda un avance material y la ronda no se confirma. |
| `discrepant` | Exige las dos fuentes en conflicto y no confirma la ronda. |

Reglas de la herencia:

- La evidencia heredada de una ronda anterior se reutiliza: no se re-verifica por rutina.
- Un estado mutable se re-observa solo cuando la decisión depende de su valor actual: es un registro nuevo, no una repetición.
- Una contradicción no confirma la ronda hasta que la autoridad la resuelve.

Esta aclaración no redefine INV-4: el catálogo, su versión, los cinco invariantes, los schemas y los criterios de aceptación se mantienen.

## Lista de lo protegido

Orden de resolución:

1. Lista del perfil activo (`development` o `production`).
2. Entradas de `project/protected-files` si están disponibles; si no lo están, se registra `protected_source_state: unavailable` sin inventar una lista.
3. Paths del baseline.
4. Todo path fuera del `write_area` queda protegido por omisión.

### Perfil development

Valor por defecto. Incluye:

- `.git/**`
- `.opencode/**`
- `.worktrees/**` de otras ejecuciones
- `main`
- Las entradas de `project/protected-files` que estén disponibles.

### Perfil production

Incluye todo lo del perfil `development` más:

- `.flowtask/agents/runner.md`
- `.flowtask/skills/memory-contract/SKILL.md`
- `.flowtask/skills/topic-keys-convention/SKILL.md`
- `.flowtask/skills/checkpoint-mixin/SKILL.md`
- `.flowtask/package.json`
- `.flowtask/config/**`

### Regla de mundo cerrado

Todo path que no pertenece al `write_area` de la ronda está protegido, aunque no figure en ninguna lista explícita. Por esa razón los archivos compartidos se tratan como protegidos sin importar si aparecen en la lista.

Reglas de la lista:

- Se resuelve antes de la ronda 1 y es consultable antes de actuar.
- La ronda no modifica su lista ni su `write_area`.
- Cambiar la lista o el área es un cambio de baseline registrado antes de la ronda.
- `protected_profile` y la severidad de `INV-2` e `INV-5` no se degradan en `production`.

## Aislamiento del área de trabajo

Comprobaciones obligatorias en cada cierre de ronda:

1. `worktree_path` es el asignado, distinto de la raíz y registrado en el contexto de la ronda.
2. La rama y el `HEAD` corresponden a la ejecución y a la última instantánea confirmada.
3. La lectura se limita al worktree propio. La lectura del repositorio principal en modo solo lectura está permitida y se registra; los worktrees ajenos están prohibidos.
4. La escritura se limita al `write_area` y al worktree propio. Escribir en la línea principal de trabajo está prohibido.
5. No se mezcla `task_id`, checkpoint, rama, worktree ni estado de otra ejecución.
6. La evidencia registra `pwd`, `git rev-parse --show-toplevel`, `git worktree list --porcelain`, `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain` y el registro de instancias.

Si el path o la identidad no se pueden verificar, `INV-5` es `not_evaluable`, nunca `pass`. Leer o escribir otro worktree, o escribir en la línea principal, produce `violated` y `rollback_and_pause`. Leer el repositorio principal en modo solo lectura no contamina la ejecución y se registra como evidencia.

## Reanudación

- La reanudación requiere una señal explícita del operador.
- El operador registra la causa corregida y la condición cumplida.
- Antes de la ronda siguiente se re-verifican los invariantes violados sobre el estado restaurado.
- Si la violación persiste, se emite un reporte nuevo y no se reanuda.
- Con vuelta atrás, la ejecución reanuda desde la última instantánea confirmada; sin vuelta atrás, el estado pausado se conserva tal cual.
- Reanudar sin corregir la causa es una violación nueva.
- Un nuevo inicio después del cierre es una ejecución nueva.

## Versionado y cambio del catálogo

- `catalog_version` es un entero monotónico que inicia en 1.
- Todo cambio exige una versión nueva y una entrada en el historial.
- Eliminar o subdividir un invariante requiere aprobación explícita y una versión nueva.
- Una ronda usa la versión activa al iniciar y la versión no se aplica retroactivamente.
- En `production` no se degradan `INV-2` ni `INV-5`.
- Las versiones anteriores siguen siendo citables.
- Un catálogo inválido —tabla y JSON discrepantes, invariante faltante o acción faltante— produce `not_evaluable` y no confirma la ronda.

Historial:

| versión | fecha | cambio | aprobación |
|---|---|---|---|
| 1 | 2026-10-20 | Catálogo inicial de cinco invariantes | Aprobación explícita del requisito funcional |

## Criterios de aceptación de la skill

1. El catálogo declara cinco invariantes con `id` 1 a 5 y `code` `INV-1` a `INV-5`.
2. Cada entrada tiene enunciado, condición de violación, acción y evidencia requerida.
3. El catálogo está versionado, con política de cambio e historial.
4. La verificación es exclusiva de la función de control y es bloqueante al cierre de ronda.
5. Los tres schemas están completos y son parseables.
6. El reporte de violación es durable, lista todas las violaciones y aplica la acción más severa.
7. La lista de lo protegido es explícita, tiene dos perfiles y es consultable antes de actuar.
8. El aislamiento define comandos y evidencia verificables.
9. La reanudación exige señal del operador y re-verificación de los invariantes violados.
10. No hay espacios de nombres nuevos, ni cambios en archivos compartidos, ni runtime.
11. El contenido funcional no incluye identificadores de coordinación, fases ni historia.
12. `QA.md` contiene los checks estáticos, la matriz de aceptación y el tabletop.

## QA de aceptación

La verificación vive en `QA.md`, en el mismo directorio. Un PASS exige los 14 checks estáticos en verde, la matriz de aceptación con sus 10 criterios completos y los 10 escenarios de tabletop correctos. No hay PASS parcial: cualquier check fallido bloquea la entrega y se reporta como fallo operativo.
