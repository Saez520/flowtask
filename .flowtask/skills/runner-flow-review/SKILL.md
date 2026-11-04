---
name: runner-flow-review
description: >-
  Flujo del runner — detección, scope, modo, invocación del review-orchestrator y flujo commit. Se carga solo ante el disparador
  `evento:review`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Flujo: Review

### Detección de intención de revisión

Frases que activan este flujo: "revisá el código", "hace un review", "revisa el diff", "revisa la rama", "revisa los archivos", "code review", "review de", "pre-commit review", `/review`.

### Extracción de scope

Determinar el scope de la revisión:
- **Rama**: `git diff {rama-base}...HEAD` para obtener el diff.
- **Diff explícito**: el usuario provee el diff directamente.
- **Archivos**: lista de archivos a revisar.
- **PR/MR**: extraer diff del PR indicado.

Si el scope no está claro, preguntar al desarrollador antes de invocar.

### Determinación de modo

- **Pre-commit** (default si no se especifica otro modo): scope es el diff staged o unstaged actual.
- **Full-4R**: activado por rutas críticas, diff > 400 líneas, o solicitud explícita.

### Invocación del review-orchestrator

Invocar review-orchestrator usando el formato canónico. Review-orchestrator
pertenece al tratamiento ligero (`inspector`, `constructor`, `validator`,
`tester`, `review-orchestrator`, `logger` e `initializer`): su invocación es
siempre Escenario A, sin `task_id`, Resume Prompt, Topic Validation ni contexto
de sesión anterior. El prompt delegado debe contener únicamente:

- `mode`: modo determinado (`pre-commit`, `branch`, `files`, `pr-mr` o `full-4r`);
- `worktree`: ruta del worktree;
- `branch`: branch bajo revisión;
- `base_branch`: branch base;
- `error`: mensaje del error de bloqueo, solo si existe.

Para las variantes `files` y `pr-mr`, incluir además únicamente la lista de rutas o el identificador PR/MR que permite al review-orchestrator recuperar el scope. Nunca adjuntar ni serializar el diff, ni prescribir lentes, skills o marcos de revisión. Conservar el contrato de findings con estado `APPROVED | BLOCKED | CHANGES_REQUIRED`, severidad, archivo/línea, evidencia, justificación y recomendación.

### Flujo commit

En flujos de CA con worktree, los commits atómicos los crea el Constructor y el Runner no crea un commit de cierre.

Si ejecutas un `git commit` y el gate lo bloquea, seguí las instrucciones del mensaje de error. Tras la aprobación, el RUNNER reintenta el commit directamente con `git commit -m "..."` usando el mensaje del trabajo realizado (CA/HF en curso). NO re-invoces al constructor solo para commitear.

***
