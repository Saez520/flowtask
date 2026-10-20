# Evidencia de operación — integración del gestor de worktrees

Este directorio registra la evidencia de la fase de integración del gestor de
worktrees en FlowTask: la procedencia de la base, la sustitución verificable de
la evidencia de la fase anterior, el estado del submódulo, la matriz de
transporte y los resultados de las suites ejecutadas.

Todo el contenido es repo-relativo y se reconstruye desde commits y refs. No
contiene rutas de directorios externos, rutas temporales ni rutas que ya no
existan: los valores de procedencia son identificadores de commit y de ref.

## Contenido

| Archivo | Contenido |
| --- | --- |
| `provenance.md` | Procedencia de la base, del gestor standalone, del submódulo y de la entrega pendiente. |
| `phase7-provenance.json` | Sustitución de la evidencia de la fase anterior, con los criterios que cubre. |
| `final-snapshot.json` | Estado del snapshot de la fase, su predecesor, los límites y el estado de entrega. |
| `mcp-matrix-evidence.json` | Las 48 celdas de la matriz de transporte, con lo esperado y lo observado en cada celda. |
| `reconstruction-check.txt` | Comandos de reconstrucción, sus resultados y los límites registrados. |
| `SHA256SUMS` | Digest SHA-256 de los otros seis archivos de este directorio. |

## Verificación de los digests

```bash
cd docs/operations/worktree-phase-8
shasum -a 256 -c SHA256SUMS
```

El resultado esperado es `OK` para los seis archivos listados. Un digest roto o
un archivo ausente invalida la evidencia y no se declara reconstrucción.

## Verificación de la matriz

La matriz se regenera desde la raíz del repositorio con el gestor materializado
como submódulo:

```bash
MCP_MATRIX_EVIDENCE=docs/operations/worktree-phase-8/mcp-matrix-evidence.json \
  node --test .flowtask/bin/test/worktree-consumer-matrix.test.js
```

El archivo publicado se normaliza sustituyendo la raíz temporal de los
repositorios aislados por el token `<matrix-root>`; la sustitución y sus reglas
están registradas en `reconstruction-check.txt`. Las 48 celdas conservan su
resultado, su código esperado, su código observado y sus mensajes.

## Reconstrucción

Los comandos de reconstrucción y sus resultados están en
`reconstruction-check.txt`. La reconstrucción se apoya en commits y refs
locales; el estado de publicación del gestor standalone está registrado como
límite en `final-snapshot.json`.

## Estado de la entrega

La entrega a `main` y a `origin` está pendiente. `final-snapshot.json` registra
`delivery_main_sync: pending` y la base sobre la que se produjo la evidencia.
