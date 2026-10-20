---
name: context-degradation
description: >-
  Contrato de degradación progresiva del contexto: aviso y entrega reducida,
  inyección de reglas vigentes por momento, recuperación verificable tras
  compactación o relevo y continuidad sin pérdida silenciosa.
license: MIT
compatibility: opencode
metadata:
  category: agent-loop
  scope: flowtask
---

# Context Degradation — Degradación progresiva y recuperación verificable

## Propósito

Este contrato define cómo se degrada el contexto cuando crece y cómo se recupera lo
que ya estaba confirmado cuando el hilo pierde contexto o cambia de instancia.

Produce tres cosas: una degradación observable por niveles, las reglas mínimas
vigentes para el momento actual y una recuperación declarada de lo durable ya
confirmado.

No reescribe el historial, no resume el contenido con un modelo, no mueve umbrales y
no decide la terminación de un trabajo. Esas decisiones viven en otros contratos.

## Alcance y fronteras

Incluye: los tres niveles de degradación, los packs de reglas por momento, la
recuperación verificable, la herencia de evidencia y los avisos observables.

Excluye: la reescritura y la compresión del historial, la ejecución simultánea de
varios trabajos, el versionado, la calibración de presupuestos, el respaldo en disco
y las fuentes de estado alternativas.

No es un checkpoint: no habilita la reanudación de un agente. No es un registro de
ejecución: no lleva la numeración de rondas ni el gasto. Es un contrato de
continuidad: gobierna qué se muestra, qué se omite y qué se declara.

## Términos

| Término | Significado |
|---|---|
| Degradación | Reducción observable de lo entregado, anunciada y nunca silenciosa. |
| Aviso | Mensaje que anuncia que el pedido es amplio y cómo acotarlo. |
| Entrega reducida | Resultado parcial que declara qué se omitió, cuánto pesaba y a quién delegar. |
| Omisión por turno | Omisión acumulada del turno, aunque cada pieza por separado quepa. |
| Delegación | Transferencia explícita de lo omitido a quien puede tratarlo. |
| Momento | Etapa del trabajo con su propio conjunto de reglas vigentes. |
| Pack | Conjunto mínimo de reglas del momento: qué se espera, qué está prohibido y qué avisa. |
| Regla resuelta | Regla ya aplicada y confirmada; no se repite ni se re-verifica. |
| Evidencia heredada | Evidencia ya confirmada que la ronda siguiente reutiliza por referencia. |
| Hueco material | Dato necesario para continuar que no se pudo recuperar. |
| Dato periférico | Dato no necesario para continuar, recuperable más tarde o irrelevante para el resultado. |

## Degradación por niveles

La degradación ocurre en tres niveles y en ese orden. Nunca se salta un nivel para
entregar menos sin avisar.

### Nivel 1 — Aviso de acotación

El primer pedido amplio dispara un aviso: qué herramienta se pidió, sobre qué ruta,
patrón o ventana, y cómo acotarlo. El aviso nombra la forma de acotar —ruta, patrón
o ventana más estrecha— y no incluye contenido ni vista anticipada del resultado.

### Nivel 2 — Entrega reducida

Si lo entregado supera el presupuesto por llamada, la entrega se reduce. El mensaje
declara qué se omitió, cuánto pesaba lo omitido y a quién delegarlo —el Inspector—,
sin preview del contenido omitido. El resultado que sí cabe se entrega normalmente.

### Nivel 3 — Omisión por turno

Si la suma entregada en el turno alcanza el presupuesto acumulado del turno, lo
siguiente se omite con el mismo aviso aunque cada pieza por separado quepa. Las
entregas que sí cabían no se bloquean.

### Reglas transversales

- Los umbrales internos no se exponen en los mensajes: el operador ve conducta, no
  cifras.
- El presupuesto aplicado se nombra por su ámbito: "presupuesto por llamada" o
  "presupuesto acumulado del turno".
- Si el tamaño no puede medirse, se emite una traza que dice qué no se pudo medir y
  la entrega se realiza sin recortar. Nunca hay recorte silencioso.
- Está prohibido entregar contenido grande sin aviso.
- Está prohibido presentar un recorte como si fuera la respuesta completa.
- Está prohibido incluir un preview del contenido omitido.

## Inyección de reglas por momento

El trabajo avanza por momentos. Cada momento tiene un pack mínimo de reglas
vigentes: qué se espera, qué está prohibido, qué avisa y qué se amplía.

| Momento | Qué se espera | Qué está prohibido | Qué avisa | Qué se amplía |
|---|---|---|---|---|
| `intake` | Clasificación del pedido y encuadre del trabajo. | Arrancar la implementación sin clasificar. | Entrada ambigua. | El encuadre, no el manual. |
| `define` | Requisito, comportamiento observable y condiciones de fallo. | Reglas de negocio no expresadas. | Requisito supuesto. | Los criterios de aceptación. |
| `plan` | Tareas, dependencias y orden de ejecución. | Decisiones de diseño no resueltas. | Dependencia no satisfecha. | El detalle de la tarea abierta. |
| `build` | Implementación conforme al plan aprobado. | Alcance fuera del plan. | Conflicto de alcance. | La evidencia de la tarea cerrada. |
| `validate` | Evidencia ejecutada y veredicto. | Repetir comprobaciones ya resueltas. | Criterio no evaluable. | Lo nuevo material. |
| `close` | Consolidación, cierre y registro. | Declarar cerrado lo no verificado. | Registro ausente o ilegible. | El resumen de cierre. |

Reglas:

- Se muestra solo el pack del momento. El manual completo no se repite en cada
  mensaje.
- Al cambiar de momento se carga el pack nuevo y lo ya resuelto se hereda por
  referencia.
- La evidencia verificada se hereda y no se re-verifica por rutina: solo se verifica
  lo nuevo material que introduce el momento.
- Si el pack no se muestra, se declara que no se mostró y el trabajo no se presenta
  como identificado.
- Si la memoria del proyecto no está disponible, se declara qué fuente faltó y se
  continúa con la siguiente fuente disponible; la ausencia no se trata como
  confirmación.
- Los umbrales no se muestran en el pack: el pack describe conducta, no cifras.

## Recuperación verificable

### Disparadores

La recuperación se ejecuta antes de actuar cuando el hilo perdió contexto por
compactación, cuando cambió de instancia por capacidad o cuando se abrió un hilo
nuevo para continuar un trabajo en curso.

### Orden de consulta

1. Mapa de instancias: quién está a cargo, con qué tarea y en qué estado.
2. Plan aprobado: las tareas, su orden y las decisiones ya tomadas.
3. Registro de ejecución: el estado de la ejecución, la ronda vigente y las
   referencias a los demás registros.
4. Registro de progreso: la última instantánea confirmada y sus variables
   observables.
5. Registro de gasto: los totales acumulados y la última compuerta evaluada.

De esos registros se recuperan `round.number`, `variables`,
`integrity.last_snapshot_id`, `tokens.total`, `time.active_time_ms`,
`cost.estimated_usd` e `integrity.last_confirmed_at`.

### Bloque de declaración

Todo lo recuperado se declara con su fuente y su momento de observación: las
decisiones vigentes, el progreso confirmado, el gasto acumulado y la última ronda
confirmada.

```
Recuperación de contexto:
- Decisiones vigentes: {lista} (fuente: {ref}, observado: {ISO-8601})
- Progreso confirmado: ronda {N}; tareas {A}/{B}; criterios {C}/{D} (fuente: {ref}, observado: {ISO-8601})
- Gasto acumulado: tokens {T}; tiempo activo {A}; costo estimado {C} (fuente: {ref}, observado: {ISO-8601})
- Última ronda confirmada: {N} (fuente: {ref})
- Huecos no registrados: {lista o "ninguno"}
- Para retomar: {qué falta o "nada"}
```

La declaración dice además qué se conservó, qué falta y cómo seguir.

### Reglas de fallo

- Si lo material para continuar no se puede confirmar, la ejecución se pausa con
  motivo `progress_unavailable` o `record_unavailable`, conservando la última
  confirmación buena y declarando la condición exacta de reanudación.
- No se declara cero por falta de datos: lo ausente se declara ausente.
- No se sobrescribe un registro ilegible ni se fusionan registros contradictorios.
- Un dato periférico no confirmable no pausa: se continúa etiquetándolo
  `[No verificado]`.
- Si la resolución de la ejecución activa es ambigua, la respuesta es `no disponible`
  y la ejecución se pausa; no se elige por conveniencia.

## Herencia de evidencia y discrepancia

- La evidencia heredada conserva su fuente y su momento de observación.
- La evidencia ya confirmada no se re-verifica por rutina: la ronda siguiente solo
  verifica lo nuevo material que introduce.
- Una observación nueva solo se registra cuando aporta un dato material nuevo.
- Ante una discrepancia entre lo heredado y lo observado, se declara qué discrepa y
  en qué, y la ejecución se pausa antes de imponer un cambio de alcance.
- La discrepancia no se resuelve suponiendo cuál de las dos fuentes tiene razón.

## Avisos observables

Cada aviso declara:

- qué pasó,
- cuánto pesaba lo omitido,
- qué se omitió,
- a quién delegar lo omitido o cómo acotar para retomarlo.

Reglas:

- Nada omitido se presenta como completo.
- Si el aviso no se puede persistir o entregar, se informa qué persistencia falló y
  no se anuncia la entrega como lista.
- Si una herramienta impide comprobar algo, se informa la causa y el alcance no
  verificado; no se trata como incumplimiento del trabajo.

## Fallos y datos no verificables

| Situación | Respuesta | Lo que nunca se hace |
|---|---|---|
| Registro ausente | Se declara la fuente faltante y se sigue con la siguiente disponible. | Declarar confirmación sin fuente. |
| Registro ilegible | Se pausa con `record_unavailable` y se conserva la última confirmación buena. | Sobrescribir el registro. |
| Registro contradictorio | Se declara la contradicción y se pausa. | Fusionar registros contradictorios. |
| Medición no disponible | Se emite una traza con la causa y se entrega sin recortar. | Recortar en silencio. |
| Persistencia fallida | Se informa qué persistencia falló y no se anuncia la entrega como lista. | Anunciar entrega lista sin persistencia. |
| Herramienta que impide comprobar | Se informa la causa y el alcance no verificado. | Presentar lo no comprobado como verificado. |

## Garantías del contrato

1. Ninguna pérdida silenciosa: lo omitido, lo delegado y lo no recuperado queda
   marcado como tal.
2. Ningún recorte se presenta como respuesta completa.
3. Ningún preview del contenido omitido.
4. Ninguna cifra de umbral en los mensajes: solo el ámbito del presupuesto aplicado.
5. Solo el pack del momento se muestra; el manual completo no se repite.
6. La evidencia confirmada se hereda y no se re-verifica por rutina.
7. Toda recuperación declara fuente y momento de observación.
8. Ningún hueco material se rellena con suposición: se pausa y se declara.
9. Ningún dato periférico se presenta como verificado.
10. Sin reescritura del historial ni fuentes de estado alternativas.

## Matriz de aceptación

| ID | Criterio | Regla | Sección |
|---|---|---|---|
| AC-01 | Un pedido amplio sin ventana acotada produce un aviso previo con la forma de acotar. | El primer pedido amplio del turno se anuncia y no se ejecuta en esa vuelta. | Degradación por niveles |
| AC-02 | La entrega que excede el presupuesto por llamada se reduce y declara lo omitido. | Se nombra el tamaño real y a quién delegar. | Degradación por niveles |
| AC-03 | La entrega reducida no incluye preview del contenido omitido. | Nunca se anticipa el contenido. | Degradación por niveles |
| AC-04 | La suma del turno se omite con el mismo aviso aunque cada pieza quepa. | Se nombra el presupuesto acumulado del turno. | Degradación por niveles |
| AC-05 | Un tamaño no medible produce traza y entrega sin recortar. | No hay recorte silencioso. | Fallos y datos no verificables |
| AC-06 | El mensaje nombra el ámbito del presupuesto, nunca su cifra. | Los umbrales internos no se exponen. | Degradación por niveles |
| AC-07 | El momento activo muestra solo su pack. | El manual completo no se repite. | Inyección de reglas por momento |
| AC-08 | Al cambiar de momento se hereda lo ya resuelto sin re-verificarlo. | La evidencia verificada se hereda por referencia. | Inyección de reglas por momento |
| AC-09 | La recuperación declara decisiones, progreso, gasto y última ronda con fuente y momento de observación. | Todo lo recuperado es citable. | Recuperación verificable |
| AC-10 | Un hueco material pausa con motivo, estado conservado y condición de reanudación. | No se avanza suponiendo. | Recuperación verificable |
| AC-11 | Un dato periférico no confirmable se etiqueta `[No verificado]` y no pausa. | La ausencia de una fuente menor no detiene el trabajo. | Recuperación verificable |
| AC-12 | Una ejecución ambigua responde `no disponible` y pausa. | No se elige por conveniencia. | Recuperación verificable |
| AC-13 | Una discrepancia entre lo heredado y lo observado se declara y pausa antes de cambiar alcance. | No se resuelve suponiendo. | Herencia de evidencia y discrepancia |
| AC-14 | Un aviso siempre dice qué pasó, cuánto pesaba, qué se omitió y a quién delegar. | Nada omitido se presenta como completo. | Avisos observables |

## Ejemplos canónicos

| ID | Entrada | Resultado | Efecto |
|---|---|---|---|
| E-01 | Lectura amplia de un archivo grande sin ventana acotada. | Aviso de acotación con la forma de acotar; el pedido no se ejecuta en esa vuelta. | El operador acota y consume menos contexto. |
| E-02 | El mismo pedido amplio se repite en el mismo turno. | Se permite la ejecución y la entrega resultante se reduce. | El pedido se atiende sin entregar el contenido completo. |
| E-03 | Una lectura cuyo resultado excede el presupuesto por llamada. | Entrega reducida con el tamaño real, el ámbito del presupuesto y la delegación. | El operador sabe qué se omitió y a quién pedirlo. |
| E-04 | Varias entregas pequeñas que suman más que el presupuesto del turno. | La siguiente se omite con el mismo aviso y se nombra el presupuesto acumulado. | El turno no se satura y el aviso no cambia de forma. |
| E-05 | Una lectura devuelve un adjunto de imagen o documento. | Aviso de delegación con el tamaño medido del texto; el adjunto no se entrega. | El adjunto se pide a quien puede tratarlo. |
| E-06 | La salida de una herramienta no es texto y no se puede medir. | Traza con la causa y entrega sin recortar. | No hay recorte silencioso ni pérdida sin aviso. |
| E-07 | Arranca un momento nuevo con reglas extensas. | Se muestra solo el pack del momento. | El contexto no se llena con el manual completo. |
| E-08 | Cambia el momento con decisiones ya verificadas. | Se carga el pack nuevo y lo resuelto se hereda; no se re-verifica. | No se repiten comprobaciones ya resueltas. |
| E-09 | El hilo se resume por compactación y hay registros durables. | Bloque de recuperación con decisiones, progreso, gasto y última ronda, con fuente y momento de observación. | El hilo nuevo continúa desde lo confirmado y declara lo que falta. |
| E-10 | Un registro material es ilegible al reanudar. | Pausa con motivo, última confirmación conservada y condición de reanudación. | Nadie avanza sobre un hecho no verificado. |
