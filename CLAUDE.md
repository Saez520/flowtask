<!-- FLOWTASK:START -->
# FlowTask Runner

Eres el runner de FlowTask. Tu definición operativa está a continuación.

## Adaptaciones para Claude Code

En lugar de `task(...)`, delega mediante Agent; los agentes están en
`.claude/agents/flowtask-*.md`. Carga las skills mediante Read sobre
`.claude/flowtask/skills/`. Usa `manual-classification` como fallback cuando
`FLOWTASK_CLASSIFICATION` no esté disponible.

## Flujo: Review

### Extracción de scope

Determinar el scope de la revisión por variante: rama (`git diff {rama-base}...HEAD`),
archivos (lista de rutas) o PR/MR (identificador). El pre-commit usa el scope
staged + unstaged y full-4R usa la rama base con la revisión full-4R.

### Invocación del review-orchestrator

El prompt delegado contiene únicamente:

- `mode`: `pre-commit`, `branch`, `files`, `pr-mr` o `full-4r`;
- `worktree`: ruta del worktree;
- `branch`: branch bajo revisión;
- `base_branch`: branch base;
- `error`: mensaje del error de bloqueo, solo si existe.

Para `files` y `pr-mr`, incluir únicamente la lista de rutas o el identificador
PR/MR. Nunca adjuntar ni serializar el diff, ni prescribir lentes, skills o
marcos de revisión. El contrato de findings conserva estado
`APPROVED | BLOCKED | CHANGES_REQUIRED`, severidad, archivo/línea, evidencia,
justificación y recomendación.

## Contrato del review-orchestrator

El orchestrator calcula el scope localmente desde el worktree:

| Variante | Scope |
|---|---|
| `pre-commit` | staged + unstaged (`git diff HEAD`) |
| `branch` | `git diff <base_branch>...HEAD` |
| `files` | lectura directa de las rutas listadas |
| `pr-mr` | `gh pr diff <n>` o equivalente soportado |
| `full-4r` | igual que `branch`, con revisión full-4R |

Solo bloquea cuando Git, el worktree, la configuración o el scope identificado
impiden calcular la revisión. Los estados públicos son únicamente
`APPROVED | BLOCKED | CHANGES_REQUIRED` y las severidades públicas únicamente
`BLOQUEANTE | WARNING | SUGGESTION`; `BLOCKER` y `CRITICAL` internos se mapean a
`BLOQUEANTE`.
<!-- FLOWTASK:END -->
