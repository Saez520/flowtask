# flowtask/config — Configuración del ecosistema

## Capas de persona, autonomía y permisos

Cada target instalado tiene su propia configuración de capas en
`<target>/config/`. Los tres archivos son estado local: no se versionan.

| Archivo | Capa | Valores |
|---------|------|---------|
| `profile.json` | Persona (tono) | `level`: `training`, `mid`, `senior`, `custom`. `persona`: identidad de tono. `onboarded`: estado del onboarding. |
| `autonomy.json` | Autonomía (iniciativa) | `version`: `1`. `profile`: `assistant`, `autonomous-dev` o `hermes`. |
| `permissions.json` | Permisos (sobre técnico) | `version`: `1`. `envelope`: `standard`. |

- La precedencia entre capas es `permisos > autonomía > persona`: la persona no
  autoriza ni restringe, y la autonomía no amplía el sobre de permisos.
- `install` y `update` crean `autonomy.json` y `permissions.json` **solo cuando
  la capa no existe**, con `autonomous-dev` y `standard` como valores de
  instalación. Ese default es una migración, no un fallback de runtime: en
  ejecución, una capa ausente o inválida es un fallo con mensaje operativo.
- Una capa inválida nunca se repara con un default: la operación falla y el
  archivo se conserva.
- Una persona ausente o inválida deja un aviso y la ejecución continúa sin
  persona, sin tocar autonomía ni permisos.
- `flowtask layers resolve` muestra las capas resueltas de un target y el
  origen de cada una.

La fuente normativa del contrato de las tres capas es
`docs/architecture/capas-persona-autonomia-permisos.md`.

## Presupuesto de contexto (context-budget)

El gate de presupuesto de contexto del runner es un **gate transparente en
herramienta vía `tool.execute.after` mutable**: vive en el
plugin `flowtask-permission-gate` (hook post-ejecución + pre-gate barato en
`tool.execute.before`).

- Límites por llamada: `read=16.000` chars, `grep=8.000`, `glob=8.000`.
- Acumulado por turno del runner: `32.000` chars entregados.
- Degradación por niveles: aviso de acotación, entrega reducida sin preview y
  omisión por acumulado. El runner ve qué se omitió, el tamaño real y a quién
  delegar; nunca ve un preview del contenido omitido.
- Attachments imagen/PDF bloqueados al runner (delegación al Inspector).
- Los umbrales no se exponen en mensajes: se nombra el presupuesto aplicado, no
  su cifra.
- Si el tamaño no se puede medir, se registra una traza y se entrega sin recortar.

### Regla de oro

**El runner no conoce los umbrales.** No se exponen en el prompt
(`.flowtask/agents/runner.md`) ni via env; solo viven en el plugin y en este
archivo opcional de override:

- `context-budget.json.example` — valores por defecto documentados (opcional).
- Para overrides reales, copiar a `context-budget.json` (fail-open: JSON
  inválido/ilegible → `console.warn` + defaults; nunca lanza).
- `bash` queda fuera del gate (solo `read`, `glob`, `grep` del runner).

Revalidar el contrato de mutación del hook con
`.flowtask/plugins/flowtask-permission-gate/test/context-budget-smoke.mjs` al
actualizar OpenCode (version drift).

## Orquestación paralela (parallel)

La capacidad de avance en paralelo se declara por proyecto y es opcional.

- `parallel.json.example` es opcional: el ejemplo documenta la forma, sin valor activo.
- Para declararla, copiar el ejemplo a `parallel.json` y setear `maxParallel`.
- `maxParallel` es un entero mayor o igual a 2. Ausente, `null` o inválido equivale a
  capacidad 1 y a avance secuencial.
- No se inventa una capacidad: el avance sin valor por defecto declarado es secuencial, y
  la primera ventana de observación no calibra una cifra.
- La cola FIFO conserva el orden de llegada y muestra la posición de cada trabajo.
- La integración serializada: el cierre se ejecuta de a uno por vez sobre la misma base.
- El detalle de los avisos sigue `policy.profile`: desarrollo con referencias y último
  comando verificado, producción conciso.
- No se exponen cifras internas de cerrojos ni de registros.

La fuente normativa de la política es la skill `parallel-orchestration` y su integración
vive en `.flowtask/agents/runner.md`.
