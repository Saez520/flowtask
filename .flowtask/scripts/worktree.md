# Gestor de worktrees

## Arquitectura

La implementación canónica es el repositorio Bash standalone materializado como submodule Git en `.flowtask/scripts/worktree-manager/`. `worktree.sh` delega a `worktree-adapter.sh`; el adapter conserva compatibilidad y traduce registros legacy durante la recuperación. El standalone no conoce FlowTask ni inspecciona rutas o refs heredadas. Los archivos legacy en `scripts/lib/` se retiraron; el instalador excluye esos nombres y el submodule del payload.

El instalador verifica el gitlink y materializa el submodule antes de copiar assets. El gestor no se copia como árbol alternativo; si la fuente no está disponible, instalación y actualización fallan con diagnóstico.

## Configuración y lifecycle

La configuración validada permite seleccionar `worktrees_dir`, `state_dir`, `backup_dir`, `backup_ref_prefix`, `branch_prefix` y `lock_dir`. Sus valores son datos `key=value`, nunca código shell. Parent-only admite `create`, `complete`, `cleanup`, `recover`, `prune` y `list`, con locks, journals, recuperación y preservación explícita.

`complete` conserva recursos ante conflictos o drift. `cleanup` no integra; retirar cambios no integrados exige `--discard`. La preservación requiere opt-in y conflictos de restauración quedan para intervención humana.

## Target-direct

Target-direct opera en el repositorio submodule indicado y no crea worktree del parent ni modifica su HEAD. Requiere identidad explícita de target/parent, ruta submodule y `--link-parent staged-only`. `create` prepara el worktree del target; `link-parent` registra únicamente el gitlink en el índice. `abort`, `complete` y `recover` conservan snapshot y journal, y se detienen ante drift ambiguo. Requiere exactamente Git 2.54.0.

## Bootstrap y distribución

El bootstrap actual usa `/Users/saez/Proyects/worktree-manager/`; `.gitmodules` conserva esa URL local provisional y el índice registra un gitlink. No representa una publicación. Publicar el repositorio y cambiar el remote para distribución portable son trabajos posteriores. La entrega conserva su worktree/branch de revisión: no se automatiza commit ni integración del repositorio consumidor.
