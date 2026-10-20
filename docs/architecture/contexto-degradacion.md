# Contexto degradado: niveles, reglas por momento y recuperación verificable

El contexto de una ejecución crece con cada lectura, cada búsqueda y cada
ronda. Este documento describe cómo el sistema degrada esa entrega antes de
omitirla, cómo inyecta solo las reglas vigentes del momento actual y cómo
recupera lo durable ya confirmado cuando el hilo pierde contexto o cambia de
instancia.

El contrato canónico vive en `.flowtask/skills/context-degradation/SKILL.md`; su
implementación ejecutable vive en
`.flowtask/plugins/flowtask-permission-gate/src/context-budget.ts` y su
aplicación en el flujo, en `.flowtask/agents/runner.md`.

## Propósito

1. Degradar por niveles: avisar, entregar menos detalle y delegar lo omitido.
2. Inyectar de forma progresiva: solo las reglas del momento actual.
3. Recuperar de forma verificable: lo ya confirmado, con su fuente y su momento
   de observación.
4. No perder información en silencio: nada omitido se presenta como completo.

## Alcance

| Incluye | Excluye |
|---------|---------|
| Los tres niveles de degradación de la entrega | La reescritura o compresión del historial |
| El pack de reglas de cada momento | La ejecución simultánea de varios trabajos |
| La recuperación desde los registros durables existentes | La calibración de presupuestos |
| La herencia de la evidencia verificada | El respaldo de estado en disco |
| Los avisos observables y su delegación | La decisión de terminación de un trabajo |

## Degradación por niveles

La degradación ocurre en tres niveles y en ese orden. Un nivel nunca se salta
para entregar menos sin avisar.

| Nivel | Cuándo ocurre | Qué ve el operador |
|-------|---------------|--------------------|
| Aviso de acotación | El primer pedido amplio del turno. | Qué se pidió, sobre qué ruta, patrón o ventana, y cómo acotarlo. |
| Entrega reducida | La entrega supera el presupuesto por llamada. | Qué se omitió, cuánto pesaba lo omitido y a quién delegarlo. |
| Omisión por turno | La suma del turno alcanza el presupuesto acumulado. | El mismo aviso, nombrando el presupuesto acumulado del turno. |

### Prohibiciones

- Entregar contenido grande sin aviso.
- Presentar un recorte como si fuera la respuesta completa.
- Incluir un preview del contenido omitido.
- Exponer la cifra del umbral: los mensajes nombran el ámbito del presupuesto
  aplicado —por llamada o acumulado del turno— y el tamaño real omitido.
- Recortar en silencio cuando el tamaño no se puede medir: en ese caso se emite
  una traza con la causa y la entrega se realiza sin recortar.
- Entregar un adjunto de imagen o documento al flujo que no lo maneja: se
  delega con su tamaño medido.

### Adjuntos y mediciones

| Situación | Comportamiento |
|-----------|----------------|
| La entrega incluye un adjunto de imagen o documento | El texto medido se declara, el adjunto se delega y no se entrega. |
| La salida de la herramienta no es texto y no se puede medir | Se emite una traza con la causa, la entrega se realiza intacta y la entrega queda marcada como no medible. |

## Reglas por momento

El trabajo avanza por momentos. Cada momento tiene un pack mínimo de reglas
vigentes: qué se espera, qué está prohibido y qué avisa. El manual completo no
se repite en cada mensaje.

| Momento | Qué se espera | Qué está prohibido | Qué avisa |
|---------|---------------|--------------------|-----------|
| `intake` | Clasificación del pedido y encuadre del trabajo. | Arrancar la implementación sin clasificar. | Entrada ambigua. |
| `define` | Requisito, comportamiento observable y condiciones de fallo. | Reglas de negocio no expresadas. | Requisito supuesto. |
| `plan` | Tareas, dependencias y orden de ejecución. | Decisiones de diseño no resueltas. | Dependencia no satisfecha. |
| `build` | Implementación conforme al plan aprobado. | Alcance fuera del plan. | Conflicto de alcance. |
| `validate` | Evidencia ejecutada y veredicto. | Repetir comprobaciones ya resueltas. | Criterio no evaluable. |
| `close` | Consolidación, cierre y registro. | Declarar cerrado lo no verificado. | Registro ausente o ilegible. |

Reglas transversales:

- Al cambiar de momento se carga el pack nuevo y lo ya resuelto se hereda por
  referencia: la evidencia verificada no se re-verifica por rutina.
- Si el pack no se muestra, se declara que no se mostró y el trabajo no se
  presenta como identificado.
- Si la memoria del proyecto no está disponible, se declara la fuente que
  faltó y se continúa con la siguiente fuente disponible; la ausencia no se
  trata como confirmación.
- El pack describe conducta, no cifras: los umbrales no se muestran.

## Recuperación verificable

La recuperación se ejecuta antes de actuar cuando el hilo perdió contexto por
compactación, cuando cambió de instancia por capacidad o cuando se abrió un
hilo nuevo para continuar un trabajo en curso.

### Fuentes y orden de consulta

| Orden | Fuente | Qué aporta |
|-------|--------|------------|
| 1 | Mapa de instancias | Quién está a cargo, con qué tarea y en qué estado. |
| 2 | Plan aprobado | Las tareas, su orden y las decisiones ya tomadas. |
| 3 | Registro de ejecución | El estado de la ejecución, la ronda vigente y las referencias a los demás registros. |
| 4 | Registro de progreso | La última instantánea confirmada y sus variables observables. |
| 5 | Registro de gasto | Los totales acumulados y la última compuerta evaluada. |

De esos registros se recuperan `round.number`, `variables`,
`integrity.last_snapshot_id`, `tokens.total`, `time.active_time_ms`,
`cost.estimated_usd` e `integrity.last_confirmed_at`.

### Bloque de declaración

Todo lo recuperado se declara con su fuente y su momento de observación:

```
Recuperación de contexto:
- Decisiones vigentes: {lista} (fuente: {ref}, observado: {ISO-8601})
- Progreso confirmado: ronda {N}; tareas {A}/{B}; criterios {C}/{D} (fuente: {ref}, observado: {ISO-8601})
- Gasto acumulado: tokens {T}; tiempo activo {A}; costo estimado {C} (fuente: {ref}, observado: {ISO-8601})
- Última ronda confirmada: {N} (fuente: {ref})
- Huecos no registrados: {lista o "ninguno"}
- Para retomar: {qué falta o "nada"}
```

### Pausa material y etiqueta periférica

| Situación | Respuesta |
|-----------|-----------|
| Lo material para continuar no está confirmado | Pausa con motivo `progress_unavailable` o `record_unavailable`, última confirmación conservada y condición exacta de reanudación. |
| La ejecución activa es ambigua | Respuesta `no disponible` y pausa: no se elige por conveniencia. |
| Un registro es ilegible o contradictorio | Se declara la contradicción y se pausa; no se sobrescribe ni se fusionan registros contradictorios. |
| Falta un dato periférico | Se continúa etiquetándolo `[No verificado]`; la ausencia de una fuente menor no detiene el trabajo. |
| Falta un dato material sin exigencia vigente | Se declara el hueco y se continúa en modo degradado declarado. |

Nunca se declara cero por falta de datos: lo ausente se declara ausente.

## Herencia y discrepancia

La evidencia heredada conserva su fuente y su momento de observación. La ronda
siguiente solo verifica el dato nuevo material que introduce.

| Situación | Efecto |
|-----------|--------|
| La evidencia heredada contradice lo observado en la ronda | Se declara qué discrepa y en qué, y la ejecución se pausa antes de imponer un cambio de alcance. |
| Un registro de un momento anterior sigue vigente | Se reutiliza por referencia: no se re-verifica por rutina. |

La contradicción no se resuelve suponiendo cuál de las dos fuentes tiene razón,
y no se oculta.

## Referencias relacionadas

- [INDEX.md](./INDEX.md) — índice de la arquitectura vigente.
- [validacion.md](./validacion.md) — validación en caliente, evidencia ejecutada y veredicto único.
- [verificacion-material.md](./verificacion-material.md) — verificación material, evidencia citable y herencia entre roles.
- [../permission-gate.md](../permission-gate.md) — permisos, presupuesto de contexto y review-stamp.
- `.flowtask/skills/context-degradation/SKILL.md` — contrato canónico de la degradación y la recuperación.
- `.flowtask/plugins/flowtask-permission-gate/src/context-budget.ts` — niveles de degradación y estado de avisos.
- `.flowtask/agents/runner.md` — packs por momento y bloque de recuperación.
- `.flowtask/agents/ca-writer.md`, `.flowtask/agents/planner.md`,
  `.flowtask/agents/constructor.md`, `.flowtask/agents/validator.md` — pack
  vigente de cada momento.
