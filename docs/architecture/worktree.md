# Integración del gestor de worktrees

## Fuente de verdad

La implementación vive en el repositorio standalone
[`worktree-manager`](https://github.com/Saez520/worktree-manager) y se integra
en FlowTask como submodule en `.flowtask/scripts/worktree-manager/`. El checkout
integrado debe coincidir con el gitlink registrado por FlowTask; no debe
mantenerse una copia del core en `.flowtask/scripts/lib/`.

Para conocer la arquitectura, configuración, comandos, target-direct,
recuperación y contrato de salida, consultar el
[README del repositorio origen](https://github.com/Saez520/worktree-manager) y
[`docs/cli-contract-v1.md`](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md).
Este documento describe únicamente la integración con FlowTask.

## Adaptador de FlowTask

`.flowtask/scripts/worktree.sh` es el entrypoint consumidor y delega en
`.flowtask/scripts/worktree-adapter.sh`. El adaptador conserva compatibilidad
con invocaciones y registros legacy de FlowTask, y traduce esos registros solo
durante la recuperación. El standalone no conoce FlowTask ni inspecciona sus
rutas o refs heredadas.

El instalador valida el gitlink, materializa el submodule antes de copiar
assets y excluye el gestor de la copia genérica. Si la fuente no está
disponible, la instalación o actualización falla con diagnóstico; no crea una
copia alternativa.

## Límites de responsabilidad

- El standalone posee lifecycle parent-only, configuración genérica,
  transacciones, locks, journals y target-direct.
- FlowTask aporta el entrypoint compatible, el adaptador y la integración como
  submodule.
- El adaptador no hace commit, merge ni push por cuenta del repositorio
  consumidor.
- La URL local histórica de `.gitmodules` solo sirve para el bootstrap de este
  checkout y no es una referencia portable de distribución.
