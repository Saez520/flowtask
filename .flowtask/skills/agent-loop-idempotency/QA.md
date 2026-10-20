# QA — Idempotencia del Loop

## Propósito y alcance

Este QA es **documental y de solo lectura**. No ejecuta el runtime, no crea archivos, no modifica el repositorio y no declara un resultado sin evidencia. Su objeto es verificar que `SKILL.md` cumple el contrato de idempotencia y que el diff autorizado no se excede.

`SKILL.md` es la fuente normativa. Este documento **no duplica el schema**: los checks lo extraen de `SKILL.md` y validan su parseo y sus campos.

Alcance de la verificación:

- La existencia, el frontmatter y la estructura de `SKILL.md`.
- El parseo del bloque de schema y sus campos top-level.
- La completitud del catálogo de fases, de los códigos de reporte y de los enums.
- La presencia de los identificadores canónicos y la ausencia de tokens de coordinación.
- El límite exacto del diff autorizado.

Fuera de alcance: la ejecución de la loop, la persistencia real del ledger en Engram y cualquier prueba de comportamiento en runtime.

## Cómo se ejecuta

Los checks se ejecutan desde la raíz del repositorio, en el worktree de la ejecución, en orden. Todos son de solo lectura: no crean archivos, no modifican el repositorio y no ejecutan `git add` ni `git commit`.

```bash
SK=".flowtask/skills/agent-loop-idempotency/SKILL.md"
QA=".flowtask/skills/agent-loop-idempotency/QA.md"
```

El resultado de cada check se anota junto a su salida esperada. Un check que falla es un **fallo operativo**: se registra y se escala. No se reinterpretan como progreso ni se omiten.

## Matriz de aceptación

| AC | Regla en SKILL.md | Check | Resultado esperado |
|----|-------------------|-------|--------------------|
| AC-01 | Identidad estable: el reintento conserva `operation_id` y `logical_unit`; el intento no forma parte de la identidad. | C-07, C-08 | El intento no altera la identidad y no aparece una operación duplicada para la misma unidad lógica. |
| AC-02 | Efecto confirmado no repetido: el protocolo devuelve `already_confirmed` y la reanudación restaura la evidencia. | C-07, C-11 | La verificación del verificador ocurre antes de cualquier efecto y una operación confirmada no genera un segundo efecto. |
| AC-03 | Solo lo pendiente: el reintento ejecuta únicamente la fase pendiente, no toda la ejecución. | C-07, C-11 | El avance se limita a la primera operación pendiente cuyas dependencias estén confirmadas. |
| AC-04 | Guardado no confirmado: no se avanza, se conserva lo último confirmado y se informa el fallo operativo. | C-06, C-08, C-11 | El código de persistencia no confirmada está presente y la constancia previa no se sobrescribe. |
| AC-05 | Rechazo funcional: no es reintento; sigue el flujo de revisión y abre una unidad lógica nueva. | C-06, C-11 | El rechazo funcional no incrementa el contador de reintentos y la unidad nueva tiene identidad propia. |
| AC-06 | Reanudación: se continúa desde la fase siguiente pendiente sin reiniciar numeración ni repetir efectos confirmados. | C-07, C-11 | La numeración de fases, unidades, intentos y rondas se conserva y las confirmaciones previas se reutilizan. |
| AC-07 | Efecto incierto no verificable: se detiene, informa el efecto con su identidad y no lo repite a ciegas. | C-06, C-08, C-11 | El protocolo de cuatro pasos está declarado y el efecto incierto queda sin repetir. |
| AC-08 | Registro ausente, ilegible o contradictorio: se informa y se conserva lo último confirmado, sin estado inventado. | C-06, C-11 | Los tres códigos de registro están presentes y no hay ruta de creación de un ledger paralelo. |
| AC-09 | Identidades distintas para efectos parecidos: dos operaciones distintas no comparten identidad ni evidencia. | C-07, C-11 | La identidad se compone de fase y unidad lógica, y la evidencia no se reutiliza entre operaciones. |
| AC-C01 | Reintentos por fase: 2 en `development`, 3 en `production`, fijados en `runner.intake`. | C-06, C-11 | La política declara ambos valores y fija que no cambia durante la ejecución. |
| AC-C02 | Espera entre reintentos: `[250, 500, 1000, 2000]` ms, sin jitter, tope 2000 ms. | C-06, C-11 | La secuencia de backoff está declarada con el tope y sin jitter. |
| AC-C03 | Exigencia de constancia por fase: sí para todo efecto observable, no para las consultas de solo lectura. | C-06, C-11 | La columna `Constancia` del catálogo distingue las fases con efecto observable de las de solo lectura. |

## Escenarios de tabletop

### Escenario 1 — Reintento tras fallo operativo

- **Setup**: operación de integración de commit en estado `in_progress`, con un intento previo que terminó en `operational_failure` y `retry.count: 0`.
- **Acción**: el actor reintenta la fase tras la espera de backoff correspondiente al índice del reintento.
- **Resultado esperado**: `operation_id` y `logical_unit` no cambian; `attempt.number` pasa a 2 y `retry.count` a 1; no se crea una operación nueva en el ledger.
- **Falla si**: aparece una segunda operación con la misma fase y la misma unidad lógica, o el `operation_id` incluye el número de intento.

### Escenario 2 — Efecto confirmado en un reintento

- **Setup**: operación con `state: "confirmed"` y evidencia canónica registrada.
- **Acción**: el actor vuelve a procesar la misma fase tras un corte de sesión.
- **Resultado esperado**: la operación devuelve `already_confirmed`; no se ejecuta el efecto; la evidencia existente se reutiliza tal cual.
- **Falla si**: se ejecuta el efecto otra vez o se genera una nueva entrada de evidencia sin necesidad.

### Escenario 3 — Efecto no confirmado: se ejecuta solo lo pendiente

- **Setup**: dos operaciones de la misma fase, la primera `confirmed` y la segunda `pending` con dependencias confirmadas.
- **Acción**: el actor reintenta el trabajo de esa fase.
- **Resultado esperado**: solo se ejecuta la operación pendiente; la confirmada no se vuelve a ejecutar y la ejecución no se reinicia desde el inicio.
- **Falla si**: se reejecuta la operación confirmada o se recorre toda la ejecución desde la primera fase.

### Escenario 4 — Guardado de constancia no confirmado

- **Setup**: la escritura del ledger no pudo confirmarse por lectura de verificación.
- **Acción**: el actor intenta avanzar a la siguiente fase.
- **Resultado esperado**: no se avanza; se conserva `last_confirmed_operation_id`; se reporta el código de persistencia no confirmada.
- **Falla si**: el avance se produce igual o se pierde la referencia a la última operación confirmada.

### Escenario 5 — Rechazo funcional

- **Setup**: el intento termina con `functional_rejection` por desacuerdo sobre el contenido.
- **Acción**: el actor procesa el rechazo.
- **Resultado esperado**: la operación cierra como `rejected` con el contador de reintentos intacto; el rework abre una unidad lógica nueva con identidad propia.
- **Falla si**: el rechazo se trata como reintento, el contador de reintentos se incrementa o la unidad nueva reutiliza la evidencia de la rechazada.

### Escenario 6 — Pausa y reanudación

- **Setup**: ejecución pausada con varias operaciones confirmadas y al menos una pendiente cuyas dependencias están confirmadas.
- **Acción**: el actor reanuda con identidad válida y constancia restaurable.
- **Resultado esperado**: se restaura la última confirmación y se continúa por la primera pendiente; fases, unidades, intentos, reintentos y rondas conservan su numeración.
- **Falla si**: la numeración se reinicia, se reejecuta un efecto confirmado o se reinicia el contador de reintentos.

### Escenario 7 — Efecto externo incierto verificable y presente

- **Setup**: operación en `uncertain` con entrada en la lista de efectos inciertos en estado de verificación pendiente; el verificador indica que el efecto ocurrió.
- **Acción**: el actor aplica el protocolo de incertidumbre.
- **Resultado esperado**: la operación pasa a `confirmed` con la evidencia del verificador; el efecto incierto queda registrado como presente; no se repite.
- **Falla si**: el efecto se vuelve a ejecutar o queda registrado como incierto sin resolver.

### Escenario 8 — Efecto externo incierto verificable y ausente

- **Setup**: misma situación, pero el verificador indica que el efecto no ocurrió.
- **Acción**: el actor aplica el protocolo de incertidumbre.
- **Resultado esperado**: el efecto se ejecuta una única vez con la misma identidad; la operación avanza por la vía normal.
- **Falla si**: el efecto se ejecuta más de una vez o se cambia la identidad de la operación.

### Escenario 9 — Efecto externo incierto no verificable

- **Setup**: la caída ocurrió a mitad de un efecto externo y el verificador no puede determinar el resultado.
- **Acción**: el actor intenta resolver la incertidumbre.
- **Resultado esperado**: el flujo se detiene, se informa el efecto incierto con su identidad y la evidencia disponible, y no se repite a ciegas.
- **Falla si**: el efecto se reintenta, se duplica «a ver si pasa» o el flujo avanza como si la operación estuviera confirmada.

### Escenario 10 — Registro ausente, ilegible o contradictorio

- **Setup**: el ledger no existe, no se puede leer o presenta contradicciones internas.
- **Acción**: el actor intenta resolver la identidad y leer el ledger.
- **Resultado esperado**: se reporta el código de registro ausente o ilegible o el de registro contradictorio; no se inventa estado, no se reinician conteos y no se crea un ledger nuevo para una ejecución en curso.
- **Falla si**: se crea un ledger paralelo, se reinician conteos o se avanza con datos no verificados.

### Escenario 11 — Dos operaciones distintas con efectos parecidos

- **Setup**: dos operaciones con efectos observables similares, por ejemplo integrar dos commits distintos.
- **Acción**: el actor las procesa en la misma ejecución.
- **Resultado esperado**: cada una tiene su propia identidad, por la fase y la unidad lógica; la evidencia de una no se reutiliza para la otra.
- **Falla si**: se confunden las identidades o se reutiliza evidencia cruzada.

### Escenario 12 — Reintentos agotados

- **Setup**: una fase falló por causa operativa en todos sus intentos permitidos por el perfil vigente.
- **Acción**: el actor agotó el último reintento.
- **Resultado esperado**: la operación queda `blocked` con la marca de reintentos agotados; se reporta el código correspondiente; no hay un nuevo intento automático.
- **Falla si**: se inicia un intento adicional por iniciativa propia o se avanza de fase pese al bloqueo.

## Checks estáticos

Todos los checks se ejecutan desde la raíz del repositorio con las variables `SK` y `QA` definidas en «Cómo se ejecuta».

### C-01 — Existencia de los dos artefactos

```bash
test -f "$SK" && test -f "$QA" && echo "files: OK"
```

Salida esperada: `files: OK`.

### C-02 — Frontmatter de la skill

```bash
sed -n '1,12p' "$SK" | grep -E "^name: agent-loop-idempotency$" \
  && sed -n '1,12p' "$SK" | grep -E "^license: MIT$" \
  && sed -n '1,12p' "$SK" | grep -E "^compatibility: opencode$" \
  && sed -n '1,12p' "$SK" | grep -E "^  category: agent-loop$" \
  && sed -n '1,12p' "$SK" | grep -E "^  scope: flowtask$" \
  && echo "frontmatter: OK"
```

Salida esperada: las cinco coincidencias y `frontmatter: OK`.

### C-03 — Presencia de las 19 secciones

```bash
SEC="Propósito|Cuándo se carga|Fronteras|Modelo conceptual|Identidad de operación|Catálogo de fases|Política configurable|Clases de efecto y tratamiento|Schema IdempotencyRecord v1|Persistencia y confirmación|Protocolo de ejecución|Reintentos|Reanudación|Matriz de acciones|Evidencia|Fallos, estados y códigos de reporte|Invariantes|Checklist de aceptación|Ejemplos"
found=$(grep -cE "^## ($SEC)$" "$SK")
echo "sections=$found"
```

Salida esperada: `sections=19`.

### C-04 — Parseo del bloque de schema y sus campos top-level

```bash
awk '/^```json$/{f=1;next} f&&/^```$/{exit} f' "$SK" | node -e '
let s="";
process.stdin.on("data",d=>s+=d).on("end",()=>{
  const o=JSON.parse(s);
  const req=["schema","execution","policy","operations","uncertain_effects","integrity","created_at","updated_at"];
  const missing=req.filter(k=>!(k in o));
  if(missing.length){console.error("missing:"+missing.join(","));process.exit(1);}
  if(o.schema!=="agent-loop-idempotency/"+"v1"){console.error("bad-schema");process.exit(1);}
  console.log("schema: OK fields="+Object.keys(o).length);
});'
```

Salida esperada: `schema: OK fields=8`. El bloque se extrae de la sección de schema; este archivo no lo reproduce.

### C-05 — Enumeraciones declaradas

```bash
for v in pending in_progress confirmed failed rejected uncertain blocked \
         operational_failure interruption functional_rejection verification_failed \
         idempotent non_idempotent pending_verification confirmed_present confirmed_absent unresolvable \
         active paused closed \
         git_ref git_commit file_hash test_run artifact_ref instance_ref progress_ref command_output human_decision; do
  grep -q "\`$v\`" "$SK" || echo "MISSING_ENUM:$v"
done
echo "enums: OK"
```

Salida esperada: `enums: OK` y ninguna línea `MISSING_ENUM`.

### C-06 — Catálogo de fases y códigos de reporte

```bash
fases=$(awk '/^## Catálogo de fases$/{f=1} f&&/^## Política configurable$/{f=0} f' "$SK" | grep -cE '^\| (Runner|Constructor) \|')
codigos=0
for code in identity_unavailable record_unavailable record_contradictory persistence_unconfirmed \
            retry_exhausted ambiguous_execution no_resumable_execution concurrent_write_suspected \
            uncertain_external_effect_unresolved; do
  grep -q "$code" "$SK" && codigos=$((codigos+1))
done
echo "fases=$fases codigos=$codigos"
```

Salida esperada: `fases=12 codigos=9`.

### C-07 — Identificadores canónicos presentes

```bash
for id in operation_id last_confirmed_operation_id uncertain_external_effect_unresolved \
          persistence_unconfirmed retry_exhausted logical_unit record_version; do
  printf "%s=%s " "$id" "$(grep -c "$id" "$SK")"
done
echo
```

Salida esperada: cada identificador con un conteo mayor o igual a 1.

### C-08 — Tokens de coordinación prohibidos

El patrón se arma por fragmentos para que este archivo no contenga de forma contigua los tokens que verifica.

```bash
PAT="CA-agent-loop-idemp""otency|F1\\.[0-9]|Agent""Run|Her""mes|H[012]|\\.open""code/"
grep -nE "$PAT" "$SK" "$QA" || echo "prohibited: none"
```

Salida esperada: `prohibited: none`.

### C-09 — Diff limitado a los dos artefactos

```bash
git diff --name-only
git status --porcelain --untracked-files=all | awk '{print $2}' | grep -vE "^\.flowtask/skills/agent-loop-idempotency/(SKILL|QA)\.md$" || true
```

Salida esperada: la primera orden no imprime rutas de archivos modificados ya versionados; la segunda no imprime ninguna ruta fuera de los dos artefactos.

### C-10 — Rutas absolutas

El patrón se arma por fragmentos para que este archivo no contenga de forma contigua las rutas que verifica.

```bash
grep -nE "/Us""ers/|/priv""ate/|^/ho""me/" "$SK" "$QA" || echo "abs-paths: none"
```

Salida esperada: `abs-paths: none`.

### C-11 — Estructura de los artefactos verificados

```bash
echo "invariantes=$(grep -cE '^\| I-[0-9]{2} \|' "$SK")"
echo "checklist=$(grep -cE '^\| (AC|CF)-[0-9]{2} \|' "$SK")"
echo "ejemplos=$(grep -cE '^### Ejemplo' "$SK")"
echo "acciones=$(awk '/^## Matriz de acciones$/{f=1} f&&/^## Evidencia$/{f=0} f' "$SK" | grep -cE '^\| [A-Z]')"
```

Salida esperada: `invariantes` igual o mayor que 10, `checklist` igual a 12, `ejemplos` igual o mayor que 4 y `acciones` igual o mayor que 13.

### C-12 — Integridad de este documento

```bash
echo "filas=$(grep -cE '^\| AC-' "$QA")"
echo "escenarios=$(grep -cE '^### Escenario [0-9]+ —' "$QA")"
echo "setup=$(grep -cE '^- \*\*Setup\*\*:' "$QA")"
echo "accion=$(grep -cE '^- \*\*Acción\*\*:' "$QA")"
echo "esperado=$(grep -cE '^- \*\*Resultado esperado\*\*:' "$QA")"
echo "falla=$(grep -cE '^- \*\*Falla si\*\*:' "$QA")"
LIT=$(printf '"schema": "agent-loop-idempotency/%s"' 'v1')
echo "schema-duplicado=$(grep -cF "$LIT" "$QA")"
```

Salida esperada: `filas=12`, `escenarios=12`, `setup=12`, `accion=12`, `esperado=12`, `falla=12` y `schema-duplicado=0`.

## Criterios de salida

- Todos los checks estáticos de esta sección pasan y su salida coincide con la esperada.
- La matriz de aceptación tiene 12 filas completas: cada fila cita la regla de `SKILL.md` que satisface y un check reproducible.
- Los 12 escenarios de tabletop tienen las cuatro partes: `Setup`, `Acción`, `Resultado esperado` y `Falla si`.
- No hay tokens de coordinación prohibidos ni rutas absolutas en los dos artefactos.
- El diff contiene exactamente dos archivos: la skill y este QA, y nada más.
- Ningún check declara un resultado sin evidencia: un check que falla se registra como **fallo operativo** y se escala; no se reinterpreta como progreso ni se omite.
- Este documento no declara un resultado favorable por sí mismo: el resultado se determina al ejecutar los checks.
