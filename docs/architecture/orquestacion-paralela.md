# Orquestación paralela segura

## Propósito

Los trabajos independientes de un mismo pedido pueden avanzar a la vez sin mezclar sus
historias. La latencia se reduce solo cuando la independencia es comprobable con fuente
citable; ante cualquier duda el lote degrada a secuencial y declara la causa.

Esta página describe cómo se decide el lote, cómo se acota el despacho, cómo se contiene
un conflicto y qué superficies heredadas no se relajan. La fuente normativa es la skill
`parallel-orchestration`; la integración operativa vive en `.flowtask/agents/runner.md`.

## Soporte actual y frontera

- **Existe despacho en segundo plano.** El runner ya invoca subagentes en background para
  la generación de documentación y media.
- **No existe motor paralelo.** No hay scheduler, ni consenso distribuido, ni motor
  paralelo de worktrees. La decisión de qué trabajos avanzan juntos es una política
  normativa del runner, no un módulo determinista.
- **El gestor de worktrees sigue siendo la autoridad del lifecycle.** Adquiere los
  cerrojos en orden determinista, reporta `resource_locked` y conserva el recurso cuando
  hay contención. La orquestación paralela no reescribe ese gestor.

## Independencia verificable

Dos trabajos son independientes cuando las cuatro dimensiones son comprobables con
fuente citable:

| Dimensión | Qué se compara | Fuente citable |
|---|---|---|
| Archivos previstos | Los archivos que cada trabajo declara que va a modificar. | El plan aprobado de cada trabajo. |
| Escrituras de memoria | Los `topic_key` que cada trabajo declara que va a escribir. | El mapa de instancias y el plan. |
| Espacio y rama de trabajo | El `worktree` y la rama de cada trabajo. | El gestor de worktrees y la asociación confirmada. |
| Dependencia | Si un trabajo necesita el resultado de otro para empezar. | El plan y sus dependencias. |

Si una dimensión no es verificable, el lote es secuencial con la causa
`independence_unverifiable` y su condición de reevaluación. Nunca se presenta una
suposición como independencia probada.

Tocar el contrato del orquestador o una regla compartida por varios agentes fuerza
avance secuencial, aunque las cuatro dimensiones sean independientes. En `build` el plan
debe declarar los archivos previstos; en `define` y `plan` la dimensión de archivos no
aplica y sí aplican la memoria, el espacio y la rama, y la dependencia.

## Decisión de lote y cola

La decisión toma un resultado: `parallel`, `sequential_independence_unverifiable`,
`sequential_shared_surface`, `sequential_dependency` o `sequential_capacity_unset`.

Se persiste como campo opcional `parallel_batch` dentro del mapa de instancias de cada
trabajo, por upsert y conservando los campos previos. No hay registro nuevo ni
`topic_key` nuevo.

La capacidad se declara en `.flowtask/config/parallel.json` con la clave `maxParallel`.
Ausente, `null` o inválida equivale a capacidad 1 y a avance secuencial: no hay valor por
defecto inventado. La cola FIFO conserva el orden de llegada, muestra la posición de
cada trabajo y no reordena en silencio. La decisión se reevalúa antes de cada fase.

## Despacho acotado y join

Un trabajo tiene como máximo una fase de subagente en vuelo. El despacho en segundo
plano usa el formato canónico de `subagent()` con `background: true`.

Antes de cada despacho se ejecuta el handshake del trabajo y se persiste su identidad.
El lote no reutiliza un `sessionID` entre trabajos: cada uno abre su propio hilo y
registra el identificador devuelto en su mapa.

Un trabajo no avanza de fase hasta que la anterior terminó y su resultado es legible. Si
la notificación no llega o el resultado es ilegible, ese trabajo se pausa con
`progress_unavailable` y los demás conservan lo suyo. No se re-despacha a ciegas.

El lote no omite el Gate, la auditoría, la decisión de pruebas ni los consentimientos:
cada trabajo los cumple por separado.

## Identidad y trazas

Cada trabajo conserva su nombre base, su mapa de instancias, su `task_id` y
`sessionID`, su `execution_id`, sus registros de progreso, terminación, idempotencia,
presupuesto y ejecución, su worktree, su rama, sus artifacts y su numeración. Nada se
comparte ni se reinicia entre trabajos.

Si un trabajo pierde su identidad, su hilo o su estado recuperable, se detiene solo ese
trabajo con la pérdida de continuidad declarada. No se sustituye la identidad perdida y
un hilo nuevo nunca se presenta como reanudación lograda.

## Contención de conflictos

| Condición | Código vigente | Estado conservado | Condición de reanudación |
|---|---|---|---|
| Cerrojo ocupado del espacio de trabajo | `resource_locked` | Worktree, rama y artifacts intactos. | Liberación del cerrojo. |
| Escritura simultánea sospechada | `concurrent_write_suspected` | Último estado confirmado y su evidencia. | La sospecha se resuelve. |
| Solapamiento de `topic_key` | `concurrent_write_suspected` | Ambos registros, sin modificación. | Los `topic_key` se separan. |
| Rama que ya no integra limpio | Resultado del gestor de worktrees | Worktree, rama y cambios sin consolidar. | El desarrollador declara cómo continuar. |
| Pérdida de identidad o de estado | `progress_unavailable` | Su checkpoint y su artifact. | La identidad o el estado vuelven a estar disponibles. |
| Carrera de deduplicación | `concurrent_write_suspected` | Ambos estados, sin fusionar. | Fuera de alcance: se declara y no se resuelve. |

Las reglas de contención: no sobrescribe, no reintenta a ciegas por otra vía, no inventa
identificadores, no crea un registro paralelo para suplir uno ausente o ilegible, no
fusiona registros contradictorios y no declara cero por falta de datos. Un conflicto
contenido nunca se presenta como trabajo completado.

## Integración serializada

El cierre `complete` se ejecuta de a uno por vez sobre la misma base. El squash-merge no
se paraleliza: dos integraciones sobre la misma base no se ejecutan a la vez, aunque los
trabajos sean independientes.

Un conflicto conserva el worktree y la rama y se escala: no se fuerza la integración, no
se limpia el destino y no se crea un stash. `--preserve-dirty` sigue exigiendo
consentimiento humano explícito.

## Superficies heredadas

- `context-degradation` conserva sus packs por momento, sus umbrales y sus pruebas.
- La puerta de pruebas condicionales conserva su decisión, su generación, su herencia y
  la coherencia de su documentación.
- `agent-loop-progress`, `agent-loop-termination`, `agent-loop-idempotency`,
  `agent-loop-budget` y `agent-loop-run` se consultan como fuente vigente y no se
  redefinen.
- `checkpoint-mixin` conserva la separación entre checkpoints y registros de ejecución.
- El gasto se atribuye por ejecución, sin repartos entre trabajos del lote y sin topes
  nuevos.
- Si una superficie heredada está ilegible o una referencia está rota, la ejecución se
  detiene con la causa exacta y no se improvisa una regla sustituta.

## Referencias

- `.flowtask/skills/parallel-orchestration/SKILL.md` — contrato normativo de la
  orquestación paralela segura.
- `.flowtask/agents/runner.md` — sección `## Orquestación paralela segura`: cuándo se
  evalúa, decisión de lote, despacho y join, cola y capacidad, contención, integración
  serializada y herencia de superficies.
- `.flowtask/config/README.md` — declaración opcional de la capacidad por proyecto.
- `docs/architecture/worktree.md` — frontera del gestor de worktrees y ausencia de motor
  paralelo.
