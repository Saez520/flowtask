# Evidencia de operación — retirada del acoplamiento legacy del gestor de worktrees

Este directorio registra la evidencia de la fase que retira el acoplamiento
legacy del gestor de worktrees: el gate de entrada de la fuente, la
procedencia de la entrega, la compatibilidad declarada y sus límites, el
snapshot final, la reconstrucción y los digests.

Todo el contenido es repo-relativo y se reconstruye desde commits y refs. No
contiene rutas de directorios externos, rutas temporales ni rutas que ya no
existan: los valores de procedencia son identificadores de commit y de ref.

## Contenido

| Archivo | Contenido |
| --- | --- |
| `entry-integrity.json` | Gate de entrada: fuente, nota de integridad histórica, reconstrucción de solo lectura y veredicto. |
| `provenance.md` | Procedencia de la base, del gestor standalone, del submódulo, del tag y de la entrega pendiente. |
| `compatibility-evidence.json` | Escenarios de la frontera de compatibilidad, ubicaciones genéricas, equivalencia de transportes, suite legacy y límites. |
| `final-snapshot.json` | Estado del snapshot de la fase, sus suites, sus criterios y sus límites. |
| `reconstruction-check.txt` | Comandos de reconstrucción, sus resultados observados y los límites registrados. |
| `SHA256SUMS` | Digest SHA-256 de los otros seis archivos de este directorio. |

## Verificación de los digests

```bash
cd docs/operations/worktree-phase-9
shasum -a 256 -c SHA256SUMS
```

El resultado esperado es `OK` para los seis archivos listados. Un digest roto o
un archivo ausente invalida la evidencia y no se declara reconstrucción.

## Verificación automática de la evidencia

```bash
node --test .flowtask/bin/test/worktree-phase9-evidence.test.js
```

La prueba observa los seis digests, el veredicto del gate de entrada, el
gitlink registrado contra el checkout materializado, el tag local, la ausencia
de rutas absolutas en este directorio, los ocho escenarios de compatibilidad, el
resultado de la suite legacy y la integridad de las fases previas.

## Alcance

La fase retira del gestor standalone el motor shell duplicado, acota el
adaptador de compatibilidad a las peticiones explícitas y rebaselina la suite
legacy del consumidor contra el gestor canónico. La entrega a `main` y a
`origin` permanece pendiente: `final-snapshot.json` registra
`delivery.main_sync: pending` y no se publicó nada.
