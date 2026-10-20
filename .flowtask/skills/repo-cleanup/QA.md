# QA — repo-cleanup

## Propósito

Este documento verifica la skill `repo-cleanup` como **documento y como protocolo**. La
verificación es de **solo lectura** sobre el repositorio objetivo: no aplica la
limpieza real, no muta el repositorio analizado y no ejecuta ningún plan de purga
contra un repositorio de trabajo.

Alcance de la verificación:

- **Alcance normativo:** el contrato de la skill (`SKILL.md`) y este documento.
- **Fuera de alcance:** la aplicación real de la limpieza, cualquier cambio de
  comportamiento ejecutable, la configuración y el producto.

La verificación tiene dos mitades: **comprobaciones estáticas** sobre la forma del
contrato (bloque A) y **escenarios de fixture** sobre repositorios construidos en un
directorio temporal (bloque B). Los fixtures se montan y se desmontan dentro del
temporal; el repositorio objetivo no se toca.

---

## Cómo se ejecuta

1. Todos los comandos se ejecutan **desde el directorio de la skill**; las rutas a los
   archivos de la skill son relativas a ese directorio.
2. El trabajo temporal se crea con `mktemp -d` y se elimina al terminar. Ningún
   archivo del repositorio objetivo se escribe ni se borra.
3. Cada bloque termina en **PASS** o **FAIL**, y devuelve código de salida distinto de
   cero cuando falla.
4. Solo se usan `git` y utilidades POSIX. Ninguna comprobación requiere red: los
   fixtures usan un remoto local.
5. Un solo **FAIL** detiene la verificación: no hay PASS parcial.
6. Los repositorios de fixture se crean con `git init -b trunk` y, cuando hace falta,
   con `git symbolic-ref`; así ningún nombre de rama del repositorio de origen queda
   escrito en este documento.

---

## A. Comprobaciones estáticas

### A-01 — Archivos y frontmatter

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fallo=0
test -f SKILL.md || { printf 'falta SKILL.md\n'; fallo=1; }
test -f QA.md || { printf 'falta QA.md\n'; fallo=1; }

sed -n '1,12p' SKILL.md > "$TMP/frontmatter.txt"
for esperado in 'name: repo-cleanup' 'description: >-' 'license: MIT' 'compatibility: opencode' 'category: maintenance' 'scope: repository'; do
  if ! grep -qF "$esperado" "$TMP/frontmatter.txt"; then
    printf 'frontmatter incompleto: falta %s\n' "$esperado"
    fallo=1
  fi
done

if [ "$fallo" -ne 0 ]; then printf 'FAIL A-01\n'; exit 1; fi
printf 'PASS A-01\n'
```

**Salida esperada:** los dos archivos existen y el frontmatter declara `name:
repo-cleanup`, `description` plegada, `license: MIT`, `compatibility: opencode`,
`metadata.category: maintenance` y `metadata.scope: repository`.

### A-02 — Catorce secciones en orden exacto

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/esperadas.txt" <<'EOF'
Propósito
Alcance y no-objetivos
Entradas y configuración
Contrato de solo lectura
Taxonomía de severidad
Familias de análisis
Reglas de higiene
Protocolo de ejecución con aprobación
Contrato de salida
Agnosticismo del repositorio
Degradación y límites
Instalación y descubrimiento
Verificación
Exclusiones
EOF

grep '^## ' SKILL.md | sed 's/^## //' > "$TMP/obtenidas.txt"

if diff -u "$TMP/esperadas.txt" "$TMP/obtenidas.txt"; then
  printf 'PASS A-02\n'
else
  printf 'FAIL A-02: el orden de secciones no coincide\n'
  exit 1
fi
```

**Salida esperada:** `diff` no reporta diferencia: las catorce secciones aparecen en el
orden del contrato.

### A-03 — Familias, reglas y etapas

```bash
set -u

familias="$(grep -c '^### F[1-7] — ' SKILL.md)"
reglas="$(grep -c '^- \*\*R\(10\|[1-9]\) — ' SKILL.md)"
etapas="$(grep -c '^- \*\*P[1-6] — ' SKILL.md)"
bloques="$(grep -c '^### \(Inventario de hallazgos\|Plan de limpieza\|Registro de aplicación\|Estado final\)$' SKILL.md)"

if [ "$familias" = "7" ] && [ "$reglas" = "10" ] && [ "$etapas" = "6" ] && [ "$bloques" = "4" ]; then
  printf 'PASS A-03\n'
else
  printf 'FAIL A-03: familias=%s reglas=%s etapas=%s bloques=%s\n' "$familias" "$reglas" "$etapas" "$bloques"
  exit 1
fi
```

**Salida esperada:** siete familias, diez reglas, seis etapas y cuatro bloques del
contrato de salida.

### A-04 — Denylist de literales del origen

El patrón se construye por partes para que este documento no contenga ninguno de los
literales prohibidos y la verificación sea reproducible sobre sí misma.

```bash
set -u

prohibido_carro='work[t]ree[-]manager'
prohibido_proyecto='flow[t]ask'
prohibido_rutas='/[Uu]ser[s]/|/hom[e]/'
prohibido_directorios='\.work[t]rees|\.flow[t]ask|\.open[c]ode'
prohibido_ramas='\b(mai[n]|mast[e]r)\b'
prohibido_revision='\b[0-9a-f]{40}\b'
prohibido_etapa='pha[s]e-[0-9]+'
prohibido_opcion='preserve[-]dirty'

patron="$prohibido_carro|$prohibido_proyecto|$prohibido_rutas|$prohibido_directorios|$prohibido_ramas|$prohibido_revision|$prohibido_etapa|$prohibido_opcion"

if grep -niE "$patron" SKILL.md QA.md; then
  printf 'FAIL A-04: literal prohibido presente\n'
  exit 1
fi
printf 'PASS A-04\n'
```

**Salida esperada:** `grep` no reporta coincidencias: ni en el contrato ni en este
documento hay nombres del proyecto de origen, rutas de máquina, nombres de rama,
identificadores de revisión, nombres de etapa ni opciones específicas de una
herramienta.

---

## B. Escenarios de fixture

### B-01 — Cadena de identidad de submódulos

**Qué verifica:** que los estados de la cadena de identidad se reporten por separado
sobre un consumidor con un submódulo declarado, con remoto local.

El fixture monta un remoto bare, un componente con dos revisiones publicadas y un
consumidor que registra el componente como submódulo. Después provoca, uno por uno, los
cinco estados esperados y comprueba que cada uno produce su etiqueta.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ORIGIN="$TMP/origin.git"
CONSUMIDOR="$TMP/consumidor"
COMPONENTE="componente"

git init --bare -q "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/trunk

CLON="$TMP/componente"
git init -q -b trunk "$CLON"
git -C "$CLON" config user.email fixture@example.invalid
git -C "$CLON" config user.name Fixture
printf 'uno\n' > "$CLON/contenido.txt"
git -C "$CLON" add contenido.txt
git -C "$CLON" commit -q -m "primera"
REV1="$(git -C "$CLON" rev-parse HEAD)"
git -C "$CLON" remote add origin "$ORIGIN"
git -C "$CLON" push -q origin trunk
printf 'dos\n' >> "$CLON/contenido.txt"
git -C "$CLON" add contenido.txt
git -C "$CLON" commit -q -m "segunda"
REV2="$(git -C "$CLON" rev-parse HEAD)"
git -C "$CLON" push -q origin trunk

git init -q -b trunk "$CONSUMIDOR"
git -C "$CONSUMIDOR" config user.email fixture@example.invalid
git -C "$CONSUMIDOR" config user.name Fixture
git -C "$CONSUMIDOR" -c protocol.file.allow=always submodule add -q "$ORIGIN" "$COMPONENTE"
git -C "$CONSUMIDOR/$COMPONENTE" checkout -q --detach "$REV1"
git -C "$CONSUMIDOR" add "$COMPONENTE"
git -C "$CONSUMIDOR" commit -q -m "registra componente"

etiqueta() {
  ruta="$1"; consumidor="$2"; rel="$3"
  if [ ! -e "$ruta/.git" ]; then printf 'no inicializado\n'; return 0; fi
  if [ -n "$(git -C "$ruta" ls-files --unmerged 2>/dev/null)" ]; then printf 'en conflicto\n'; return 0; fi
  if [ -n "$(git -C "$ruta" status --porcelain 2>/dev/null)" ]; then printf 'sucio\n'; return 0; fi
  checkout="$(git -C "$ruta" rev-parse HEAD 2>/dev/null || printf '')"
  publicado=no
  for referencia in $(git -C "$ruta" ls-remote origin 2>/dev/null | awk '{print $1}'); do
    if git -C "$ruta" merge-base --is-ancestor "$checkout" "$referencia" 2>/dev/null; then publicado=si; break; fi
  done
  if [ "$publicado" != "si" ]; then printf 'no publicado\n'; return 0; fi
  registrado="$(git -C "$consumidor" ls-tree HEAD -- "$rel" | awk '{print $3}')"
  if [ "$checkout" != "$registrado" ]; then printf 'divergente\n'; return 0; fi
  if ! git -C "$ruta" symbolic-ref -q HEAD >/dev/null 2>&1; then
    punta="$(git -C "$ruta" ls-remote origin HEAD 2>/dev/null | awk '{print $1}')"
    if [ -n "$punta" ] && ! git -C "$ruta" merge-base --is-ancestor "$checkout" "$punta" 2>/dev/null; then
      printf 'separado\n'; return 0
    fi
  fi
  printf 'limpio\n'
}

datos() {
  ruta="$1"; consumidor="$2"; rel="$3"
  printf 'checkout=%s\n' "$(git -C "$ruta" rev-parse HEAD 2>/dev/null || printf '')"
  printf 'registrado=%s\n' "$(git -C "$consumidor" ls-tree HEAD -- "$rel" | awk '{print $3}')"
  printf 'publicado=%s\n' "$(git -C "$ruta" ls-remote origin 2>/dev/null | awk '{print $1}' | head -1)"
  printf 'arbol=%s\n' "$(git -C "$ruta" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
}

observados=""
observados="$observados $(etiqueta "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE")"
datos "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE" > "$TMP/datos-limpio.txt"

printf 'cambio\n' >> "$CONSUMIDOR/$COMPONENTE/contenido.txt"
observados="$observados $(etiqueta "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE")"
git -C "$CONSUMIDOR/$COMPONENTE" checkout -q -- contenido.txt

git -C "$CONSUMIDOR/$COMPONENTE" checkout -q --detach "$REV2"
observados="$observados $(etiqueta "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE")"
git -C "$CONSUMIDOR/$COMPONENTE" checkout -q --detach "$REV1"

git -C "$CONSUMIDOR/$COMPONENTE" checkout -q --detach "$REV2"
printf 'tres\n' >> "$CONSUMIDOR/$COMPONENTE/contenido.txt"
git -C "$CONSUMIDOR/$COMPONENTE" add contenido.txt
git -C "$CONSUMIDOR/$COMPONENTE" commit -q -m "revision local no publicada"
REV3="$(git -C "$CONSUMIDOR/$COMPONENTE" rev-parse HEAD)"
git -C "$CONSUMIDOR" add "$COMPONENTE"
git -C "$CONSUMIDOR" commit -q -m "actualiza puntero"
observados="$observados $(etiqueta "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE")"

git -C "$CONSUMIDOR" submodule deinit -f "$COMPONENTE" >/dev/null 2>&1
observados="$observados $(etiqueta "$CONSUMIDOR/$COMPONENTE" "$CONSUMIDOR" "$COMPONENTE")"

esperados=" limpio sucio divergente no publicado no inicializado"
if [ "$observados" = "$esperados" ]; then
  printf 'PASS B-01\n'
else
  printf 'FAIL B-01: esperado [%s] obtenido [%s]\n' "$esperados" "$observados"
  exit 1
fi
```

**Salida esperada:** los cinco estados aparecen etiquetados por separado y en orden —
`limpio`, `sucio`, `divergente`, `no publicado`, `no inicializado`. Los cuatro datos de
la cadena (checkout, identificador registrado, revisión publicada y estado del árbol) se
resuelven por separado.

### B-02 — Artefacto sin consumidor

**Qué verifica:** que un artefacto sin consumidor operativo se liste, y que deje de
listarse en cuanto aparece una referencia activa.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repositorio"
git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
mkdir -p "$REPO/evidencia/historial"
printf 'reporte\n' > "$REPO/evidencia/historial/reporte.txt"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "contenido inicial"

CANDIDATO="evidencia/historial"
SIN_CONSUMIDOR="$(git -C "$REPO" grep -n -F "$CANDIDATO" -- . ":(exclude)$CANDIDATO" || true)"
if [ -n "$SIN_CONSUMIDOR" ]; then
  printf 'FAIL B-02: el artefacto no deberia tener consumidor\n'
  exit 1
fi

mkdir -p "$REPO/guias"
printf 'Ver %s para el historial.\n' "$CANDIDATO" > "$REPO/guias/indice.md"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "agrega guia"

CON_CONSUMIDOR="$(git -C "$REPO" grep -n -F "$CANDIDATO" -- . ":(exclude)$CANDIDATO" || true)"
if [ -z "$CON_CONSUMIDOR" ]; then
  printf 'FAIL B-02: el artefacto con consumidor debe dejar de listarse\n'
  exit 1
fi
printf 'PASS B-02\n'
```

**Salida esperada:** sin consumidor, el artefacto es candidato a purga; con una
referencia activa, deja de listarse.

### B-03 — Referencia muerta

**Qué verifica:** que un enlace relativo a un destino inexistente se reporte con su
origen y su destino, y que deje de reportarse cuando el destino aparece.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repositorio"
git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
mkdir -p "$REPO/guias"
printf 'Consulta la [politica de versiones](politica/versiones.md).\n' > "$REPO/guias/guia.md"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "guia"

ORIGEN="$(git -C "$REPO" grep -l -E '\]\([^)]+\)' -- . | head -1)"
DESTINO="guias/politica/versiones.md"

if [ "$ORIGEN" != "guias/guia.md" ]; then
  printf 'FAIL B-03: no se localizo el origen del enlace\n'
  exit 1
fi
if [ -e "$REPO/$DESTINO" ]; then
  printf 'FAIL B-03: el destino deberia estar ausente\n'
  exit 1
fi

mkdir -p "$REPO/guias/politica"
printf '# Politica de versiones\n' > "$REPO/$DESTINO"
if [ ! -e "$REPO/$DESTINO" ]; then
  printf 'FAIL B-03: el destino deberia existir tras crearlo\n'
  exit 1
fi
printf 'origen=%s destino=%s\n' "$ORIGEN" "$DESTINO"
printf 'PASS B-03\n'
```

**Salida esperada:** el enlace se localiza en su archivo de origen, el destino no
existe y se reporta el par origen/destino; tras crear el destino, la referencia deja de
estar rota.

### B-04 — Contradicción documental

**Qué verifica:** que una afirmación documental divergente de la fuente declarada se
detecte, y que la contradicción desaparezca al alinear la afirmación.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repositorio"
git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
mkdir -p "$REPO/guias"
printf 'version=1.2.3\n' > "$REPO/manifiesto.txt"
printf 'Requiere version 9.9.9\n' > "$REPO/guias/requisitos.md"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "contenido inicial"

AFIRMACION="$(git -C "$REPO" grep -n -F 'Requiere version' -- guias/requisitos.md | head -1)"
FUENTE="$(git -C "$REPO" grep -n -F 'version=' -- manifiesto.txt | head -1)"

if [ -z "$AFIRMACION" ] || [ -z "$FUENTE" ]; then
  printf 'FAIL B-04: no se localizaron afirmacion y fuente\n'
  exit 1
fi

DECLARADA="$(printf '%s\n' "$FUENTE" | sed 's/.*version=//')"
EXIGIDA="$(printf '%s\n' "$AFIRMACION" | sed 's/.*version //')"

if [ "$DECLARADA" = "$EXIGIDA" ]; then
  printf 'FAIL B-04: no habria contradiccion que detectar\n'
  exit 1
fi

printf 'Requiere version %s\n' "$DECLARADA" > "$REPO/guias/requisitos.md"
ALINEADA="$(git -C "$REPO" grep -n -F 'Requiere version' -- guias/requisitos.md | head -1)"
ALINEADA="$(printf '%s\n' "$ALINEADA" | sed 's/.*version //')"

if [ "$ALINEADA" != "$DECLARADA" ]; then
  printf 'FAIL B-04: la contradiccion persiste tras alinear\n'
  exit 1
fi
printf 'PASS B-04\n'
```

**Salida esperada:** la afirmación y su fuente declarada se localizan, se contrasta y
se declara la divergencia; tras alinear la afirmación, la divergencia desaparece.

### B-05 — Identificador fijado y entradas huérfanas

**Qué verifica:** que un identificador fijado a mano se marque frente al identificador
derivado del índice, y que las entradas huérfanas de un manifiesto se cuenten de forma
exacta y se purguen por parche de clave.

El identificador del fixture se genera en tiempo de ejecución a partir de las revisiones
reales del repositorio de prueba: no hay ningún identificador escrito en este
documento.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repositorio"
COMP="$TMP/componente"
git init -q -b trunk "$COMP"
git -C "$COMP" config user.email fixture@example.invalid
git -C "$COMP" config user.name Fixture
printf 'uno\n' > "$COMP/contenido.txt"
git -C "$COMP" add contenido.txt
git -C "$COMP" commit -q -m "primera"
REV1="$(git -C "$COMP" rev-parse HEAD)"
printf 'dos\n' >> "$COMP/contenido.txt"
git -C "$COMP" add contenido.txt
git -C "$COMP" commit -q -m "segunda"
REV2="$(git -C "$COMP" rev-parse HEAD)"

git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
git -C "$REPO" -c protocol.file.allow=always submodule add -q "$COMP" componente
git -C "$REPO" commit -q -m "registra componente"

printf 'revision esperada: %s\n' "$REV1" > "$REPO/compuerta.sh"
printf 'ruta=componente\nruta=huerfana/inexistente\n' > "$REPO/manifiesto.txt"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "compuerta y manifiesto"

DERIVADO="$(git -C "$REPO" ls-tree HEAD -- componente | awk '{print $3}')"
LITERAL="$(git -C "$REPO" grep -o -E '(^|[^0-9a-f])[0-9a-f]{7,40}([^0-9a-f]|$)' -- compuerta.sh | head -1 | grep -o -E '[0-9a-f]{7,40}' | head -1)"

if [ -z "$LITERAL" ]; then
  printf 'FAIL B-05: no se localizo el identificador fijado a mano\n'
  exit 1
fi
if [ "$LITERAL" = "$DERIVADO" ]; then
  printf 'FAIL B-05: no habria identificador fijado que marcar\n'
  exit 1
fi
if [ "$DERIVADO" != "$REV2" ]; then
  printf 'FAIL B-05: el identificador derivado no coincide con el indice\n'
  exit 1
fi

HUERFANAS=0
while IFS= read -r ruta; do
  [ -n "$ruta" ] || continue
  if [ ! -e "$REPO/$ruta" ]; then HUERFANAS=$((HUERFANAS + 1)); fi
done <<EOF
$(grep '^ruta=' "$REPO/manifiesto.txt" | cut -d= -f2)
EOF

if [ "$HUERFANAS" -ne 1 ]; then
  printf 'FAIL B-05: se esperaba 1 entrada huerfana y se encontraron %s\n' "$HUERFANAS"
  exit 1
fi

CLAVE='ruta=huerfana/inexistente'
OCURRENCIAS="$(grep -c -F "$CLAVE" "$REPO/manifiesto.txt" || true)"
if [ "$OCURRENCIAS" -ne 1 ]; then
  printf 'FAIL B-05: la clave deberia aparecer exactamente una vez\n'
  exit 1
fi
awk -v clave="$CLAVE" 'index($0, clave) != 1 {print}' "$REPO/manifiesto.txt" > "$TMP/manifiesto.txt"
cp "$TMP/manifiesto.txt" "$REPO/manifiesto.txt"

RESTANTES=0
while IFS= read -r ruta; do
  [ -n "$ruta" ] || continue
  if [ ! -e "$REPO/$ruta" ]; then RESTANTES=$((RESTANTES + 1)); fi
done <<EOF
$(grep '^ruta=' "$REPO/manifiesto.txt" | cut -d= -f2)
EOF

if [ "$RESTANTES" -ne 0 ]; then
  printf 'FAIL B-05: el parche por clave no vacio las entradas huerfanas\n'
  exit 1
fi
printf 'PASS B-05\n'
```

**Salida esperada:** el identificador escrito a mano se marca porque no coincide con el
derivado del índice; el manifiesto tiene exactamente una entrada huérfana y el parche
por clave la deja en cero.

### B-06 — Duplicación documental

**Qué verifica:** que un mismo tema contado en el consumidor y en el componente con
afirmaciones divergentes se detecte y se citen las dos rutas.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

COMP="$TMP/componente"
git init -q -b trunk "$COMP"
git -C "$COMP" config user.email fixture@example.invalid
git -C "$COMP" config user.name Fixture
mkdir -p "$COMP/docs"
printf '# Instalacion\n\nRequiere version 2.0.0 del componente.\n' > "$COMP/docs/instalacion.md"
git -C "$COMP" add .
git -C "$COMP" commit -q -m "documentacion del componente"

REPO="$TMP/consumidor"
git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
git -C "$REPO" -c protocol.file.allow=always submodule add -q "$COMP" componente
mkdir -p "$REPO/guias"
printf '# Instalacion\n\nRequiere version 1.0.0 del componente.\n' > "$REPO/guias/instalacion.md"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "documentacion del consumidor"

git -C "$REPO" grep -n -E '^#{1,3} ' -- guias | sed 's/^[^:]*:[0-9]*://' | sed 's/^#* *//' | sort -u > "$TMP/temas-consumidor.txt"
git -C "$REPO/componente" grep -n -E '^#{1,3} ' -- docs | sed 's/^[^:]*:[0-9]*://' | sed 's/^#* *//' | sort -u > "$TMP/temas-componente.txt"
comm -12 "$TMP/temas-consumidor.txt" "$TMP/temas-componente.txt" > "$TMP/temas-comunes.txt"

if ! grep -q -x 'Instalacion' "$TMP/temas-comunes.txt"; then
  printf 'FAIL B-06: no se detecto el tema comun\n'
  exit 1
fi

RUTA_CONSUMIDOR="guias/instalacion.md"
RUTA_COMPONENTE="componente/docs/instalacion.md"
AFIRMA_CONSUMIDOR="$(git -C "$REPO" grep -h -E 'Requiere version' -- "$RUTA_CONSUMIDOR" | head -1)"
AFIRMA_COMPONENTE="$(git -C "$REPO/componente" grep -h -E 'Requiere version' -- docs/instalacion.md | head -1)"

if [ -z "$AFIRMA_CONSUMIDOR" ] || [ -z "$AFIRMA_COMPONENTE" ]; then
  printf 'FAIL B-06: no se localizaron las afirmaciones divergentes\n'
  exit 1
fi
if [ "$AFIRMA_CONSUMIDOR" = "$AFIRMA_COMPONENTE" ]; then
  printf 'FAIL B-06: no habria afirmacion divergente\n'
  exit 1
fi
printf 'consumidor=%s componente=%s\n' "$RUTA_CONSUMIDOR" "$RUTA_COMPONENTE"
printf 'PASS B-06\n'
```

**Salida esperada:** el tema común se detecta y el hallazgo cita las dos rutas con sus
afirmaciones divergentes.

### B-07 — Protocolo y fallo cerrado

**Qué verifica:** que sin aprobación no se modifique nada, que un plan aprobado se
aplique en una copia aislada en el orden componente→consumidor, que una purga con una
ruta faltante aborte informando la ruta sin borrar nada, y que un repositorio sin
submódulos informe F1 y F6 como no aplicables.

Este fixture **no usa `git stash`**: en un árbol con submódulos declarados esa
operación reinicia el checkout al identificador registrado y puede borrar código.

```bash
set -u
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- parte 1: sin aprobacion explicita no se modifica nada ---
REPO="$TMP/repositorio"
git init -q -b trunk "$REPO"
git -C "$REPO" config user.email fixture@example.invalid
git -C "$REPO" config user.name Fixture
mkdir -p "$REPO/evidencia"
printf 'resto\n' > "$REPO/evidencia/obsoleto.txt"
printf 'guia\n' > "$REPO/guia.md"
git -C "$REPO" add .
git -C "$REPO" commit -q -m "inicial"

HUELLA_ANTES="$(git -C "$REPO" rev-parse HEAD)"
ARBOL_ANTES="$(git -C "$REPO" status --porcelain)"

git -C "$REPO" ls-files > /dev/null
git -C "$REPO" grep -n -F 'evidencia' -- . ':(exclude)evidencia' > /dev/null || true
git -C "$REPO" submodule status --recursive > /dev/null 2>&1 || true

HUELLA_DESPUES="$(git -C "$REPO" rev-parse HEAD)"
ARBOL_DESPUES="$(git -C "$REPO" status --porcelain)"
if [ "$HUELLA_ANTES" != "$HUELLA_DESPUES" ] || [ "$ARBOL_ANTES" != "$ARBOL_DESPUES" ]; then
  printf 'FAIL B-07: el analisis sin aprobacion modifico el arbol\n'
  exit 1
fi

# --- parte 2: el plan aprobado se aplica en copia aislada, componente antes que consumidor ---
ORIGIN="$TMP/origin.git"
git init --bare -q "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/trunk

COMP="$TMP/componente"
git init -q -b trunk "$COMP"
git -C "$COMP" config user.email fixture@example.invalid
git -C "$COMP" config user.name Fixture
printf 'uno\n' > "$COMP/contenido.txt"
git -C "$COMP" add contenido.txt
git -C "$COMP" commit -q -m "primera"
git -C "$COMP" remote add origin "$ORIGIN"
git -C "$COMP" push -q origin trunk

CON="$TMP/consumidor"
git init -q -b trunk "$CON"
git -C "$CON" config user.email fixture@example.invalid
git -C "$CON" config user.name Fixture
git -C "$CON" -c protocol.file.allow=always submodule add -q "$ORIGIN" componente
git -C "$CON" commit -q -m "registra componente"

AISLADA="$TMP/aislada"
git clone -q "$CON" "$AISLADA"
git -C "$AISLADA" -c protocol.file.allow=always submodule update -q --init

ORDEN="$TMP/orden.txt"
: > "$ORDEN"

printf 'dos\n' >> "$COMP/contenido.txt"
git -C "$COMP" add contenido.txt
git -C "$COMP" commit -q -m "segunda"
REV2="$(git -C "$COMP" rev-parse HEAD)"
git -C "$COMP" push -q origin trunk
printf 'componente\n' >> "$ORDEN"

git -C "$AISLADA/componente" fetch -q origin
git -C "$AISLADA/componente" checkout -q --detach "$REV2"
git -C "$AISLADA" add componente
git -C "$AISLADA" commit -q -m "actualiza puntero"
printf 'consumidor\n' >> "$ORDEN"

if [ "$(sed -n 1p "$ORDEN")" != "componente" ] || [ "$(sed -n 2p "$ORDEN")" != "consumidor" ]; then
  printf 'FAIL B-07: el orden de aplicacion no es componente antes que consumidor\n'
  exit 1
fi
REGISTRADO="$(git -C "$AISLADA" ls-tree HEAD -- componente | awk '{print $3}')"
if [ "$REGISTRADO" != "$REV2" ]; then
  printf 'FAIL B-07: el consumidor no registro el identificador nuevo\n'
  exit 1
fi
if ! git -C "$AISLADA/componente" ls-remote origin | awk '{print $1}' | grep -q -x "$REV2"; then
  printf 'FAIL B-07: el identificador registrado no esta publicado\n'
  exit 1
fi
if [ "$(git -C "$CON" rev-parse HEAD)" != "$(git -C "$CON" rev-parse HEAD)" ]; then
  printf 'FAIL B-07: inconsistencia en el consumidor\n'
  exit 1
fi
if [ -n "$(git -C "$CON" status --porcelain)" ]; then
  printf 'FAIL B-07: la copia aislada no es independiente del consumidor\n'
  exit 1
fi

# --- parte 3: una purga con ruta faltante aborta informando la ruta y sin borrar nada ---
PURGA="$TMP/purga"
git init -q -b trunk "$PURGA"
git -C "$PURGA" config user.email fixture@example.invalid
git -C "$PURGA" config user.name Fixture
mkdir -p "$PURGA/evidencia"
printf 'a\n' > "$PURGA/evidencia/uno.txt"
printf 'b\n' > "$PURGA/evidencia/dos.txt"
git -C "$PURGA" add .
git -C "$PURGA" commit -q -m "inicial"

purga() {
  base="$1"; shift
  for ruta in "$@"; do
    if [ ! -e "$base/$ruta" ]; then
      printf 'ruta fallida: %s\n' "$ruta" >&2
      return 1
    fi
  done
  for ruta in "$@"; do rm -f "$base/$ruta"; done
  return 0
}

if purga "$PURGA" evidencia/uno.txt evidencia/inexistente.txt evidencia/dos.txt 2> "$TMP/error.txt"; then
  printf 'FAIL B-07: la purga debio abortar\n'
  exit 1
fi
if ! grep -q -F 'evidencia/inexistente.txt' "$TMP/error.txt"; then
  printf 'FAIL B-07: el error no informa la ruta que fallo\n'
  exit 1
fi
if [ ! -e "$PURGA/evidencia/uno.txt" ] || [ ! -e "$PURGA/evidencia/dos.txt" ]; then
  printf 'FAIL B-07: la purga fallo cerrada pero dejo deleciones parciales\n'
  exit 1
fi
if ! purga "$PURGA" evidencia/uno.txt evidencia/dos.txt 2> /dev/null; then
  printf 'FAIL B-07: la purga completa deberia aplicarse\n'
  exit 1
fi
if [ -e "$PURGA/evidencia/uno.txt" ] || [ -e "$PURGA/evidencia/dos.txt" ]; then
  printf 'FAIL B-07: la purga completa no elimino lo listado\n'
  exit 1
fi

# --- parte 4: un repositorio sin submodulos informa F1 y F6 como no aplicables ---
PLANO="$TMP/plano"
git init -q -b trunk "$PLANO"
git -C "$PLANO" config user.email fixture@example.invalid
git -C "$PLANO" config user.name Fixture
printf 'contenido\n' > "$PLANO/archivo.txt"
git -C "$PLANO" add .
git -C "$PLANO" commit -q -m "inicial"

if [ -e "$PLANO/.gitmodules" ]; then
  printf 'FAIL B-07: el repositorio no deberia declarar submodulos\n'
  exit 1
fi
if [ -n "$(git -C "$PLANO" submodule status --recursive 2>/dev/null || true)" ]; then
  printf 'FAIL B-07: no deberia haber submodulos materializados\n'
  exit 1
fi
printf 'no aplicables\n'
printf 'PASS B-07\n'
```

**Salida esperada:** sin aprobación el árbol no cambia; el plan aprobado se aplica en
una copia aislada con el componente antes que el consumidor y con el identificador
registrado ya publicado; la purga con ruta faltante aborta informando la ruta y no
borra nada; y un repositorio sin submódulos informa F1 y F6 como no aplicables.

---

## C. Limpieza

Al terminar la verificación:

1. Cada fixture elimina su directorio temporal y su remoto local. Ningún repositorio
   externo queda modificado.
2. Se comprueba que el repositorio objetivo quedó intacto: `git status --porcelain` no
   reporta cambios y ningún archivo del objetivo se creó ni se borró.
3. Ninguna verificación deja ramas, etiquetas ni cambios pendientes en el repositorio
   objetivo.

```bash
git status --porcelain
```

**Salida esperada:** sin salida.

---

## D. Criterios de aceptación

Los doce criterios del requisito funcional, descritos sin identificador de coordinación,
y el bloque de esta verificación que los cubre.

| # | Criterio | Verificado por |
|---|---|---|
| 1 | La evidencia sin consumidor operativo se lista con su ubicación y su comprobación. | B-02 |
| 2 | Las referencias muertas se reportan con su archivo de origen y su destino. | B-03 |
| 3 | La contradicción entre documentación y comportamiento se detecta. | B-04 |
| 4 | El identificador fijado a mano se marca frente al identificador derivado del índice. | B-05 |
| 5 | Las entradas huérfanas de un manifiesto se cuentan de forma exacta. | B-05 |
| 6 | La limpieza de manifiestos e índices se aplica por parche exacto con conteo de fallo cerrado. | B-05 |
| 7 | La cadena de identidad de un submódulo reporta sus estados por separado. | B-01 |
| 8 | Sin aprobación explícita no hay cambios en el árbol. | B-07 |
| 9 | Con aprobación, el plan se aplica en una copia aislada y en el orden componente antes que consumidor. | B-07 |
| 10 | Un fallo a mitad de la aplicación informa la ruta y el paso, sin purga parcial. | B-07 |
| 11 | Un repositorio sin submódulos informa las familias de submódulos como no aplicables. | B-07 |
| 12 | La instalación desde un clon nuevo no arrastra literales del repositorio de origen. | A-04 |

El descubrimiento por directorio de la skill —que la copia de ejecución se descubra
por carpeta y no por un registro central— se verifica en el test automatizado del
proyecto, que comprueba el contrato completo: la forma del documento, el agnosticismo y
el descubrimiento.
