---
name: runner-flow-paralelo
description: >-
  Flujo del runner — lote, despacho, cola, contención, integración serializada y herencia. Se carga solo ante el disparador
  `evento:lote`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Orquestación paralela segura

Los trabajos independientes de un mismo pedido pueden avanzar a la vez, con identidad y
trazas separadas. La decisión se toma con evidencia citable y el lote degrada a
secuencial ante cualquier duda. Esta sección no crea un motor paralelo: usa el despacho
en segundo plano ya disponible y deja el ciclo de vida en manos del gestor de worktrees.

### Cuándo se evalúa

- Al recibir un lote de dos o más trabajos en el mismo pedido, antes del primer despacho.
- Antes de cada cambio de fase, porque los archivos previstos y los `topic_key` pueden
  cambiar entre fases.
- Al reanudar un lote.
- No se evalúa para un trabajo único: un solo trabajo avanza sin decisión de lote.

### Decisión de lote

1. Cargar `parallel-orchestration` como fuente vigente de la política.
2. Comparar las cuatro dimensiones de independencia: archivos previstos, escrituras de
   memoria (`topic_key`), espacio y rama de trabajo, y dependencia entre trabajos.
3. Comprobar las superficies compartidas: si un trabajo toca el contrato del
   orquestador o una regla compartida por varios agentes, el lote es secuencial aunque
   las cuatro dimensiones sean independientes.
4. Producir `parallel` o `sequential` con su causa y su evidencia.
5. Persistir la decisión en el campo `parallel_batch` del mapa de instancias de cada
   trabajo, por upsert y conservando todos los campos previos.
6. Mostrar la línea visible de la decisión.
7. Si falta la evidencia de independencia, el lote es secuencial por `independencia no
   verificable` y la decisión declara la condición exacta de reevaluación.

### Despacho y join

1. Despachar solo las invocaciones independientes, con `background: true`.
2. Ejecutar el handshake de cada trabajo antes de su despacho: completo para los agentes
   de tratamiento completo, ligero para los demás.
3. El lote no reutiliza un `sessionID` entre trabajos: cada uno abre su propio hilo.
4. Registrar el `sessionID` devuelto en el mapa de instancias de su trabajo.
5. No avanzar una fase hasta que la fase anterior esté confirmada y su resultado sea
   legible.
6. Si una notificación falta o el resultado es ilegible, pausar ese trabajo con
   `progress_unavailable` y conservar lo demás.
7. No re-despachar a ciegas: un re-despacho sin evidencia de lo anterior no está
   permitido.
8. El lote no omite el Gate, la auditoría, la decisión de pruebas ni los consentimientos.

### Cola y capacidad

1. Leer `.flowtask/config/parallel.json` si existe.
2. `maxParallel` como entero mayor o igual a 2 habilita el avance en paralelo; ausente,
   `null` o inválido equivale a capacidad 1 y a avance secuencial.
3. La cola FIFO conserva el orden de llegada y muestra la posición de cada trabajo.
4. Al liberarse capacidad entra el siguiente: la cola no descarta, no reordena en
   silencio y no se supera el máximo sin aviso.

### Contención de conflictos

| Condición | Código vigente | Acción | Estado conservado | Condición de reanudación |
|---|---|---|---|---|
| Cerrojo ocupado del espacio de trabajo | `resource_locked` | Conservar worktree y rama; esperar o degradar el lote a secuencial. | Worktree, rama y artifacts intactos. | Liberación del cerrojo. |
| Escritura simultánea sospechada en memoria | `concurrent_write_suspected` | Detener al afectado sin escribir encima. | Último estado confirmado y su evidencia. | La sospecha se resuelve. |
| Solapamiento de `topic_key` entre trabajos | `concurrent_write_suspected` | Detener a los afectados sin fusionar registros. | Ambos registros, sin modificación. | Los `topic_key` se separan. |
| Rama que ya no integra limpio | Resultado del gestor de worktrees | No limpiar, no forzar y escalar. | Worktree, rama y cambios sin consolidar. | El desarrollador declara cómo continuar. |
| Pérdida de identidad o de estado de un trabajo | `progress_unavailable` | Detener solo ese trabajo. | Su checkpoint y su artifact. | La identidad o el estado vuelven a estar disponibles. |
| Carrera de deduplicación | `concurrent_write_suspected` | Detener y declarar, sin arbitrar un ganador. | Ambos estados, sin fusionar. | Fuera de alcance: se declara y no se resuelve. |

Reglas de contención: no sobrescribe, no reintenta a ciegas por otra vía, no inventa
identificadores, no crea un registro paralelo para suplir uno ausente o ilegible, no
fusiona registros contradictorios y no declara cero por falta de datos. Un conflicto
contenido nunca se presenta como trabajo completado. La condición de reanudación se
declara con la causa exacta en cada caso.

### Integración serializada

1. Ejecutar el cierre `complete` de a uno por vez sobre la misma base.
2. No paralelizar el `complete` (squash o preserve-history): dos integraciones sobre la misma base no se ejecutan a
   la vez, aunque los trabajos sean independientes.
3. Un conflicto conserva el worktree y la rama y se escala: no se fuerza la integración.
4. No se limpia el destino ni se crea un stash.
5. `--preserve-dirty` sigue exigiendo consentimiento humano explícito.

### Herencia de superficies

- `context-degradation` conserva sus packs por momento, sus umbrales y sus pruebas.
- La puerta de pruebas condicionales conserva su decisión, su generación, su herencia y
  la coherencia de su documentación.
- `agent-loop-progress`, `agent-loop-termination`, `agent-loop-idempotency`,
  `agent-loop-budget` y `agent-loop-run` se consultan como fuente vigente: no se
  redefine ninguno.
- `checkpoint-mixin` conserva la separación entre checkpoints y registros de ejecución:
  no se redefine.
- El Gate, la auditoría, la decisión de pruebas y los consentimientos se cumplen por
  trabajo: el lote no los omite.
- El gasto se atribuye por ejecución, sin repartos y sin topes nuevos.
- Si una superficie está ilegible o una referencia está rota, la ejecución se detiene con
  la causa exacta y no se improvisa una regla sustituta.

***
