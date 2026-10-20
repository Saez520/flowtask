---
name: parallel-orchestration
description: >-
  Contrato de orquestación paralela segura: independencia verificable, lote
  acotado con cola visible, identidad y trazas separadas, contención de
  conflictos y degradación a secuencial ante cualquier duda.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Orquestación Paralela Segura — Lote Acotado con Cola Visible

## Propósito

Este contrato define cómo se decide qué trabajos avanzan a la vez, cómo se despachan
sin mezclar historias y cómo se contiene un conflicto antes de perder trabajo.

La latencia se reduce solo cuando la independencia es comprobable con fuente citable.
Ante cualquier duda, el lote es secuencial: la decisión conservadora siempre está
disponible y nunca requiere una regla improvisada.

No es un motor distribuido. No reemplaza al gestor de worktrees, que sigue siendo la
autoridad única del ciclo de vida. No redefine los contratos de control del loop: los
consulta como fuente vigente.

## Alcance y fronteras

Incluye: la verificación de independencia, la decisión de lote, la cola visible, el
despacho en segundo plano, la identidad y las trazas separadas, la contención de
conflictos y la herencia de las superficies vigentes.

Excluye: el consenso distribuido, la deduplicación en carrera, el motor paralelo de
worktrees, la calibración numérica de la capacidad, el versionado y el cierre de fase.

No es un checkpoint: no habilita la reanudación de un agente. No es un registro de
ejecución: no lleva la numeración de rondas ni el gasto. No crea espacios de nombres
nuevos: la decisión de lote vive como campo opcional `parallel_batch` dentro del mapa de
instancias que ya existe.

No modifica `agent-loop-progress`, `agent-loop-termination`, `agent-loop-idempotency`,
`agent-loop-budget`, `agent-loop-run`, `checkpoint-mixin`, `memory-contract` ni
`topic-keys-convention`: los consulta y los aplica.

## Términos

| Término | Significado |
|---|---|
| Trabajo | Unidad de ejecución con identidad, estado, trazabilidad y resultados propios. |
| Lote | Conjunto de trabajos evaluados juntos para decidir si avanzan a la vez. |
| Independencia | Calidad de un trabajo cuyo avance no depende de ni interfiere con otro del lote. |
| Superficie compartida | Contrato, regla, archivo o espacio que dos trabajos del lote tocarían en común. |
| Decisión de lote | Resultado `parallel` o `sequential` con su causa y su evidencia. |
| Capacidad | Cantidad máxima de trabajos que pueden avanzar simultáneamente. |
| Cola | Orden FIFO de los trabajos que exceden la capacidad, con posición visible. |
| Fase | Etapa del trabajo con su propio conjunto de reglas vigentes. |
| Join | Espera confirmativa de que la fase previa terminó y su resultado es legible. |
| Contención | Acción de conservar recursos y detener o degradar ante un conflicto. |
| Traza | Registro propio de un trabajo: progreso, terminación, idempotencia, gasto y ejecución. |

## Independencia verificable

Dos trabajos son independientes solo si las cuatro dimensiones son comprobables con
fuente citable. Si una sola no lo es, el lote es secuencial.

| Dimensión | Qué se compara | Fuente citable | Resultado si falta o coincide |
|---|---|---|---|
| Archivos previstos | El conjunto de archivos que cada trabajo declara que va a modificar. | El plan aprobado de cada trabajo y su sección de archivos. | Coincidencia: secuencial por superficie compartida. Falta: secuencial por independencia no verificable. |
| Escrituras de memoria | Los `topic_key` que cada trabajo declara que va a escribir. | El mapa de instancias y el plan de cada trabajo. | Coincidencia: secuencial por superficie compartida. Falta: secuencial por independencia no verificable. |
| Espacio y rama de trabajo | El `worktree` y la rama que cada trabajo usa. | El gestor de worktrees y la asociación confirmada en el mapa de instancias. | Coincidencia: secuencial por superficie compartida. Falta: secuencial por independencia no verificable. |
| Dependencia | Si un trabajo necesita el resultado de otro para empezar. | El plan y el grafo de dependencias del lote. | Dependencia declarada: secuencial por dependencia. Falta: secuencial por independencia no verificable. |

**Por momento.** En `define` y `plan` no se modifican archivos de producto: la dimensión
de archivos previstos no aplica y sí aplican la memoria, el espacio y la rama, y la
dependencia. En `build` la dimensión de archivos previstos es obligatoria: un plan sin
archivos previstos no habilita un lote paralelo.

**Superficies compartidas.** Tocar cualquiera de estas superficies obliga a avance
secuencial, aunque las cuatro dimensiones anteriores sean independientes. Las
superficies compartidas se declaran siempre en positivo: no hay superficie que avance
en paralelo por omitirse de la lista.

- `.flowtask/agents/`
- `.flowtask/skills/`
- `.flowtask/bin/lib/`
- un archivo de test existente compartido
- `.flowtask/plugins/`
- `.flowtask/scripts/`
- `.flowtask/commands/`
- `opencode.json`
- `.flowtask/package.json`
- `.flowtask/config/`
- `docs/architecture/INDEX.md`
- `docs/roadmap/`
- `.opencode/`

**Causa por defecto.** Si una dimensión no es verificable con fuente citable, el lote es
secuencial con la causa `independence_unverifiable` y declara la condición exacta de
reevaluación. Nunca se presenta una suposición como independencia probada.

## Decisión de lote y cola

**Resultados posibles.** La decisión de lote toma exactamente uno de estos valores:

| Resultado | Cuándo se aplica |
|---|---|
| `parallel` | Las cuatro dimensiones son independientes y verificables, no hay superficie compartida y la capacidad declarada es mayor que uno. |
| `sequential_independence_unverifiable` | Al menos una dimensión no se puede comprobar con fuente citable. |
| `sequential_shared_surface` | Un trabajo toca el contrato del orquestador o una superficie compartida. |
| `sequential_dependency` | Un trabajo depende del resultado de otro del lote. |
| `sequential_capacity_unset` | La capacidad no está declarada, o es inválida: el avance es secuencial. |

**Forma de la decisión.** La decisión se persiste como campo opcional `parallel_batch`
dentro del mapa de instancias de cada trabajo, por upsert y conservando todos los campos
previos:

| Campo | Contenido |
|---|---|
| `id` | Identificador del lote. Es solo coordinación: no es un identificador de trabajo ni un `topic_key`. |
| `decision` | El resultado de la decisión de lote. |
| `capacity` | La capacidad efectiva usada para esta decisión. |
| `queue_position` | Posición del trabajo en la cola, o la posición que ocupa en el lote. |
| `reasons` | Las causas que sostienen la decisión. |
| `evidence_refs` | Las referencias citables de la evidencia comparada. |
| `decided_at` | Momento de la decisión. |

**Capacidad.** La capacidad se declara en la configuración del proyecto con la clave
`maxParallel`. Si la clave falta, es `null` o es inválida, la capacidad es 1 y el avance
es secuencial. No hay valor por defecto inventado: la primera ventana de observación no
calibra una cifra.

**Cola.** La cola FIFO conserva el orden de llegada. Lo que excede la capacidad espera
con su posición visible. Al liberarse capacidad entra el siguiente sin reordenar en
silencio. Un trabajo que sale de la cola o del lote no reordena a los demás. La cola no
descarta trabajos y la capacidad no se supera sin aviso.

**Reevaluación.** La decisión se reevalúa antes de cada fase, porque los archivos
previstos y los `topic_key` pueden cambiar entre fases.

## Despacho paralelo acotado

**Un vuelo por trabajo.** Un trabajo tiene como máximo una fase de subagente en vuelo.
Un lote de trabajos independientes no multiplica fases dentro del mismo trabajo.

**Formato canónico.** El despacho en segundo plano usa el formato canónico de
`subagent()` con la opción de segundo plano:

```
subagent(
  agent: "[tipo]",
  prompt: "[prompt conforme al contrato + contexto inyectado]",
  description: "[work_id] [fase]",
  background: true
)
```

**Identidad antes del despacho.** Antes de cada despacho se ejecuta el handshake del
trabajo —completo para los agentes de tratamiento completo, ligero para los demás— y la
identidad resultante se persiste antes de invocar. El lote no reutiliza un `sessionID`
entre trabajos: cada uno abre su propio hilo y lo registra en su mapa.

**Join.** Un trabajo no avanza de fase hasta que su fase previa terminó y su resultado
es legible. El join de un trabajo se resuelve antes de abrir la fase siguiente: si la
notificación no llega o el resultado es ilegible, ese trabajo se pausa con
`progress_unavailable` y los demás conservan lo suyo. No se re-despacha a ciegas: un
re-despacho sin evidencia de lo anterior no está permitido.

**Lo que el lote no omite.** El lote no omite el Gate, la auditoría, la decisión de
pruebas ni los consentimientos: cada trabajo los cumple por separado.

**Identidad visible.** La identidad visible del orquestador es la del trabajo líder. Cada
subagente usa el `base_name` de su propio trabajo. El identificador de lote sirve solo
para coordinación y no sustituye ninguna identidad de trabajo.

## Identidad y trazas separadas

Cada trabajo conserva lo suyo y no lo comparte con otro:

| Elemento | Regla |
|---|---|
| Nombre base | Único dentro del lote; no se reutiliza entre trabajos activos. |
| Mapa de instancias | Propio de cada trabajo; el registro de lote no lo reemplaza. |
| `task_id` y `sessionID` | Propios; no se comparten ni se reasignan. |
| `execution_id` | Propio; dos trabajos del lote no comparten ejecución. |
| Registros de progreso, terminación, idempotencia, presupuesto y ejecución | Propios; no se mezclan ni se sustituyen. |
| Worktree y rama | Propios; un trabajo no opera sobre el espacio de otro. |
| Artifacts | Propios; ningún trabajo consume el artifact de otro como propio. |
| Numeración de rondas y contadores | No se reinician ni se reparten entre trabajos. |

**Pérdida de continuidad.** Si un trabajo pierde su identidad, su hilo o su estado
recuperable, se detiene solo ese trabajo con la pérdida de continuidad declarada. Los
demás trabajos conservan su numeración, sus contadores y su evidencia. No se sustituye
la identidad perdida y un hilo nuevo nunca se presenta como reanudación lograda.

## Contención de conflictos

| Condición | Código vigente | Acción | Estado conservado | Condición de reanudación |
|---|---|---|---|---|
| Cerrojo del espacio de trabajo ocupado por otro trabajo del lote | `resource_locked` | Se espera la liberación o el lote degrada a secuencial. | Worktree, rama y artifacts intactos. | Cerrojo liberado o lote reevaluado como secuencial. |
| Sospecha de escritura simultánea en memoria | `concurrent_write_suspected` | Se detiene al afectado sin escribir encima. | Último estado confirmado y su evidencia. | La sospecha se resuelve y la evidencia vuelve a estar disponible. |
| Solapamiento de `topic_key` detectado en ejecución | `concurrent_write_suspected` | Se detienen los afectados; no se fusionan registros. | Ambos registros, sin modificación. | Los `topic_key` se separan y se declara cuál escribe. |
| Rama que ya no integra limpio sobre la base | Resultado del gestor de worktrees | No se limpia, no se fuerza y se escala. | Worktree, rama y cambios sin consolidar. | El desarrollador declara cómo continuar. |
| Pérdida de identidad, hilo o estado recuperable | `progress_unavailable` | Se detiene solo ese trabajo. | Su checkpoint, su artifact y su rastro. | La identidad o el estado vuelven a estar disponibles. |
| Carrera de deduplicación entre dos trabajos | `concurrent_write_suspected` | Se detiene y se declara; no se arbitra un ganador. | Ambos estados, sin fusionar. | Fuera de alcance: la carrera se declara, no se resuelve. |

**Reglas de contención.**

- La contención no sobrescribe: un conflicto nunca se resuelve escribiendo encima del
  recurso o del registro afectado.
- La contención no reintenta a ciegas por otra vía: un conflicto no se esquiva con un
  camino alternativo que evita la contención.
- La contención no inventa identificadores: si el registro o el recurso no se puede
  identificar, se declara y no se fabrica una referencia.
- No crea un registro paralelo para suplir uno ausente o ilegible.
- No fusiona registros contradictorios: declara la contradicción.
- No declara cero por falta de datos: la ausencia se etiqueta como no verificada.
- La carrera simultánea se detiene y se declara, sin arbitrar un ganador.

## Superficies heredadas

| Superficie | Qué conserva |
|---|---|
| `context-degradation` | Sus packs de reglas por momento, sus umbrales y sus pruebas. |
| Puerta de pruebas condicionales | Su decisión, su generación, su herencia y la coherencia de su documentación. |
| `agent-loop-progress` | El registro de progreso por ronda. No se redefine. |
| `agent-loop-termination` | El predicado de terminación. No se redefine. |
| `agent-loop-idempotency` | La identidad estable de operación y el tratamiento de efectos inciertos. No se redefine. |
| `agent-loop-budget` | El registro de gasto y el aviso suave. No se redefine. |
| `agent-loop-run` | El controlador de la ejecución. No se redefine. |
| `checkpoint-mixin` | La separación entre checkpoints y registros de ejecución. No se redefine. |

**Gasto.** El gasto se atribuye por ejecución, sin repartos entre trabajos del lote y
sin topes nuevos. La capacidad de un lote no divide el presupuesto de ninguna ejecución.

**Herencia de evidencia.** La evidencia ya verificada se hereda por referencia y no se
re-verifica por rutina. Solo se verifica el dato nuevo material que introduce el
paralelismo.

**Fallo de superficie.** Si una superficie heredada está ilegible o una de sus
referencias está rota, la ejecución se detiene con la causa exacta y no se improvisa una
regla sustituta ni se recurre a una fuente paralela.

## Fallos, avisos y datos no verificables

Solo se usan los códigos vigentes. No se agrega un enum de motivo de pausa ni un código
de error nuevo.

| Condición | Código vigente | Acción | Estado conservado | Condición de reanudación |
|---|---|---|---|---|
| Independencia no comprobable con fuente citable | — | Lote secuencial. | La decisión de lote con su causa. | La evidencia de independencia disponible. |
| Capacidad no declarada o inválida | — | Lote secuencial. | La decisión de lote con su causa. | La capacidad declarada. |
| Notificación de segundo plano ausente o resultado ilegible | `progress_unavailable` | Se pausa ese trabajo. | Su checkpoint y su último resultado confirmado. | El resultado vuelve a estar disponible. |
| Cerrojo ocupado | `resource_locked` | Se espera o el lote degrada a secuencial. | Worktree, rama y artifacts. | Cerrojo liberado. |
| Escritura simultánea sospechada | `concurrent_write_suspected` | Se detiene al afectado. | Último estado confirmado. | La sospecha se resuelve. |
| Escritura del registro de lote sin confirmar por lectura | `persistence_unconfirmed` | Se reintenta la confirmación; no se avanza con la escritura no confirmada. | La última versión confirmada del registro. | La lectura de verificación coincide con la escritura. |
| Referencia heredada rota o superficie ilegible | `progress_unavailable` | Se detiene y se informa la causa. | Todo lo confirmado hasta ese punto. | La superficie vuelve a estar legible. |

**La independencia no comprobable y la capacidad no declarada no son pausas.** Producen
un lote secuencial con su causa visible y su condición de reevaluación.

**Detalle por perfil.** El detalle de los avisos y de la evidencia sigue el perfil de
política vigente: el perfil de desarrollo agrega referencias de evidencia y el último
comando verificado; el perfil de producción mantiene la línea concisa. La verificación
técnica para reanudar es la misma en ambos perfiles.

**Líneas visibles.**

```
🔀 Lote paralelo: {work_ids} (capacidad {N}); cola: {work_ids}. Evidencia: {dimensiones}.
🔁 Lote secuencial: {work_ids}; causa: {causa}. Reevaluar: {condición}.
⏳ Cola: {work_id} posición {N}; capacidad {M}.
```

No se exponen cifras internas de cerrojos ni de registros.

## Garantías del contrato

| ID | Garantía |
|---|---|
| `G-01` | Solo avanza en paralelo un trabajo con independencia comprobable. |
| `G-02` | Un trabajo sobre superficie compartida avanza en secuencial. |
| `G-03` | No hay lote paralelo sin evidencia citable de la independencia. |
| `G-04` | La capacidad está acotada y la cola respeta el orden FIFO. |
| `G-05` | Cada trabajo conserva su identidad y su traza. |
| `G-06` | Ningún trabajo reutiliza el hilo ni los registros de otro. |
| `G-07` | Un conflicto se contiene sin sobrescritura, sin reintento a ciegas y sin identificadores inventados. |
| `G-08` | La integración se serializa: de a un cierre por vez sobre la misma base. |
| `G-09` | Las superficies heredadas se consultan y no se redefinen. |
| `G-10` | El gasto se atribuye por ejecución, sin repartos ni topes nuevos. |
| `G-11` | Ningún registro paralelo suplanta un registro ausente o contradictorio. |
| `G-12` | Una carrera simultánea se detiene y se declara, sin arbitrar un ganador. |

## Matriz de aceptación

| ID | Criterio | Regla que lo satisface | Verificación |
|---|---|---|---|
| `AC-01` | Un lote de trabajos independientes comprobables avanza a la vez, cada uno con su identidad, su espacio y su traza. | `G-01`, `G-03`, `G-05`. | Revisar la línea visible del lote y los mapas de instancias de cada trabajo. |
| `AC-02` | Un trabajo que toca el contrato del orquestador o una regla compartida avanza en secuencial. | `G-02`. | Revisar la causa declarada en la decisión de lote. |
| `AC-03` | Una independencia no comprobable produce un lote secuencial con causa exacta y condición de reevaluación. | `G-01`, `G-03`. | Retirar la evidencia de independencia y reevaluar el lote. |
| `AC-04` | Al alcanzar la capacidad máxima, el trabajo excedente espera con cola visible y sin perderse. | `G-04`. | Superar la capacidad y revisar la cola. |
| `AC-05` | Un cerrojo ocupado deja el trabajo en espera con su recurso conservado. | `G-07`, `G-08`. | Provocar la contención del cerrojo y revisar el estado conservado. |
| `AC-06` | Una sospecha de escritura simultánea detiene a los afectados y conserva lo último confirmado. | `G-07`, `G-11`. | Provocar la escritura simultánea y revisar el estado conservado. |
| `AC-07` | Una rama que no integra limpio produce una integración contenida, con trabajos y ramas conservados y escalación. | `G-08`. | Divergir las ramas y revisar la decisión previa a integrar. |
| `AC-08` | Un cambio en el contrato del orquestador con paralelismo activo deja en verde las superficies heredadas. | `G-09`. | Ejecutar la suite de esas superficies y revisar la documentación. |
| `AC-09` | La pérdida de identidad de un trabajo detiene solo ese trabajo y no sustituye su identidad. | `G-05`, `G-06`. | Retirar la identidad de un trabajo y revisar el lote. |
| `AC-10` | El gasto de un lote se atribuye por ejecución, sin repartos. | `G-10`. | Acumular gasto en paralelo y revisar los registros por ejecución. |

## Ejemplos canónicos

### `E-01` — Lote paralelo de dos trabajos independientes

Dos trabajos con archivos previstos disjuntos, `topic_key` distintos, worktree y rama
propios, y sin dependencia entre ellos. La capacidad declarada es 2. Resultado:
`parallel`, y la línea visible `🔀 Lote paralelo: {work_ids} (capacidad 2); cola: —.
Evidencia: {dimensiones}.` Cada trabajo conserva su identidad y su traza.

### `E-02` — Secuencial por superficie compartida

Uno de los dos trabajos modifica un archivo bajo `.flowtask/agents/`. Las cuatro
dimensiones son independientes, pero la superficie compartida obliga a secuencial.
Resultado: `sequential_shared_surface`. La causa queda citable y el lote avanza de a un
trabajo.

### `E-03` — Secuencial por independencia no verificable

Uno de los dos trabajos no declara sus archivos previstos en el plan. La dimensión de
archivos no se puede comprobar. Resultado: `sequential_independence_unverifiable`, con
la condición de reevaluación: el plan declara los archivos previstos.

### `E-04` — Cola al alcanzar la capacidad

La capacidad declarada es 2 y llegan tres trabajos independientes. Los dos primeros
avanzan; el tercero espera con `queue_position` visible. Al terminar uno, entra el
tercero sin reordenar a los demás. La línea visible es
`⏳ Cola: {work_id} posición 1; capacidad 2.`

### `E-05` — Cerrojo ocupado y degradación

El worktree de un trabajo del lote está bloqueado por otro trabajo. Resultado visible:
`resource_locked`. El worktree, la rama y los artifacts quedan intactos, el lote degrada
a secuencial y la condición de reanudación es la liberación del cerrojo.

### `E-06` — Escritura simultánea sospechada

Dos trabajos del lote escriben sobre el mismo `topic_key`. El trabajo afectado se
detiene con `concurrent_write_suspected`, sin sobrescribir, sin fusionar registros y sin
crear un registro paralelo. El otro trabajo conserva su estado.

### `E-07` — Pérdida de identidad en un trabajo

Un trabajo del lote pierde su hilo recuperable. Ese trabajo se detiene con la pérdida de
continuidad declarada; el resto del lote conserva numeración, contadores y evidencia. No
se abre un hilo sustituto.

### `E-08` — Conflicto de integración al cerrar

Dos trabajos independientes terminan y sus ramas chocan al integrarse. La integración se
serializa: el primer cierre se intenta, el segundo detecta que la rama no integra limpio
y conserva worktree y rama. No se fuerza la integración, no se limpia el destino y el
conflicto se escala.
