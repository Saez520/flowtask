---
name: ficha-proyecto
description: >-
  Prepara la ficha verificada de un proyecto local <Z> a partir de su
  repositorio y de Engram, lista para un flujo de redacción externo. Se
  activa con "generemos contenido de <Z>", "prepara la ficha de <Z>" o por
  invocación explícita. No redacta, no decide formato editorial, no toca el
  tono, no publica y no escribe archivos.
license: MIT
compatibility: opencode
metadata:
  category: content-preparation
  scope: project
---

skill({ name: "memory-protocol" })
skill({ name: "zero-assumptions" })

# Skill: ficha-proyecto — ficha verificada de un proyecto local

## Propósito

Esta skill produce **material verificable para redacción posterior**: una ficha
verificada de un proyecto local, lista para llevar a un flujo de redacción
externo. Una ficha por proyecto por invocación; no es contenido editorial y no
produce borradores ni prosa publicable.

## Activación

Frases disparadoras: "generemos contenido de <Z>", "prepara la ficha de <Z>",
"ficha verificada de <Z>". También se puede invocar explícitamente con
`skill({ name: "ficha-proyecto" })`.

Si <Z> no se proporciona, se pide el nombre del proyecto. No hay default.

Lote solo explícito: una ficha por proyecto por invocación. Solo se procesan
varios proyectos si el pedido usa "lote", "todos", "cada uno", "estos N" o
"los dos"; en ese caso se entrega una ficha completa por proyecto, secuencial,
sin fusionarlas. Un segundo proyecto mencionado sin esas palabras no genera
lote implícito: se entrega la primera ficha y se pregunta por el segundo.

No hay rama especial para ningún proyecto: el contrato es genérico para
cualquier <Z> local.

## Frontera de alcance

**Incluye:**

- Resolver un proyecto local <Z> a una ruta.
- Reunir evidencia observable del repositorio objetivo y de Engram.
- Entregar la ficha verificada en chat con las 9 secciones de la convención y
  marcas de evidencia.

**Excluye:**

- Redactar prosa publicable, decidir formato editorial (post/thread/article),
  tocar el tono (por ejemplo, `config/voice.md` como artefacto externo),
  publicar o invocar un redactor externo.
- Escribir archivos, persistir en Engram, invocar subagentes o modificar el
  runner.
- Implementar Graphify, instalación, servidor, CLI, agentes o comandos.

**Solo lectura:** la skill no escribe, no persiste y no delega. No usa
`mem_save`, no invoca subagentes, no registra ni invoca redactores externos y
no toca perfiles de tono. La ficha se entrega en chat y el autor la guarda
manualmente.

## Resolución del proyecto

Convención: `/Users/saez/Proyects/<Z>`. Si esa ruta no existe, se pide la
ruta explícita al autor. No se buscan otros roots, no se prueban variantes de
mayúsculas, no se propone otro proyecto.

Si el autor entrega una ruta explícita tras el pedido, se usa solo para esa
invocación; no cambia la convención y no se persiste el override entre
invocaciones.

Se rechaza cualquier ruta que apunte a `.worktrees/`: la evidencia se reúne
desde la raíz del proyecto, nunca desde un worktree.

Diferencia path inexistente (se pide ruta explícita) de path inaccesible
(error declarado, no se avanza).

El nombre del proyecto es el basename del root resuelto. Se usa en `# <Proyecto>`
y en la ruta de guardado.

## Evidencia del repositorio

Orden de fuentes: memoria del proyecto → documentación/código/estado del
repositorio → persona. La ficha usa marcas inline; no usa el JSON
`verification-record/v1`.

Exclusiones de directorios: `.worktrees/`, `.git/` (salvo comandos git de
lectura), `node_modules/`, `vendor/`, `dist/`, `build/`, `.venv/`,
`__pycache__/`, `.opencode/`, `.claude/`, `.vscode/`, `coverage/` y
`target/`.

Topes: máximo 12 archivos, máximo 400 líneas por archivo, máximo 8 búsquedas
en Engram y máximo 20 observaciones recuperadas.

Citas de repositorio: `<Proyecto>/<ruta>:Lx-Ly`.

Comandos git de solo lectura permitidos (por ejemplo, `git shortlog`,
`git log`, `git status`, `git remote -v`).

Prohibición de fuentes externas y de Graphify: la evidencia proviene de lectura
directa del repositorio objetivo y de Engram. No se usa Graphify, webfetch ni
websearch.

Ficha previa no es fuente: `/Users/saez/Proyects/fichas/<Proyecto>.md` es
material previo del autor, no evidencia. La skill genera la ficha desde el
repositorio y Engram. Si la ficha previa contradice las fuentes vigentes, no se
copia el claim: se marca la discrepancia.

Documentos históricos/legacy/deprecados: no se usan como fuente de claims
vigentes. Si un documento se declara histórico, se lee solo para detectar
claims retirados y se reporta la discrepancia. Los documentos vigentes y los
históricos que discrepan se reportan con ambas fuentes.

## Evidencia de Engram

Resolución del proyecto Engram: `mem_current_project(directory: <root>)`. Si no
hay resultado, se intenta `mem_list_projects()` y se compara el basename del
root sin distinguir mayúsculas. Si hay cero o más de un match, no se elige: la
memoria se declara ausente/ambigua y la ficha continúa con marcas. Nunca se
usan memorias de otro proyecto.

Búsquedas acotadas: máximo 8 búsquedas, máximo 20 observaciones recuperadas.
Recuperación por ID cuando corresponda.

Citas de Engram: `Engram #<id> (<topic_key>)`.

Prohibición de mezclar proyectos y de escribir en Engram: no se usa `mem_save`
ni se modifica memoria ajena.

## Marcas de evidencia

Sintaxis exacta: `[Verificado — <fuente>]`, `[Inferencia — <base>]`,
`[No verificado — <causa>]`.

- `Verificado` exige fuente resoluble (ruta con líneas o ID de Engram).
- `Inferencia` exige la base verificada.
- `No verificado` exige la causa.

Cada bullet de las 9 secciones lleva exactamente una marca.

Discrepancia entre fuentes: si la documentación vigente y la histórica
discrepan, se reporta la discrepancia con ambas fuentes.

## Plantilla de la ficha

```
# <Proyecto>

## Qué es (1-2 líneas)
- [marca] ...

## Problema que resuelve
- [marca] ...

## Estado
- [marca] ...

## Alcance y decisiones clave de diseño
- [marca] ...

## Resultados o evidencia de funcionamiento
- [marca] ...

## Stack técnico
- [marca] ...

## Rol del autor
- [marca] ...

## Relevancia potencial
- [marca] ...

## Nivel de confianza de esta ficha
- Verificados: N
- Inferencias: N
- No verificados: N
- Fuentes leídas: [rutas y IDs de Engram]

## Material faltante
- [solo si hay al menos una fuente ausente o un bullet No verificado]
```

`# <Proyecto>` usa el basename del root resuelto.

Las 9 secciones se incluyen siempre; si no hay evidencia, un bullet
`[No verificado — <causa>]`.

`## Material faltante` se agrega solo si hay al menos una fuente ausente o un
bullet `[No verificado]`.

`Nivel de confianza` cuenta bullets de las 9 secciones por marca y lista las
fuentes leídas (rutas y IDs de Engram); no usa porcentajes.

`Relevancia potencial` siempre es `[Inferencia — <base>]`.

`Resultados o evidencia de funcionamiento` no inventa métricas; si solo hay uso
del autor, usa `[Descriptivo, sin evidencia de impacto]` con `[Inferencia]`.

`Rol del autor` se apoya en `git shortlog`/docs; si no se puede determinar,
`[No verificado]` o `[Inferencia]`, nunca una suposición de autoría única.

## Reglas por sección

- `Qué es`: definición observable del proyecto (README, manifiesto, código).
- `Problema que resuelve`: problema declarado en docs/código; si no está, marcar.
- `Estado`: estado actual según docs vigentes; no usar docs históricos.
- `Alcance y decisiones clave`: decisiones registradas en docs/código/Engram.
- `Resultados`: métricas o uso real; no inventar; si solo uso del autor, marcar
  descriptivo sin impacto.
- `Stack técnico`: lenguajes, frameworks, dependencias observables.
- `Rol del autor`: aportes del autor según `git shortlog`/docs; si no se
  puede determinar, marcar.
- `Relevancia potencial`: siempre inferencia basada en evidencia verificada.
- `Nivel de confianza`: conteo por marca y fuentes leídas.

## Material faltante

Se incluye cuando hay al menos una fuente ausente o un bullet `[No verificado]`.
Formato: lista de fuentes ausentes y datos no verificados. Prohibición de
rellenar huecos con invención.

## Persistencia y frontera

La ficha se entrega como un único bloque fenced `markdown`, precedido por una
línea breve de contexto y seguido por la línea de guardado manual:

`Guardá esta ficha en /Users/saez/Proyects/fichas/<Proyecto>.md.`

No se escribe el archivo. No se persiste en Engram.

## Rechazos

- Formato editorial, tono, publicación, redactor externo: se rechaza esa parte
  y se entrega solo la ficha. No se lee ni modifica `config/voice.md`.
- Lote implícito: se entrega una sola ficha y se pregunta por el segundo.
- Modificación del runner: rechazado. No se modifica `.flowtask/agents/runner.md`.
- Otros roots: rechazado. Solo convención + ruta explícita.
- Subagentes: no se invocan.
- Escritura: no se escribe ningún archivo.

## Criterios de aceptación

- Dado un nombre Z con ruta convencional existente, entrega en chat la ficha
  completa con las 9 secciones y fuentes citables por afirmación verificada.
- Dado un nombre Z cuya ruta no existe, pide la ruta explícita; no adivina.
- Dado material insuficiente, entrega igual con marcas y sección de material
  faltante; no inventa.
- En uso normal, declara que el autor guarda en
  `/Users/saez/Proyects/fichas/<Proyecto>.md` y no escribe archivos.
- Si se pide formato editorial, tono, publicación o redactor externo, rechaza
  esa parte y mantiene solo la ficha.
- Con cualquier Z, sigue el contrato genérico sin rama especial.
- Un segundo pedido sin mención de lote prepara una sola ficha.

## QA

Escenarios estáticos y de conversación:

- Happy path: ficha completa desde el nombre.
- Path inexistente: pide ruta explícita.
- Ruta explícita de escape: usa la ruta solo para esa invocación.
- Material insuficiente: marcas + `## Material faltante`.
- Ficha previa desactualizada: no copia claim retirado; marca o reporta
  discrepancia.
- Pedido editorial: entrega solo la ficha; no toca tono ni publica.
- Lote implícito vs. explícito: uno solo vs. dos completas.
- Runner intacto: `git diff` vacío en `.flowtask/agents/runner.md`.
- Copias instaladas intactas: sin cambios en `.opencode` ni `.claude`.
- Test contractual: `node --test` exit 0.
- Regresión de descubrimiento por directorio: test de repo-cleanup exit 0.

## Limitaciones

- GAP 1: nombres ambiguos entre roots — fuera de alcance; solo convención +
  ruta explícita.
- GAP 2: validación automática de calidad de ficha — fuera de alcance.
- GAP 3: lote multi-proyecto, ranking o priorización — fuera de alcance salvo
  pedido explícito.
- GAP 4: sincronización de copias instaladas — fuera de alcance; lo hace el
  instalador.
- GAP 5: publicación, tono y formato editorial — fuera de alcance por diseño.
- Ambigüedad de Engram: si no hay match único, la memoria se declara
  ausente/ambigua.
- Ausencia de Graphify: la skill no consulta el grafo por diseño.

## Verificación

```
test -f .flowtask/skills/ficha-proyecto/SKILL.md
node --test .flowtask/bin/test/ficha-proyecto-skill.test.js
node --test .flowtask/bin/test/repo-cleanup-skill.test.js
git diff --exit-code -- .flowtask/agents/runner.md
git status --porcelain -- .opencode .claude
```

## Exclusiones

No implementa Graphify, instalación, servidor, CLI, agentes ni comandos. No es
un registry. No modifica el runner ni las copias instaladas. No escribe archivos
ni persiste en Engram.
