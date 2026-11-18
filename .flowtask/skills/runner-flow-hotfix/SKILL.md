---
name: runner-flow-hotfix
description: >-
  Flujo del runner — persistencia, worktree, Constructor, Validator y cierre. Se carga solo ante el disparador
  `evento:hotfix`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Flujo: ejecución de hotfix acordado

Cuando el diagnóstico concluye con una corrección acordada, la aceptación explícita de esa
corrección es la señal de inicio del hotfix. No se espera una segunda palabra. Este flujo no
crea CA ni invoca ca-writer, planner ni plan-auditor.

### Paso 1 — Persistencia previa

Construye una sola vez un slug descriptivo normalizado en minúsculas y
kebab-case a partir del problema acordado, y forma el ID `HF-{slug}`. Si el
operador ya entrega el prefijo `HF-`, no lo dupliques. Antes de persistir,
consulta Engram por el candidato completo `hotfix/{id}`. Si ya existe,
conserva el nombre base y prueba secuencialmente `HF-{slug}-2`, `-3`, etc.,
hasta encontrar el primer candidato libre; no sobrescribas ni mezcles
historiales. Los IDs temporales históricos no se renombran.

Una vez fijado, reutiliza exactamente el mismo ID en los artifacts completos
`type: ca-artifact`, los namespaces `hotfix/{id}/artifact/investigacion` y
`hotfix/{id}/artifact/plan`, el flow-state, los prompts, el `execution_id`, el
`artifact_namespace`, el worktree y la branch.

### Paso 2 — Worktree y Constructor

Detecta la base en orden `development → main → trunk → main`. El servidor MCP
`worktree_manager` es la vía primaria: usá `worktree_create` con `repo`,
`work_id = hotfix/{id}`, `base = {base_branch}` y `dry_run: true`; leé
`data.plan_hash` y ejecutá con los mismos campos más `plan_hash`. Habilitá
`init_submodules`, `prepare` o `verify` solo por intención explícita.

Antes de la primera llamada, guardá `worktree/association/hotfix/{id}` con
`state: pending`; tras el éxito, reemplazalo por `state: confirmed` con
`{ repo_root, work_id, path, branch, base_branch, init_submodules,
init_submodules_result, transport: "mcp" }`. Si Engram falla antes, no llames
al gestor; si falla después de un efecto confirmado, conservá los recursos y
bloqueá dispatch y cierre hasta reconciliar.

Persistí en `flow-state/hotfix/{id}/instances` el path, la branch, la base y la
asociación que devolvió el gestor. Los defaults del gestor producen
`.worktrees/hotfix/{id}` y `worktree/hotfix/{id}`; el path y la branch efectivos
se toman de la respuesta del gestor. Reutilizá un worktree existente en
reanudaciones solo con identidad exacta.

Si el MCP no está registrado o no responde, informá la indisponibilidad con su
causa y solo entonces podés usar
`${FLOWTASK_SCRIPTS}/worktree.sh create hotfix/{id} --base {base_branch} [--init-submodules]`
como alternativa declarada. No hay fallback automático después de una solicitud
entregada: un rechazo, un error de contrato, un lock ocupado, un timeout o una
respuesta perdida se reportan como resultado incierto y el siguiente paso es
reconciliar.

Despachá el Constructor con `execution_id=hotfix/{id}`,
`artifact_namespace=hotfix/{id}`, path, branch y base branch.

### Paso 3 — Validator y cierre

Despacha el Validator con el mismo contexto. El Validator persiste
`hotfix/{id}/artifact/validacion` y su flow-state separado. Los rechazos siguen el
Loop de validación común, incluidos el diagnóstico posterior, la pausa por sus
condiciones y cualquier límite expreso propio de la ejecución. El veredicto
`APPROVED` es registro técnico: el runner informa en llano qué se verificó y qué
sigue, y con la aprobación hace el commit y cierra por MCP con
`worktree_complete`.

Para cerrar, usá `worktree_complete` con `repo`, `work_id = hotfix/{id}`,
`base = {base_branch}` y `dry_run: true`; leé `data.plan_hash` y
`data.transaction_id`, y ejecutá con los mismos campos más `plan_hash`,
`transaction_id`, `authorization: "I_AUTHORIZE_THIS_CALL"` y `confirm: true`.
Pasá `merge_strategy` tal como lo propuso el Constructor, `commit_title` y
`commit_body` en español, y `preserve_dirty: true` solo si
`.flowtask/config/worktree.json` lo declara o si el desarrollador consintió
explícitamente; el archivo nunca se escribe. El `complete` se serializa siempre
por base, aunque los trabajos sean independientes.

Un conflicto conserva worktree y branch y se escala sin limpiar; un destino con
cambios sin commitear también conserva todo intacto y se escala. Si el MCP no
está disponible, informá la causa y solo entonces usá
`${FLOWTASK_SCRIPTS}/worktree.sh complete hotfix/{id} --base {base_branch} [--init-submodules] [--merge-strategy {estrategia}] [--title TEXTO] [--body TEXTO]`
como alternativa declarada.

Para recuperar una transacción interrumpida usá `worktree_recover` con
`transaction_id`; `${FLOWTASK_SCRIPTS}/worktree.sh recover [<tx-id>]` es la
alternativa declarada. `worktree_list` y `worktree_prune` cruzan los worktrees
hotfix con `flow-state/hotfix/{id}/instances` y reportan huérfanos; `prune`
requiere `authorization` y `confirm: true`.

#### Estrategia de cierre dual

El Constructor propone la estrategia y el Runner la ejecuta sin re-evaluarla.

- Leé `commit_strategy`, `commit_strategy_rationale`, `commit_count` y `commits` del reporte del Constructor.
- Propuesta faltante → squash; propuesta inválida → pausa con `authority_block`; nunca re-evalúes la estrategia. El default del manager solo aplica cuando falta la propuesta.
- Pasá `merge_strategy` a `worktree_complete` con la misma identidad y base registradas; en la vía alternativa `.sh`, `--merge-strategy`.
- Registrá `merge_strategy`, `merge_commit`, `commit_count` y el fundamento en `flow-state/hotfix/{id}/instances` y en el reporte final.
- La transacción del gestor es la fuente autoritativa de lo aplicado.

El flujo hotfix mantiene aislamiento, checkpoints, reintentos y cierre con la
estrategia propuesta, sin alterar los namespaces históricos de CA.

***
