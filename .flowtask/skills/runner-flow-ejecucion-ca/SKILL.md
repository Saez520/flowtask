---
name: runner-flow-ejecucion-ca
description: >-
  Flujo del runner — apertura, planificación, Gate, worktree, construcción, pruebas
  por huecos, validación, purga y cierre. Se carga solo ante el disparador
  `evento:ca`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Flujo: ejecución de un CA

### Paso 1 — Verificar o crear CA

```
mem_search(query: "CA-{ID}", type: "decision", scope: "project")
```

**Si existe artifact:** Determina primero si el input solicita una modificación;
si no es una revisión, continúa al Paso 2.

### Rama prioritaria — revisión de un CA formalizado

Si el input solicita modificar o revisar un CA que ya tiene artifact, no se
salta directamente a la planificación. Recupera
`flow-state/CA-{ID}/instances` y exige que existan ambos valores en
`agents["ca-writer"]`:

- `instance_name`, que identifica la misma instancia del CA-Writer;
- `task_id`, que identifica el mismo hilo de conversación.

Con ambos valores disponibles, invoca a CA-Writer mediante el formato de
reanudación vigente, pasando a `subagent()` el `task_id` exacto como `sessionID` y la misma
`instance_name`. La revisión actualiza el artifacto canónico existente; no
crea otro CA ni sustituye el mapa de instancias.

Si falta el mapa, falta cualquiera de los dos valores o `subagent()` rechaza el
`task_id`, informa la pérdida de continuidad y detiene la revisión. Esta rama
no ejecuta Escenario A, no abre un hilo nuevo, no aplica Self-Healing de
sustitución y no comunica una reanudación exitosa. El `task_id` registrado no
se fabrica, limpia ni reemplaza como parte de esta revisión.

Solo cuando la respuesta de CA-Writer indique `ca_created` o `ca_updated`,
`ca_status: complete`, `blockers: NONE` y `persistencia: confirmed` se continúa
al Paso 2. Una respuesta `draft`, `blocked`, con persistencia incompleta o con
decisiones pendientes detiene el avance y se comunica sin planificar. En modo
`--auto` esta rama tampoco agrega una espera de formalización: la entrega
completa persistida habilita la transición, y los controles posteriores del
flujo permanecen vigentes.

La creación normal conserva el comportamiento existente: si no se trata de
una revisión de un CA formalizado y no existe artifact, invoca a CA-Writer con
el prompt del usuario.

**Si no existe:** Invoca ca-writer con el prompt del usuario — el ca-writer conduce la conversación:

Invoca ca-writer usando el formato canónico: ejecutar el Handshake Protocol
(getOrCreateInstance) + Context Injection; Escenario A/B según `task_id` y
Topic Validation. Prompt: el texto original del usuario.

### Paso 1.5 — Derivaciones del CA-Writer

La respuesta del CA-Writer puede traer `derivations`: pedidos de dato que el
agente no resuelve con sus permisos, porque son una duda técnica material que
bloquea una decisión de negocio, una verificación externa o la observación del
estado del repositorio. El runner no delega por su cuenta: responde al pedido
ya formulado.

Cuando `derivations` viene con contenido:

1. Invoca al Inspector usando el formato canónico y su contrato de entrada: la
   pregunta, el alcance, las referencias citables ya reunidas (`evidence_refs`)
   y los huecos declarados (`gaps`). Cada item trae su `kind`:
   `technical | external_verification | repository_state`.
2. Devuelve el resultado al CA-Writer con el mismo `task_id` y la misma
   `instance_name` registrados en el mapa de instancias, para que la respuesta
   se incorpore al mismo requisito.
3. No avances a planificación mientras la respuesta traiga `derivations` con
   contenido o `ca_status` distinto de `complete`. El paso a planificación exige
   `derivations: []` y `ca_status: complete`.
4. El dato que vuelve sin fuente citable queda con estado `unverified` y el
   requisito se mantiene en `draft`.

Si `derivations` viene vacío, esta rama no aplica y el flujo continúa en el Paso 2.

***

### Paso 2 — Planificación

Invoca planner usando el formato canónico: ejecutar el Handshake Protocol
(getOrCreateInstance) + Context Injection; Escenario A/B según `task_id` y
Topic Validation. Prompt: flow state del CA desde Engram.

En la reanudación, el prompt incorpora los resultados de derivación ya
devueltos o la referencia al CA actualizado. El prompt deriva al checkpoint del
Planner: no re-narra su estado.

***

### Paso 2.5 — Derivaciones y huecos del Planner

La respuesta del Planner puede traer `derivations` (pedidos de dato que el
Planner no resuelve con sus permisos), `business_gaps` (huecos de negocio),
`pending_decisions`, `blockers`, `pause_reason` y `persistencia`. El runner no
delega por su cuenta y no sustituye el juicio del Planner sobre el tipo de
hueco: responde al pedido ya formulado.

Lee `state`, `derivations`, `business_gaps`, `pending_decisions`, `blockers`,
`pause_reason`, `persistencia` y `next`, y aplica esta precedencia:

1. **Persistencia fallida**: si `persistencia: failed`, detente e informa
   `persistencia_fallida` (`artifact | checkpoint`). No invoqués el Gate.
2. **Pausa**: si `pause_reason` es distinto de `NONE`, emite el mensaje
   canónico de tres líneas y no invoqués el Gate:

   ```
   ⏸ Pausa por excepción: {motivo}
   Estado conservado: {trabajo; artifacts; cambios; última ronda confirmada}
   Para reanudar: {condición exacta}
   ```

3. **Derivaciones**: si `derivations` viene con contenido, por cada item
   invoca al Inspector con `datum_id`, `kind`, `question`, `scope`,
   `evidence_refs` y `gaps`, y devuelve el resultado al Planner con el mismo
   `task_id` y la misma `instance_name`, conservando el `datum_id`, la fuente,
   el estado y la nota. El Runner no completa el dato ni lo presenta como
   hecho: el dato que vuelve sin fuente citable se entrega como `unverified` y
   el Planner lo convierte en decisión pendiente o en bloqueo.
   No avances al Gate, ni al Plan-Auditor, ni al worktree, ni al Constructor
   mientras queden derivaciones. **No avanzar al Gate** con derivaciones
   pendientes.
4. **Huecos de negocio**: si `business_gaps`, `pending_decisions` o `blockers`
   vienen con contenido y `derivations: []`, invoca al CA-Writer con el mismo
   hilo, el `kind`, la descripción, las `evidence_refs` y el fundamento de cada
   hueco. Si el CA-Writer emite `derivations`, resolvelas por el Paso 1.5.
   Reinvoca al Planner solo cuando la respuesta del CA-Writer indique
   `ca_updated` o `ca_created`, con `ca_status: complete`, `derivations: []` y
   `persistencia: confirmed`. Si la respuesta queda en `draft` o en
   `waiting_for_user`, detente sin planificar.
5. **Plan completo**: si `state: plan_generated`, `derivations: []`,
   `business_gaps: []`, `pending_decisions: []`, `blockers: NONE` y
   `persistencia: confirmed`, continuá al Paso 3.

**Una ronda por dato**: el Runner no reenvía un `datum_id` ya respondido. Si
el Planner repite un `datum_id` que ya volvió, se declara el bloqueo y se
conserva el estado, sin invocar al Inspector otra vez.

En la composición del prompt, no reenvíes un resultado de derivación ya
devuelto para el mismo `datum_id`.

***

### Paso 3 — Gate de Ejecución

Invoca el Gate definido en la sección `## Gate de Ejecución` sobre `ca/CA-{ID}/artifact/plan`.

- Si el Planner respondió `state: blocked` o `next: waiting_for_derivation`, no se invoca el Gate: la rama del Paso 2.5 sigue vigente.
- Si FAIL: imprime `⛔ Gate rechazado: {razón}` y termina el flujo (sin worktree, sin Constructor, sin Validator). NO continúa aunque haya confirmación humana o `--auto`.
- Si PASS: registra la evidencia del Gate en `flow-state/{execution_id}/run` (`autonomy.decisions`) y continúa directamente al Paso 4. La orden original del desarrollador y el resultado PASS del Gate son la señal de inicio: no hay sub-paso de confirmación humana.

***

### Paso 4 — Constructor

El orden de inicio es: `AgentRunRecord` → worktree → Constructor.

Antes de despachar al Constructor, abre la ejecución con el `AgentRunRecord` que incluye la
evidencia del Gate en `autonomy.decisions` y confírmalo por lectura. El worktree y la
construcción son la ronda 1. No hay una decisión de pruebas antes del worktree: la
generación por huecos ocurre después de la construcción, en el Paso 4.5.

### Política de worktrees — consumo directo del gestor por CA

El gestor standalone es la autoridad única del lifecycle. El Runner consume las
siete herramientas del servidor MCP `worktree_manager`; no ejecuta Git ni mantiene
journals, locks, backups o lógica de recuperación propia.

1. **Selección antes de mutación:** determina `repo_root` como ruta absoluta
   existente del repositorio objetivo (nunca lo sustituyas por `cwd`), detecta
   la base local en orden `development → main → trunk → main` salvo que el
   usuario indique una base explícita, y resuelve un `work_id` genérico; nunca
   lo conviertas en un CA ID. El gestor valida `repo`, `base` y `work_id`.
2. **Vía primaria y alternativa:** el servidor MCP directo es la vía primaria.
   Si no está registrado o no responde, el Runner informa la indisponibilidad
   con su causa y solo entonces puede usar `${FLOWTASK_SCRIPTS}/worktree.sh`
   como alternativa declarada. Nunca hace fallback automático después de una
   solicitud entregada: un rechazo, un error de contrato, un lock ocupado, un
   timeout o una respuesta perdida se reportan como resultado incierto y el
   siguiente paso es reconciliar.
3. **Mutaciones en dos fases:** `create`, `complete`, `cleanup`, `prune` y
   `recover` se planean con `dry_run: true`; el Runner lee `data.plan_hash` y
   `data.transaction_id` y ejecuta con los mismos campos más `plan_hash` y,
   cuando corresponde, `transaction_id`. `list` y `status` usan una sola
   llamada. `plan_mismatch` se replanifica; `uncertain` se reconcilia antes de
   reintentar.
4. **Campos por herramienta:**
   - `worktree_create`: `repo`, `work_id`, `base`, `dry_run`, `parent_repo`,
     `submodule_path`, `confirm`, `plan_hash`, `init_submodules`, `prepare`,
     `verify`.
   - `worktree_complete`: `repo`, `work_id`, `base`, `dry_run`,
     `authorization`, `confirm`, `plan_hash`, `transaction_id`,
     `preserve_dirty`, `target_direct`, `parent_repo`, `commit_title`,
     `commit_body`, `merge_strategy`.
   - `worktree_cleanup`: `repo`, `work_id`, `base`, `dry_run`, `authorization`,
     `confirm`, `plan_hash`, `discard`, `discard_consent`.
   - `worktree_recover`: `repo`, `transaction_id`, `dry_run`, `authorization`,
     `confirm`, `target_direct`, `parent_repo`.
   - `worktree_list`: `repo`.
   - `worktree_prune`: `repo`, `dry_run`, `authorization`, `confirm`,
     `plan_hash`.
   - `worktree_status`: `repo`, `work_id`.
5. **Consentimiento:** `complete`, `cleanup`, `prune` y `recover` requieren
   `authorization: "I_AUTHORIZE_THIS_CALL"` y `confirm: true`; `discard`
   requiere `discard_consent: true`. `init_submodules`, `prepare` y `verify` se
   habilitan únicamente por intención explícita; `--auto` no agrega permisos ni sustituye
   consentimientos.
6. **Asociación durable en Engram:** antes de la primera llamada de `create`,
   guardá `worktree/association/{work_id}` con `state: pending`; tras el éxito,
   reemplazalo por `state: confirmed` con `{ repo_root, work_id, path, branch,
   base_branch, init_submodules, init_submodules_result, transport: "mcp" }`.
   Si Engram falla antes, no llames al gestor; si falla después de un efecto
   confirmado, conservá los recursos y bloqueá dispatch y cierre hasta
   reconciliar. Reanudá solo con identidad exacta; una discrepancia bloquea y
   conserva los recursos. No uses memoria local ni limpiezas para simular
   atomicidad.
7. **Cierre:** `complete` se serializa siempre por base, aunque los trabajos
   sean independientes. Antes de completar, el worktree debe estar limpio y no
   se crea un commit de cierre: los commits atómicos los aporta el Constructor.
   Pasá `merge_strategy` tal como lo propuso el Constructor, sin reevaluarlo.
   Un conflicto no limpia el worktree; un destino sucio se escala al
   desarrollador. `preserveDirty` se lee de `.flowtask/config/worktree.json` y
   se pasa como `preserve_dirty: true`; el archivo nunca se escribe.
8. **Recuperación:** usá `worktree_recover` con `transaction_id` cuando exista;
   `${FLOWTASK_SCRIPTS}/worktree.sh recover [<tx-id>]` es la alternativa
   declarada.
9. **Retiro:** si una sesión o el operador nombra `flowtask_worktree_consume`,
   respondé que esa vía ya no existe y nombrales las siete herramientas
   directas; no intentes invocarla.

Con el worktree confirmado, invoca constructor usando el formato canónico y aplica continuidad automática
acotada ante fallo/interrupción recuperable. Relevo o recuperación tras rechazo
inicia hilo nuevo con restauración explícita.
Prompt: flow state del plan desde Engram y contexto actual del CA.

***

### Paso 4.5 — Generación de pruebas por huecos

La generación ocurre después de la construcción y antes de la validación. No se pide
confirmación para avanzar y no existe una decisión previa que re-evaluar.

1. Leé la sección `## Verificación por criterio` del plan y reuní los huecos declarados
   (`Vía: gap`) con su criterio, defecto y `why_not_detected`.
2. Considerá el input literal: un pedido que nombra un criterio del plan y un defecto no
   cubierto se registra como hueco `explicit_request`; un pedido genérico no bloquea si hay
   huecos declarados; un pedido genérico sin huecos devuelve `needs_decision`.
3. Si no hay huecos declarados ni pedido válido, imprimí
   `✔ Sin huecos declarados: no se generan pruebas` y continuá al Paso 5 con
   `tests_report_ref: NONE` y `tests_gaps: NONE`.
4. Si hay huecos o pedido válido, invocá `flowtask-tester` con `execution_id`,
   `artifact_namespace`, `plan_ref`, `gap_refs` (criterio, defecto y `why_not_detected`),
   el worktree, el alcance, el `profile` con su `report_detail`, el input literal y el
   reporte previo. Hilo fresco, tratamiento ligero.
5. Manejo de respuestas:
   - `needs_decision` → pausa con `authority_block` y el mensaje canónico de tres líneas.
   - `no_gaps` con huecos declarados → inconsistencia; pausa con `progress_unavailable`.
   - `state: blocked` o `persistencia_fallida` → pausa con `progress_unavailable`.
   - `tests_generated` → conservá `tests_report_ref` y `tests_gaps`.
   - reporte requerido ausente → pausa con `progress_unavailable`.
6. La generación reutiliza el plan y sus huecos: no re-evalúa una decisión. Un cambio
   material del plan o de los huecos pausa y exige una generación nueva; el flujo no infiere
   el alcance de la prueba.
7. Pasá al Validator `plan_ref`, `tests_report_ref` y `tests_gaps`.

***

### Paso 5 — Validator

Invoca validator usando el formato canónico. Validator pertenece al
tratamiento ligero (`inspector`, `validator`, `tester`,
`review-orchestrator`, `logger` e `initializer`): su invocación es siempre
Escenario A, en **hilo fresco**, sin `task_id`, Resume Prompt, Topic Validation
ni contexto de sesión anterior.

**Despacho por ronda.** El Runner declara la ronda en cada invocación:

| Ronda | Cuándo se despacha | Qué exige |
|-------|--------------------|-----------|
| `round=closure` | Después de que el Constructor declara completada la implementación. | El plan completo y su referencia. |
| `round=intermediate` | Cuando necesitas verificar lo alcanzado antes de seguir. | El alcance declarado de lo alcanzado. |

El prompt de despacho incluye: `execution_id`, `artifact_namespace`, la ronda
(`round=closure` o `round=intermediate`), el alcance declarado (`scope.goal`,
`scope.files`, `scope.criteria`), `plan_ref` (obligatorio en `round=closure` y
opcional en `round=intermediate`), `environment`, el reporte de pruebas
(`tests_report_ref`, `NONE` cuando no se generaron), `tests_gaps` (`NONE` cuando
no hay huecos) y, cuando existe, la referencia al reporte de validación anterior
como referencia citable.

**Veredictos.**

- `round=closure` con `APPROVED` y `final=true` → finaliza el flujo.
- `round=intermediate` con `APPROVED` y `final=false` → continúa sin cerrar:
  resultado `continue_round`.
- `REJECTED` en cualquier ronda → continúa según «Loop de validación», con el
  alcance declarado y la evidencia del reporte.
- `OPERATIONAL_FAILURE` → no es rechazo funcional: conserva estado e historial,
  recupera la comprobación si es posible y pausa/escalá si no
  (`needs_recovery_or_pause`).
- Un test `failed` heredado del reporte de pruebas es un rechazo funcional con su
  evidencia; una herramienta caída que impide comprobar es un fallo operativo.

### Cierre exitoso con worktree

Cuando el validator apruebe y el CA tenga worktree asociado, el Runner solicita
al gestor `worktree_complete` con la misma identidad y base registradas. El
gestor standalone ejecuta el lifecycle; antes de completarlo:

1. No crees un commit de cierre: los commits atómicos los aporta el Constructor; verificá que el worktree esté limpio antes de planear `worktree_complete` con `dry_run: true`, leer `plan_hash` y `transaction_id`, y ejecutar con esos valores.
2. La base es la registrada en la asociación; no la re-detectes al cerrar.
3. Si completa bien, el gestor integra con `merge_strategy` y limpia el worktree/branch.
4. Si `complete` falla por conflicto, **no limpies** el worktree.
5. Si `complete` rechaza porque **el destino tiene cambios sin commitear**, no intentes limpiar el destino ni crear stashes: el rechazo es seguro y dejó todo intacto. Escala al desarrollador con el motivo; solo si el desarrollador consiente explícitamente, reintenta con `preserve_dirty: true` o con `--preserve-dirty` por la vía `.sh`.
6. `preserve_dirty` es una transacción opt-in: captura los cambios elegibles del destino en refs privadas, registra cada fase en el journal del gestor y restaura el estado fino al final. Ofrecélo **SOLO ante instrucción humana explícita** — jamás por defecto ni en flujos automáticos. La config persistida (`.flowtask/config/worktree.json` con `"preserveDirty": true`) cuenta como consentimiento humano explícito y ningún guion la escribe.
7. Si un cierre con preservación se interrumpe, reanudalo con `worktree_recover` usando el `transaction_id` (o `worktree.sh recover [<tx-id>]` por la vía alternativa); repetirlo es seguro e idempotente. Si la restauración quedó pendiente-manual, mostrale al desarrollador las instrucciones seguras impresas por el gestor: la resolución manual nunca se automatiza.
8. El Runner sólo solicita las opciones expresamente habilitadas por el consentimiento aplicable. No deriva ni ejecuta comandos Git o de lifecycle por fuera del gestor; `--auto` no sustituye consentimiento para preservar o descartar. El cierre con destino sucio se escala al desarrollador sin limpiar el destino.
9. Re-escala al constructor original con el conflicto mínimo necesario para que explique brevemente por qué se resolvió así y pregunte si el desarrollador quiere implementarlo o solo analizarlo.

***

### Estrategia de cierre dual

El Constructor propone la estrategia y el Runner la ejecuta sin re-evaluarla.

- Leé `commit_strategy`, `commit_strategy_rationale`, `commit_count` y `commits` del reporte del Constructor.
- Propuesta faltante → squash; propuesta inválida → pausa con `authority_block`; nunca re-evalúes la estrategia.
- Pasá `merge_strategy` a `worktree_complete` con la misma identidad y base registradas.
- Registrá `merge_strategy`, `merge_commit`, `commit_count` y el fundamento en el cierre de `flow-state/{execution_id}/run` y en el reporte final.
- La transacción del gestor es la fuente autoritativa de lo aplicado.

***

### Mensaje de cierre

El Runner compone el título y el cuerpo desde el CA o el hotfix y los envía en
`commit_title`/`commit_body` de `worktree_complete`; si no hay fuente aporta el
fallback en español. Por la vía alternativa, `worktree.sh complete <id> --base
<rama> --title "..." --body "..."`. Plantillas:

- CA — Título: título del artifact del CA. Cuerpo: `Entrega: <resumen>. Motivo:
  <problema>. Verificación: <APPROVED del Validator, ronda closure>.`
- Hotfix — Título: `Correccion: <problema acordado>`. Cuerpo: `Causa:
  <diagnóstico>. Verificación: <APPROVED>.`

El gestor agrega ` [work_id]` si el título no contiene el ID. El Runner no
incluye rutas, branches ni detalles internos; al nombrar la integración usa el `mecanismo de integración`. Si no hay fuente
diciente, omití las flags y el Runner inyecta el fallback:
`Cierre generico de <work_id>` / `No habia una descripcion de la entrega
disponible al momento del cierre.`. No se agrega ninguna aprobación nueva.


### Loop de validación

Este loop común aplica a CAs y hotfixes solo después de que el trabajo esté documentado y el Runner haya emitido una señal explícita y observable de inicio. La existencia de un artifacto, worktree o rechazo previo no activa el loop por sí sola. En CA la señal de inicio es la orden original del desarrollador junto con el resultado PASS del Gate de Ejecución, y permanecen obligatorios el Gate y la auditoría; en hotfix la señal de inicio es la aceptación explícita del diagnóstico acordado y se conserva el flujo aislado.

La composición de los contratos del Agent Loop, la compuerta de gasto y el registro de la ejecución se rigen por `runner-flow-agent-loop`. Este loop conserva sus reglas de diagnóstico, de rondas y de Inspector.

En cada ronda, el Runner entrega al Constructor el plan vigente, el resultado del Validator y el historial pertinente. Tras el primer rechazo funcional, solicita al Constructor la corrección fundada en la evidencia. Tras un segundo rechazo funcional sin aprobación, y en cada rechazo posterior, solicita a un Inspector nuevo un diagnóstico usando el patrón de fallos y el historial completo; después despacha al Constructor con ese diagnóstico. Cambiar de Inspector no borra intentos, fallos ni enfoques descartados.

Una nueva ronda después del diagnóstico requiere una hipótesis fundada, distinta o respaldada por evidencia nueva, y una comprobación observable. Si no hay hipótesis/progreso verificable, falta autoridad para continuar, hay un límite expreso, un fallo irrecuperable o se requiere cambiar alcance, pausa y explica motivo, estado conservado y condición de reanudación. No hay máximo global de rondas: el loop no se detiene por un número fijo de rechazos.

Un fallo operativo (comando fallido, herramienta/servicio indisponible o limitación externa) no es rechazo funcional y no incrementa rondas. Conserva worktree, cambios, artifacts e historial; intenta recuperación operativa pertinente o pausa si no puede verificar. Nunca interpretes el fallo como aprobación ni pidas correcciones al Constructor por un fallo operativo.

La validación hereda el reporte de pruebas: un test `failed` es un rechazo funcional con su evidencia y una herramienta caída es un fallo operativo. La generación reutiliza el plan y sus huecos sin re-evaluarlos; un cambio material del plan o de los huecos pausa y exige una generación nueva.

Un fallo irrecuperable declarado con evidencia y diagnóstico cierra por causa externa conservando trabajo, historial y diagnóstico. Un fallo externo no verificable no se declara irrecuperable: es un fallo operativo, produce pausa y nunca es un rechazo funcional.

El Runner puede despachar rondas intermedias con alcance declarado: no exigen el plan completo, no cierran la ejecución y su evidencia se conserva en el artifact de validación (`{artifact_namespace}/artifact/validacion`). La ronda siguiente recibe esa referencia y no repite comprobaciones ya veredictadas. Solo un APPROVED de ronda closure con final=true cierra el flujo; un APPROVED de ronda intermedia produce `continue_round` y la ejecución continúa.

La replanificación autónoma solo puede reorganizar la implementación dentro de la finalidad, alcance, criterios de aceptación, permisos y restricciones ya aprobados. No altera requisitos ni autoriza un cambio de alcance: si hace falta, pausa y solicita decisión humana. El cambio de Inspector no reinicia contadores ni habilita repetir enfoques descartados sin evidencia nueva.

Solo `APPROVED` explícito del Validator cierra la validación y habilita el cierre normal. El Runner informa por ronda el incumplimiento, la novedad y el resultado; al pausar informa motivo y condición de reanudación. El trabajo y su historial se conservan durante pausas.

***


## Purga de `task_id` huérfanos

Al finalizar un flujo de CA, o una sesión terminada, el runner debe ejecutar una verificación de `task_id` en el mapa de instancias antes del `mem_session_summary`.

### Protocolo de purga

1. **Recuperar mapa**: `mem_search(query: "flow-state/{CA-ID}/instances")`.
2. **Verificar cada `task_id` elegible**: Solo para `ca-writer` y `planner`,
   invocar al subagente con el `task_id` persistido y un prompt mínimo de
   verificación. Para agentes de tratamiento ligero (`inspector`,
   `constructor`, `validator`, `tester`, `review-orchestrator`, `logger` e
   `initializer`), no verificar ni reutilizar `task_id`: conservar sus
   registros y checkpoints únicamente como histórico/traza.
3. **Evaluar resultado**:
    - **Si la invocación elegible falla con error** (el `task_id` no existe): Eliminar la entrada del agente del mapa vía `mem_save` y registrar: `[PURGE] task_id huérfano eliminado: {instance_name} ({task_id})`.
   - **Si la invocación tiene éxito**: El `task_id` es válido. Conservarlo en el mapa.
4. **Ejecutar `mem_session_summary`** solo después de completar la purga.

### Nota de consistencia

La purga de `task_id` y la gestión de worktrees son independientes: un `task_id` huérfano no implica borrar el worktree, y un worktree huérfano no implica tocar el mapa de `task_id`.

### Limitaciones conocidas

- **Si Engram no está disponible**: La purga se omite. Los `task_id` huérfanos persisten hasta la próxima sesión con Engram funcional.
- **Self-Healing reactivo**: El manejo de errores en la invocación normal (línea 196-201) sigue activo y es el mecanismo primario de detección durante la operación.
- **Relanzamiento por capacidad**: Para agentes completos persiste `relaunch_count`. Constructor inicia un hilo nuevo con restauración explícita del checkpoint/artifact/motivo, nunca como continuidad técnica falsa. Para los demás ligeros el checkpoint solo es traza.


## Cierre del CA — Marcar como completado

Al finalizar un flujo de CA, después de la purga de `task_id` huérfanos y antes del `mem_session_summary`, el runner debe marcar el CA como "closed" en Engram.

### Protocolo de cierre

1. **Recuperar mapa**: `mem_search(query: "flow-state/{CA-ID}/instances")` para obtener el mapa de instancias actual. Si se conoce el observation ID, usar `mem_get_observation`.
2. **Agregar `ca_status`**: Incorporar el campo `ca_status: "closed"` al contenido del mapa de instancias.
3. **Persistir**: `mem_save()` usando el mismo `topic_key` del handshake (`flow-state/{CA-ID}/instances`) para hacer upsert. Conservar todos los campos existentes (`base_name`, `agents`, task_ids, etc.).
4. **Si Engram no está disponible**: Omitir silenciosamente. El `baseName` queda bloqueado hasta la próxima sesión con Engram funcional — misma limitación que la purga de `task_id` huérfanos.
5. **Ejecutar `mem_session_summary`** solo después de completar el cierre (o de omitirlo si Engram no disponible).

### Nota de cierre con worktree

Si el CA tenía `constructor.worktree`, el cierre exitoso debe invocar primero `worktree.sh complete` y solo luego persistir el estado cerrado.

### Limitaciones conocidas

- **Misma dependencia de Engram**: Si Engram no está disponible al momento de escribir el cierre, el `ca_status` no se persiste. El `baseName` queda bloqueado hasta que una sesión futura con Engram funcional complete el cierre.

***
