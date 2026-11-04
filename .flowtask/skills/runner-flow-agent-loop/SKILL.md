---
name: runner-flow-agent-loop
description: >-
  Flujo del runner — activación, orden de ejecución, composición y fallos operativos. Se carga solo ante el disparador
  `evento:agent-loop`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Control del Agent Loop

### Fuentes vigentes

Cada ejecución del Agent Loop consulta cinco contratos de control y el controlador de la ejecución como fuente vigente. Este apartado dirige cuándo se consulta cada uno y no redefine sus reglas.

| Skill | Qué aporta | Cuándo se consulta |
|-------|-----------|-------------------|
| `agent-loop-progress` | El registro de progreso: única fuente del avance verificable por ronda. | Antes de despachar cada ronda y al leer el avance. |
| `agent-loop-invariants` | El catálogo de invariantes: reglas que se verifican de forma bloqueante al cierre de cada ronda. | Al declarar el contexto de la ronda 1 y en cada cierre de ronda. |
| `agent-loop-termination` | El predicado de terminación: única decisión de continuar, pausar o cerrar. | Al cierre de cada ronda funcional completada, antes de despachar la siguiente. |
| `agent-loop-idempotency` | La identidad estable de operación: reintentos y reanudaciones sin duplicar efectos. | Antes de cada fase con efecto observable, antes de un reintento y al reanudar. |
| `agent-loop-budget` | El registro de gasto: única fuente de cuánto costó el objetivo, con aviso suave ante límites blandos declarados. | Al cierre de ronda, después de la terminación, solo cuando la terminación dice `continue`. |
| `agent-loop-run` | El controlador de la ejecución: compone los cinco contratos, persiste el registro de la ejecución y aplica el freno duro por gasto declarado. | Al iniciar, antes de la ronda 1, al cerrar cada ronda, al pausar, al reanudar y al cerrar. |

`agent-loop-run` no reemplaza ni redefine los cinco contratos de control: los consulta como
fuente vigente y los aplica en orden fijo.

El binding de persistencia de esos contratos vive en `memory-contract`, la ownership y los sub-namespaces en `topic-keys-convention`, y la separación entre checkpoints y registros de ejecución en `checkpoint-mixin`.

Si una de las cinco skills de control no carga, si `agent-loop-run` no carga o si alguna de esas referencias está rota, la ejecución se detiene y se informa: no se improvisa una regla sustituta.

### Orden de la ejecución

**Antes de la ronda 1:**

1. Resolver `execution.id`, el baseline vigente de la ejecución y el tope duro declarado por el trabajo.
2. Inicializar el registro de progreso como ronda 0 y confirmarlo por lectura.
3. Crear el ledger de idempotencia en la fase `runner.intake` y confirmarlo por lectura.
4. Resolver y registrar el contexto de invariantes de la ronda, y confirmarlo por lectura.
5. Crear el registro de gasto de la ejecución y confirmarlo por lectura.
6. Crear el `AgentRunRecord` con las referencias a los cuatro registros y el tope duro, y confirmarlo por lectura.
7. Consultar el registro de terminación: si no existe, la ejecución está en estado `running`; si existe, se restaura y se respeta.
8. Despachar la ronda 1.

Ninguna ronda se despacha sin esas confirmaciones.

**En cada ronda:**

1. Congelar el resultado y la evidencia de la ronda.
2. La ronda verifica los cinco invariantes de forma bloqueante. Si hay violación, se persiste el reporte, se aplica la acción del catálogo (`pause` o `rollback_and_pause`), no se confirma la instantánea y no se despacha la ronda siguiente.
3. Si algún invariante no es evaluable, no se confirma la instantánea y se registra la información faltante.
4. Registrar la instantánea de progreso de la ronda y confirmarla por lectura.
5. Evaluar el predicado de terminación.
6. Si la terminación dice `continue`, evaluar la compuerta de gasto antes de despachar: primero el tope duro y después el límite blando. Tope duro alcanzado → pausa `source: controller`, `reason: hard_limit`. Límite blando con `pause` → pausa reversible. Límite blando con `notify` → aviso visible.
7. Confirmar las fases de idempotencia de la ronda y actualizar el `AgentRunRecord` con la ronda, el estado efectivo, la pausa o el cierre y la última compuerta.
8. Despachar la ronda siguiente solo si la decisión es `continue`.

La ronda siguiente se despacha solo cuando todas las confirmaciones anteriores están leídas.

### Reglas de composición

- **La terminación prevalece sobre el presupuesto**: un cierre del predicado prevalece sobre cualquier aviso suave de gasto. El aviso suave no impide un cierre ni lo provoca, y `on_soft: pause` solo propone una pausa reversible.
- **Un invariante violado no confirma la instantánea**, aunque el predicado de terminación indique continuar: vale lo declarado en el catálogo vigente, no la interpretación de la ronda.
- **La misma identidad no repite el efecto**: una operación repetida con la misma identidad reutiliza su evidencia y devuelve `already_confirmed`; el trabajo no se ejecuta dos veces.
- **El progreso no decide**: el registro informa hechos con evidencia citable y declara `unknown` sin estimar cuando la evidencia falta.
- **La reevaluación no duplica**: reevaluar el predicado con los mismos hechos y el mismo baseline produce la misma decisión, sin duplicar transiciones ni cierres.
- **El estancamiento no es un tope**: el umbral de estancamiento no es un máximo de rondas y nunca cierra por sí solo; solo propone.
- **El rechazo funcional no es un reintento**: un rechazo funcional del Validator no es un reintento de idempotencia y abre una unidad lógica nueva.
- **El fallo operativo no es una ronda**: no es una ronda funcional ni incrementa la numeración de rondas ni el contador de estancamiento.
- **Los registros de ejecución no son checkpoints**: no habilitan la reanudación de subagentes ni sustituyen el estado por subagente.
- **El controlador compone, no redefine**: `agent-loop-run` aplica los cinco contratos en orden fijo. Si una skill no carga o una referencia está rota, se detiene la ejecución y se informa; no se improvisa una regla sustituta.
- **La terminación prevalece sobre la compuerta**: si la terminación dice `pause` o `close`, la compuerta de gasto no se evalúa y el motivo visible es el de la terminación. El gasto no anula ni fuerza una terminación.
- **El tope duro solo existe si el trabajo lo declara**: sin `hard_limit` declarado no hay pausa por gasto, solo observación y aviso suave. Se evalúa después de la terminación y antes del límite blando.
- **El tope duro solo pausa**: alcanzado, produce una pausa reversible del controlador con `source: controller` y `reason: hard_limit`. Nunca cierra, nunca abandona, nunca termina procesos por consumo y nunca cambia de modelo.
- **Con tope duro, el gasto ilegible o la atribución incompleta pausan en seguridad**; sin tope duro, esas mismas anomalías solo se informan y el trabajo continúa en modo degradado.
- **El estancamiento no cambia de modelo** y las rondas no son una señal de gasto.
- **El `AgentRunRecord` no es un checkpoint**: referencia el progreso, la terminación, la idempotencia y el gasto; no los sustituye y no habilita la reanudación de subagentes.
- **La decisión de pruebas no altera los contratos de control**: es posterior al Gate de Ejecución, no es una confirmación humana y no modifica el `AgentRunRecord`.

### Fallos operativos

- Si una superficie contractual es ilegible o una de sus referencias está rota, la ejecución se detiene y se informa el motivo. No se aplica una regla improvisada ni una fuente paralela.
- Si un registro operativo es ilegible, no está confirmado o no se persistió, se aplica la regla de su propio contrato: no se sustituye por una regla improvisada, no se anuncian avances y no se despacha la ronda siguiente.
- Si el `AgentRunRecord` no existe, es ilegible o no se confirma, no se despacha: se conserva la última confirmación y se pausa en seguridad.
- Si el `AgentRunRecord` contradice a otro registro de la ejecución, se informa la contradicción, no se sobrescribe ninguno de los dos y no se avanza.

***
