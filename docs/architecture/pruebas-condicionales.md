# Pruebas por huecos de verificación: presupuesto y herencia

Las pruebas automáticas se generan solo cuando falta verificación real.
Este documento describe su arquitectura; el contrato canónico vive en
`.flowtask/agents/tester.md`, `.flowtask/agents/runner.md` y
`.flowtask/agents/validator.md`.

## Propósito

Generar pruebas por riesgo producía volumen sin beneficio: el flujo casi siempre
concluía que hacían falta, escribía decenas de casos por entrega y duplicaba lo
que el plan ya declaraba como comprobación. El costo crecía y la detección de
defectos no.

La política por huecos cambia el disparador:

1. el plan declara cómo se verifica cada criterio de aceptación;
2. solo los criterios sin vía suficiente se convierten en huecos;
3. el Tester escribe como máximo una prueba por hueco y tres por entrega;
4. la validación hereda el reporte sin repetir lo comprobado.

## Hueco de verificación

Un **hueco de verificación** es un criterio de aceptación cuyo incumplimiento no
puede observarse con una prueba existente, un comando determinista ni la
comprobación manual que el plan ya declara.

El disparador de la generación es uno de estos:

| Situación | Resultado |
|-----------|-----------|
| El plan declara al menos un hueco con defecto y motivo. | El Tester genera para esos huecos dentro del presupuesto. |
| El pedido nombra un criterio del plan y un defecto no cubierto. | Se registra como hueco `explicit_request` dentro del presupuesto. |
| El pedido es genérico y el plan no declara huecos. | `needs_decision`: no se genera nada. |
| El pedido nombra un criterio ausente del plan. | `needs_decision`: el Tester no inventa criterios ni alcance. |
| Un gap no declara defecto ni motivo. | `needs_decision`: se pide la corrección del plan. |
| Un criterio no declara vía. | Se reporta `not_covered` con `missing_verification_path`; no se inventa una prueba. |
| Un gap ya tiene cobertura. | `no_gaps` con la referencia existente; no se duplica cobertura. |

Sin huecos declarados ni pedido válido, el flujo continúa a validación sin
generar pruebas y sin pedir confirmación.

## Verificación por criterio en el plan

Todo plan con criterios de comportamiento incluye la sección
`## Verificación por criterio` con una fila por criterio material:

| Criterio | Vía | Referencia | Defecto | Por qué la vía no lo detecta |
|----------|-----|------------|---------|------------------------------|
| Criterio material. | `existing_test`, `command`, `manual` o `gap`. | Archivo y caso, comando, o pasos manuales. | Incumplimiento que quedaría sin detectar. | Motivo por el que la vía no lo observa. |

Reglas del plan:

- Cada criterio material tiene su fila.
- `existing_test` cita archivo y caso; `command` cita comando y resultado
  esperado; `manual` cita pasos y observación esperada.
- `gap` exige defecto y `why_not_detected`.
- Un criterio sin vía se marca `gap` con defecto y motivo; no se rellena con una
  comprobación ficticia.
- El plan no escribe código de prueba: las tareas ejecutan pruebas existentes,
  comandos o comprobaciones manuales, pero no crean ni editan archivos de test.
- No se usan plantillas genéricas, no se afirma sobre prosa literal salvo que sea
  un formato consumido por otro componente y no se duplica cobertura.

La auditoría rechaza un plan sin la sección, un gap sin defecto o motivo, un gap
con cobertura existente, una tarea que crea o edita tests y una comprobación de
relleno o duplicada. Un plan sin tareas de prueba no es un blocker.

## Presupuesto

El presupuesto es fijo y no varía por entorno:

| Regla | Valor |
|-------|-------|
| Pruebas por hueco | 1 prueba por hueco. |
| Techo por entrega | 3 pruebas. |
| Valor por defecto | 0 pruebas si no hay huecos ni pedido válido. |

El techo no es cuota: no se completa con relleno. La selección respeta el orden
del plan. Lo que excede el techo se reporta como hueco no cubierto con motivo
`budget_limit` y no se escribe.

## Generación y reporte

Solo el Tester escribe código de prueba, y solo para huecos declarados. Cada
prueba declara en su encabezado:

| Campo | Contenido |
|-------|-----------|
| `gap_ref` | Hueco que cubre. |
| Criterio | Criterio de aceptación asociado. |
| Defecto | Incumplimiento que detecta. |
| `why_not_detected` | Por qué la vía del plan no lo detectaba. |
| Comportamiento observable | Resultado esperado ante una condición. |

Sin defecto nombrado no se escribe la prueba. Se comprueba comportamiento, no
estructura interna. No se usan plantillas genéricas, no se duplica cobertura, no
se afirma sobre prosa literal no consumida y no se agregan dependencias ni red.

El reporte se registra en `ca/CA-{ID}/artifact/tests-report` con `plan_ref`,
`execution_id`, `status`, `environment`, `report_detail`, `gaps_declared`,
`gaps_covered`, `gaps_not_covered`, `generated`, `coverage`, `commands`, `limits`
y `persistence`. No referencia un artifact de decisión porque no existe.

El estado del flujo se registra en `flow-state/CA-{ID}/tests` con tratamiento
ligero. Si la persistencia falla, el Tester informa el fallo operativo y no
anuncia la entrega como lista para validar.

| Elemento | Estados |
|----------|---------|
| Prueba | `passed`, `failed` o `unverified`. |
| Criterio | `covered`, `not_covered`, `failed` o `unverified`. |

`failed` es un incumplimiento funcional: el comportamiento esperado no se
cumple. `unverified` es una limitación de herramienta o de entorno: no se pudo
comprobar.

El detalle del mensaje al operador sigue el `policy.profile` vigente: `detailed`
en desarrollo y `concise` en producción.

## Herencia en la validación

La validación recibe `plan_ref`, `tests_report_ref` y `tests_gaps`, y hereda el
reporte con su fuente y su momento de observación sin re-ejecutar lo comprobado.

| Situación | Resultado |
|-----------|-----------|
| Sin gaps y reporte `NONE` | No se espera reporte; la validación sigue su curso normal. |
| Con gaps y reporte ausente, ilegible o incompleto | Fallo operativo con causa `tests_report_missing`; el alcance queda `unverified` y no se aprueba. |
| Test `failed` | Rechazo funcional, con el caso, el comando, el esperado y el obtenido. |
| Test `passed` | Evidencia verificada, heredada sin re-ejecutar. |
| Criterio no cubierto o no verificable | Verificación manual o declaración como no verificado con su causa. |

Un reporte incompleto es el que no declara todos los gaps del plan. Una
herramienta ausente no se presenta como incumplimiento del trabajo: se conserva
lo alcanzado y se informa la causa y el alcance no verificado.

## Sin interruptores

No existe un interruptor para activar o desactivar la generación por entrega: el
disparador es el hueco declarado y el presupuesto es fijo.

| No hay | Por qué |
|--------|---------|
| Interruptor por entrega | El disparador es el hueco, no una configuración por flujo. |
| Puntaje o umbral de riesgo | La decisión es binaria: hay hueco o no lo hay. |
| Pregunta al desarrollador | Generar o no generar no se consulta: el hueco y el pedido válido lo determinan. |
| Agente o skill nuevos | El contrato vive en los agentes existentes. |
| Artifact de decisión | El plan declara los huecos; el Tester solo genera y reporta. |

## Verificación

Desde la raíz del repositorio:

```
node --test '.flowtask/bin/test/tester-conditional-gate.test.js'
```

La prueba afirma el contrato del Tester, del Runner y del Validator, las claves
de memoria y la higiene de coordinación, y falla ante una copia que reintroduce
una decisión previa, pierde el presupuesto 1/3/0, omite el defecto o el motivo
del hueco, acepta relleno o cobertura duplicada, pierde el reporte o confunde el
fallo funcional con el de herramienta.

## Referencias relacionadas

- [INDEX.md](./INDEX.md) — índice de la arquitectura vigente.
- [validacion.md](./validacion.md) — validación en caliente, evidencia ejecutada y veredicto único.
- [../core-flowtask.md](../core-flowtask.md) — flujo principal de una ejecución.
- `.flowtask/agents/tester.md` — contrato del agente que genera pruebas por huecos.
- `.flowtask/agents/runner.md` — despacho de la generación por huecos.
- `.flowtask/agents/validator.md` — herencia del reporte de pruebas.
