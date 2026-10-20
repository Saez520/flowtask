# Verificación material y evidencia citable

## Propósito

Toda decisión que dependa de un dato material deja constancia de dónde salió ese
dato y de en qué estado se confirmó. Un dato material no confirmado nunca se
presenta como hecho: se convierte en decisión pendiente o en pausa. Un dato
periférico no confirmado puede continuar declarado como no verificado.

La fuente normativa del protocolo es la skill `zero-assumptions`; los contratos
de rol que lo aplican son los agentes de `.flowtask/agents/`.

## Orden de verificación

El orden de consulta es fijo:

1. **Memoria del proyecto** — requisitos, decisiones y convenciones ya registradas.
2. **Documentación, código y estado del repositorio** — lo que el proyecto declara
   y lo que el repositorio muestra. El grafo de conocimiento y la lectura directa
   instrumentan este paso.
3. **La persona** — la autoridad que decide.

El orden solo se altera con un motivo declarado. Cuando la memoria del proyecto no
está disponible, se declara la fuente ausente y se continúa con la siguiente: la
ausencia de fuente no confirma nada, no habilita el dato.

## Registro de evidencia

El registro vive dentro del artifact que contiene la decisión. No hay registro
global, archivo paralelo ni espacio de nombres propio.

| Campo | Contenido |
|-------|-----------|
| `schema` | `verification-record/v1`. |
| `id` | Identificador único del registro dentro del artifact. |
| `datum` | El dato verificado, con contenido no vacío. |
| `materiality` | `material` o `peripheral`. |
| `source_kind` | `memory`, `document_or_code`, `repository_state` o `person`. |
| `source_ref` | Referencia concreta y resoluble de la fuente. |
| `status` | `verified`, `unverified` o `discrepant`. |
| `observed_at` | Marca de tiempo ISO-8601 de la observación. |
| `order_exception` | Motivo declarado de alteración del orden, o vacío. |
| `missing_source` | Fuente ausente, o vacío. |
| `note` | Nota de la observación, o vacío. |

Reglas de estado:

- `verified` exige una fuente resoluble.
- `unverified` exige la causa de la ausencia y solo es admisible para un dato
  periférico.
- `discrepant` exige las dos fuentes en conflicto y en qué discrepan.

No hay puntaje de confianza: el estado y la fuente bastan.

## Incertidumbre y discrepancia

Un dato material no confirmado no se presenta como hecho: pasa a decisión
pendiente o a pausa. Un dato periférico no confirmado continúa como no
verificado. Cuando dos fuentes se contradicen, la contradicción se informa con
ambas fuentes y no se resuelve por suposición.

## Alcance por rol

| Rol | Alcance |
|-----|---------|
| Redacta, planifica y explora | Verifica el dato material en el orden vigente y registra la evidencia. |
| Construye y valida | Hereda la evidencia verificada y verifica solo el dato nuevo material. |
| Orquesta | Verifica el routing, el gate y el diagnóstico. |

## Herencia de evidencia

La evidencia verificada se hereda con su fuente y su momento de observación: no
se re-verifica por rutina. Un estado mutable se re-observa solo cuando la
decisión depende de su valor actual, y esa re-observación es un registro nuevo,
no una repetición.

Una contradicción con la evidencia heredada se registra como discrepante, con
ambas fuentes, y pausa antes de imponer un cambio de alcance.

## Pausa y reanudación

Cuando un dato material no se puede confirmar, la ejecución se pausa con el
motivo vigente: falta de autoridad para decidir, fuente no disponible o ilegible,
o ausencia de hipótesis y de progreso verificable. La pausa se informa con el
mensaje de tres líneas:

~~~
⏸ Pausa por excepción: {motivo}
Estado conservado: {trabajo; artifacts; cambios; última ronda confirmada}
Para reanudar: {condición exacta}
~~~

El detalle se ajusta al perfil de política vigente: el perfil de desarrollo
detalla la fuente y el momento de observación; el perfil de producción mantiene
fuente y estado concisos. La verificación mínima para reanudar es la misma en
ambos perfiles.

Al reanudar se reutiliza la evidencia material verificada y no se repiten las
comprobaciones ya realizadas. Si un dato material sigue sin confirmarse, la
pausa se mantiene.

## Límites

- No hay bloqueo automático: el cumplimiento se verifica por auditoría.
- No hay puntaje de confianza, porcentaje ni motor general de verificación.
- No hay interruptores por rol ni configuración estática nueva.
- No hay espacios de nombres nuevos: el registro vive en el artifact contenedor.
- No hay motivo de pausa nuevo: se usan los motivos vigentes.

## Verificación

~~~
node --test .flowtask/bin/test/zero-assumptions-enforcement.test.js
~~~

La prueba contractual verifica el orden de verificación, el registro de
evidencia, la materialidad conservadora, la pausa por dato material no
confirmado, el alcance por rol, la herencia de evidencia y la ausencia de un
enum de motivo de pausa nuevo.
