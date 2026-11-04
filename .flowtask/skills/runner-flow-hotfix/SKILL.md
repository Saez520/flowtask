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

Detecta la base en orden `development → main → trunk → main` y ejecuta:
`${FLOWTASK_SCRIPTS}/worktree.sh create hotfix/{id} --base {base_branch} [--init-submodules]`. La
ruta es `.worktrees/hotfix/{id}` y la branch es `worktree/hotfix/{id}`.
Reutiliza un worktree existente en reanudaciones. Persiste el estado bajo
`flow-state/hotfix/{id}/instances` y despacha el Constructor con
`execution_id=hotfix/{id}`, `artifact_namespace=hotfix/{id}`, path, branch y
base branch.

### Paso 3 — Validator y cierre

Despacha el Validator con el mismo contexto. El Validator persiste
`hotfix/{id}/artifact/validacion` y su flow-state separado. Los rechazos siguen el
Loop de validación común, incluidos el diagnóstico posterior, la pausa por sus
condiciones y cualquier límite expreso propio de la ejecución. Con APPROVED hacé el commit antes de
`${FLOWTASK_SCRIPTS}/worktree.sh complete hotfix/{id} --base {base_branch} [--init-submodules] [--title TEXTO] [--body TEXTO]`.
Un conflicto conserva worktree y branch y se escala sin limpiar; un rechazo por
destino con cambios sin commitear también conserva todo intacto, se escala al
desarrollador y solo procede con `--preserve-dirty` si hay consentimiento
humano explícito. `list`,
`prune` y la reconciliación cruzan los worktrees hotfix con
`flow-state/hotfix/{id}/instances` y reportan huérfanos.

El flujo hotfix mantiene aislamiento, checkpoints, reintentos y cierre con la
estrategia vigente (squash por defecto), sin alterar los namespaces históricos de CA.

***
