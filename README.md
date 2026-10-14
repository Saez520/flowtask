# FlowTask

FlowTask es un sistema de workflow de desarrollo asistido por IA. Un runner recibe la conversación del desarrollador, investiga el repositorio, coordina el flujo adecuado y conserva el contexto operativo en Engram.

No es un chatbot aislado: combina memoria persistente, ejecución aislada mediante Git worktrees, validación y una integración instalable para OpenCode, Claude Code y VS Code.

Versión actual: 1.23.0 (fuente: `.flowtask/package.json`).

## Qué resuelve

- Mantiene decisiones, artefactos y estado entre sesiones mediante Engram.
- Aísla cada CA o hotfix en un worktree y branch propios.
- Permite trabajar conversacionalmente sin depender de comandos de coordinación antiguos.
- Instala y actualiza recursos, plugins y configuración derivada de forma delta.
- Incluye revisión, permisos, personalidad del runner y soporte Graphify.

## Cómo se usa

Después de instalarlo, hablá con el runner desde el IDE configurado. El runner identifica preguntas, cambios, revisiones y ejecuciones acordadas.

Comandos del entorno instalado: `/init-types`, `/init-data`, `/init-business`, `/init-config`, `/init-api`, `/onboard` y `/update`. Las revisiones se solicitan describiendo el alcance o usando `/review` cuando el runtime lo soporte. Un hotfix acordado se ejecuta cuando el runner ya persistió el diagnóstico y recibe ejecutar.

## Primeros pasos

1. Consultá [docs/installation.md](docs/installation.md) para instalar o actualizar.
2. Leé [docs/README.md](docs/README.md) para elegir documentación.
3. Consultá [docs/core-flowtask.md](docs/core-flowtask.md) para el modelo técnico.
4. Consultá [docs/permission-gate.md](docs/permission-gate.md) para permisos y review-stamps.
5. Consultá [docs/project-history.md](docs/project-history.md) para elementos retirados o legacy.

## Límites importantes

- `flowtask graphify query` es un shim histórico: no consulta localmente. La vía vigente es Graphify por MCP; si no está disponible, el flujo declara degradación y usa búsqueda normal.
- Los artifacts nuevos se persisten en Engram; los archivos locales antiguos son compatibilidad histórica.
- La documentación editorial no reemplaza los contratos ejecutables bajo `.flowtask`.

## Estructura mínima

`.flowtask/` — fuente canónica del CLI, contratos y plugins.

`.opencode/` — instalación/configuración OpenCode, si aplica.

`.claude/` — instalación/configuración Claude Code, si aplica.

`.vscode/` — instalación/configuración VS Code, si aplica.

`docs/` — documentación pública.

`graphify-out/` — salidas Graphify cuando fueron generadas.

## Licencia

MIT
