# Procedencia de la retirada del acoplamiento legacy del gestor de worktrees

Este documento registra de dónde proviene cada elemento de la entrega, con
identificadores de commit y de ref. No contiene rutas de directorios externos
ni rutas que ya no existan.

## Base del consumidor

| Elemento | Valor |
| --- | --- |
| Base de la fase | `bd3eab24c6687a7fbed69be7f807c169ba01d34b` |
| Rama de la entrega | `worktree/CA-worktree-manager-phase-9` |
| Commit de la implementación | `6903781acf85d28a32c4cd608f0158e93bf07f1b` |
| `main` observada | `3314ed4c20a1606f428d1c12fdd1329afd26e39b` |

La entrega se construye sobre la base congelada y no usa `main` como base. La
`main` observada difiere del valor que registraba el plan de la fase y del
valor que publicaba la evidencia de la fase anterior: la entrega sobre la
`main` movida exige rebase y revalidación completa de las suites.

## Gestor standalone

| Elemento | Valor |
| --- | --- |
| Ref del build | `integration/phase-9` |
| Commit del build | `a4b4782236407d4c6067344218f7b3e43c9b4ecf` |
| Base del build | `d948dc4295cdc644ef69a0ec9f9c6b9eb1660da4` |
| Tag local | `phase-9` |
| `origin/main` publicado | `091d5db120a8b779931ac9c802526550e617d231` |
| `tool_version` | `1.0.0` |

El commit del build está disponible en el clon local del gestor y en el
submódulo materializado, y no está publicado en el origen del gestor
standalone. El tag `phase-9` es local y no se publicó.

## Submódulo y gitlink

| Elemento | Valor |
| --- | --- |
| Ruta del submódulo | `.flowtask/scripts/worktree-manager` |
| Gitlink antes de la fase | `d948dc4295cdc644ef69a0ec9f9c6b9eb1660da4` |
| Gitlink después de la fase | `a4b4782236407d4c6067344218f7b3e43c9b4ecf` |
| `HEAD` del submódulo | `a4b4782236407d4c6067344218f7b3e43c9b4ecf` |

El gitlink registrado en el árbol del consumidor y el `HEAD` del submódulo
materializado coinciden. El checkout del submódulo está en estado detached y
`.gitmodules` no cambió.

## Fases previas, solo lectura

| Elemento | Valor |
| --- | --- |
| Commit de la fase anterior | `bd3eab24c6687a7fbed69be7f807c169ba01d34b` |
| Ramas de la fase anterior | `worktree/CA-worktree-manager-phase-8` |
| Evidencia de la fase anterior | `docs/operations/worktree-phase-8` |
| Digests de la fase anterior | `6/6` verificados |
| Snapshot de documentación de la fase de documentación | `consumer/docs-snapshot:2560b10` |
| Referencia de la fase de traducción al inglés | `c094fa8` |

Las ramas, los tags y la evidencia de las fases previas se consultaron sin
modificarlos. El diff entre la base y el tip de la entrega sobre
`docs/operations/worktree-phase-8` y sobre `docs/worktree-manager` está vacío.

## Versión

| Elemento | Valor |
| --- | --- |
| Versión del consumidor | `1.25.0` |
| Archivo de la versión | `.flowtask/package.json` |

La versión del consumidor vive únicamente en `.flowtask/package.json` y la
versión del gestor standalone no cambió.

## Entrega

`delivery.main_sync` está en `pending`. No se publicó nada: ni la rama de la
entrega, ni la `main` del consumidor, ni el origen del gestor standalone, ni el
tag local.

## Límites

Los límites de esta evidencia están enumerados en `final-snapshot.json` y en
`compatibility-evidence.json`:

- el commit del build no está publicado en el origen del gestor standalone;
- el manifiesto de la fase anterior sigue ausente y su digest no es verificable;
- la `main` del consumidor se movió respecto de la base congelada;
- una prueba del instalador falla con un error de tipo, presente antes de este
  incremento;
- una prueba de la configuración materializada de OpenCode falla, presente antes
  de este incremento;
- la suite legacy se rebaselinó y su conteo cambió respecto del incremento
  anterior; el detalle está en `compatibility-evidence.json`;
- no se publicó nada.
