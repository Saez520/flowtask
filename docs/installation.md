# Instalación y actualización

Guía operativa de FlowTask 1.23.0. La fuente del CLI es `.flowtask/bin/flowtask.js` y el instalador/actualizador está en `.flowtask/bin/lib/installer.js`.

## Requisitos

Git, Node.js, npm y un terminal interactivo. OpenCode, Claude Code o VS Code solo son necesarios para el target elegido. Engram es comprobado y advertido por el instalador, pero no se instala automáticamente.

## Instalar el CLI

Usar la URL oficial del repositorio, sin inventarla en la documentación:

```bash
git clone <URL_DEL_REPOSITORIO_FLOWTASK>
cd FlowTask/.flowtask
npm link
flowtask --version
```

## Instalar en un proyecto

Desde la raíz del consumidor:

```bash
flowtask install
```

El instalador selecciona interactivamente targets OpenCode, VS Code y Claude Code. Se puede marcar uno o varios; confirmar sin marcar instala standalone en `.flowtask/`. Luego selecciona personalidad `training`, `mid`, `senior` o `custom`. `--persona` evita la selección de personalidad, no la selección de targets; sin TTY la instalación falla de forma explícita.

Durante `install` copia recursos, skills y scripts; para Claude genera agents, commands, settings, MCP y `CLAUDE.md`; para OpenCode instala plugins del manifiesto en `.opencode/plugins` y genera `.opencode/opencode.json` y `.opencode/tui.json`; escribe `config/profile.json`, `config/review.json` y `.installation-method` en el target; y coordina Graphify/ferris-search según las preguntas del instalador.

## Targets

| Target | Instalación | Derivados |
| --- | --- | --- |
| OpenCode | `.opencode/flowtask/` y `.opencode/skills/` | `.opencode/opencode.json`, `.opencode/tui.json`, `.opencode/plugins/` |
| Claude Code | `.claude/flowtask/` | `.claude/agents/`, `.claude/commands/`, `.claude/settings.json`, `.mcp.json`, `CLAUDE.md` |
| VS Code | `.vscode/flowtask/` | mirror del target VS Code |
| Standalone | `.flowtask/` | agents, commands, skills, plugins y scripts |

## Actualizar

```bash
flowtask update
flowtask update --persona senior
```

`update` detecta markers `.installation-method`, sincroniza delta, conserva rutas preservables, reinstala plugins, regenera configuración y coordina Graphify. Sin marker, ejecutar `install` primero. En target Claude regenera `CLAUDE.md`; en OpenCode regenera la declaración TUI y limpia el `tui.json` legacy cuando verifica el destino.

## Plugins y Graphify

El manifiesto declara permission-gate, model-selector y context-checkpoint; classifier-hook y classifier-tui están deprecated y disabled, por lo que no se instalan por defecto. El gitlink fuente de context-checkpoint puede estar vacío si el submodule no fue materializado, mientras una copia instalada en `.opencode/plugins` pertenece al proyecto consumidor y no prueba el estado del source checkout.

Graphify se consulta por `graphify_query_graph` mediante MCP. `flowtask graphify query --query <consulta>` solo prueba el shim deprecated y termina sin consultar localmente.

## Diagnóstico

```bash
flowtask --version
flowtask --help
git status --short
find .opencode/flowtask -maxdepth 2 -type f
find .opencode/plugins -maxdepth 2 -type f
```

No editar `opencode.json` manualmente para sustituir `update`. Si no hay instalación, ejecutar `install`; si hay error de permisos/espacio, corregirlo y reintentar `update`.
