# Instalación y actualización

Guía operativa de FlowTask. La versión vigente vive en `.flowtask/package.json`. La fuente del CLI es `.flowtask/bin/flowtask.js` y el instalador/actualizador está en `.flowtask/bin/lib/installer.js`.

## Requisitos

Git, Node.js, npm y un terminal interactivo. OpenCode, Claude Code o VS Code solo son necesarios para el target elegido. Engram es comprobado y advertido por el instalador, pero no se instala automáticamente. El gestor de worktrees requiere Python 3.9 o superior.

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

Durante `install` copia recursos, skills y scripts; para Claude genera agents, commands, settings, MCP y `CLAUDE.md`; para OpenCode instala plugins del manifiesto en `.opencode/plugins` y genera `.opencode/opencode.json` y `.opencode/tui.json`; escribe `config/profile.json`, `config/review.json`, `config/autonomy.json`, `config/permissions.json` y `.installation-method` en el target; y coordina Graphify/ferris-search según las preguntas del instalador.

## Capas de configuración del target

Cada target instalado recibe tres capas de configuración en `<target>/config/`:

| Archivo | Capa | Valores |
|---------|------|---------|
| `profile.json` | Persona (tono) | `level`: `training`, `mid`, `senior` o `custom`; `persona`: identidad de tono; `onboarded`: estado del onboarding. |
| `autonomy.json` | Autonomía (iniciativa) | `version`: `1`; `profile`: `assistant`, `autonomous-dev` o `hermes`. |
| `permissions.json` | Permisos (sobre técnico) | `version`: `1`; `envelope`: `standard`. |

`install` y `update` crean `autonomy.json` y `permissions.json` solo cuando la
capa no existe, con `autonomous-dev` y `standard` como valores de instalación,
para que lo instalado siga funcionando. Ese default es una migración y no un
fallback de runtime: en ejecución, una capa ausente o inválida es un fallo con
mensaje operativo. Una capa inválida nunca se repara con un default — la
operación falla y el archivo se conserva. `profile.json` conserva su forma
vigente y una persona ausente o inválida deja un aviso sin alterar la autonomía
ni los permisos.

La precedencia entre capas es `permisos > autonomía > persona`. Para inspeccionar
las capas resueltas de un target:

```bash
flowtask layers resolve --target opencode
flowtask layers resolve --json
```

El contrato completo está en
[architecture/capas-persona-autonomia-permisos.md](architecture/capas-persona-autonomia-permisos.md).

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

## Worktree Manager

El gestor de worktrees se integra como submódulo en
`.flowtask/scripts/worktree-manager/`. El gitlink registrado en el árbol del
consumidor es la referencia: no se mantiene una copia local del núcleo y el
gestor no se copia al target instalado.

El instalador verifica el gitlink y los entrypoints obligatorios antes de
copiar recursos: `worktree.sh` y `worktree_manager/__main__.py` para la línea de
comandos, y `mcp_transport.py`, `mcp_server.py`, `mcp_contract.py` y
`mcp_operations.py` para el transporte MCP. Si el checkout no coincide con el
gitlink o le falta un entrypoint, la instalación falla con un diagnóstico; no
se crea una copia alternativa.

El instalador sondea dos capacidades y las reporta por separado:

| Capacidad | Sonda de solo lectura | Resultado esperado |
| --- | --- | --- |
| CLI | `python3 -m worktree_manager --version` | versión del gestor |
| MCP | `python3 -m worktree_manager.mcp_transport` con `initialize` y `tools/list` | las siete tools: `worktree_create`, `worktree_complete`, `worktree_cleanup`, `worktree_recover`, `worktree_list`, `worktree_prune`, `worktree_status` |

La sonda es local, no escribe en el checkout, no instala dependencias y
dispone de un límite de 5 segundos por detección.

- **Ambas operativas:** la instalación continúa y las dos vías quedan
  disponibles.
- **Una sola operativa:** la instalación continúa y se reporta la capacidad
  ausente con su causa; el consumidor sigue operando por la vía disponible.
- **Ninguna operativa:** la instalación falla antes de escribir en el target y
  informa la causa de cada vía.

`install` y `update` son idempotentes respecto del gestor: repiten la
verificación del checkout sin duplicar nada y preservan `.worktree-manager.conf`,
`opencode.json`, los servidores ajenos, `.worktrees`, los journals, los backups
y las asociaciones registradas.

### Compatibilidad con instalaciones anteriores

La entrada `worktree.sh` y el adaptador de compatibilidad siguen disponibles.
La configuración genérica manda: la ruta pasada con `--config` y el archivo
`.worktree-manager.conf` se aplican en ese orden, y la ruta explícita excluye
cualquier lectura de la configuración anterior.

El archivo `.flowtask/config/worktree.json` es un dato de solo lectura. Se
interpreta únicamente en dos peticiones: un `complete --preserve-dirty` sin
`--config`, que traduce su valor `preserveDirty` a `preserve_dirty=true` y
declara la compatibilidad aplicada por stderr; y un `recover` explícito, que
importa una transacción anterior al estado canónico una sola vez. Una
configuración anterior inválida bloquea la operación con el código 3 y no
muta nada. La recuperación nunca copia el estado canónico de vuelta.

Un conflicto de identidad entre la transacción canónica y la anterior bloquea
la operación con el código 5 y conserva ambos registros. Las instalaciones
nuevas no activan ninguna ruta anterior: no se crean espejos de respaldos ni
referencias heredadas. No se anuncia publicación, ni retirada definitiva del
punto de entrada, ni compatibilidad ilimitada; la fase de deprecación es
posterior.

La instalación no amplía permisos. El asistente consume el gestor con la
herramienta `flowtask_worktree_consume`; el protocolo de request del gestor no
está autorizado por shell. Ver
[architecture/worktree.md](architecture/worktree.md) para el límite de
responsabilidad y [permission-gate.md](permission-gate.md) para el
consentimiento.

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
