# QA — agent-loop-run

## Propósito

Este documento verifica la skill normativa `agent-loop-run` como **documento**: comprueba que
su estructura, sus cuatro schemas, sus enumeraciones, sus tablas y sus matrices son coherentes
entre sí y que satisfacen los criterios de aceptación del contrato del controlador de la
ejecución.

La verificación es **estática y de solo lectura**. No ejecuta el controlador, no escribe en el
mecanismo de memoria, no invoca agentes, no modifica archivos del repositorio y no crea
registros de flujo.

Alcance de la verificación:

- **Alcance normativo:** `SKILL.md` (20 secciones) y `QA.md` (este documento).
- **Fuera de alcance:** cualquier cambio de comportamiento ejecutable, configuración, registro
  de flujo o contrato vecino. Esta verificación no escribe, no crea archivos versionados y no
  modifica registros de memoria.

Los conceptos de frontera —freno irreversible por gasto, cierre o abandono automático,
terminación de procesos, escalación de modelo, topes por participante, corte por dinero
estimado y conteo de rondas como freno— aparecen en este documento **solo como objeto de
verificación o como prohibición declarada**. Nunca como una capacidad habilitada.

Los identificadores prohibidos —identificador de coordinación de este trabajo, identificadores
de fase, nombres de hito y nombres de plan— se escriben **ofuscados** en los comandos de la
sección G, para que este documento no contenga ninguno de ellos y la verificación sea
reproducible sobre sí misma.

---

## Cómo se ejecuta

1. Todos los comandos se ejecutan **desde la raíz del repositorio**.
2. El directorio de trabajo temporal es `.flowtask/.temp/` y está ignorado por el control de
   versiones. Ningún archivo versionado se escribe ni se borra.
3. Las extracciones de los bloques de ejemplo se hacen con `awk` hacia `.flowtask/.temp/` y se
   validan con el intérprete de JavaScript del proyecto. El bloque 1 es el contexto de
   ejecución, el bloque 2 es el tope duro, el bloque 3 es el registro de ejecución y el bloque
   4 es la decisión del controlador.
4. Los chequeos se ejecutan **en orden**. Un solo **FAIL** detiene la verificación y bloquea
   el resultado: no hay PASS parcial.
5. La verificación **no escribe** en el mecanismo de memoria, no crea checkpoints, no invoca
   agentes y no modifica ningún archivo del repositorio.

---

## A. Chequeos estáticos

### A-01 — Archivos y frontmatter

```bash
test -f .flowtask/skills/agent-loop-run/SKILL.md \
  && test -f .flowtask/skills/agent-loop-run/QA.md \
  && sed -n '1,12p' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** los dos archivos existen y el frontmatter declara `name: agent-loop-run`,
`description` plegada en español, `license: MIT`, `compatibility: opencode`,
`metadata.category: agent-loop` y `metadata.scope: flowtask`.
**PASS** si ambos archivos existen y el frontmatter coincide con esos valores. **FAIL** en
cualquier otro caso.

### A-02 — Veinte secciones en orden exacto

```bash
grep -n '^## ' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** exactamente 20 encabezados de nivel dos, en este orden: `Propósito`,
`Alcance y fronteras`, `Términos`, `Cuándo se carga`, `Modelo de ejecución`, `Identidad y señal
de inicio`, `Baseline y tope duro`, `Registros de la ejecución`, `Orden de la ejecución`,
`Protocolo de inicio`, `Protocolo de ronda`, `Decisión del controlador`, `Freno duro por
gasto`, `Pausa y reanudación`, `Cierre y veredictos`, `Fallos operativos`, `Configuración`,
`Garantías del contrato`, `Matriz de aceptación`, `Ejemplos canónicos`.
**PASS** si la cantidad es 20 y el orden coincide exactamente. **FAIL** si falta, sobra o se
reordena cualquier sección.

### A-03 — Los cuatro bloques de ejemplo parsean

```bash
mkdir -p .flowtask/.temp
SKILL=.flowtask/skills/agent-loop-run/SKILL.md
for i in 1 2 3 4; do
  awk -v n="$i" 'BEGIN{c=0} /^~~~json$/{c++; f=(c==n); next} f&&/^~~~$/{exit} f' \
    "$SKILL" > ".flowtask/.temp/run-$i.json"
  node -e "JSON.parse(process.argv[1]); console.log('ok $i')" "$(cat ".flowtask/.temp/run-$i.json")"
done
```

**Salida esperada:** cuatro líneas `ok 1`, `ok 2`, `ok 3`, `ok 4` y código de salida 0.
**PASS** si los cuatro bloques parsean y sus esquemas son, en orden,
`agent-loop-run/context/v1`, `agent-loop-run/hard-limit/v1`, `agent-loop-run/v1` y
`agent-loop-run/decision/v1`. **FAIL** si alguno no parsea o si el esquema no coincide.

### A-04 — Claves del registro de ejecución

```bash
node -e "const o=JSON.parse(process.argv[1]);const k=['schema','execution','baseline','hard_limit','round','records','state','pause','closure','budget_gate','integrity','created_at','updated_at'];const m=k.filter(x=>!(x in o));console.log(m.length===0?'ok':m.join(','))" \
  "$(cat .flowtask/.temp/run-3.json)"
```

**Salida esperada:** `ok`.
**PASS** si están presentes las trece claves de primer nivel del registro de ejecución. **FAIL**
si falta alguna.

### A-05 — El contexto de ejecución referencia los cinco registros

```bash
node -e "const o=JSON.parse(process.argv[1]);console.log(Object.keys(o.records).sort().join(','))" \
  "$(cat .flowtask/.temp/run-1.json)"
```

**Salida esperada:** `budget,idempotency,progress,run,termination`.
**PASS** si el contexto referencia los cuatro registros operativos y el propio. **FAIL** si
falta alguna referencia o si aparece un namespace ajeno.

### A-06 — Claves de la decisión del controlador

```bash
node -e "const o=JSON.parse(process.argv[1]);const k=['schema','execution_id','round','termination','budget','decision','reason','pause','verdict','evidence_refs'];const m=k.filter(x=>!(x in o));console.log(m.length===0?'ok':m.join(','))" \
  "$(cat .flowtask/.temp/run-4.json)"
```

**Salida esperada:** `ok`.
**PASS** si están presentes las diez claves de primer nivel de la decisión. **FAIL** si falta
alguna.

### A-07 — El tope duro solo admite pausa y no trae valores por defecto

```bash
grep -oE '"effect":"[a-z]+"' .flowtask/skills/agent-loop-run/SKILL.md | sort -u
grep -oE '"(tokens|active_time_ms)":(null|[0-9]+)' .flowtask/skills/agent-loop-run/SKILL.md | sort -u
grep -nE '\| `hard_limit\.(tokens|active_time_ms)` \| `HardLimit v1` \| `null`' \
  .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** una sola forma de efecto, `"effect":"pause"`; los valores numéricos del
tope aparecen como enteros positivos o como `null`; y la tabla de configuración declara `null`
como valor por defecto de `hard_limit.tokens` y de `hard_limit.active_time_ms`.
**PASS** si no aparece ningún otro valor de efecto y no hay ningún valor numérico por
defecto. **FAIL** si aparece un efecto distinto de `pause` o un umbral por defecto.

### A-08 — Los cinco contratos de control se nombran por su nombre exacto

```bash
for s in agent-loop-progress agent-loop-invariants agent-loop-termination \
         agent-loop-idempotency agent-loop-budget; do
  printf '%s: ' "$s"
  grep -c "$s" .flowtask/skills/agent-loop-run/SKILL.md
done
```

**Salida esperada:** cada nombre aparece al menos una vez.
**PASS** si los cinco contratos están referenciados por su nombre exacto. **FAIL** si falta
alguno o si el nombre está escrito de otra forma.

### A-09 — Orden de inicio y orden de ronda con confirmaciones

```bash
awk '/^\*\*Antes de la ronda 1:\*\*$/{f=1;next} /^\*\*En cada ronda:\*\*$/{f=0} f' \
  .flowtask/skills/agent-loop-run/SKILL.md | grep -cE '^\| [0-9]+ \|'
awk '/^\*\*En cada ronda:\*\*$/{f=1;next} /^## Protocolo de inicio$/{f=0} f' \
  .flowtask/skills/agent-loop-run/SKILL.md | grep -cE '^\| [0-9]+ \|'
```

**Salida esperada:** `9` y `7`.
**PASS** si el orden previo a la ronda 1 tiene nueve pasos y el orden de ronda tiene siete, y si
cada paso anterior al despacho declara su confirmación por lectura. **FAIL** en cualquier otro
caso.

### A-10 — El único namespace nuevo es el del registro de ejecución

```bash
git diff -U0 -- \
  .flowtask/skills/memory-contract/SKILL.md \
  .flowtask/skills/topic-keys-convention/SKILL.md \
  .flowtask/skills/checkpoint-mixin/SKILL.md \
  | grep '^+' | grep -oE 'flow-state/\{execution_id\}/[a-z]+' | sort -u
```

**Salida esperada:** exactamente una línea, `flow-state/{execution_id}/run`.
**PASS** si las líneas agregadas a los tres contratos compartidos no introducen ningún otro
namespace de ejecución. **FAIL** si aparece un namespace distinto o si falta el esperado.

### A-11 — Sin valores por defecto y con ventana de calibración

```bash
grep -nE '10 a 20' .flowtask/skills/agent-loop-run/SKILL.md
grep -cE '\| `null` \|' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** la ventana de calibración aparece escrita como las primeras 10 a 20
ejecuciones, y los valores por defecto nulos de los topes están declarados.
**PASS** si la calibración está escrita y si los topes sin declarar aparecen como `null`.
**FAIL** si hay un umbral numérico por defecto o si la calibración no está declarada.

### A-12 — La terminación prevalece y la compuerta solo se evalúa al continuar

```bash
grep -n 'termination_precedence' .flowtask/skills/agent-loop-run/SKILL.md
grep -n 'únicamente' .flowtask/skills/agent-loop-run/SKILL.md
grep -n 'La terminación prevalece' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** el motivo `termination_precedence` está declarado, la evaluación de la
compuerta está restringida al caso en que la terminación dice `continue`, y la precedencia de
la terminación sobre el gasto está escrita.
**PASS** si las tres afirmaciones están presentes. **FAIL** si falta alguna.

### A-13 — El tope duro pausa y nunca habilita cierre, abandono, terminación de procesos ni cambio de modelo

```bash
grep -n 'pause.source' .flowtask/skills/agent-loop-run/SKILL.md
grep -n 'reason: hard_limit' .flowtask/skills/agent-loop-run/SKILL.md
grep -nE 'Nunca hay cierre ni abandono por gasto|Nunca se terminan procesos por consumo|Nunca se cambia de modelo' \
  .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** el origen `controller` y el motivo `hard_limit` están declarados, y las
tres prohibiciones del freno duro están escritas.
**PASS** si el único efecto del tope duro es una pausa reversible del controlador. **FAIL** si
el documento habilita o describe un cierre, un abandono, una terminación de procesos o un
cambio de modelo por gasto.

### A-14 — La reanudación del tope duro exige causa y no reinicia

```bash
awk '/^## Pausa y reanudación$/{f=1;next} /^## Cierre y veredictos$/{f=0} f' \
  .flowtask/skills/agent-loop-run/SKILL.md | grep -nE 'new_limit|authority_decision|re-definición'
grep -n 'no reinicia' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** la fila de reanudación del tope duro declara `new_limit` y
`authority_decision` con la re-definición como decisión de autoridad con baseline nuevo, y
está escrito que la reanudación no reinicia.
**PASS** si una reanudación sin causa resuelta queda rechazada y la ejecución conserva
numeración y contadores. **FAIL** si alguna causa no está tipada o si se admite reanudar sin
causa.

### A-15 — Gasto ilegible, atribución incompleta, cero inventado y gasto no atribuido

```bash
grep -nE 'record_unavailable|data_unverified' .flowtask/skills/agent-loop-run/SKILL.md
grep -nE 'Nunca se declara cero|nunca se declara cero' .flowtask/skills/agent-loop-run/SKILL.md
grep -nE 'nunca se suma|no se suma' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** los dos motivos de pausa de seguridad están declarados, la prohibición de
declarar cero está escrita, y la prohibición de sumar el gasto no atribuido está escrita.
**PASS** si con tope duro la anomalía pausa y sin tope duro solo se informa. **FAIL** si
alguna anomalía se resuelve con un cero inventado o imputando gasto ajeno.

### A-16 — Protocolo de inicio con ocho confirmaciones

```bash
awk '/^## Protocolo de inicio$/{f=1;next} /^## Protocolo de ronda$/{f=0} f' \
  .flowtask/skills/agent-loop-run/SKILL.md | grep -cE '^[0-9]+\. \*\*'
grep -n 'ocho confirmaciones anteriores leídas' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** nueve pasos numerados, de los cuales los ocho primeros exigen confirmación
por lectura, y el noveno despacha la primera ronda solo con las ocho confirmaciones leídas.
**PASS** si el protocolo tiene esa forma y si la falta de una confirmación impide iniciar la
ronda y se reporta como fallo operativo. **FAIL** si el protocolo despacha con una
confirmación pendiente.

### A-17 — Protocolo de ronda con siete pasos y confirmación por lectura

```bash
awk '/^## Protocolo de ronda$/{f=1;next} /^## Decisión del controlador$/{f=0} f' \
  .flowtask/skills/agent-loop-run/SKILL.md | grep -cE '^[0-9]+\. \*\*'
grep -n 'después** de la terminación y **antes** de la idempotencia' \
  .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** siete pasos numerados y la regla de que la compuerta de gasto va después
de la terminación y antes de la idempotencia.
**PASS** si el protocolo de ronda tiene siete pasos ordenados, cada uno con su confirmación.
**FAIL** si el orden se altera o si un paso se ejecuta sin confirmación.

### A-18 — Matriz de fallos de los cinco registros, los invariantes y la carga de skills

```bash
for t in "Registro de progreso" "Registro de terminación" "Ledger de idempotencia" \
         "Registro de gasto" "Registro de ejecución" "invariante" "skills no carga"; do
  printf '%s: ' "$t"
  awk '/^## Fallos operativos$/{f=1;next} /^## Configuración$/{f=0} f' \
    .flowtask/skills/agent-loop-run/SKILL.md | grep -c "$t"
done
```

**Salida esperada:** cada asunto aparece al menos una vez en la matriz de fallos.
**PASS** si la matriz cubre los cinco registros, los invariantes y la indisponibilidad de una
skill, con la regla de que no hay éxito, ni avance, ni despacho ante un fallo. **FAIL** si
falta un asunto o si se propone una regla sustituta.

### A-19 — Sin escalación de modelo habilitada

```bash
grep -nE 'escalación de modelo|cambio de modelo' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** cada coincidencia está dentro de una prohibición o de una garantía de
que no ocurre.
**PASS** si ninguna coincidencia describe una capacidad habilitada. **FAIL** si el documento
ofrece cambiar de modelo por rondas, por gasto o por estancamiento.

### A-20 — Sin código ejecutable ni archivos locales

```bash
CODE='[i]mport |[r]equire\(|[c]hild_process|[p]rocess\.|fetch\(|#!/'
grep -nE "$CODE" .flowtask/skills/agent-loop-run/SKILL.md
grep -nE 'archivos? local(es)?' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** la primera búsqueda no devuelve nada; la segunda devuelve solo menciones
que prohíben o niegan el uso de archivos locales.
**PASS** si el documento es solo normativo y no habilita copias de respaldo. **FAIL** si
contiene código o habilita un archivo local.

### A-21 — Sin identificadores de coordinación, de fase, de hito ni de plan

```bash
IDS='CA-[a]gent-[r]un|[F]1\.[0-9]|[Hh][e]rm[e]s|[r]oadmap|[a]gent-loop-[h]ermes'
grep -nE "$IDS" \
  .flowtask/skills/agent-loop-run/SKILL.md \
  .flowtask/skills/agent-loop-run/QA.md
```

**Salida esperada:** cero coincidencias en ambos archivos.
**PASS** si ninguno de los dos documentos contiene identificadores ajenos al contrato. **FAIL**
si aparece cualquiera.

### A-22 — Diff acotado y contratos vecinos intactos

```bash
git status --porcelain=v1 --untracked-files=all
git diff --name-only
git diff --cached --name-only
git diff --quiet -- \
  .flowtask/skills/agent-loop-progress \
  .flowtask/skills/agent-loop-invariants \
  .flowtask/skills/agent-loop-termination \
  .flowtask/skills/agent-loop-idempotency \
  .flowtask/skills/agent-loop-budget
git diff --quiet -- .opencode/
```

**Salida esperada:** el estado muestra exactamente seis rutas —cuatro archivos modificados y
los dos archivos nuevos de esta skill— y los cuatro comandos de diferencia no devuelven nada.
**PASS** si el diff está acotado a los seis archivos autorizados y los cinco contratos de
control no fueron tocados. **FAIL** si hay un archivo extra o si un contrato vecino cambió.

### A-23 — Matriz de aceptación completa

```bash
grep -cE '^\| AC-[0-9]{2} ' .flowtask/skills/agent-loop-run/SKILL.md
```

**Salida esperada:** `30`.
**PASS** si hay 30 criterios, cada uno con su regla y su sección. **FAIL** si falta o sobra
alguno.

### A-24 — Dieciocho escenarios de tabletop

```bash
grep -cE '^\| T-[0-9]{2} ' .flowtask/skills/agent-loop-run/QA.md
```

**Salida esperada:** `18`.
**PASS** si hay 18 escenarios de tabletop, cada uno con entrada, comportamiento esperado y
resultado. **FAIL** si falta o sobra alguno.

---

## B. Matriz de comportamiento

| ID | Supuesto | Resultado | Decisión | Motivo | Pausa o cierre |
|----|----------|-----------|----------|--------|----------------|
| Q-01 | Señal de inicio con objetivo documentado, sin ejecución previa y sin tope duro. | Se crea el registro de ejecución antes de la ronda 1 y se despacha la ronda. | `continue` | `none` | Ninguna |
| Q-02 | No hay señal explícita de inicio. | No hay registro, no hay ronda y no se atribuye gasto. | — | — | Ninguna |
| Q-03 | La señal encuentra una ejecución `active` o `paused` del mismo trabajo. | Se reanuda la misma ejecución con su última instantánea, su numeración y sus contadores. | `continue` | `none` | Ninguna |
| Q-04 | La señal llega después del cierre de la ejecución anterior. | Se abre una ejecución nueva con identidad y contadores propios. | `continue` | `none` | Ninguna |
| Q-05 | La ronda entregó trabajo, dejó resultado observado y los cinco invariantes están en `pass`. | La instantánea se confirma, la terminación se evalúa y la siguiente se despacha solo si corresponde. | `continue` | `none` | Ninguna |
| Q-06 | La ronda no dejó resultado observado por un fallo operativo. | No se confirma instantánea, no se evalúa la terminación y no se incrementa ningún contador canónico. | — | — | Ninguna |
| Q-07 | Un invariante fue violado y hay evidencia. | Se detiene en seguridad, no se declara éxito y queda reporte durable. | `pause` | `invariant_violation` | Pausa de terminación |
| Q-08 | Un invariante no es evaluable por falta de información. | La ronda no se confirma y se registra la información faltante; no hay pausa por esa vía. | — | — | Ninguna |
| Q-09 | El objetivo está cumplido con evidencia vigente y quedan bloqueos abiertos. | La ejecución cierra con veredicto de éxito y los bloqueos quedan registrados. | `close` | `objective_met` | Cierre con `success` |
| Q-10 | Un invariante vigente impide declarar éxito aunque los criterios estén completos. | La seguridad prevalece sobre el éxito aparente. | `pause` | `invariant_violation` | Pausa de terminación |
| Q-11 | Hay un bloqueo que requiere decisión de autoridad. | La ejecución pausa y espera; no continúa por cuenta propia. | `pause` | `authority_block` | Pausa de terminación |
| Q-12 | Hay un fallo declarado irrecuperable con diagnóstico. | La ejecución cierra conservando trabajo, historial y diagnóstico. | `close` | `irrecoverable_failure` | Cierre con `external_cause` |
| Q-13 | Un límite expreso del trabajo se alcanzó con efecto declarado de pausa. | Se aplica exactamente el efecto declarado, sin sustituirlo. | `pause` | `explicit_limit` | Pausa de terminación |
| Q-14 | Un límite expreso del trabajo se alcanzó con efecto declarado de cierre. | Se aplica exactamente el efecto declarado, sin sustituirlo. | `close` | `explicit_limit` | Cierre con `safe_abandonment` |
| Q-15 | Se alcanzó el umbral de rondas sin avance verificable. | La ejecución pausa y propone el abandono; nunca cierra. | `pause` | `no_verifiable_progress` | Pausa de terminación |
| Q-16 | La terminación dice `pause` o `close` y el consumo está por encima de todo tope. | La compuerta no se evalúa; el motivo visible es el de la terminación. | según terminación | `termination_precedence` | La de la terminación |
| Q-17 | La terminación dice `continue` y el tope duro declarado está alcanzado. | La ejecución pausa de forma reversible en la misma ejecución. | `pause` | `hard_limit` | Pausa del controlador |
| Q-18 | El tope duro se alcanza: no hay cierre, no hay abandono, no se terminan procesos y no se cambia de modelo. | El único efecto es la pausa reversible. | `pause` | `hard_limit` | Pausa del controlador |
| Q-19 | La ejecución está pausada por tope duro y se intenta reanudar sin presupuesto nuevo, sin decisión de autoridad y sin re-definición. | La reanudación se rechaza y la pausa se mantiene; el registro no muta. | `pause` | `hard_limit` | Pausa vigente |
| Q-20 | El consumo es alto pero no hay tope duro declarado. | La ejecución continúa y como máximo emite el aviso blando. | `continue` | según la evaluación blanda | Ninguna |
| Q-21 | El límite blando está declarado con efecto de pausa y fue superado. | Se propone una pausa reversible; el trabajo continúa al reanudar. | `pause` | `soft_limit_exceeded` | Pausa de presupuesto |
| Q-22 | Con tope duro declarado, el registro de gasto es ilegible. | La ejecución frena en seguridad y pide decisión; no se inventa un cero. | `pause` | `record_unavailable` | Pausa del controlador |
| Q-23 | Con tope duro declarado, la atribución es incompleta o los datos son parciales. | No se declara gasto verificable: la ejecución pausa o queda como no verificable. | `pause` | `data_unverified` | Pausa del controlador |
| Q-24 | Se acumulan muchas rondas. | No hay pausa por conteo de rondas y no hay cambio de modelo. | `continue` | `none` | Ninguna |

---

## C. Escenarios de tabletop

| ID | Escenario | Entrada | Comportamiento esperado | Resultado |
|----|-----------|---------|------------------------|-----------|
| T-01 | Inicio de una ejecución | Señal explícita, objetivo documentado, plan aprobado, sin ejecución previa. | Se crea el registro de ejecución con identidad, baseline y referencias; se inicializa el progreso como ronda 0; se despacha la ronda 1. | `continue` en la ronda 1 |
| T-02 | Trabajo previo a la señal | Material escrito antes de la señal de inicio. | El trabajo previo alimenta los valores iniciales y no cuenta como ronda ni como avance. | `continue` |
| T-03 | Ronda con avance verificable | Cinco invariantes en `pass`, criterio con evidencia, tarea completada con evidencia. | La instantánea se confirma, la terminación dice `continue` y la ronda siguiente se despacha. | `continue` |
| T-04 | Ronda sin avance y umbral cerca | Ningún criterio ni tarea avanzó; el contador de rondas sin avance se aproxima al umbral. | La ronda se confirma sin avance, el contador se incrementa y la terminación sigue evaluando. | `continue` o `pause` según el umbral |
| T-05 | Invariante de alcance | La ronda introduce un entregable que no figura en el baseline vigente. | Se persiste el reporte de violación, no se confirma la instantánea y se frena en seguridad. | `pause` |
| T-06 | Invariante de área protegida | La ronda escribe fuera del área asignada o sobre una ruta protegida. | Se aplica la acción de mayor severidad del catálogo y no se confirma la ronda. | `pause` |
| T-07 | Éxito con bloqueo abierto | Todos los criterios con evidencia; un bloqueo abierto sin marca de autoridad. | La ejecución cierra con veredicto de éxito y el bloqueo queda registrado. | `close` con `success` |
| T-08 | Autoridad que ordena el cierre | Bloqueo de autoridad con decisión registrada que ordena cerrar. | La ejecución se reanuda con la decisión y luego cierra por abandono seguro. | `close` con `safe_abandonment` |
| T-09 | Fallo irrecuperable | Fallo declarado con evidencia y diagnóstico. | Cierre por causa externa, conservando trabajo, historial y diagnóstico; no hay reintento. | `close` con `external_cause` |
| T-10 | Límite expreso con pausa y con cierre | Límite declarado por el trabajo, alcanzado, con efecto de pausa; y otro con efecto de cierre. | En cada caso se aplica exactamente el efecto declarado, sin sustitución. | `pause` o `close` |
| T-11 | Tope duro con terminación `continue` | Tope duro declarado de 500000 tokens; total acumulado 520000; terminación `continue`. | La ejecución pausa en la misma ejecución, con motivo `hard_limit` y condiciones de reanudación. | `pause` del controlador |
| T-12 | Tope duro con terminación `pause` | Tope duro declarado; la terminación dice `pause` por otra causa. | La compuerta no se evalúa; el motivo visible es el de la terminación. | `pause` de terminación |
| T-13 | Sin tope duro y gasto alto | Total acumulado muy por encima de cualquier valor observado; ningún tope declarado. | La ejecución continúa; como máximo hay aviso blando si había un techo blando declarado. | `continue` |
| T-14 | Límite blando con aviso | Límite blando declarado con efecto de aviso y superado por primera vez. | Aviso visible una vez por tope y ejecución; el trabajo sigue. | `continue` con aviso |
| T-15 | Límite blando con pausa | Límite blando declarado con efecto de pausa y superado. | Pausa reversible propuesta con motivo y condiciones; la ejecución no se cierra. | `pause` de presupuesto |
| T-16 | Gasto ilegible con tope duro | Tope duro declarado; el registro de gasto no se puede leer. | Pausa de seguridad por registro no disponible; no se sobrescribe ni se inventa un cero. | `pause` |
| T-17 | Atribución incompleta y sesión hija no atribuida | Tope duro declarado; una sesión hija sin atribución y datos parciales que no prueban cumplimiento. | Pausa de seguridad por datos no verificados; el gasto no atribuido se informa aparte y no se suma. | `pause` |
| T-18 | Reanudación sin causa, muchas rondas y nuevo inicio | Pausa por tope duro con señal de reanudación sin causa; doce rondas acumuladas; y una señal posterior al cierre. | La primera se rechaza; las rondas no pausan ni cambian de modelo; la tercera abre una ejecución nueva con contadores propios. | `pause`, `continue` y nueva ejecución |

---

## D. Casos límite y concurrencia

| ID | Caso | Comportamiento esperado | Verificación |
|----|------|-------------------------|--------------|
| L-01 | La misma ronda se reevalúa con los mismos hechos. | Devuelve la misma decisión sin transición, sin instantánea y sin cierre duplicado. | Q-05; «Protocolo de ronda» |
| L-02 | Dos escritores concurrentes sobre el registro de ejecución. | La escritura se condiciona a `integrity.record_version`; si cambió, se relee y se reevalúa; no se pisa el registro ajeno. | «Registros de la ejecución» |
| L-03 | El registro de ejecución no existe al intentar reanudar. | Pausa de seguridad del controlador: no se despacha, se conserva la última confirmación y se informa la limitación. | «Fallos operativos» |
| L-04 | El registro de ejecución contradice a otro registro de la ejecución. | Se informa la contradicción, no se sobrescribe ningún registro y no se avanza. | «Registros de la ejecución»; «Fallos operativos» |
| L-05 | El registro de gasto falta en una ejecución nueva frente a una reanudada. | En la nueva se crea con totales en cero; en la reanudada se crea con totales desconocidos, integridad incompleta y hueco declarado, nunca con cero. | «Fallos operativos»; «Freno duro por gasto» |
| L-06 | Una sesión hija no atribuida con tope duro declarado. | La ejecución pausa por datos no verificados y el consumo no atribuido no se suma a la ejecución. | Q-23; T-17 |
| L-07 | La declaración de tope duro es inválida. | Se ignora, se informa como declaración inválida y se trata como no declarado; no pausa ni habilita freno. | «Baseline y tope duro»; «Configuración» |
| L-08 | El registro de terminación no existe. | La ejecución queda en estado `running`; tras una pausa, la restauración respeta el estado conservado. | «Protocolo de inicio»; Q-02 |

---

## E. Trazabilidad de criterios del CA

Cada criterio de aceptación del trabajo se mapea a una regla de la skill, a su sección y a al
menos un caso de la matriz de comportamiento.

| Criterio | Regla contractual | Sección de la skill | Caso |
|----------|-------------------|---------------------|------|
| 1 | La señal crea el registro de la ejecución antes de la primera ronda y el trabajo previo no cuenta como ronda. | «Identidad y señal de inicio»; «Protocolo de inicio» | Q-01, Q-02 |
| 2 | La ronda con resultado observado se confirma, se evalúa la parada y solo entonces se despacha la siguiente. | «Protocolo de ronda» | Q-05 |
| 3 | La ronda sin resultado observado no cuenta como ronda completada, no evalúa la parada ni actualiza contadores. | «Protocolo de ronda»; «Fallos operativos» | Q-06 |
| 4 | El objetivo cumplido con evidencia vigente termina con veredicto de éxito aunque queden bloqueos registrados. | «Cierre y veredictos» | Q-09 |
| 5 | Una regla violada con evidencia detiene en seguridad, no declara éxito y deja reporte durable; sin resolución no reanuda. | «Protocolo de ronda»; «Pausa y reanudación» | Q-07, Q-10 |
| 6 | Un bloqueo que requiere decisión de autoridad pausa y espera; no continúa por cuenta propia. | «Pausa y reanudación» | Q-11 |
| 7 | Un fallo declarado irrecuperable con evidencia cierra por causa externa conservando trabajo, historial y diagnóstico. | «Cierre y veredictos» | Q-12 |
| 8 | Un límite expreso del trabajo con efecto declarado se aplica exactamente como fue declarado. | «Decisión del controlador» | Q-13, Q-14 |
| 9 | Cuando la regla de parada dice parar, el gasto por debajo de todo tope tampoco anula la parada. | «Decisión del controlador» | Q-16 |
| 10 | Con la regla de parada diciendo continuar y tope duro alcanzado, la ejecución pausa de forma reversible en la misma ejecución. | «Freno duro por gasto» | Q-17, Q-18 |
| 11 | Con gasto alto y sin tope declarado, la ejecución continúa y como máximo emite el aviso blando. | «Freno duro por gasto» | Q-20, Q-21 |
| 12 | Con registro de gasto ilegible y tope duro declarado, la ejecución frena en seguridad y pide decisión. | «Freno duro por gasto»; «Fallos operativos» | Q-22 |
| 13 | El gasto de una sesión no atribuible queda marcado como no atribuido y no se suma a otro objetivo. | «Freno duro por gasto» | Q-23, T-17 |
| 14 | Una pausa se reanuda con señal explícita y causa resuelta, y continúa la misma ejecución con su numeración y sus contadores. | «Pausa y reanudación» | Q-03, Q-19 |
| 15 | Una ejecución pausada por tope duro sin presupuesto nuevo, sin decisión de autoridad y sin re-definición no reanuda. | «Pausa y reanudación» | Q-19, T-18 |
| 16 | El consumo anómalo de un participante con el total del objetivo bajo el tope no pausa la ejecución. | «Freno duro por gasto» | Q-24 |

---

## F. Criterios de PASS/FAIL

**PASS** solo si se cumplen **todas** estas condiciones:

1. Los chequeos estáticos **A-01 a A-24** se cumplen sin excepciones.
2. Los cuatro bloques de ejemplo **parsean** y exponen las claves de primer nivel esperadas.
3. La matriz de aceptación de la skill tiene los **30** criterios y los **18** ejemplos
   canónicos, y cada criterio referencia su sección.
4. La matriz de comportamiento tiene los **24** casos y **ninguna** contradicción con la
   skill; en particular, ningún caso pausa por consumo alto sin tope declarado, por dinero
   estimado, por conteo de rondas ni por anomalía de un participante.
5. Los escenarios de tabletop son **18** y los casos límite y de concurrencia son **8**.
6. La trazabilidad de la sección E tiene las **16** filas del trabajo, ninguna celda vacía y
   cada criterio apunta al menos a un caso de la sección B.
7. La búsqueda de identificadores ajenos al contrato devuelve **cero** coincidencias en los
   dos archivos.
8. El diff está limitado **exactamente** a los seis archivos autorizados y los cinco
   contratos de control y la copia de ejecución no tienen cambios.

**FAIL** en cuanto una sola de estas condiciones no se cumple. Un FAIL no se declara PASS "con
observaciones": se reporta la condición incumplida, su evidencia y el alcance exacto del
desvío.

No se modifica ningún archivo durante la verificación. La corrección de un FAIL corresponde a
la implementación, no a esta comprobación.

---

## G. Registro de verificación

Todos los comandos se ejecutan desde la raíz del repositorio. Los temporales van a
`.flowtask/.temp/`, que está ignorado por el control de versiones. Ningún comando escribe en el
mecanismo de memoria ni invoca agentes.

### G.1 Preparación

```bash
mkdir -p .flowtask/.temp
```

### G.2 Bloques de ejemplo

```bash
SKILL=.flowtask/skills/agent-loop-run/SKILL.md
for i in 1 2 3 4; do
  awk -v n="$i" 'BEGIN{c=0} /^~~~json$/{c++; f=(c==n); next} f&&/^~~~$/{exit} f' \
    "$SKILL" > ".flowtask/.temp/run-$i.json"
  node -e "JSON.parse(process.argv[1]); console.log('ok $i')" "$(cat ".flowtask/.temp/run-$i.json")"
done
```

### G.3 Conteos de las matrices y de las secciones

```bash
grep -c '^## ' .flowtask/skills/agent-loop-run/SKILL.md      # 20
grep -cE '^\| AC-[0-9]{2} ' .flowtask/skills/agent-loop-run/SKILL.md  # 30
grep -cE '^\| E-[0-9]{2} '  .flowtask/skills/agent-loop-run/SKILL.md  # 18
grep -cE '^### A-[0-9]{2}'  .flowtask/skills/agent-loop-run/QA.md     # 24
grep -cE '^\| Q-[0-9]{2} '  .flowtask/skills/agent-loop-run/QA.md     # 24
grep -cE '^\| T-[0-9]{2} '  .flowtask/skills/agent-loop-run/QA.md     # 18
grep -cE '^\| L-[0-9]{2} '  .flowtask/skills/agent-loop-run/QA.md     # 8
```

### G.4 Identificadores ajenos al contrato

```bash
IDS='CA-[a]gent-[r]un|[F]1\.[0-9]|[Hh][e]rm[e]s|[r]oadmap|[a]gent-loop-[h]ermes'
grep -nE "$IDS" \
  .flowtask/skills/agent-loop-run/SKILL.md \
  .flowtask/skills/agent-loop-run/QA.md
```

El resultado esperado es **cero coincidencias**.

### G.5 Código y archivos locales

```bash
CODE='[i]mport |[r]equire\(|[c]hild_process|[p]rocess\.|fetch\(|#!/'
grep -nE "$CODE" .flowtask/skills/agent-loop-run/SKILL.md
grep -nE 'archivos? local(es)?' .flowtask/skills/agent-loop-run/SKILL.md
```

La primera búsqueda no debe devolver nada. La segunda debe devolver solo menciones que
prohíben o niegan el uso de archivos locales.

### G.6 Namespace único de ejecución

```bash
git diff -U0 -- \
  .flowtask/skills/memory-contract/SKILL.md \
  .flowtask/skills/topic-keys-convention/SKILL.md \
  .flowtask/skills/checkpoint-mixin/SKILL.md \
  | grep '^+' | grep -oE 'flow-state/\{execution_id\}/[a-z]+' | sort -u
```

La salida esperada es una sola línea: `flow-state/{execution_id}/run`.

### G.7 Diff y contratos vecinos

```bash
git status --porcelain=v1 --untracked-files=all
git diff --name-only
git diff --cached --name-only
git diff --check
git diff --quiet -- \
  .flowtask/skills/agent-loop-progress \
  .flowtask/skills/agent-loop-invariants \
  .flowtask/skills/agent-loop-termination \
  .flowtask/skills/agent-loop-idempotency \
  .flowtask/skills/agent-loop-budget
git diff --quiet -- .opencode/
```

El estado debe mostrar **exactamente seis rutas**: los cuatro archivos modificados y los dos
archivos nuevos de esta skill. Los comandos de diferencia sobre archivos versionados deben
estar vacíos y los dos `git diff --quiet` deben salir con código 0.

### G.8 Referencias de los cinco contratos

```bash
for s in agent-loop-progress agent-loop-invariants agent-loop-termination \
         agent-loop-idempotency agent-loop-budget; do
  printf '%s: ' "$s"
  grep -c "$s" .flowtask/skills/agent-loop-run/SKILL.md
done
```

Cada valor debe ser mayor o igual que 1.

### G.9 Conceptos de frontera

```bash
grep -niE 'tope duro|pausa dura|cierre autom.tico|abandono autom.tico|escalaci.n de modelo' \
  .flowtask/skills/agent-loop-run/SKILL.md
```

Cada coincidencia debe estar en una prohibición, en la tabla de fronteras o en una garantía.
Ninguna coincidencia puede describir una capacidad habilitada.

### G.10 Registro del resultado

El resultado de la verificación —PASS o FAIL, con la evidencia de cada chequeo— se registra
en el estado de flujo del constructor de esta ejecución. La verificación no escribe en el
mecanismo de memoria por sí misma y no crea artefactos nuevos.
