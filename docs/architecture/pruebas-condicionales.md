# Pruebas condicionales: decidir por riesgo y heredar la evidencia

Las pruebas automáticas se generan solo cuando el riesgo del cambio lo exige.
Este documento describe su arquitectura; el contrato canónico vive en
`.flowtask/agents/tester.md`, `.flowtask/agents/runner.md` y
`.flowtask/agents/validator.md`.

## Propósito

La generación de pruebas existe como capacidad, pero el flujo no decidía cuándo
usarla: o se generaban siempre y cada entrega pequeña pagaba el costo completo,
o no se generaban nunca y un cambio de lógica de negocio llegaba a validación
sin red de contención.

La decisión condicional resuelve esa tensión:

1. decide automáticamente, antes de construir, si el alcance requiere pruebas;
2. genera pruebas acotadas sobre el comportamiento ya implementado cuando la
   decisión lo exige;
3. deja la decisión y el reporte como registros reutilizables;
4. hace que la validación posterior herede esa evidencia sin repetir lo
   comprobado.

## Momento de la decisión

La decisión se toma cuando el plan es final: después del Gate de Ejecución y
antes de abrir el worktree. En ese punto se leen el requisito, el plan, la
auditoría del plan, las pruebas ya existentes en el repositorio y el input
literal de quien encarga el trabajo.

La generación ocurre en otro momento: después de la construcción, sobre el
comportamiento implementado.

| Momento | Qué ocurre | Qué escribe |
|---------|------------|-------------|
| Antes del worktree | La decisión condicional. | El artifact de decisión. |
| Después de la construcción | La generación acotada. | El artifact de reporte. |
| Después de la generación | La validación hereda el reporte. | El artifact de validación. |

## Condiciones

La entrada a generar pruebas se produce cuando se cumple al menos una de estas
cuatro condiciones:

| Condición | Señal observable |
|-----------|-----------------|
| `regression_risk` | El cambio toca comportamiento ya entregado que otras partes usan. |
| `business_logic` | El cambio decide un resultado de negocio: cálculo, permiso, estado o regla de aceptación. |
| `ambiguous_criterion` | El requisito o su criterio admite más de una lectura y construir lo incorrecto es más caro que comprobarlo con una prueba. |
| `explicit_test_request` | Quien encarga el trabajo pide pruebas al solicitarlo. |

Cuando ninguna condición se cumple, el flujo continúa hacia la validación sin
generar pruebas y sin detenerse a pedir confirmación por no haberlas generado.

## Decisión conservadora

No hay puntaje, umbral ni tabla de pesos: la decisión es booleana y su motivo
queda registrado.

| Situación | Resultado |
|-----------|-----------|
| Alguna condición verdadera | `tests_required: true`, con la condición activadora registrada. |
| Ninguna condición verdadera | `tests_required: false`, con evidencia negativa explícita de las cuatro. |
| Riesgo no evaluable o evidencia insuficiente | `tests_required: true` con la condición `risk_not_discardable`. |

La ausencia de evidencia no es una dispensa: nunca se avanza suponiendo que no
hay riesgo. La duda tampoco se convierte en `tests_required: false`.

## Artefacto de decisión

La decisión se registra en `ca/CA-{ID}/artifact/test-gate` y su estado en
`flow-state/CA-{ID}/test-gate`.

| Campo | Contenido |
|-------|-----------|
| `decision_id` | Identificador de la ejecución. |
| `plan_ref` | Plan final que originó la decisión. |
| `audit_ref` | Auditoría del plan, cuando existe. |
| `tests_required` | `true` o `false`. |
| `conditions` | Condiciones activadoras; `risk_not_discardable` cuando la evidencia no alcanza. |
| `rationale` | Motivo verificable de la decisión. |
| `negative_evidence` | Evidencia negativa de las cuatro condiciones. |
| `test_scope` | Alcance que las pruebas deben cubrir. |
| `source_refs` | Referencias que sostienen la decisión. |
| `uncovered_risks` | Riesgos que ninguna prueba cubre. |
| `persistence` | `confirmed` o `failed`. |

La decisión se reutiliza: si el registro ya existe para la misma ejecución y el
mismo plan, se lee y no se vuelve a evaluar. Un cambio material de alcance
pausa y exige una decisión nueva. Si la persistencia falla, el flujo informa
qué falló y no anuncia la entrega como lista para construir.

## Generación y reporte

La generación produce pruebas que comprueban el comportamiento implementado,
sin modificar el comportamiento entregado.

- Solo escribe archivos de test y no toca producción.
- Usa el framework y las librerías ya instaladas: no agrega dependencias ni usa
  red.
- Cubre el recorrido principal, los errores principales y los bordes
  identificados en el alcance de la decisión.
- Si una parte del alcance no puede cubrirse, esa parte queda declarada como
  no cubierta con su motivo: nunca se presenta como cubierta.

El reporte se registra en `ca/CA-{ID}/artifact/tests-report` con el estado
`generated`, `partial` o `blocked`, las pruebas generadas, la cobertura, lo no
cubierto, los comandos ejecutados y las limitaciones observadas.

| Elemento | Estados |
|----------|---------|
| Prueba | `passed`, `failed` o `unverified`. |
| Criterio | `covered`, `not_covered`, `failed` o `unverified`. |

`failed` es un incumplimiento funcional: el comportamiento esperado no se
cumple. `unverified` es una limitación de herramienta o de entorno: no se pudo
comprobar.

El detalle del mensaje al operador sigue el `policy.profile` vigente:
`detailed` en desarrollo y `concise` en producción. La verificación para
retomar es la misma en ambos perfiles; solo cambia el detalle.

## Herencia en la validación

La validación posterior hereda el reporte de pruebas con su fuente y su
momento de observación, y no repite lo ya comprobado.

| Situación | Resultado |
|-----------|-----------|
| Decisión ausente o ilegible | Fallo operativo con causa `test_decision_missing`. |
| Pruebas requeridas y reporte ausente o ilegible | Fallo operativo con causa `tests_report_missing`; el alcance queda no verificado y no se aprueba. |
| Pruebas no requeridas | No se espera reporte; la validación sigue su curso normal. |
| Test `failed` | Rechazo funcional, con el caso, el comando, el esperado y el obtenido. |
| Test `passed` | Evidencia verificada, heredada sin re-ejecutar. |
| Criterio no cubierto o no verificable | Verificación manual o declaración como no verificado con su causa. |

Una herramienta ausente no se presenta como incumplimiento del trabajo: se
conserva lo alcanzado y se informa la causa y el alcance no verificado.

## Sin interruptores

No existe un interruptor para activar o desactivar la generación condicional
por entrega: la decisión rige por la política vigente y sus cuatro
condiciones, no por configuración por flujo.

| No hay | Por qué |
|--------|---------|
| Interruptor por entrega | La decisión es automática y auditable. |
| Puntaje o umbral de riesgo | Cuatro condiciones observables, sin pesos. |
| Pregunta al desarrollador | Generar o no generar pruebas no se consulta: la decisión queda registrada. |
| Agente o skill nuevos | El contrato vive en los agentes existentes. |

## Verificación

Desde la raíz del repositorio:

```
node --test '.flowtask/bin/test/tester-conditional-gate.test.js'
```

La prueba afirma el contrato del Tester, del Runner y del Validator, las claves
de memoria y la higiene de coordinación, y falla ante una copia que pierde la
decisión, degrada el riesgo no descartable, devuelve la pregunta al
desarrollador, agrega un interruptor, pierde la respuesta de pruebas no
requeridas, confunde el fallo funcional con el de herramienta, borra el
artifact de decisión o registra un agente nuevo.

## Referencias relacionadas

- [INDEX.md](./INDEX.md) — índice de la arquitectura vigente.
- [validacion.md](./validacion.md) — validación en caliente, evidencia ejecutada y veredicto único.
- [../core-flowtask.md](../core-flowtask.md) — flujo principal de una ejecución.
- `.flowtask/agents/tester.md` — contrato del agente que decide y genera.
- `.flowtask/agents/runner.md` — despacho de la decisión y de la generación.
- `.flowtask/agents/validator.md` — herencia del reporte de pruebas.
