# QA — agent-loop-budget

## Propósito

Verificación de **solo lectura** del contrato de observabilidad del gasto por
ejecución. Comprueba tres cosas: que el documento normativo declara lo que
debe declarar (y solo eso), que el schema canónico es parseable y coherente, y
que el comportamiento descrito en la matriz no se contradice ni habilita
capacidades de frenado que este contrato no tiene.

Alcance de la verificación:

- **Alcance normativo:** `SKILL.md` (17 secciones) y `QA.md` (este documento).
- **Fuera de alcance:** cualquier cambio de código, configuración, runtime o
  registro de flujo. Esta verificación no escribe, no crea archivos en el
  repositorio y no modifica registros de memoria.

Los conceptos de frontera —frenado irreversible, cierre o abandono automático,
`kill`, escalación de modelo, topes por agente, por sesión o por objetivo, y
corte por costo estimado— aparecen en este documento **solo como objeto de
verificación o como diferidos a otro contrato**. Nunca como regla habilitable.

Los identificadores prohibidos (identificador de esta CA, identificadores de
roadmap, nombres de hitos, nombres de módulos de runtime ajenos y nombres de
claves de tope numérico) se escriben **ofuscados** en los comandos de la
sección E, para que este documento no contenga ninguno de ellos y la
verificación sea reproducible sobre sí misma.

---

## A. Chequeos estáticos

| ID | Chequeo | Cómo verificar | Resultado esperado |
|----|---------|----------------|-------------------|
| A-01 | Frontmatter de la skill | `sed -n '1,12p' SKILL.md` | `name: agent-loop-budget`, `description` plegada, `license: MIT`, `compatibility: opencode`, `metadata.category: agent-loop`, `metadata.scope: flowtask`. |
| A-02 | 17 secciones en orden exacto, sin duplicados | `grep -n '^## ' SKILL.md` | 17 líneas, en el orden de la sección E, cada una una sola vez. |
| A-03 | El primer bloque `json` parsea | Extracción con `awk` a un temporal y `node -e` con `JSON.parse` | La salida es `schema ok` y el código de salida es 0. |
| A-04 | El schema v1 contiene todos sus bloques | Lectura del JSON extraído | Raíz, `round`, `tokens`, `time`, `cost`, `attribution`, `sessions`, `limits`, `acknowledged_limit_refs`, `evaluation`, `events`, `pause`, `gaps`, `integrity`. |
| A-05 | Señales y precedencia | Lectura de la sección de señales | Tokens primaria, tiempo activo secundario, rondas solo lectura, costo observacional; la precedencia entre tokens y tiempo está escrita; los rondas y el costo no disparan. |
| A-06 | Defaults sin topes numéricos | Lectura de la tabla de defaults | `limits.soft.tokens: null`, `limits.soft.active_time_ms: null`, `limits.soft.on_soft: notify`, `limits.soft.declared_by: authority`, `limits.soft.ref: null`. No hay ningún valor numérico por defecto. |
| A-07 | Frontera de prohibición | Lectura de la tabla de fronteras y de la tabla D5 | La skill **no define ni habilita** frenado irreversible (tope o pausa dura), cierre o abandono automático, `kill`, escalación de modelo, topes por agente, por sesión o por objetivo, ni corte por costo estimado. Toda mención es una prohibición en la sección de fronteras o una fila diferida en D5. |
| A-08 | Tabla D5 completa | Lectura de la tabla D5 | Filas 1 a 10. Las filas 5, 6 y 7 están marcadas como diferidas al controlador de ejecución y no se evalúan. |
| A-09 | Precedencia de terminación | Lectura de la sección de precedencia | La terminación va primero; `pause` y `close` producen `not_evaluated` con `termination_precedence`; solo `continue` evalúa el presupuesto; el presupuesto no anula ni fuerza la terminación. |
| A-10 | Atribución | Lectura de la sección de atribución | El mapa de sesiones es la única fuente; hay herencia por sesión padre; el gasto no atribuido se informa aparte y nunca se suma; no hay inferencia por modelo, agente, texto ni marcas de tiempo; la corrección se registra como evento. |
| A-11 | Namespace, tipo, scope, título y owner | Lectura de la sección de persistencia | `flow-state/{execution_id}/budget`, `type: decision`, `scope: project`, título `Agent Loop budget — {execution_id}`, un único escritor (quien coordina) y confirmación con `record_version` y `last_event_id`. |
| A-12 | Momentos de registro | Lectura de la sección de momentos | Cuatro momentos: inicialización, cierre de ronda, pausa y cierre. Está escrito que no se anota por paso, por herramienta ni por mensaje. |
| A-13 | Sin archivos locales y degradación sin memoria | Lectura de la sección de integridad | No hay archivos de respaldo local ni fuentes paralelas; la caída del proveedor de memoria degrada según el contrato de memoria y bloquea con exigencia declarada. |
| A-14 | Cero identificadores fuera de contrato | `grep -nE "$FORBIDDEN" SKILL.md QA.md` con el patrón de la sección E | Cero coincidencias en ambos archivos. |
| A-15 | Diff limitado a dos archivos | `git status --porcelain=v1 --untracked-files=all` y `git diff --name-only` | Solo `SKILL.md` y `QA.md` aparecen; los diffs de archivos versionados están vacíos. |
| A-16 | Matriz de aceptación completa | `grep -cE '^\| AC-[0-9]{2} ' SKILL.md` | 12 criterios, cada uno con sección y regla. |

---

## B. Matriz de comportamiento

| ID | Supuesto | Resultado | Outcome | Reason | Pausa |
|----|----------|-----------|---------|--------|-------|
| Q-01 | Ejecución sin ningún límite declarado; ronda normal | Se registra el acumulado de tokens, tiempo, ronda y costo; no hay aviso | `continue` | `observing` | No |
| Q-02 | Tokens acumulados 120000; límite de tokens 100000; `on_soft: notify` | Aviso visible en el reporte de ronda; el trabajo sigue | `notify` | `tokens_soft_limit_exceeded` | No |
| Q-03 | Tiempo activo 4800000 ms; límite de tiempo 3600000 ms; `on_soft: notify` | Aviso visible; el trabajo sigue | `notify` | `active_time_soft_limit_exceeded` | No |
| Q-04 | Tokens 120000 y tiempo activo 4800000 ms; ambos límites superados; `on_soft: notify` | Un aviso; los dos límites quedan citados en `limit_refs` | `notify` | `both_soft_limits_exceeded` | No |
| Q-05 | Tokens 120000; límite 100000; `on_soft: pause` | Pausa reversible propuesta, con motivo y condiciones de reanudación | `pause` | `soft_limit_exceeded` | Sí |
| Q-06 | Ejecución pausada por límite blando; llega una señal explícita de reanudación | Se retoma con los mismos totales, la misma ronda y los mismos eventos; el límite queda reconocido y no vuelve a pausar | `continue` | `none` | No |
| Q-07 | Tras la reanudación se declara un límite nuevo, ya superado | El límite nuevo se evalúa y vuelve a pausar | `pause` | `soft_limit_exceeded` | Sí |
| Q-08 | Sin límites declarados; la autoridad decide pausar de forma explícita | Pausa reversible con origen `authority` | `pause` | `explicit_pause_decision` | Sí |
| Q-09 | La terminación dice `pause`; el gasto está por encima del techo | El presupuesto no se evalúa; el motivo visible de la parada es la terminación | `not_evaluated` | `termination_precedence` | No por gasto |
| Q-10 | La terminación dice `close`; el gasto está por debajo del techo | El presupuesto no se evalúa; el registro se cierra con totales finales | `not_evaluated` | `termination_precedence` | No por gasto |
| Q-11 | La terminación dice `continue`; el gasto está por debajo de todo techo | Sin aviso y sin pausa; el trabajo continúa | `continue` | `within_limits` | No |
| Q-12 | No existe registro al inicializar una ejecución nueva | Se crea con totales en cero, `integrity: complete` y evento `initialized` | `continue` | `observing` | No |
| Q-13 | No existe registro al reanudar una ejecución ya iniciada | Se crea con totales `unknown`, `integrity: incomplete` y un hueco declarado; nunca con cero | `unverified` | `data_unverified` | No |
| Q-14 | El registro es ilegible y hay un límite declarado | Pausa de seguridad; el registro no se sobrescribe ni se inventa | `pause` | `record_unavailable` | Sí |
| Q-15 | El registro es ilegible y no hay ningún límite declarado | `unavailable` visible; el trabajo sigue en modo degradado | `unavailable` | `record_unavailable` | No |
| Q-16 | Una sesión no aparece en el mapa y su padre no está atribuido | El gasto se informa aparte como no atribuido; no se suma a la ejecución | `continue` | `observing` | No |
| Q-17 | Tokens parciales; subconjunto conocido 80000; límite 100000; con exigencia declarada | El cumplimiento no se puede probar; el trabajo se frena a la espera de decisión | `pause` | `data_unverified` | Sí |
| Q-18 | Tokens parciales; subconjunto conocido 120000; límite 100000 | La superación está probada; aviso o pausa según `on_soft` | `notify` o `pause` | `tokens_soft_limit_exceeded` | Según `on_soft` |
| Q-19 | Tokens en estado `unknown` con límite declarado y sin exigencia | `unverified` visible; el trabajo continúa | `unverified` | `data_unverified` | No |
| Q-20 | Tiempo activo en estado `unknown` y sin límite de tiempo declarado | No se estima el tiempo; se registra `unknown` | `continue` | `observing` | No |
| Q-21 | El costo estimado resulta en cero | Se registra `cost.state: zero`; no dispara ninguna acción | `continue` | `observing` | No |
| Q-22 | Falta el precio de un modelo, así que el costo total es `unknown` | El total queda `unknown`; no se publica un parcial como si fuera el total | `continue` | `observing` | No |
| Q-23 | Muchas rondas y ningún límite declarado | No hay pausa por rondas y no se cambia de modelo | `continue` | `observing` | No |
| Q-24 | Muchas rondas y un límite de tokens declarado y superado | Se evalúa el límite de tokens; el número de rondas no pausa por sí mismo | `notify` | `tokens_soft_limit_exceeded` | No |
| Q-25 | Un agente concreto muestra una anomalía de consumo y no hay límites declarados | No hay pausa; el gasto no atribuido se informa aparte | `continue` | `observing` | No |
| Q-26 | Un umbral irreversible definido en otro contrato sigue vigente y la terminación dice `continue` | Este contrato no lo evalúa; queda diferido a ese contrato y solo aplica el límite blando declarado | `continue` | `observing` | No |
| Q-27 | La escritura del registro falla y hay un límite declarado | El evento no queda registrado; se conserva la última confirmación buena; pausa de seguridad | `pause` | `record_unavailable` | Sí |
| Q-28 | La escritura del registro falla y no hay ningún límite declarado | `unavailable` visible; se conserva la última confirmación buena; el trabajo sigue | `unavailable` | `record_unavailable` | No |
| Q-29 | Interrupción entre el cierre de ronda 3 y el de la ronda 4 | Se declara un hueco `unrecorded`; el tramo perdido no se inventa ni se estima | `continue` | `observing` | No |
| Q-30 | Consulta de gasto por `execution_id` | Devuelve estado, totales, ronda, límites, evaluación, pausa, eventos, atribución e integridad; no escribe nada | `not_evaluated` | `none` | No |
| Q-31 | El `execution_id` del registro de gasto difiere del del registro de progreso, sin exigencia declarada | Estado contradictorio; no se fusionan ni se sobrescriben los registros; se escala la contradicción | `unavailable` | `record_unavailable` | No |
| Q-32 | La escritura devuelve un `record_version` que no avanzó, sin exigencia declarada | Fallo operativo: no se sobrescribe; se conserva la última confirmación buena | `unavailable` | `record_unavailable` | No |
| Q-33 | La misma `evaluation_key` se evalúa dos veces con el mismo resultado y el gasto está dentro de los límites | No se duplica el evento | `continue` | `within_limits` | No |
| Q-34 | Cierre de la ejecución por terminación | `status: closed`, `closed_at`, totales finales y `last_recorded_moment: close` | `not_evaluated` | `closed` | No |
| Q-35 | Se intenta reanudar una ejecución con `status: closed` | No se reanuda; el registro permanece cerrado | `not_evaluated` | `closed` | No |

---

## C. Trazabilidad de criterios

| Criterio | Sección de la skill | Regla que lo sostiene | Casos de la matriz |
|----------|---------------------|-----------------------|--------------------|
| AC-01 | Señales y precedencia; Límites declarados y configuración; Evaluación del presupuesto | Sin límites declarados el outcome es `continue` con reason `observing`, sin aviso ni pausa | Q-01, Q-12 |
| AC-02 | Condiciones de pausa; Evaluación del presupuesto | Un límite de tokens superado con `on_soft: notify` produce `notify` y el trabajo sigue; no hay cierre ni abandono | Q-02, Q-04, Q-24 |
| AC-03 | Pausa y reanudación | La pausa por límite blando es reversible; al reanudar se conserva todo y el mismo límite no vuelve a pausar | Q-05, Q-06, Q-07, Q-35 |
| AC-04 | Precedencia respecto de la terminación | Si la terminación dice `pause` o `close`, el outcome es `not_evaluated` con `termination_precedence` | Q-09, Q-10 |
| AC-05 | Evaluación del presupuesto | Con terminación `continue` y ningún límite superado el outcome es `continue` con `within_limits` | Q-11, Q-03, Q-21, Q-22 |
| AC-06 | Integridad, datos faltantes y fallos | Registro ilegible, atribución incompleta o escritura fallida dan `pause` con exigencia declarada y `unavailable` o `unverified` visible sin exigencia; nunca se declara cero | Q-13, Q-14, Q-15, Q-16, Q-17, Q-19, Q-27, Q-28, Q-31, Q-32 |
| AC-07 | Señales y precedencia; Condiciones de pausa | Las rondas son solo lectura y nunca disparan aviso ni pausa; la escalación de modelo no pertenece a este contrato | Q-23, Q-24, Q-25 |
| AC-08 | Límites declarados y configuración; Condiciones de pausa | Sin límites declarados no hay pausa por gasto; la exigencia declarada es la condición habilitante | Q-01, Q-08, Q-26 |
| AC-09 | Momentos de registro; Persistencia y consulta | Se escribe en cuatro momentos definidos, nunca por paso; el registro es independiente del de progreso | Q-12, Q-29, Q-30, Q-34 |
| AC-10 | Fronteras; Condiciones de pausa | No hay umbral irreversible, cierre automático ni abandono por gasto en este contrato | Q-09, Q-10, Q-26, Q-34 |
| AC-11 | Señales y precedencia; Condiciones de pausa | El costo estimado es observacional y nunca pausa | Q-21, Q-22, Q-25 |
| AC-12 | Unidad de gasto e identidad de ejecución; Límites declarados y configuración | La unidad es la ejecución completa y no hay topes por agente, por sesión ni por objetivo | Q-16, Q-25 |

---

## D. Casos límite y concurrencia

| ID | Situación | Comportamiento esperado | Verificación |
|----|-----------|-------------------------|--------------|
| D-1 | Dos sesiones de la misma ejecución trabajan al mismo tiempo | Sus intervalos efectivos se **suman**; el tiempo activo no es tiempo de reloj | Contrato de tiempo activo en la skill |
| D-2 | El mismo `session_id` aparece con modelos distintos entre anotaciones | Se conserva la última observación conocida del modelo y se declara la inconsistencia; no se fusionan consumos de ejecuciones distintas | Bloque de sesiones y bloque de integridad |
| D-3 | Una atribución resulta estar mal y se corrige | Se registra un evento `attribution_correction`; los totales se ajustan **una sola vez** y no se duplica consumo | Reglas de atribución |
| D-4 | El snapshot de precios cambia entre anotaciones | Cada estimación conserva su propio `price_snapshot`; el histórico de eventos no se reescribe | Bloque `cost` y bloque `events` |
| D-5 | El documento completo del registro excede lo que la plataforma acepta | Es un fallo operativo: el registro **no** se trunca en silencio; con exigencia declarada, pausa | Regla de escritura y matriz de fallos |
| D-6 | Una sesión previa fue borrada o compactada | El gasto de esa sesión ya está en los totales de la anotación anterior; su ausencia no genera un delta negativo ni un hueco falso | Reglas de huecos y de atribución |
| D-7 | Dos escritores intentan escribir la misma `execution_id` a la vez | `record_version` es monotónico y la confirmación manda; no se pisa una versión más nueva | Regla de monotonía y de confirmación |
| D-8 | El mapa de atribución no está disponible en absoluto | La atribución queda `unverifiable` y las sesiones se listan con `mapping_unavailable`; no se infiere la atribución | Reglas de atribución |

---

## E. Procedimiento de verificación

Todos los comandos son de **solo lectura** y se ejecutan desde la raíz del
repositorio.

### E.1 Existencia de los artefactos

```bash
test -f .flowtask/skills/agent-loop-budget/SKILL.md && echo "SKILL ok"
test -f .flowtask/skills/agent-loop-budget/QA.md && echo "QA ok"
```

### E.2 Secciones en orden

```bash
grep -n '^## ' .flowtask/skills/agent-loop-budget/SKILL.md
```

El resultado debe traer exactamente 17 líneas, en este orden:

```text
Propósito
Fronteras
Unidad de gasto e identidad de ejecución
Señales y precedencia
Schema BudgetRecord v1
Atribución de sesiones
Límites declarados y configuración
Evaluación del presupuesto
Condiciones de pausa
Precedencia respecto de la terminación
Pausa y reanudación
Momentos de registro
Persistencia y consulta
Integridad, datos faltantes y fallos
Distinciones explícitas
Invariantes de aceptación
Matriz de aceptación y ejemplos canónicos
```

### E.3 Parseo del schema canónico

```bash
TMP_SCHEMA=$(mktemp)
awk '/^```json$/{f=1;next} /^```$/{if(f){exit}} f' \
  .flowtask/skills/agent-loop-budget/SKILL.md > "$TMP_SCHEMA"
TMP_SCHEMA="$TMP_SCHEMA" node -e \
  "JSON.parse(require('fs').readFileSync(process.env.TMP_SCHEMA,'utf8')); console.log('schema ok')"
```

### E.4 Bloques del schema

```bash
TMP_SCHEMA="$TMP_SCHEMA" node -e "
const r = JSON.parse(require('fs').readFileSync(process.env.TMP_SCHEMA,'utf8'));
const need = ['round','tokens','time','cost','attribution','sessions','limits',
  'acknowledged_limit_refs','evaluation','events','pause','gaps','integrity'];
const missing = need.filter(k => !(k in r));
console.log(missing.length ? 'missing: ' + missing.join(',') : 'blocks ok');
"
```

### E.5 Identificadores fuera de contrato

El patrón se escribe **ofuscado** para que este documento no contenga ninguno de
los identificadores prohibidos y la comprobación sea reproducible sobre sí misma.

```bash
FORBIDDEN='CA-[a]gent-loop-[b]udget|[F]1\.[0-9]|[H]erm[e]s|[A]gent[R]un|[t]oken_[b]udget|[c]ost_[b]udget|[m]ax_[r]ounds|[m]ax_[t]okens'
grep -nE "$FORBIDDEN" \
  .flowtask/skills/agent-loop-budget/SKILL.md \
  .flowtask/skills/agent-loop-budget/QA.md
```

El resultado esperado es **cero coincidencias**.

### E.6 Namespace y solo lectura

```bash
grep -n 'flow-state/{execution_id}/budget' .flowtask/skills/agent-loop-budget/SKILL.md
grep -n 'flow-state/{execution_id}/progress' .flowtask/skills/agent-loop-budget/SKILL.md
grep -nE 'mem_save\([^)]*progress' \
  .flowtask/skills/agent-loop-budget/SKILL.md \
  .flowtask/skills/agent-loop-budget/QA.md
```

La segunda búsqueda debe devolver **una sola** aparición, y debe describir una
lectura. La tercera no debe devolver nada.

### E.7 Conteos de las matrices

```bash
grep -cE '^\| AC-[0-9]{2} ' .flowtask/skills/agent-loop-budget/SKILL.md   # 12
grep -cE '^\| E-[0-9]{2} '  .flowtask/skills/agent-loop-budget/SKILL.md   # 13
grep -cE '^\| Q-[0-9]{2} '  .flowtask/skills/agent-loop-budget/QA.md      # 35
grep -cE '^\| A-[0-9]{2} '  .flowtask/skills/agent-loop-budget/QA.md      # 16
```

### E.8 Diff y archivos protegidos

```bash
git status --porcelain=v1 --untracked-files=all
git diff --name-only
git diff --cached --name-only
git diff --check
git diff --quiet -- \
  .flowtask/agents/runner.md \
  .flowtask/skills/memory-contract \
  .flowtask/skills/topic-keys-convention \
  .flowtask/skills/checkpoint-mixin
```

`git status` debe mostrar **solo** los dos archivos de esta skill. Los dos
`git diff` de archivos versionados deben estar vacíos y `git diff --quiet` sobre
los archivos protegidos debe salir con código 0.

### E.9 Menciones de frontera

```bash
grep -niE 'tope duro|pausa dura|cierre autom.tico|abandono autom.tico|(^|[^[:alnum:]_])[k]ill([^[:alnum:]_]|$)' \
  .flowtask/skills/agent-loop-budget/SKILL.md
```

Cada coincidencia debe estar en la tabla de fronteras (como prohibición) o en
las filas 5 a 7 de la tabla D5 (como diferida a otro contrato). Ninguna
coincidencia puede describe una capacidad habilitada.

---

## F. Criterios de PASS/FAIL

**PASS** solo si se cumplen **todas** estas condiciones:

1. Los chequeos estáticos **A-01 a A-16** se cumplen sin excepciones.
2. El schema canónico **parsea** y contiene **todos** los bloques de la versión 1.
3. La matriz de aceptación de la skill tiene los **12** criterios y los **13**
   ejemplos canónicos, y cada criterio referencia su sección.
4. La matriz de comportamiento de este documento tiene los **35** casos y **ninguna
   contradicción** con la skill: en particular, ningún caso pausa por costo
   estimado, por número de rondas o por consumo alto sin límite declarado.
5. La trazabilidad de la sección C no tiene ninguna celda vacía y cada criterio
   apunta al menos a un caso de la sección B.
6. La búsqueda de identificadores fuera de contrato (E.5) devuelve **cero**
   coincidencias en ambos archivos.
7. El diff está limitado **exactamente** a `SKILL.md` y `QA.md`; los archivos
   protegidos y los de configuración no tienen cambios.
8. La mención de conceptos de frontera solo aparece como prohibición o como
   fila diferida (E.9).

**FAIL** en cuanto una sola de estas condiciones no se cumple. Un FAIL no se
declara PASS "con observaciones": se reporta la condición incumplida, su
evidencia y el alcance exacto del desvío.

No se modifica ningún archivo durante la verificación. La corrección de un FAIL
corresponde a la implementación, no a esta comprobación.
