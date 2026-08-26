# flowtask/config — Configuración del ecosistema

## Presupuesto de contexto (context-budget)

El gate de presupuesto de contexto del runner es un **gate transparente en
herramienta vía `tool.execute.after` mutable (OpenCode 1.18.15)**: vive en el
plugin `flowtask-permission-gate` (hook post-ejecución + pre-gate barato en
`tool.execute.before`).

- Límites por llamada: `read=16.000` chars, `grep=8.000`, `glob=8.000`.
- Acumulado por turno del runner: `32.000` chars entregados.
- Fallback exacto sin preview (el runner solo ve el mensaje, nunca un preview
  del contenido omitido ni los umbrales como configuración).
- Attachments imagen/PDF bloqueados al runner (delegación al Inspector).

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