# QA — agent-loop-invariants

## Propósito

Este archivo verifica la skill `agent-loop-invariants`: que el catálogo esté completo y parseable, que los schemas tengan las claves exigidas, que las fronteras (sin alcance ajeno, sin espacios de nombres nuevos, sin archivos compartidos tocados) se respeten y que los criterios de aceptación del requisito tengan cobertura observable.

Los checks son estáticos: leen los dos archivos de la skill y no escriben nada. El tabletop es de razonamiento: cada escenario se evalúa contra el catálogo vigente, no contra una ejecución real.

Todos los comandos se ejecutan desde la raíz del repositorio. En los patrones de búsqueda, los términos prohibidos se escriben con una clase de caracteres en su primer carácter (por ejemplo `H[e]rmes`): la expresión regular resultante es equivalente y así el propio archivo de QA no contiene literalmente la cadena buscada.

## Checks estáticos

### C-01 — Existencia de los dos archivos

Comando:

~~~bash
test -f .flowtask/skills/agent-loop-invariants/SKILL.md && test -f .flowtask/skills/agent-loop-invariants/QA.md && echo "C-01 OK"
~~~

Esperado: exit 0 y salida `C-01 OK`.

### C-02 — Frontmatter con los cinco campos requeridos

Comando:

~~~bash
sed -n '2,/^---$/p' .flowtask/skills/agent-loop-invariants/SKILL.md | grep -cE '^(name|description|license|compatibility|metadata):'
~~~

Esperado: `5`. Los cinco campos son `name`, `description`, `license`, `compatibility` y `metadata` (con `category` y `scope` dentro).

### C-03 — Dieciséis secciones H2 en el orden exacto

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const exp=["## Propósito","## Fronteras","## Términos","## Cuándo se carga","## Autoridad de verificación","## Catálogo de invariantes — versión 1","## Declaración de la ronda","## Verificación al cierre de ronda","## Reporte y acción ante violaciones","## Evidencia requerida por invariante","## Lista de lo protegido","## Aislamiento del área de trabajo","## Reanudación","## Versionado y cambio del catálogo","## Criterios de aceptación de la skill","## QA de aceptación"];const got=t.split("\n").filter(l=>l.startsWith("## "));console.log(got.length===16&&got.every((l,i)=>l===exp[i])?"C-03 OK":"C-03 FAIL count="+got.length+" "+JSON.stringify(got))'
~~~

Esperado: `C-03 OK`.

### C-04 — Los cuatro bloques JSON parsean

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const m=[...t.matchAll(/~~~json\n([\s\S]*?)\n~~~/g)].map(x=>x[1]);let ok=0;for(const b of m){try{JSON.parse(b);ok++}catch(e){console.log("parse error: "+e.message)}};console.log("JSON OK "+ok)'
~~~

Esperado: `JSON OK 4` (catálogo, contexto, check y reporte de violación).

### C-05 — Catálogo con cinco invariantes, ids, codes y acciones exactas

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const c=[...t.matchAll(/~~~json\n([\s\S]*?)\n~~~/g)].map(x=>x[1]).map(x=>JSON.parse(x)).find(x=>x.schema==="agent-loop-invariants/catalog/v1");const ids=c.invariants.map(i=>i.id).join(",");const codes=c.invariants.map(i=>i.code).join(",");const acts=c.invariants.map(i=>i.violation_action).join(",");console.log(ids==="1,2,3,4,5"&&codes==="INV-1,INV-2,INV-3,INV-4,INV-5"&&acts==="pause,rollback_and_pause,pause,pause,rollback_and_pause"?"C-05 OK":"C-05 FAIL count="+c.invariants.length+" mismatch "+ids+" "+codes+" "+acts)'
~~~

Esperado: `C-05 OK`.

### C-06 — Tabla derivada con las cinco filas y las cinco etiquetas

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const rows=[1,2,3,4,5].every(i=>t.includes("| "+i+" | INV-"+i+" |"));const labels=["No ampliar el alcance","No tocar lo protegido","No decidir diseño en la ejecución","Persistir la evidencia","Mantener el aislamiento del área de trabajo"];const miss=labels.filter(l=>!t.includes(l));console.log(rows&&miss.length===0?"C-06 OK":"C-06 FAIL rows="+rows+" missing="+miss.join(","))'
~~~

Esperado: `C-06 OK`. Si la tabla y el JSON discrepan, el check falla aunque el JSON sea válido.

### C-07 — Schema del check con todas sus claves y cinco entradas

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const c=[...t.matchAll(/~~~json\n([\s\S]*?)\n~~~/g)].map(x=>x[1]).map(x=>JSON.parse(x)).find(x=>x.schema==="agent-loop-invariants/check/v1");const keys=["schema","catalog_version","check_id","execution_id","round","checked_at","checked_by","executor","verdict","invariants","violation_report_id","action","resulting_state","missing_information"];const miss=keys.filter(k=>!(k in c));const n=c.invariants.length;console.log(miss.length===0&&n===5?"C-07 OK":"C-07 FAIL missing="+miss.join(",")+" entries="+n)'
~~~

Esperado: `C-07 OK`.

### C-08 — Schema del reporte con todas sus claves y violaciones no vacías

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const r=[...t.matchAll(/~~~json\n([\s\S]*?)\n~~~/g)].map(x=>x[1]).map(x=>JSON.parse(x)).find(x=>x.schema==="agent-loop-invariants/violation/v1");const keys=["schema","report_id","catalog_version","execution_id","round","reported_at","checked_by","violations","action","action_rationale","resulting_state","requires_operator_signal","resume_condition","supersedes"];const miss=keys.filter(k=>!(k in r));console.log(miss.length===0&&r.violations.length>0?"C-08 OK":"C-08 FAIL missing="+miss.join(",")+" violations="+r.violations.length)'
~~~

Esperado: `C-08 OK`.

### C-09 — Perfiles de lo protegido y cierre por omisión

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const a=(t.match(/### Perfil development/g)||[]).length;const b=(t.match(/### Perfil production/g)||[]).length;const c=(t.match(/Regla de mundo cerrado/g)||[]).length;console.log(a===1&&b===1&&c===1?"C-09 OK":"C-09 FAIL "+a+"/"+b+"/"+c)'
~~~

Esperado: `C-09 OK`.

### C-10 — Aislamiento con comandos y evidencia

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const a=(t.match(/## Aislamiento del área de trabajo/g)||[]).length;const b=(t.match(/git worktree list --porcelain/g)||[]).length;const c=(t.match(/git diff --name-only/g)||[]).length;console.log(a===1&&b>=1&&c>=1?"C-10 OK":"C-10 FAIL "+a+"/"+b+"/"+c)'
~~~

Esperado: `C-10 OK`.

### C-11 — Reanudación y versionado del catálogo

Comando:

~~~bash
node -e 'const fs=require("fs");const t=fs.readFileSync(".flowtask/skills/agent-loop-invariants/SKILL.md","utf8");const a=(t.match(/## Reanudación/g)||[]).length;const b=(t.match(/## Versionado y cambio del catálogo/g)||[]).length;const c=(t.match(/catalog_version/g)||[]).length;console.log(a===1&&b===1&&c>=3?"C-11 OK":"C-11 FAIL "+a+"/"+b+"/"+c)'
~~~

Esperado: `C-11 OK`.

### C-12 — Sin alcance ajeno en el contenido funcional

Comando:

~~~bash
grep -nE 'CA-[A-Za-z0-9-]+|F1\.[0-9]|H[e]rmes|A[g]entRun|r[o]admap|p[re]supuesto|i[d]empotencia|terminaci[o]n|m[a]ximo de rondas|u[m]bral|d[a]shboard' .flowtask/skills/agent-loop-invariants/SKILL.md
~~~

Esperado: exit 1 y sin salida. Cualquier coincidencia es FAIL.

### C-13 — Estructura de este archivo de QA

Comando:

~~~bash
node -e 'const fs=require("fs");const q=fs.readFileSync(".flowtask/skills/agent-loop-invariants/QA.md","utf8");const c=(q.match(/^### C-/gm)||[]).length;const a=(q.match(/^\| AC-/gm)||[]).length;const tt=(q.match(/^### TT-/gm)||[]).length;const p=(q.match(/^## Criterios de PASS\/FAIL$/gm)||[]).length;console.log(c===14&&a===10&&tt===10&&p===1?"C-13 OK":"C-13 FAIL "+c+"/"+a+"/"+tt+"/"+p)'
~~~

Esperado: `C-13 OK` (14 checks, 10 filas de aceptación, 10 tabletop y una sola sección de criterios).

### C-14 — Sin espacios de nombres ni claves de topicado en la skill

Comando:

~~~bash
grep -nE 'topic_key|flow-state/|ca/CA-' .flowtask/skills/agent-loop-invariants/SKILL.md
~~~

Esperado: exit 1 y sin salida. Los registros del check y del reporte se adjuntan al resultado durable de la ronda, sin crear claves propias.

## Matriz de aceptación del requisito

| ID | Enunciado | Sección o regla | Check |
|---|---|---|---|
| AC-1 | Una ronda que trabaja dentro del baseline, sin escrituras fuera del área, sin rediseños y con evidencia durable verifica los cinco invariantes en `pass` y la ronda queda confirmada. | "Verificación al cierre de ronda" (paso 6) | C-05, C-07 |
| AC-2 | Una ronda que entrega trabajo fuera del baseline verifica `INV-1` como `violated`, el avance invocado no cuenta y el loop pausa sin confirmar la ronda. | "Catálogo de invariantes — versión 1" (`INV-1`) | C-05 |
| AC-3 | Una ronda que escribe fuera de su área o sobre un path protegido verifica `INV-2` como `violated`, descarta los efectos hasta la última instantánea confirmada y pausa; no subsiste ninguna escritura indebida. | "Reporte y acción ante violaciones" | C-05, TT-03 |
| AC-4 | Una ronda donde quien ejecuta redefine un criterio o implementa otro diseño verifica `INV-3` como `violated`, el cambio no cuenta como avance y el loop pausa. | "Catálogo de invariantes — versión 1" (`INV-3`) | C-05 |
| AC-5 | Una ronda que invoca un avance sin evidencia durable registrada verifica `INV-4` como `violated`, el avance no cuenta y la ronda no se confirma. | "Catálogo de invariantes — versión 1" (`INV-4`) | C-05 |
| AC-6 | Una ejecución que lee o escribe el área de otra ejecución o la línea principal verifica `INV-5` como `violated` y aplica vuelta atrás más pausa. | "Catálogo de invariantes — versión 1" (`INV-5`) | C-05, C-10 |
| AC-7 | Una ronda cuya verificación no puede ejecutarse por falta de información queda como `not_evaluable`, no se confirma instantánea y no se declara avance. | "Verificación al cierre de ronda" (paso 8) | C-07, TT-07 |
| AC-8 | Una violación detectada produce un registro durable con invariante, ronda, ejecución, hecho observable, evidencia, alcance afectado, acción y estado resultante. | "Reporte y acción ante violaciones" | C-08 |
| AC-9 | Una ronda que viola varios invariantes a la vez aplica la acción más severa y el reporte lista cada invariante violado. | "Reporte y acción ante violaciones" (tabla de acción) | C-08, TT-09 |
| AC-10 | La definición vive solo en su skill propia: `runner`, `memory-contract`, `topic-keys-convention` y `checkpoint-mixin` no se crean, modifican ni reinterpretan. | "Fronteras" | C-01, C-14 |

## Tabletop de verificación

### TT-01 — Ronda limpia dentro del baseline

- **Hechos**: la ronda entrega un cambio dentro del baseline, escribe solo dentro del `write_area`, no altera criterios ni interfaces aprobadas y registra evidencia durable consultable.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` pass, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `pass`.
- **Acción**: `none`.
- **Estado**: `confirmed`.
- **Registros**: check `CHK-ejemplo-R001` con cinco entradas en `pass` y evidencia no vacía; sin reporte de violación.

### TT-02 — Entrega fuera del baseline

- **Hechos**: la ronda propone un criterio de aceptación que no figura en el baseline vigente; no hay escritura indebida.
- **Veredicto por invariante**: `INV-1` violated, `INV-2` pass, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `violated`.
- **Acción**: `pause`.
- **Estado**: `paused`.
- **Registros**: check `CHK-ejemplo-R002` con `observed_fact` en `INV-1` y reporte `VIO-ejemplo-R002` con una violación; el avance invocado no cuenta y la ronda no se confirma.

### TT-03 — Escritura fuera del área o sobre un path protegido

- **Hechos**: la ronda escribe un path que no pertenece al `write_area`; el path afectado queda en el registro de escrituras.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` violated, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `violated`.
- **Acción**: `rollback_and_pause`.
- **Estado**: `rolled_back_and_paused`.
- **Registros**: check `CHK-ejemplo-R003` y reporte `VIO-ejemplo-R003` con `affected_scope` que describe el path no autorizado; tras la vuelta atrás no subsiste ninguna escritura indebida.

### TT-04 — Criterio o diseño redefinido por quien ejecuta

- **Hechos**: quien ejecuta altera un criterio de aceptación del plan vigente sin reportarlo como bloqueo.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` pass, `INV-3` violated, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `violated`.
- **Acción**: `pause`.
- **Estado**: `paused`.
- **Registros**: check `CHK-ejemplo-R004` con `observed_fact` en `INV-3` y reporte `VIO-ejemplo-R004`; el cambio no cuenta como avance y la ejecución queda a la espera del operador.

### TT-05 — Avance sin evidencia durable

- **Hechos**: la ronda declara un avance sin referencia de evidencia durable consultable.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` pass, `INV-3` pass, `INV-4` violated, `INV-5` pass.
- **Veredicto agregado**: `violated`.
- **Acción**: `pause`.
- **Estado**: `paused`.
- **Registros**: check `CHK-ejemplo-R005` con `observed_fact` en `INV-4` y reporte `VIO-ejemplo-R005`; la ronda no se confirma aunque el trabajo parezca hecho.

### TT-06 — Acceso al área de otra ejecución o a la línea principal

- **Hechos**: la ronda escribe en la línea principal de trabajo o lee un worktree ajeno; el registro de accesos muestra el path.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` pass, `INV-3` pass, `INV-4` pass, `INV-5` violated.
- **Veredicto agregado**: `violated`.
- **Acción**: `rollback_and_pause`.
- **Estado**: `rolled_back_and_paused`.
- **Registros**: check `CHK-ejemplo-R006` y reporte `VIO-ejemplo-R006` con `affected_scope` que describe el worktree o la línea principal afectados; el estado no confiable no permanece.

### TT-07 — Verificación no ejecutable

- **Hechos**: la lista de paths modificados no puede consultarse, así que `changed_paths` no es resoluble.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` not_evaluable, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `not_evaluable`.
- **Acción**: `none`.
- **Estado**: `not_confirmed`.
- **Registros**: check `CHK-ejemplo-R007` con `missing_information` describiendo el dato faltante; sin reporte de violación, sin pausa y sin vuelta atrás por esta skill; no se confirma instantánea ni se declara avance.

### TT-08 — Reporte de violación durable

- **Hechos**: se detecta una violación de `INV-2` y el reporte se persiste antes de aplicar la acción.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` violated, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `violated`.
- **Acción**: `rollback_and_pause`.
- **Estado**: `rolled_back_and_paused`.
- **Registros**: un solo reporte por check con invariante, ronda, ejecución, hecho observable, evidencia, alcance afectado, acción y estado resultante; `requires_operator_signal` en `true` y `resume_condition` no vacío; el reporte no se edita después.

### TT-09 — Varias violaciones simultáneas

- **Hechos**: la ronda amplía el alcance y además accede al área de otra ejecución.
- **Veredicto por invariante**: `INV-1` violated, `INV-2` pass, `INV-3` pass, `INV-4` pass, `INV-5` violated.
- **Veredicto agregado**: `violated`.
- **Acción**: `rollback_and_pause`.
- **Estado**: `rolled_back_and_paused`.
- **Registros**: check `CHK-ejemplo-R009` y reporte `VIO-ejemplo-R009` con `violations` listando `INV-1` e `INV-5`; se aplica la acción de mayor severidad y no solo la primera.

### TT-10 — Diff autorizado y archivos compartidos intactos

- **Hechos**: el cambio de la entrega agrega únicamente los dos archivos de la skill; `runner`, `memory-contract`, `topic-keys-convention` y `checkpoint-mixin` no presentan diferencias y no hay archivos de runtime bajo el directorio de la skill.
- **Veredicto por invariante**: `INV-1` pass, `INV-2` pass, `INV-3` pass, `INV-4` pass, `INV-5` pass.
- **Veredicto agregado**: `pass`.
- **Acción**: `none`.
- **Estado**: `confirmed`.
- **Registros**: `git diff --name-only` lista solo los dos archivos de la skill; `git diff --exit-code` sobre los archivos compartidos devuelve 0; bajo el directorio de la skill no hay `.js`, `.ts`, `.sh` ni `.json`.

## Criterios de PASS/FAIL

- PASS exige los 14 checks estáticos en verde, la matriz de aceptación con sus 10 criterios completos y sin celdas vacías, y los 10 escenarios de tabletop correctos.
- No hay PASS parcial: cualquier fallo es FAIL y se registra con el comando, la salida observada y la regla infringida.
- Un FAIL bloquea la entrega y se reporta como fallo operativo; no se avanza con checks en rojo.
- El tabletop se evalúa contra el catálogo vigente: un escenario cuyo veredicto por invariante, veredicto agregado, acción o estado no coincide con el catálogo es FAIL.

## Registro de ejecución

| fecha | ejecutor | checks ejecutados | resultado | evidencia |
|---|---|---|---|---|
| 2026-10-19 | constructor | C-01 a C-14 | PASS | C-01 a C-14 en verde; `JSON OK 4`; matriz AC-1 a AC-10 completa sin celdas vacías; TT-01 a TT-10 correctos con `rollback_and_pause` en TT-03, TT-06 y TT-09; `git status --porcelain` lista solo los dos archivos de la skill; `git diff --exit-code` sobre los archivos compartidos devuelve 0; `git diff --check` sin salida. |
