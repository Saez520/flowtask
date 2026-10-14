# Arquitectura documental del gestor de worktrees

> Documento auxiliar: describe el gestor, pero no es un entrypoint ejecutable.
> La implementación canónica está en los scripts y módulos indicados abajo.

## Relación entre los componentes

El entrypoint público es `.flowtask/scripts/worktree.sh`. Es un wrapper
pequeño que carga `.flowtask/scripts/lib/worktree-manager-core.sh` en el mismo
proceso de shell.

El core implementa el lifecycle parent-only: `create`, `complete`, `cleanup`,
`recover`, `prune` y `list`, además de locks, journals y preservación
transaccional. Al final de su carga, el core incorpora
`.flowtask/scripts/lib/worktree-manager-target-direct.sh`, que mantiene aislado
el lifecycle especial para operar directamente sobre un submodule.

La relación con el transporte JavaScript es indirecta y deliberada:

1. `worktree.sh` carga el core.
2. El core carga `worktree-manager-target-direct.sh`.
3. La variante target-direct selecciona el adaptador
   `.flowtask/bin/lib/runner-constructor-target-direct.js`.
4. Ese adaptador importa `.flowtask/bin/lib/target-direct-transport.js`, que
   valida, serializa y rehidrata el descriptor persistido entre Runner y
   Constructor.

Por tanto, el shell target-direct no carga directamente
`target-direct-transport.js`; llega a él a través del adaptador
`runner-constructor-target-direct.js`. Este archivo Markdown tampoco sustituye
ninguno de esos componentes.

## Detección de la rama base

Cuando no se especifica `--base`, el código busca ramas locales en el orden
`development → main → trunk`; si ninguna existe, usa `main` como fallback. El
runner puede pasar una rama explícita y, en ese caso, el gestor valida que
exista.

## Lifecycle parent-only

La forma general es:

```text
.flowtask/scripts/worktree.sh create <work-id> --base <branch>
  → .worktrees/<work-id>/ y branch worktree/<work-id>
  → Constructor implementa
  → Validator verifica
  → worktree.sh complete <work-id> --base <branch>
```

`create` valida el repositorio, el identificador, la rama base, la branch de
trabajo, la ruta y la identidad Git antes de crear recursos. La preparación y
la verificación de comandos son opt-in mediante la configuración admitida y
sus flags explícitos.

## `complete`, `cleanup` y `recover`

`complete` hace un cierre verificado: comprueba identidad, estado, commits,
submodules y destino; realiza el squash; valida el commit resultante; registra
las fases del journal; deinitializa submodules cuando corresponde; retira el
worktree y elimina la branch mediante una actualización condicionada al SHA
esperado.

Después de validar identidad, estado, de-inicialización y fase del journal, la
ruta interna de cierre usa:

```text
git worktree remove --force <worktree-cerrado>
```

Ese uso interno verificado de `--force` no convierte a `complete` en la vía
pública de descarte: `complete` no expone `--discard` ni `git branch -D`. Si
hay conflicto o estado ambiguo, conserva los recursos y detiene el avance.

`cleanup` no hace merge. Sin `--discard` solo retira un worktree y branch que
no conservan cambios locales, commits propios ni estado pendiente. La vía
pública para retirar trabajo no integrado es `cleanup --discard`, que requiere
autorización explícita y usa la retirada forzada del worktree y la eliminación
forzada de la branch.

`recover` reanuda transacciones de `--preserve-dirty` según su journal. Usa
locks y conserva backups ante drift o una restauración `pending_manual`; no
retira automáticamente recursos por la ruta interna de cierre.

## Lifecycle target-direct

La variante target-direct exige un target submodule explícito mediante
`--repo`, `--parent-repo`, `--target submodule`, `--submodule-path` y
`--link-parent staged-only`. El worktree se crea en la raíz Git del submodule,
no en el parent. El parent solo puede recibir el gitlink staged esperado; esta
ruta no hace commit, merge ni push del parent.

El descriptor persistido contiene la identidad del target, parent, gitlink,
branch, worktree, namespace y fase. Antes de entregarlo al Constructor, el
adaptador JavaScript y el transporte validan claves, duplicados, campos,
paths absolutos normalizados, SHA, fases, operación, namespace y formato
UTF-8/LF. Ante drift del parent, del gitlink o del índice, la operación se
detiene y conserva la evidencia.

## Portabilidad

Las rutas de este documento son relativas al repositorio. No dependen de una
ruta absoluta concreta del entorno ni de la salida de una ejecución local de
`worktree.sh list`.
