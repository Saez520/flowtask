# QA — agent-loop-termination

## Propósito

Este documento verifica la skill normativa `agent-loop-termination` como documento: comprueba que su
estructura, su schema, sus enums y sus reglas internas son coherentes entre sí y que satisfacen los
criterios de aceptación del contrato de terminación.

La verificación es **estática y de lectura**. No ejecuta el predicado, no escribe en el mecanismo de
memoria, no invoca al runner y no modifica ningún archivo.

Todos los comandos se ejecutan **desde la raíz del repositorio**. El directorio de trabajo temporal
es `.flowtask/.temp/` y está ignorado por el control de versiones.

## A. Chequeos estáticos

### A-01 — Archivo y frontmatter

```bash
test -f .flowtask/skills/agent-loop-termination/SKILL.md \
  && test -f .flowtask/skills/agent-loop-termination/QA.md \
  && sed -n '1,11p' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** los dos archivos existen y el frontmatter declara `name: agent-loop-termination`,
`description` en español, `license: MIT`, `compatibility: opencode`, `metadata.category: agent-loop`
y `metadata.scope: flowtask`.
**PASS** si ambos archivos existen y el frontmatter coincide con esos valores. **FAIL** en cualquier
otro caso.

### A-02 — Orden de las dieciséis secciones

```bash
grep -n '^## ' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** exactamente 16 encabezados de nivel dos, en este orden: `Propósito`,
`Fronteras`, `Cuándo se carga y cuándo se evalúa`, `Entradas y salida del predicado`,
`Contrato de lectura del progreso`, `Precedencia de las condiciones`, `Algoritmo de evaluación`,
`Condiciones de terminación`, `Pausa`, `Reanudación`, `Cierre y abandono seguro`, `Persistencia y
consulta`, `Schema TerminationRecord v1`, `Configuración`, `Distinción respecto del presupuesto`,
`Invariantes de aceptación`.
**PASS** si la cantidad es 16 y el orden coincide exactamente. **FAIL** si falta, sobra o se reordena
cualquier sección.

### A-03 — Schema parseable

```bash
mkdir -p .flowtask/.temp
awk '/^~~~json$/{f=1;next} f&&/^~~~$/{exit} f' \
  .flowtask/skills/agent-loop-termination/SKILL.md > .flowtask/.temp/termination-schema.json
node -e "JSON.parse(require('fs').readFileSync('.flowtask/.temp/termination-schema.json','utf8')); console.log('schema ok')"
```

**Salida esperada:** `schema ok` y código de salida 0.
**PASS** si el bloque canónico parsea y el documento contiene las claves de primer nivel `schema`,
`execution_id`, `work_id`, `state`, `round`, `baseline_version`, `pause`, `closure`, `transitions`,
`integrity`, `created_at` y `updated_at`.
**FAIL** si el JSON no parsea o falta alguna de esas claves.

### A-04 — Seis condiciones de terminación

```bash
grep -nE '^### [1-6]\. ' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** seis subsecciones, `### 1.` a `### 6.`, dentro de `Condiciones de
terminación`.
**PASS** si aparecen las seis. **FAIL** si falta alguna o si se agrega una séptima condición.

### A-05 — Precedencia 1–6

```bash
grep -nE '^\| [1-6] \| ' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** al menos seis filas de tabla, una por orden de precedencia, con la fila `—`
(progreso no disponible) fuera del rango numerado.
**PASS** si los seis órdenes están presentes y `progress_unavailable` no aparece numerado como
séptimo orden. **FAIL** en cualquier otro caso.

### A-06 — Tres veredictos de cierre

```bash
grep -nE '"success" \| "safe_abandonment" \| "external_cause"' \
  .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** al menos una coincidencia con los tres veredictos en la misma declaración.
**PASS** si el enum de veredictos contiene exactamente esos tres valores. **FAIL** si falta o sobra
alguno.

### A-07 — Tablas de pausa y reanudación

```bash
grep -nE '^## (Pausa|Reanudación)$' .flowtask/skills/agent-loop-termination/SKILL.md
grep -c 'resume_conditions' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** dos encabezados (`Pausa` y `Reanudación`) y al menos una aparición de
`resume_conditions`.
**PASS** si ambas secciones existen y las condiciones de reanudación están tipadas. **FAIL** si falta
alguna.

### A-08 — Contrato de lectura del progreso

```bash
grep -nE '^## Contrato de lectura del progreso$' \
  .flowtask/skills/agent-loop-termination/SKILL.md
grep -c 'flow-state/{execution_id}/progress' \
  .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** la sección existe y el namespace de progreso aparece al menos una vez como
referencia de lectura.
**PASS** si ambos conditions se cumplen. **FAIL** si el namespace no aparece o si la sección
falta.

### A-09 — Frontera de presupuesto

```bash
grep -nE '^## Distinción respecto del presupuesto$' \
  .flowtask/skills/agent-loop-termination/SKILL.md
grep -c 'continue' .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** la sección existe y el texto establece que el consumo alto sin condición
produce `continue`.
**PASS** si la frontera está declarada de forma explícita. **FAIL** si la sección falta o si en
algún lugar se infiere una terminación a partir del consumo.

### A-10 — Tokens prohibidos en la skill

```bash
grep -nE 'CA-agent-loop-termination|F1\.[0-9]|Hermes|AgentRun|token_budget|cost_budget|max_rounds' \
  .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** sin coincidencias (código de salida 1).
**PASS** si no hay coincidencias. **FAIL** si aparece alguna coincidencia.

### A-11 — Namespace de terminación declarado

```bash
grep -c 'flow-state/{execution_id}/termination' \
  .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** 2 o más coincidencias (topic key de escritura y topic key de lectura).
**PASS** si el namespace aparece al menos dos veces. **FAIL** si no aparece o si el nombre del
namespace es otro.

### A-12 — Sin escritura en el registro de progreso

```bash
grep -n 'mem_save.*flow-state/{execution_id}/progress' \
  .flowtask/skills/agent-loop-termination/SKILL.md
```

**Salida esperada:** sin coincidencias (código de salida 1).
**PASS** si el registro de progreso solo se lee. **FAIL** si aparece una escritura dirigida al
registro de progreso.

### A-13 — Coherencia de enums entre tipos, algoritmo y schema

```bash
node -e '
const fs = require("fs");
const s = fs.readFileSync(".flowtask/skills/agent-loop-termination/SKILL.md", "utf8");
const ts = s.split("~~~ts")[1].split("~~~")[0];
const schema = JSON.parse(s.split("~~~json")[1].split("~~~")[0]);
const sets = {
  outcome: ["continue", "pause", "close"],
  verdict: ["success", "safe_abandonment", "external_cause"],
  reason: ["none", "invariant_violation", "irrecoverable_failure", "objective_met", "explicit_limit", "authority_block", "no_verifiable_progress", "progress_unavailable"],
  state: ["running", "paused", "closed"]
};
let ok = true;
for (const name of Object.keys(sets)) {
  for (const v of sets[name]) {
    if (!ts.includes("\"" + v + "\"")) { console.log("falta en tipos: " + name + "." + v); ok = false; }
  }
}
if (!sets.state.includes(schema.state)) { console.log("state fuera de enum: " + schema.state); ok = false; }
if (!sets.outcome.includes(schema.transitions[0].outcome)) { console.log("outcome fuera de enum"); ok = false; }
if (!sets.reason.includes(schema.pause.reason)) { console.log("reason fuera de enum: " + schema.pause.reason); ok = false; }
console.log(ok ? "enums ok" : "enums inconsistentes");
process.exit(ok ? 0 : 1);
'
```

**Salida esperada:** `enums ok` y código de salida 0.
**PASS** si los enums de `outcome`, `verdict`, `reason` y `state` coinciden entre el bloque de tipos,
el algoritmo, las condiciones y el schema. **FAIL** si algún valor del schema está fuera de su enum
o si falta algún literal en el bloque de tipos.

### A-14 — Diff limitado a los dos artefactos

```bash
git status --porcelain --untracked-files=all | awk '{print $2}' \
  | grep -vE '^\.flowtask/skills/agent-loop-termination/(SKILL|QA)\.md$'
```

**Salida esperada:** sin salida.
**PASS** si no hay ningún otro archivo modificado o creado. **FAIL** si aparece un archivo fuera de
los dos artefactos, en particular un archivo compartido (`runner.md`, `memory-contract`,
`topic-keys-convention`, `checkpoint-mixin`) o el espejo `.opencode/skills/`.

## B. Matriz de comportamiento

Cada fila es un escenario de tabletop sobre el algoritmo normativo. `Reason` y `Precedencia`
corresponden a la decisión devuelta; `Veredicto` solo aplica a las salidas `close`.

| ID | Supuesto | Resultado esperado | Reason | Precedencia | Veredicto |
|----|----------|--------------------|--------|-------------|-----------|
| Q-01 | Criterios `known` con `total = 5`, `met = 5`, `evidenced_met = 5`, evidencia suficiente, sin invariante ni fallo declarado | `close`: la ejecución termina y no se despacha otra ronda | `objective_met` | 3 | `success` |
| Q-02 | Señal de invariante vigente y todos los criterios completos con evidencia | `pause`: no se declara éxito y la ejecución se detiene por seguridad | `invariant_violation` | 1 | — |
| Q-03 | Fallo irrecuperable declarado y criterios completos con evidencia | `close`: el fallo irrecuperable prevalece sobre el objetivo aparente | `irrecoverable_failure` | 2 | `external_cause` |
| Q-04 | Objetivo cumplido y límite expreso con efecto de cierre ya alcanzado | `close`: la precedencia 3 gana sobre la 4 | `objective_met` | 3 | `success` |
| Q-05 | Límite expreso con efecto de cierre alcanzado y bloqueo de autoridad abierto | `close`: la precedencia 4 gana sobre la 5 | `explicit_limit` | 4 | `safe_abandonment` |
| Q-06 | Bloqueo de autoridad abierto y contador de estancamiento en el umbral | `pause`: la precedencia 5 gana sobre la 6 | `authority_block` | 5 | — |
| Q-07 | `rounds_without_verifiable_progress = 3` con `pause_threshold = 3` | `pause` por estancamiento sin propuesta de abandono | `no_verifiable_progress` | 6 | — |
| Q-08 | `rounds_without_verifiable_progress = 6` con umbral de propuesta 6 | `pause` por estancamiento con `proposed_abandonment = true`; nunca cierra | `no_verifiable_progress` | 6 | — |
| Q-09 | Rondas intercaladas clasificadas `not_evaluable` con contador en 2 y umbral 3 | `continue`: las rondas `not_evaluable` no incrementan el contador | `none` | `null` | — |
| Q-10 | Pausa por estancamiento y solicitud de reanudación sin hipótesis, baseline ni decisión nuevos | La reanudación se **rechaza** y la pausa se mantiene; no hay transición | `no_verifiable_progress` | 6 | — |
| Q-11 | Pausa por estancamiento y reanudación con `new_hypothesis` y referencia | `continue` sobre la misma ejecución, con la misma numeración y los mismos contadores | `none` | `null` | — |
| Q-12 | Pausa por autoridad y decisión externa registrada que resuelve el bloqueo | `continue`: la ejecución reanuda con la misma numeración y sin reiniciar contadores | `none` | `null` | — |
| Q-13 | Pausa por autoridad y decisión registrada que ordena cerrar el trabajo | `close` por abandono seguro | `authority_block` | 5 | `safe_abandonment` |
| Q-14 | Fallo irrecuperable declarado con `ref` y `diagnosis_ref` | `close` que conserva trabajo, historial, diagnóstico y referencias preservadas | `irrecoverable_failure` | 2 | `external_cause` |
| Q-15 | Fallo operativo transitorio sin resultado observado | El predicado **no se evalúa**: no hay ronda funcional | — | — | — |
| Q-16 | Límite expreso declarado, alcanzado, con `ref` y efecto de cierre | `close` con el efecto declarado aplicado | `explicit_limit` | 4 | `safe_abandonment` |
| Q-17 | Límite expreso declarado, alcanzado, con `ref` y efecto de pausa | `pause` con el efecto declarado aplicado; no cierra | `explicit_limit` | 4 | — |
| Q-18 | Registro de progreso ausente o no disponible | `pause` de seguridad; no declara éxito ni abandono | `progress_unavailable` | `null` | — |
| Q-19 | Registro de progreso contradictorio (`evidenced_met < met`) | `pause` de seguridad por contradicción | `progress_unavailable` | `null` | — |
| Q-20 | Pausa por progreso no disponible y reanudación con `progress_readable` más última instantánea confirmada | `continue`: la ejecución se reanuda con la última instantánea restaurada | `none` | `null` | — |
| Q-21 | Ejecución ya cerrada que se reevalúa | Devuelve el cierre existente **sin** transición nueva; no se reabre | — | — | el veredicto ya registrado |
| Q-22 | Consulta posterior a un cierre por abandono seguro | Devuelve veredicto, motivo, evidencia y `preserved_refs`; ningún criterio figura cumplido sin evidencia | — | — | `safe_abandonment` |
| Q-23 | Lectura del registro de progreso | La lectura no modifica valores, clasificaciones, evidencia ni numeración | — | — | — |
| Q-24 | Consumo alto de recursos sin ninguna de las seis condiciones cumplidas | `continue`: el predicado no detiene por costo | `none` | `null` | — |
| Q-25 | Consumo alto de recursos y límite expreso declarado por el negocio y alcanzado | Se aplica el efecto declarado del límite; el consumo no interviene | `explicit_limit` | 4 | según el efecto declarado |
| Q-26 | Dos evaluaciones con la misma `evaluation_key` y la misma causa de pausa | Una sola transición: la segunda devuelve la pausa existente | — | — | — |
| Q-27 | Baseline vacío: `criteria.total = 0` con `criteria.state = "known"` | `continue`: el baseline vacío nunca declara éxito | `none` | `null` | — |
| Q-28 | `criteria.state = "not_applicable"`, tareas `known` con `total = 4`, `completed = 4`, `evidenced_completed = 4`, evidencia suficiente y `objective_confirmation` con referencia | `close` por la vía alternativa | `objective_met` | 3 | `success` |
| Q-29 | `criteria.state = "not_applicable"` con tareas completas pero sin `objective_confirmation` | `continue`: sin confirmación explícita no hay éxito | `none` | `null` | — |
| Q-30 | Invariante sin constancia de resolución y la autoridad declara abandono final | `close` por abandono seguro con ese motivo | `invariant_violation` | 1 | `safe_abandonment` |
| Q-31 | Varias señales de invariante activas con referencias distintas | Gana la de `ref` lexicográficamente menor y **todas** se citan en la evidencia | `invariant_violation` | 1 | — |
| Q-32 | Registro de terminación ilegible o contradictorio | Fallo operativo `termination_unavailable`: sin despacho, sin sobrescritura del registro | — | — | — |
| Q-33 | Bloqueos abiertos sin marca de autoridad | `pause` de seguridad: no se asume que el bloqueo no requiere autoridad | `progress_unavailable` | `null` | — |
| Q-34 | Límite expreso declarado y alcanzado pero sin `ref` | El límite se ignora y se informa configuración inválida; el resto de la evaluación continúa | según la condición que aplique | según la condición que aplique | — |
| Q-35 | La misma `evaluation_key` produce un resultado distinto del ya registrado | Fallo operativo: se informa el conflicto y el registro existente **no** se sobrescribe | — | — | — |

## C. Trazabilidad de criterios

Cada criterio de aceptación del contrato se mapea a la sección o regla de la skill y a al menos un
escenario de la matriz.

| Criterio | Sección o regla de la skill | Escenario |
|----------|-----------------------------|-----------|
| AC-01 | «Condiciones de terminación» → 3, y `objective_met` en «Algoritmo de evaluación» | Q-01 |
| AC-02 | «Precedencia de las condiciones» → orden 1, y «Condiciones de terminación» → 1 | Q-02 |
| AC-03 | «Condiciones de terminación» → 6, y «Configuración» → `stagnation.pause_threshold` / `stagnation.abandonment_proposal_threshold` | Q-07, Q-08 |
| AC-04 | «Contrato de lectura del progreso» → clasificación de ronda, y «Condiciones de terminación» → 6 | Q-09 |
| AC-05 | «Reanudación» → estancamiento | Q-10 |
| AC-06 | «Condiciones de terminación» → 5, y «Reanudación» → autoridad | Q-12 |
| AC-07 | «Reanudación» → numeración y contadores conservados | Q-12 |
| AC-08 | «Condiciones de terminación» → 2, y «Cierre y abandono seguro» → `external_cause` | Q-14 |
| AC-09 | «Cuándo se carga y cuándo se evalúa» → fallo operativo sin ronda funcional | Q-15 |
| AC-10 | «Condiciones de terminación» → 4, y «Algoritmo de evaluación» → `apply_limit` | Q-16, Q-17 |
| AC-11 | «Contrato de lectura del progreso» → reglas de la lectura, y «Algoritmo de evaluación» → paso 6 | Q-18, Q-19 |
| AC-12 | «Reanudación» → restauración de la última instantánea | Q-11, Q-20 |
| AC-13 | «Cierre y abandono seguro» → regla de no reabrir, y «Algoritmo de evaluación» → paso 2 | Q-21 |
| AC-14 | «Cierre y abandono seguro» → garantías del abandono seguro, y «Persistencia y consulta» → consulta | Q-22 |
| AC-15 | «Contrato de lectura del progreso» → solo lectura, y «Fronteras» | Q-23 |
| AC-16 | «Precedencia de las condiciones» → reglas de precedencia | Q-02, Q-04, Q-05, Q-06 |
| AC-17 | «Distinción respecto del presupuesto» | Q-24 |
| AC-18 | «Contrato de lectura del progreso» → `progress_unavailable`, y «Cierre y abandono seguro» → consulta posterior | Q-18, Q-22 |
| AC-19 | «Condiciones de terminación» → 1, y «Reanudación» → invariante | Q-30 |
| AC-20 | «Condiciones de terminación» → 4 (límite declarado por el negocio) | Q-25 |

## D. Casos límite y concurrencia

| ID | Caso | Comportamiento esperado | Verificación |
|----|------|-------------------------|--------------|
| D-01 | Dos evaluaciones concurrentes de la misma ronda | Comparten `evaluation_key`; solo una escribe la transición | Q-26, Q-35 |
| D-02 | Escritura condicionada por `integrity.record_version` | Si el valor cambió entre la lectura y la escritura, se relee y se reevalúa; no se pisa el registro ajeno | «Persistencia y consulta» |
| D-03 | Payload que excede el límite de la observación | Fallo operativo; no se trunca el historial ni se crea una fuente paralela | «Persistencia y consulta» |
| D-04 | Mecanismo de memoria no disponible | Bloqueo: sin despacho de rondas y sin archivos locales de respaldo | «Persistencia y consulta» |
| D-05 | Señal de invariante levantada mientras la ejecución está pausada | No habilita la reanudación por sí sola: se exige además la constancia de resolución | Q-30 |
| D-06 | Límite alcanzado mientras el registro de progreso está ausente | El efecto del límite se aplica antes de la pausa de seguridad por progreso no disponible | «Algoritmo de evaluación» → paso 6.a |
| D-07 | Bloqueo de autoridad abierto pero con `refs` vacío y sin bloqueos con marca | No es un bloqueo de autoridad: se ignora la señal y sigue la evaluación | Q-33 |
| D-08 | Varios límites expresos alcanzados a la vez | Gana el `ref` lexicográficamente menor y todos se citan en la evidencia | «Condiciones de terminación» → 4 |
| D-09 | Rondas `not_evaluable` intercaladas entre rondas efectivas | El contador no se reinicia ni se incrementa | Q-09 |
| D-10 | `criteria.state = "unknown"` con el resto de los hechos en orden | Nunca hay éxito; el resultado es `continue` o la pausa de la condición que aplique | Q-29 |
| D-11 | Reevaluación de una ejecución pausada por la misma causa, sin señal nueva | Devuelve la pausa existente sin transición nueva | Q-26 |
| D-12 | Consultas simultáneas al registro de terminación | La consulta es de solo lectura y no muta el registro | Q-22, Q-23 |

## E. Procedimiento de verificación

1. Preparar el directorio temporal:

   ```bash
   mkdir -p .flowtask/.temp
   ```

2. Ejecutar los chequeos estáticos A-01 a A-14 en orden y registrar la salida de cada comando. Un
   solo `FAIL` detiene la verificación y bloquea el resultado.

3. Extraer y parsear el schema canónico:

   ```bash
   awk '/^~~~json$/{f=1;next} f&&/^~~~$/{exit} f' \
     .flowtask/skills/agent-loop-termination/SKILL.md > .flowtask/.temp/termination-schema.json
   node -e "JSON.parse(require('fs').readFileSync('.flowtask/.temp/termination-schema.json','utf8')); console.log('schema ok')"
   ```

4. Extraer y parsear el ejemplo compacto de cierre:

   ```bash
   awk 'BEGIN{n=0} /^~~~json$/{n++; f=(n==2); next} f&&/^~~~$/{exit} f' \
     .flowtask/skills/agent-loop-termination/SKILL.md > .flowtask/.temp/termination-closure.json
   node -e "JSON.parse(require('fs').readFileSync('.flowtask/.temp/termination-closure.json','utf8')); console.log('closure ok')"
   ```

5. Confirmar que el progreso solo se lee:

   ```bash
   grep -n 'flow-state/{execution_id}/progress' \
     .flowtask/skills/agent-loop-termination/SKILL.md
   grep -n 'mem_save.*flow-state/{execution_id}/progress' \
     .flowtask/skills/agent-loop-termination/SKILL.md
   ```

   La primera orden lista las apariciones del namespace de progreso (referencias de lectura). La
   segunda no debe producir ninguna coincidencia.

6. Confirmar el namespace de escritura:

   ```bash
   grep -n 'flow-state/{execution_id}/termination' \
     .flowtask/skills/agent-loop-termination/SKILL.md
   ```

   Deben aparecer al menos dos coincidencias: topic key de escritura y topic key de lectura.

7. Buscar tokens prohibidos en la skill:

   ```bash
   grep -nE 'CA-agent-loop-termination|F1\.[0-9]|Hermes|AgentRun|token_budget|cost_budget|max_rounds' \
     .flowtask/skills/agent-loop-termination/SKILL.md
   ```

   Sin coincidencias.

8. Verificar el diff y la limpieza de whitespace:

   ```bash
   git diff --check
   git status --porcelain --untracked-files=all
   grep -nE '[[:blank:]]+$' \
     .flowtask/skills/agent-loop-termination/SKILL.md \
     .flowtask/skills/agent-loop-termination/QA.md
   ```

   `git diff --check` no reporta problemas y el estado muestra únicamente los dos artefactos. La
   última orden no debe encontrar trailing whitespace.

9. Revisar la matriz B contra el algoritmo y las tablas de la skill: cualquier contradicción entre un
   escenario `Q` y una regla de la skill bloquea el resultado.

10. Completar la matriz C verificando que cada criterio tiene sección o regla y escenario. Ninguna
    celda puede quedar vacía.

11. Registrar el resultado por criterio A, por bloque de la matriz B y por fila de la matriz C. No
    declarar PASS sin la matriz completa.

## F. Criterios de PASS/FAIL

**PASS** solo si se cumplen todas estas condiciones:

1. Los catorce chequeos estáticos A-01 a A-14 dan PASS.
2. Los dos bloques JSON parsean y el canónico contiene las doce claves de primer nivel exigidas.
3. Los enums de `outcome`, `verdict`, `reason` y `state` son coherentes entre tipos, algoritmo,
   condiciones y schema.
4. La matriz B contiene los treinta y cinco escenarios Q-01 a Q-35, sin celdas vacías y sin
   contradicciones con las reglas de la skill.
5. La matriz C contiene los veinte criterios AC-01 a AC-20, cada uno con sección o regla y al menos
   un escenario asociado, sin celdas vacías.
6. El registro de progreso aparece solo como referencia de lectura: no hay ninguna escritura
   dirigida a él.
7. No hay tokens prohibidos en la skill.
8. El diff contiene únicamente los dos artefactos del contrato y no toca archivos compartidos ni el
   espejo de distribución.

**FAIL** en cualquier otro caso, con indicación del chequeo, del comando y de la salida obtained.

Resultado de la verificación: **PASS / FAIL** (completar con el detalle de los comandos ejecutados).
