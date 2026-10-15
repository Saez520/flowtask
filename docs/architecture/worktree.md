# Arquitectura del gestor de worktrees

## Componentes

`.flowtask/scripts/worktree-manager/` es el único propietario de la implementación Bash. `worktree.sh` delega a `worktree-adapter.sh`, que conserva compatibilidad del consumidor y traduce registros legacy solo al recuperar. No hay copia fallback. El instalador valida el checkout frente al gitlink y materializa el submodule; excluye el gestor de la copia genérica de assets.

El repositorio standalone contiene lifecycle parent-only, configuración genérica y target-direct. No depende de rutas FlowTask, mecanismos de coordinación, almacenamiento legacy ni transporte externo.

## Parent-only y target-direct

Parent-only gestiona lifecycle y transacciones en el repositorio seleccionado. La configuración define rutas de worktrees, estado, backups, refs y locks. Journals y validaciones permiten reanudar operaciones; ante conflicto, drift o corrupción se preservan recursos.

Target-direct opera sobre un repositorio submodule explícito. El descriptor valida identidades y fases, y conserva snapshot del índice. El parent solo puede recibir el gitlink staged mediante `staged-only`: no se crea worktree, commit, merge ni push del parent. Git 2.54.0 es requisito exacto.

## Bootstrap local y publicación

El bootstrap provisional usa `/Users/saez/Proyects/worktree-manager/` como fuente Git local. El gitlink en `.flowtask/scripts/worktree-manager/` fija el commit consumido; la URL local de `.gitmodules` no es portable ni constituye publicación. Publicar y sustituir la URL por una fuente distribuible está fuera de esta etapa. El installer no publica ni crea commits del consumidor; la entrega mantiene su worktree y branch para revisión.
