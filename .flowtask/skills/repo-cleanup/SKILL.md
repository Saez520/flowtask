---
name: repo-cleanup
description: >-
  Higiene agnóstica de repositorios: analiza en solo lectura artefactos sin
  consumidor operativo, referencias muertas, contradicciones documentales,
  identificadores fijados a mano, entradas huérfanas y desvíos de submódulos;
  aplica limpieza segura solo con aprobación explícita.
license: MIT
compatibility: opencode
metadata:
  category: maintenance
  scope: repository
---

# Skill: repo-cleanup — limpieza agnóstica de repositorios

## Propósito

Esta skill define el contrato de **higiene de un repositorio**: el análisis en solo
lectura de las familias de resto que acumulan los repositorios con historial —incluidos
los que declaran submódulos— y la aplicación de un plan de limpieza seguro, únicamente
cuando el operador lo aprueba de forma explícita.

El diagnóstico y la mutación están separados por diseño: el análisis no escribe nada y
el plan se presenta antes de cualquier cambio. Una invocación atiende **un repositorio
objetivo** y recorre de forma recursiva los submódulos que ese repositorio declara; no
es un barrido global sobre un conjunto de repositorios.

La skill **no agrega comportamiento al producto**: no introduce un escáner ejecutable, no
extiende ningún comando, no modifica la instalación ni el transporte. Prescribe
comprobaciones de solo lectura, las reglas que rigen la limpieza y el formato del
informe que el operador recibe.

No se supone nada del repositorio objetivo: ni nombres de proyecto, ni nombres de rama,
ni lenguaje de implementación, ni dónde está hospedado, ni qué herramientas usa. Todo
objetivo, submódulo, identificador y rama se derivan del propio repositorio en el
momento de la ejecución.

## Alcance y no-objetivos

**Incluye:**

- Siete familias de análisis: declaración y estado de submódulos; artefactos sin
  consumidor operativo; referencias muertas; contradicciones entre documentación y
  comportamiento; identificadores fijados a mano y entradas huérfanas; cadena de
  identidad de submódulos; duplicación documental entre consumidor y componente.
- El detalle de cada familia, sus comprobaciones de solo lectura y su criterio de
  fallo cerrado.
- Diez reglas de higiene que se aplican sin excepción.
- Un protocolo de ejecución en seis etapas con aprobación explícita antes de mutar.
- Un contrato de salida en cuatro bloques, con la severidad de cada hallazgo.
- La degradación declarada cuando una comprobación no puede ejecutarse.

**Excluye:**

- La mutación sin aprobación: sin aprobación explícita sobre el plan presentado no se
  purga, no se ajusta documentación, no se actualiza un identificador y no se limpia un
  índice.
- La reescritura del historial y la publicación de etiquetas nuevas.
- La migración de transporte y el retiro de adaptadores heredados.
- La decisión de publicación: la skill informa si la revisión de un componente está
  publicada; no aprueba ni rechaza su publicación.
- La corrección de fallos que no pertenecen al alcance del plan presentado.
- El barrido simultáneo de varios repositorios.

## Entradas y configuración

La skill se invoca sobre un repositorio objetivo y admite cinco claves de
configuración. Ninguna es obligatoria: todas tienen valor por defecto.

| Clave | Valor por defecto | Semántica |
|---|---|---|
| `repositorio_objetivo` | directorio actual | Repositorio sobre el que se ejecuta el análisis. Admite una ruta explícita; si se omite, se usa el directorio de trabajo actual. |
| `categorias_activas` | `F1–F7` | Subconjunto explícito de familias a revisar. |
| `severidad_minima` | `ruido` | Nivel desde el que se listan hallazgos: `ruido`, `riesgo silencioso` o `bloqueante`. |
| `modo` | `informe` | `informe` produce el diagnóstico; `aplicacion` aplica el plan aprobado. La aplicación exige aprobación explícita en cualquier modo. |
| `idioma` | informes en español, literales en inglés | Idioma de los informes y de las guías; los contratos y los literales técnicos no se traducen. |

Una ruta explícita es opcional y puede apuntar a cualquier clon, copia de trabajo o
directorio del que se derivan todos los datos. La configuración nunca amplía el
alcance: solo acota qué se revisa y con qué severidad mínima se listan los hallazgos.

## Contrato de solo lectura

El análisis se apoya exclusivamente en lecturas. Las comprobaciones permitidas son:

- `git ls-files` — contenido del índice y modo de cada entrada.
- `git ls-tree` — contenido del árbol registrado.
- `git ls-remote` — referencias anunciadas por un remoto.
- `git status` — estado del árbol de trabajo.
- `git rev-parse` — resolución de revisiones y de la raíz del repositorio.
- `git config --file` — lectura de un archivo de configuración del repositorio.
- `git grep` — búsqueda de texto en el contenido registrado.
- `git submodule status` — estado materializado de los submódulos.
- `git worktree list` — copias de trabajo registradas.

Durante el análisis **no** se escribe en el repositorio: no se modifica ningún archivo,
no se prepara ningún cambio, no se crean ramas ni etiquetas, y no se ejecutan `fetch`,
`checkout`, `clean` ni `stash`. Ninguna operación de escritura pertenece a esta fase.

Una comprobación que no puede ejecutarse —por permisos, por una ruta ausente o por un
remoto inaccesible— **se informa**: el informe nombra la comprobación, el motivo y la
ausencia de resultado. Nunca se rellena con una suposición ni con un valor por defecto
presentado como verificado.

## Taxonomía de severidad

Cada hallazgo se clasifica en exactamente uno de tres niveles:

- **`bloqueante`** — rompe la instalación, la materialización o la integridad del
  repositorio. Impide operar: se atiende antes que cualquier otra cosa.
- **`riesgo silencioso`** — da una señal falsa de éxito o diverge sin aviso. El
  repositorio aparenta estar bien mientras el resultado real difiere del esperado.
- **`ruido`** — ocupa espacio, duplica o contradice sin romper. Se limpia por higiene.

La severidad se deriva de la familia y del efecto observable, no de la magnitud del
cambio. Un hallazgo nunca se reporta con dos severidades a la vez.

## Familias de análisis

### F1 — Declaración y estado de submódulos

**Objetivo:** cruzar lo que el repositorio declara con lo que el índice registra y con
lo que está materializado, para detectar discrepancias entre las tres fuentes.

**Derivación:** se toma el archivo de configuración de submódulos del repositorio, el
índice del árbol de trabajo y el estado de materialización.

**Comprobaciones de solo lectura:**

```bash
git config --file .gitmodules --get-regexp '^submodule\..*\.path$'
git ls-files --stage
git submodule status --recursive
```

**Clasificación esperada:**

- Declarado sin entrada en el índice → `bloqueante`.
- Indexado sin declaración → `bloqueante`.
- Declarado dos veces bajo rutas distintas → `bloqueante`.
- Declarado y no materializado → `ruido`.

**Criterio de fallo cerrado:** si el archivo de configuración de submódulos no existe,
la familia se informa como no aplicable. Si el índice no puede leerse, la comprobación
se informa como no verificable y no se infiere el estado de ningún submódulo.

### F2 — Artefactos sin consumidor operativo

**Objetivo:** identificar artefactos que el repositorio conserva pero que ninguna guía,
prueba ni procedimiento activo necesita.

**Derivación:** se recorre el árbol de trabajo y se seleccionan los candidatos que
declaran fase cerrada, histórico, evidencia o adjunto. Para cada candidato se busca un
consumidor fuera del propio candidato.

**Comprobaciones de solo lectura:**

```bash
git ls-files
git grep -n -F '<nombre-o-ruta>' -- . ':(exclude)<candidato>'
```

**Clasificación esperada:** artefacto sin consumidor en un directorio de evidencia o de
histórico → `ruido`. Artefacto sin consumidor que además es referenciado por un
procedimiento activo → `riesgo silencioso`, porque la referencia se rompe al purgar.

**Exclusiones de esta familia:** nunca se propone purgar código fuente, skills,
plugins, dependencias vendorizadas, recursos de ejecución ni manifiestos declarados.

**Criterio de fallo cerrado:** un candidato solo se propone cuando la búsqueda de
consumidor devuelve vacío en todo el árbol; si la búsqueda no puede completarse, el
candidato se informa como no verificable y no se propone su purga.

### F3 — Referencias muertas

**Objetivo:** encontrar enlaces y rutas que apuntan a destinos que ya no existen.

**Derivación:** se extraen los destinos declarados en guías, pruebas y procedimientos
activos.

**Comprobaciones de solo lectura:**

```bash
git grep -n -E '\]\([^)]+\)' -- . ':(exclude)<ruta>'
test -e '<destino-resuelto>'
```

**Clasificación esperada:** destino inexistente referenciado desde una guía o un
procedimiento activo → `riesgo silencioso`, porque la navegación queda rota. Destino
inexistente referenciado desde una prueba → `ruido`.

**Criterio de fallo cerrado:** se descartan los esquemas externos, las anclas y los
correos; cada destino relativo se resuelve contra el directorio del archivo de origen
y se comprueba con `test -e`. Un destino que no puede resolverse se informa como no
verificable.

### F4 — Contradicciones entre documentación y comportamiento

**Objetivo:** contrastar lo que la documentación afirma con lo que el repositorio
hace.

**Derivación:** se extraen las afirmaciones verificables —versiones exigidas, comandos,
flags, autorizaciones, estados emitidos y ubicación de documentos— y se busca su fuente
de verdad.

**Comprobaciones de solo lectura:**

```bash
git grep -n -F '<afirmación>' -- .
git grep -n -F '<clave-de-la-fuente>' -- <ruta-de-la-fuente>
git <comando-afirmado> --version
```

**Clasificación esperada:** afirmación que contradice la fuente declarada →
`riesgo silencioso`. Afirmación que contradice un comportamiento observable →
`bloqueante`.

**Criterio de fallo cerrado:** una afirmación que no puede contrastarse se marca como
`no verificable` indicando la comprobación intentada y el motivo. Nunca se declara una
contradicción sin la fuente y el destino de la contradicción.

### F5 — Identificadores fijados a mano y entradas huérfanas

**Objetivo:** localizar identificadores de revisión escritos a mano y claves de
manifiestos e índices que apuntan a rutas ya retiradas.

**Derivación:** el identificador esperado se deriva del índice en el momento de
verificar; los literales se buscan en pruebas, guiones y compuertas.

**Comprobaciones de solo lectura:**

```bash
git ls-tree HEAD -- <ruta>
git ls-files --stage -- <ruta>
git grep -n -E '(^|[^0-9a-f])[0-9a-f]{7,40}([^0-9a-f]|$)' -- <pruebas> <guiones> <compuertas>
```

El límite del literal se expresa con clases de caracteres y no con un escape de
frontera de palabra: no toda compilación de Git interpreta ese escape en las
expresiones regulares extendidas, y un patrón que no coincide no encuentra nada.

**Clasificación esperada:** literal de identificador que no coincide con el derivado →
`bloqueante`. Clave de manifiesto o de índice cuyo destino no existe → `ruido`.

**Criterio de fallo cerrado:** el conteo de entradas huérfanas es exacto y se propone
un parche por clave con el conteo esperado; no se reindexa de forma completa e
indiscriminada. Si el índice no puede leerse, la derivación se informa como no
verificable.

### F6 — Cadena de identidad de submódulos

**Objetivo:** verificar, por separado, que el checkout materializado, el identificador
registrado en el índice y la revisión publicada por el remoto coinciden.

**Derivación:** para cada submódulo declarado se resuelven cuatro datos
independientes: el checkout, el identificador registrado, la revisión publicada y el
estado del árbol.

**Comprobaciones de solo lectura:**

```bash
git -C <ruta> rev-parse HEAD
git ls-tree HEAD -- <ruta>
git -C <ruta> ls-remote origin
git -C <ruta> status --porcelain
git worktree list --porcelain
```

**Estados que se reportan por separado:**

- `no inicializado` — el submódulo está declarado pero no materializado.
- `en conflicto` — el submódulo tiene una fusión sin resolver.
- `sucio` — el árbol de trabajo del submódulo tiene cambios.
- `no publicado` — la revisión del checkout no pertenece a la historia publicada por
  el remoto.
- `divergente` — la revisión del checkout difiere del identificador registrado en el
  índice.
- `separado` — el checkout está en un `HEAD` desligado y su revisión no es alcanzable
  desde la punta de la rama publicada por defecto.

Las etiquetas se evalúan **en ese orden** y la primera que se cumple nombra el estado
del submódulo; el resto no se reporta para ese submódulo. Si ninguna se cumple, el
submódulo está `limpio` y no genera hallazgo.

La pertenencia de la revisión del checkout a la historia publicada se determina con las
referencias anunciadas por `git ls-remote origin` y con la comprobación de ancestría
contra cada referencia anunciada; no basta con que la revisión exista en el clon local.

**Clasificación esperada:** `divergente`, `no publicado` y `en conflicto` →
`bloqueante`. `sucio` y `separado` → `riesgo silencioso`. `no inicializado` → `ruido`.

**Criterio de fallo cerrado:** las copias de trabajo huérfanas se detectan con `git
worktree list --porcelain`. Si el remoto no es accesible, la cadena no publicable se
informa como no verificable y se prohíbe aplicar lo que dependa de esa publicación.

### F7 — Duplicación documental entre consumidor y componente

**Objetivo:** detectar el mismo tema contado en dos lugares, con riesgo de
contradicción.

**Derivación:** se construye un mapa de temas por encabezados y por nombres de archivo
entre la documentación del consumidor y la del componente declarado.

**Comprobaciones de solo lectura:**

```bash
git grep -n -E '^#{1,3} ' -- <documentacion-del-consumidor>
git grep -n -E '^#{1,3} ' -- <documentacion-del-componente>
```

**Clasificación esperada:** mismo tema con afirmaciones divergentes → `riesgo
silencioso`. Mismo tema con afirmaciones equivalentes → `ruido`.

**Criterio de fallo cerrado:** el hallazgo cita las dos rutas enfrentadas y propone un
único dueño del tema. Sin las dos rutas, el hallazgo no se reporta.

## Reglas de higiene

Las reglas rigen la limpieza. Se aplican **sin excepción**: no son recomendaciones
opcionales y no admiten una versión debilitada.

- **R1 — Purga con fallo cerrado.** Una purga elimina todo lo listado o se detiene informando la ruta que falló; nunca deja una purga parcial silenciosa.
- **R2 — Sin reescritura de historial ni republicación de etiquetas.** La evidencia retirada queda trazable por las etiquetas y los mensajes de purga existentes; no se reescribe historial, no se crean etiquetas nuevas y la evidencia no se duplica en el árbol.
- **R3 — Identificadores derivados del índice.** El identificador esperado se deriva del índice en el momento de verificar y nunca se fija a mano; se compara contra el checkout materializado y contra las referencias publicadas por el remoto.
- **R4 — Revalidación del consumidor.** Tras registrar un identificador nuevo, se revalida la suite del consumidor contra el checkout materializado y se confirman por separado el HEAD del componente, el checkout del submódulo, el identificador indexado y el estado del consumidor.
- **R5 — Sin guardado temporal en árboles con submódulos.** Nunca uses `git stash` ni ningún guardado temporal del árbol en un repositorio con submódulos declarados: la operación reinicia el checkout al identificador registrado y puede borrar código del HEAD.
- **R6 — Destino sucio por puntero de submódulo.** Si el único cambio del destino es el puntero de un submódulo, no uses marcas de inmutabilidad ni registres el puntero fuera de la fusión: alinea el checkout al identificador registrado, ejecuta el cierre normal y después materializa el identificador nuevo.
- **R7 — Tolerancia de estado y fallo cerrado.** Las verificaciones previas toleran submódulos declarados no inicializados y activos limpios; ante activos sucios, divergentes, en conflicto o no verificables, se cierra con fallo.
- **R8 — Orden componente antes que consumidor.** El componente publica antes de que el consumidor registre el identificador nuevo; un identificador que apunta a una revisión no publicada rompe la materialización.
- **R9 — Manifiestos e índices por parche exacto.** La limpieza de manifiestos e índices se aplica por clave exacta con un conteo esperado y fallo cerrado; no se reindexa de forma completa e indiscriminada.
- **R10 — Una sola fuente por tema.** Cada tema vive en un solo lugar; la purga repara la navegación que deja enlaces rotos; el histórico es memoria, no manual, y no duplica contratos.

## Protocolo de ejecución con aprobación

El protocolo separa el diagnóstico de la mutación en seis etapas. Las etapas P1, P2 y
P3 preceden a toda escritura; P3 no se sustituye por ninguna otra señal.

- **P1 — Pre-verificación.** Antes de tocar nada: estado limpio o cambios declarados, identificadores verificados y remoto alcanzable para lo que se va a publicar.
- **P2 — Copia aislada.** Todo cambio se prepara en una copia aislada de trabajo (worktree o clon temporal), nunca sobre la rama principal del operador.
- **P3 — Aprobación explícita.** Ninguna purga, ajuste documental, actualización de identificador o limpieza de índice se aplica sin aprobación explícita del operador sobre el plan presentado.
- **P4 — Orden de aplicación.** Primero el componente, después el consumidor. La documentación del consumidor se ajusta solo después de que la revisión del componente exista en el remoto.
- **P5 — Post-verificación.** Se repiten las comprobaciones del análisis, se ejecutan las suites afectadas del componente y del consumidor, y se confirma estado limpio e identificadores alineados.
- **P6 — Reporte de fallo.** Si algo falla en la aplicación, se informa qué paso falló, qué ruta está afectada y el estado final; no se presenta éxito parcial como completo.

## Contrato de salida

El informe tiene cuatro bloques, en este orden. Los informes y las guías se escriben en
español; los contratos y los literales técnicos se mantienen en inglés sin traducir.

### Inventario de hallazgos

Una tabla con una fila por hallazgo y estas columnas:

| Columna | Contenido |
|---|---|
| Identificador | Referencia corta y estable del hallazgo dentro del informe. |
| Familia | La familia del análisis que lo produjo. |
| Severidad | `bloqueante`, `riesgo silencioso` o `ruido`. |
| Ubicación | Ruta exacta del hallazgo. |
| Comprobación | Comando o lectura que lo produjo. |
| Acción propuesta | Qué se propone hacer con él. |

### Plan de limpieza

Los pasos ordenados, del componente al consumidor. Cada paso declara su verificación y
su criterio de fallo cerrado.

### Registro de aplicación

Qué se aplicó y qué se omitió, con el motivo de cada omisión. Las aprobaciones y las
excepciones quedan registradas.

### Estado final

Los identificadores resultantes, el estado de limpieza y las suites ejecutadas con su
resultado.

## Agnosticismo del repositorio

La skill no contiene rutas, ramas, identificadores de revisión, lenguajes de
implementación, nombres de proyectos ni de hospedaje.

- Todo objetivo, submódulo, identificador y rama se derivan en tiempo de ejecución del
  repositorio que se analiza.
- Funciona con cero, uno o varios submódulos declarados.
- La única ubicación propia que conoce es su patrón de instalación.
- La ausencia de un tipo de resto no es un fallo: se informa como no aplicable.

## Degradación y límites

Si el repositorio no declara submódulos, F1 y F6 se informan como no aplicables, no como
fallo.

- Una comprobación que no puede ejecutarse se informa como `no verificable`, con la
  comprobación intentada y el motivo.
- Si un remoto no es accesible, la cadena de publicación de ese componente es no
  verificable y queda prohibido aplicar lo que dependa de esa publicación.
- Si el entorno ofrece un grafo de conocimiento, se usa como contexto y no como verdad;
  no se consultan copias aisladas. Si no está disponible, se continúa con
  búsqueda normal y se declara.

## Instalación y descubrimiento

La fuente de esta skill vive en el directorio de skills del proyecto y la copia de
ejecución vive en el directorio de skills del agente.

El descubrimiento es por directorio: el nombre de la carpeta es el nombre de la skill y no existe un registro central.

La replicación la hace el instalador. Tras editar la fuente hay que reinstalar o
sincronizar el espejo y verificar que ambas copias quedan idénticas; una copia
desactualizada no es un espejo válido.

## Verificación

La verificación ejecutable de esta skill vive en `QA.md` y es de solo lectura; si esa
verificación falla, la skill no está lista para usarse.

La verificación cubre dos cosas: la forma del contrato —secciones, familias, reglas,
etapas y agnosticismo— y el comportamiento del análisis sobre fixtures construidos en
un directorio temporal.

## Exclusiones

Esta skill no:

- reescribe historial ni publica etiquetas;
- migra transporte ni retira adaptadores heredados;
- decide aprobaciones de publicación;
- regenera grafos de conocimiento;
- modifica código de ejecución, configuración ni agentes;
- barre todos los repositorios en una sola ejecución;
- corrige fallos ajenos al alcance.
