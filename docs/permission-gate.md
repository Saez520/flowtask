# FlowTask Permission Gate

La migración desde el gate histórico quedó consolidada en un único plugin:
`flowtask-permission-gate`. El mensaje operativo único es
`[FlowTask Permission Gate]`.

`flowtask-permission-gate` es el único control runtime de permisos específicos
de FlowTask. Se carga desde `.opencode/plugins/` después de `flowtask install`
o `flowtask update` y requiere reiniciar OpenCode. No existe un fallback nativo.

## Políticas

- **Todos los agentes:** el gate de commits conserva el stamp
  `.flowtask/config/.review-stamp`, sus bypasses y el consumo del stamp válido.
- **Runner:** puede ejecutar únicamente las operaciones de gestión aprobadas.
  El resto se bloquea antes de ejecutar y devuelve exactamente:
  `Recordá que debés delegar esta operación al subagente correspondiente.`

Las operaciones Runner autorizadas, con sus formas canónicas, son:

- `${FLOWTASK_SCRIPTS}/worktree.sh list`
- `${FLOWTASK_SCRIPTS}/worktree.sh create <id> --base <branch>`
- `${FLOWTASK_SCRIPTS}/worktree.sh complete <id> --base <branch>`
- `git status` y `git status` con flags (por ejemplo, `git status --short`);
  no acepta argumentos que no sean flags.
- `git add <files>` (uno o más paths).
- `git restore --staged <file>` (uno o más paths).
- `git commit -m "..."` con un mensaje no vacío; el gate universal de commits
  sigue aplicando sus reglas de revisión y bypasses.
- `git push` con sus argumentos canónicos.
- `git merge` con sus argumentos canónicos.
- Graphify mediante `node .flowtask/bin/flowtask.js graphify *`, incluyendo la
  forma local `node .flowtask/bin/flowtask.js graphify query --query <query>`.
- Engram usando herramientas con prefijo MCP `engram_` (por ejemplo,
  `engram_mem_search` o `engram_mem_save`).
- `task` únicamente para los 12 subagentes autorizados: `flowtask-ca-writer`,
  `flowtask-planner`, `flowtask-plan-auditor`, `flowtask-constructor`,
  `flowtask-validator`, `flowtask-initializer`, `flowtask-logger`,
  `flowtask-tester`, `flowtask-review-orchestrator`, `flowtask-inspector`,
  `flowtask-onboarder` y `flowtask-graphify-docs-media`.
- `skill` para cargar skills.

No se aceptan verbos, flags o argumentos fuera de estas formas canónicas.

Los comandos compuestos (`&&`, `||`, `;`, pipes o sustitución de comandos) se
rechazan si introducen una operación no autorizada. La acción esperada ante un
bloqueo es delegar la operación al subagente correspondiente.

### Denegaciones y evasión

Cada ejemplo siguiente se bloquea antes de ejecutar cualquier segmento y
devuelve el feedback exacto indicado arriba:

```text
git status && git diff   # se bloquea por el segmento git diff
git status || git diff   # se bloquea por el segmento git diff
git status; git diff     # se bloquea por el segmento git diff
git status | git diff    # se bloquea por el segmento git diff
git log                  # verbo no autorizado
${FLOWTASK_SCRIPTS}/worktree.sh create id --base  # falta <branch>
```

Los operadores no sirven para evadir el gate: una operación compuesta es
rechazada si contiene un segmento no autorizado.

### Identidad del agente

El runtime de OpenCode 1.18.4 no expone la identidad en
`tool.execute.before`. El plugin la registra por sesión mediante `chat.message`
(`agent?: string`) y consulta ese mapa al evaluar cada herramienta. Un mensaje
sin `agent` conserva el valor previo de la sesión. No se infiere identidad desde
el texto del comando; si no hay identidad registrada, la regla específica del
Runner se degrada sin aplicar y permanece el gate universal de commits.

## Diagnóstico

Después de actualizar, comprobar que existe
`.opencode/plugins/flowtask-permission-gate/dist/index.js`, que la configuración
registra ese entrypoint y que no registra el nombre anterior ni
`agent.flowtask-runner.permission`. Reiniciar OpenCode y probar una operación
Runner permitida, una denegada y el gate de commit con y sin stamp.

## Smoke runtime post-install/update y reinicio

Este procedimiento debe ejecutarlo el desarrollador; el Constructor no reinicia
OpenCode ni ejecuta `flowtask update` contra el repositorio raíz durante esta
corrección. El plan exige el smoke real después de la actualización y el
reinicio; los tests con fixtures solo verifican el script y no sustituyen esta
prueba.

1. Desde la raíz del target instalado, ejecutar `node .flowtask/bin/flowtask.js
   update` (o `node .flowtask/bin/flowtask.js install` para una instalación
   nueva). No editar `.opencode/opencode.json` manualmente.
2. Verificar que exista
   `.opencode/plugins/flowtask-permission-gate/dist/index.js` y que el array
   `plugin` registre ese entrypoint una sola vez. Confirmar que no exista el
   el entrypoint histórico del gate ni
   `agent.flowtask-runner.permission`.
3. Cerrar y reiniciar OpenCode por el procedimiento habitual del desarrollador.
   Resultado esperado: el plugin nuevo se carga desde `.opencode/plugins/` y
   el plugin viejo no se carga.
4. En una sesión del Runner, ejecutar `${FLOWTASK_SCRIPTS}/worktree.sh list`,
   `git status --short` y `node .flowtask/bin/flowtask.js graphify query --query
   <query>`. Resultado esperado: se permiten y no aparece el feedback de
   delegación.
5. En la misma sesión intentar `git diff` y `git status && git diff`.
   Resultado esperado: ambas se bloquean antes de ejecución y muestran
   exactamente `Recordá que debés delegar esta operación al subagente
   correspondiente.`; confirmar que `git diff` no produjo salida ni efecto.
6. Probar el gate universal con cualquier agente: un `git commit` sin
   `.flowtask/config/.review-stamp` debe bloquear; repetir con un stamp
   ISO-8601 válido debe permitir y consumir el stamp; comprobar también los
   bypasses vigentes `--no-verify` y `--no-review`.
7. Registrar en el reporte la identidad observada (`hookInput.agent`,
   `input.agent` o ninguna), las rutas verificadas, los comandos permitidos y
   denegados, el feedback literal y cualquier GAP del runtime.
