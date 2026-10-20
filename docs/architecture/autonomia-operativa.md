# Autonomía operativa por políticas

## Propósito

La ejecución avanza por política y no por espera rutinaria. El control técnico se verifica
primero y, cuando pasa, la construcción arranca sin pedir una segunda confirmación.

La autonomía **no elimina controles**. El gate técnico, la auditoría del plan y la validación
de la implementación siguen siendo obligatorios. Lo que se elimina es la confirmación
rutinaria posterior al gate: la orden original del desarrollador que autoriza el trabajo y el
resultado `PASS` del gate son la señal de inicio.

## Transición automática tras el gate

- **Gate `PASS`** habilita la construcción. El runner informa el resultado en una línea,
  registra la evidencia del gate como decisión de política y continúa con el worktree y el
  Constructor. No hay espera intermedia.
- **Gate `FAIL`** no construye nada. El runner informa el motivo en una sola línea, no crea
  worktree, no abre ejecución y no invoca al Constructor ni al Validator. El plan conserva su
  estado de gate como evidencia.

En un hotfix, la señal de inicio es la aceptación explícita del diagnóstico acordado. No se
exige una segunda palabra, y las acciones de riesgo conservan su consentimiento explícito.

## Consentimientos que se conservan

Estos consentimientos nunca se derivan de la política vigente ni de un indicador de invocación:

- Preservar los cambios sin consolidar del destino (`--preserve-dirty`).
- Descartar trabajo no integrado (`cleanup --discard`).
- Publicar o mover trabajo a remoto.
- Eliminar trabajo ajeno o pendiente-manual.
- Modificar archivos protegidos.

Un cierre con destino sucio se escala al desarrollador sin limpiar el destino: el rechazo es
seguro y deja todo intacto.

## Pausa por excepción

La ejecución se detiene solo por excepción. Nunca se pausa por rutina: si el gate permite y no
falta un consentimiento, se avanza.

| Situación operativa | Motivo de pausa |
|--------------------|-----------------|
| Falta de autoridad, cambio de alcance o requisitos, o consentimiento de riesgo ausente. | `authority_block` |
| Límite expreso del trabajo alcanzado con efecto de pausa. | `explicit_limit` |
| Ausencia de hipótesis o de progreso verificable. | `no_verifiable_progress` |
| Invariante violado. | `invariant_violation` |
| Fallo externo no verificable o registro ilegible. | `progress_unavailable` |

La pausa se informa con un mensaje canónico de tres líneas:

~~~
⏸ Pausa por excepción: {motivo}
Estado conservado: {worktree/branch; artifacts; última ronda confirmada; checkpoint si aplica}
Para reanudar: {condición exacta}
~~~

El detalle se ajusta al perfil vigente de la ejecución: el perfil de desarrollo agrega
referencias de evidencia y el último comando verificado; el perfil de producción mantiene las
tres líneas concisas. La verificación técnica para reanudar es la misma en ambos perfiles.

Un fallo operativo no es un rechazo funcional: no es una ronda, no incrementa contadores y no
pide correcciones al Constructor. Un fallo irrecuperable declarado con evidencia y diagnóstico
cierra por causa externa conservando trabajo, historial y diagnóstico; un fallo externo no
verificable no se declara irrecuperable y produce una pausa.

## Reanudación

Reanudar exige, en conjunto:

1. Una señal explícita de reanudación.
2. La misma ejecución: la identidad no cambia.
3. La causa resuelta, conforme al motivo de la pausa.
4. La lectura del registro de ejecución y del registro de progreso.

La reanudación reutiliza la evidencia de la última ronda y de las decisiones de política: no
repite comprobaciones ya verificadas ni reinicia contadores. Las acciones no idempotentes cuyo
efecto anterior sea incierto no se repiten: se detienen y se escalan.

## Registro de decisiones automáticas

El registro de ejecución `AgentRunRecord` incluye un bloque `autonomy`:

| Campo | Valor |
|-------|-------|
| `autonomy.policy` | `gate-then-auto` — el gate técnico se verifica primero y, cuando pasa, el avance es automático. |
| `autonomy.decisions[]` | Lista append-only de decisiones de política. |

Cada gate `PASS`, cada pausa por excepción y cada reanudación agregan **exactamente una**
entrada. Cada entrada describe una decisión de política:

| Campo | Contenido |
|-------|-----------|
| `id` | Identidad monotónica de la decisión. |
| `kind` | `gate`, `pause` o `resume`. |
| `policy` | `execution_gate`, `exception_pause` o `resume_gate`. |
| `outcome` | `pass`, `fail`, `pause`, `resume` o `reject`. |
| `verified` | `true` solo si la evidencia se leyó y confirmó. |
| `reason` | `null` o el motivo de pausa vigente. |
| `command` | Comando ejecutado cuando aplica. |
| `result` | Resultado resumido y verificable. |
| `evidence_refs` | Referencias citable de la decisión. |
| `at` | Momento de la evaluación. |

Una decisión con `verified: false` nunca autoriza un permiso de riesgo ni un cierre: habilita
como máximo una pausa.

## Modo automático

El indicador de invocación `--auto` **no agrega permisos**: declara que no hay espera
rutinaria. No altera el gate ni los consentimientos, no habilita la preservación ni el
descarte de cambios, no autoriza publicar, no habilita el borrado de trabajo ajeno y no
habilita la modificación de archivos protegidos.

## Límites

- No hay configuración estática nueva ni interruptores por flujo: la autonomía rige por la
  política vigente y por el consentimiento aplicable.
- No hay espacios de persistencia nuevos: las decisiones de política viven en el registro de
  ejecución.
- No hay agentes ni contratos nuevos: se extienden las superficies vigentes de runner,
  constructor, control del loop y terminación.
- El contrato de validación en caliente conserva su esquema y su veredicto: la
  verificación material se apoya en su distinción entre verificado y no verificado
  y en la herencia de evidencia.

## Verificación

~~~
node --test .flowtask/bin/test/hitl-policy-gates.test.js
~~~

La prueba contractual verifica la política `gate-then-auto`, la señal de inicio sin segunda
confirmación, el registro de decisiones de política, los motivos de pausa, el mensaje canónico
de tres líneas, los consentimientos preservados y la coherencia de la documentación funcional.

La fuente normativa del contrato es la skill `agent-loop-run` y, para la terminación, la skill
`agent-loop-termination`.
