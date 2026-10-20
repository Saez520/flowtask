# Procedencia de la integración del gestor de worktrees

Este documento registra de dónde proviene cada elemento de la integración del
gestor de worktrees en FlowTask, con identificadores de commit y de ref. No
contiene rutas de directorios externos ni rutas que ya no existan.

## Base del consumidor

| Elemento | Valor |
| --- | --- |
| Base congelada de la integración | `df4279317055894e9845edc0cfeebe98191b6519` |
| Commit de la fase 6 integrado | `271778b7ce42ba1fe76b89ae6d6302ce57dee9d3` |
| Base sobre la que se produjo esta evidencia | `10a3b06` |

La base congelada es un ancestro de la rama `main` del consumidor: al momento de
producir esta evidencia `main` estaba 12 commits por delante. Las referencias de
este snapshot usan la base congelada; una entrega sobre la `main` movida exige
rebase y revalidación completa de las suites.

## Gestor standalone

| Elemento | Valor |
| --- | --- |
| Ref del build | `integration/phase-chain` |
| Commit del build | `d948dc4295cdc644ef69a0ec9f9c6b9eb1660da4` |
| Base del build | `c5f51fa70b3b9b9d1a3c6106437692300fb1f3c9` |
| `main` local del clon de build | `c5f51fa70b3b9b9d1a3c6106437692300fb1f3c9` |
| `origin/main` publicado | `091d5db120a8b779931ac9c802526550e617d231` |

El commit del build está disponible en el clon local y en el submódulo
materializado, y no está publicado en el origen del gestor standalone. La
reconstrucción desde el remoto no es posible por ese motivo; el límite queda
registrado en `final-snapshot.json`.

## Submódulo y gitlink

| Elemento | Valor |
| --- | --- |
| Ruta del submódulo | `.flowtask/scripts/worktree-manager` |
| Gitlink antes de la fase | `d7a0a6f203e21b5156bf92dfa701a6d220182a34` |
| Gitlink después de la fase | `d948dc4295cdc644ef69a0ec9f9c6b9eb1660da4` |
| `HEAD` del submódulo | `d948dc4295cdc644ef69a0ec9f9c6b9eb1660da4` |

El gitlink registrado en el árbol del consumidor y el `HEAD` del submódulo
materializado coinciden. El submódulo del plugin de checkpoint de contexto no
está materializado en este checkout y su estado se registra aparte.

## Sustitución de la evidencia de la fase anterior

La evidencia materializada de la fase anterior no existe: ni el directorio del
snapshot ni su manifiesto están presentes, y el digest esperado solo se conoce
por su prefijo. La procedencia se sustituye por commits y refs verificables:

| Elemento | Valor |
| --- | --- |
| Commit de reconstrucción de la fase anterior | `2236fadefa76ca068467cf0e6cab6f694991d405` |
| Rama que lo contiene | `worktree/CA-worktree-manager-phase-7-rebuild` |
| Etiqueta que lo resuelve | `consumer/subtree-rebuild` |
| Estado del snapshot materializado | `absent` |
| Digest esperado del manifiesto | `aeaaddf...` |
| Digest observado | `unavailable` |
| Verificación del digest | `unavailable` |

Los criterios que esa sustitución cubre quedan mapeados en
`phase7-provenance.json` y en `final-snapshot.json`: criterio 1
`substituted_by_commit_provenance`, criterio 2 `not_modified_by_f8` y criterio
18 `pass_by_f8_snapshot_referencing_f7_commit`.

La reconstrucción de solo lectura se ejecutó sobre un worktree detached del
commit predecesor: los paths documentados de esa fase están presentes, su
manifiesto no lo está, y su harness adversarial pasa. El worktree temporal se
retiró y no se escribió nada en el árbol predecesor.

## Refs de consumidor, solo lectura

Los refs `consumer/*` y `salvage/consumer-*` se consultaron sin modificarlos.
Los SHA de sus commits resueltos están en `final-snapshot.json`. No se crean, no
se fusionan, no se cierran y no se eliminan.

## Entrega

`delivery_main_sync` está en `pending`. No se publicó nada: ni la rama de
integración, ni la `main` del consumidor, ni el origen del gestor standalone.
El gitlink registrado en la rama de integración es el que la entrega deberá
actualizar si la integración sobre `main` se autoriza.

## Límites

Los límites de esta evidencia están enumerados en `final-snapshot.json` y son:

- el commit del build no está publicado en el origen del gestor standalone;
- el manifiesto de la fase anterior está ausente y su digest no es verificable;
- la `main` del consumidor se movió respecto de la base congelada;
- la suite legacy del núcleo bash conserva expectativas de códigos de salida
  previos al backend;
- una prueba del instalador falla con un error de tipo, presente antes de este
  incremento;
- los contratos standalone no nombran el digest de plan que el consumidor envía
  siempre;
- no se publicó nada.
