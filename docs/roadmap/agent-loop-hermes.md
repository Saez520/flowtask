# Plan de implementación — Agent Loop y Hermes

**Estado:** aprobado el 2026-10-19. F0 y F1 completadas. F2 siguiente. GATE HERMES H0 abierto.
**Alcance:** evolución de FlowTask/Flotas hacia un motor de desarrollo autónomo y Hermes como producto generalista.
**Frontera:** OpenCode V2 es el harness/runtime; FlowTask es el control plane; Hermes es el producto. No se forkeará OpenCode.

## Convención de nombres y commits

- F0–F4 son etiquetas de planificación. Viven en este documento y en Engram.
- Los worktrees, branches y CAs usan nombres descriptivos de la capacidad, no el ID de fase.
- Los commits usan Conventional Commits y describen qué se hizo. No incluyen F0.1, CA-... ni IDs de roadmap.
- Ejemplos:
  - feat(agent-loop): add progress variables
  - feat(agent-loop): add termination invariants
  - feat(agent-loop): add idempotent retry checkpoints
  - docs(agent-loop): add implementation roadmap
- El ID de fase puede aparecer en documentación y Engram; nunca en el mensaje del commit.

## Estado actual

F0 completada:
- Loop de validación supervisado — 602dfdd.
- Continuidad durable del Constructor — 82a3f65.
- E2E de task_id con planner y ca-writer — flow-state/CA-task-id-e2e/instances (#9594).
- Documentación sin versión hardcodeada — dcb03db.

F1 completada:
- F1.2 Variables de progreso — 0f522a7.
- F1.4 Invariantes — 3510b2c.
- F1.3 Terminación — e986bd5.
- F1.5 Idempotencia — 1db9197.
- F1.6a Observabilidad del presupuesto — 3274881.
- Integración de control — 761004f.
- F1.1 AgentRun con F1.6b freno declarado — 712b89f.

## F0 — Integración y base (completada)

| Punto | Qué se hizo | Evidencia |
|---|---|---|
| F0.1 Loop de validación | Rechazo funcional vs fallo operativo; Inspector desde el segundo rechazo; sin máximo global; pausa por falta de progreso, autoridad, límite, fallo irrecuperable o cambio de alcance. | 602dfdd |
| F0.2 Continuidad del Constructor | Reanudación solo con identidad, task_id válido y checkpoint restaurable; solo fallo operativo o interrupción. | 82a3f65 |
| F0.3 E2E task_id | Captura, persistencia en Engram y reanudación del mismo hilo con planner y ca-writer. | #9594 |

## F1 — Núcleo del Agent Loop

Objetivo: definir el controlador, el progreso, la terminación, los invariantes y la idempotencia.

| Punto | Estado | Dependencias / paralelo | Merge |
|---|---|---|---|
| F1.2 Variables de progreso | Implementado y validado | Paralelo con F1.3, F1.4, F1.5, F1.6 | 0f522a7 |
| F1.4 Invariantes | Implementado y validado | Paralelo con F1.2/F1.3/F1.5 | 3510b2c |
| F1.3 Terminación | Implementado y validado | Depende de F1.2; paralelo con F1.4/F1.5 | e986bd5 |
| F1.5 Idempotencia | Implementado y validado | Paralelo con F1.2/F1.3/F1.4 | 1db9197 |
| F1.6a Presupuesto — observabilidad | Implementado y validado | Paralelo | 3274881 |
| F1.6b Presupuesto — freno declarado | Implementado y validado | Vive dentro de AgentRun (F1.1) | 712b89f |
| F1.1 AgentRun | Implementado y validado | Depende de F1.2–F1.5 | 712b89f |
| Integración de control | Implementado y validado | Consolida el control de F1.2–F1.6 | 761004f |

Orden de merge aplicado: progreso → invariantes → terminación → idempotencia → presupuesto → integración → AgentRun.

GATE HERMES H0 — ABIERTO: el contrato de F1.1 fue validado.

## F2 — Autonomía operativa

Objetivo: reemplazar esperas humanas por políticas, reforzar validación, identidad y evolución de agentes.

Grupos paralelos:
- A fundacional: F2.6 identidad, F2.8 degradación de contexto, F2.9 orquestación paralela.
- B evolución de agentes: F2.3 CA-Writer y F2.4 Planner, con coordinación.
- C validación: F2.2 Validator realtime y F2.5 Tester condicional; F2.5 después de F2.2.

Secuencia: F2.1 HITL después de F1.1 + F2.6 + F2.2. F2.7 Zero-Assumptions después de F2.6 + F2.1.

| Punto | Estado | Nota |
|---|---|---|
| F2.1 HITL | Análisis condicional | Validar en implementación cuándo aplica |
| F2.2 Validator realtime | Análisis | Herramientas del harness y validaciones no-plan |
| F2.3 CA-Writer | Dirección aprobada | Auditoría de contradicciones antes de evolucionar |
| F2.4 Planner | Dirección aprobada | Comunicación mediada entre agentes |
| F2.5 Tester condicional | Análisis | Gate tipo plan-auditor |
| F2.6 Identidad | Análisis | Bug histórico resuelto (#572); alcance Hermes |
| F2.7 Zero-Assumptions | Análisis | Formalizado para CA-Writer/Planner/Inspector; falta cobertura |
| F2.8 Degradación de contexto | Análisis | Inyección progresiva |
| F2.9 Orquestación paralela | Análisis | Validar si ya se soporta |

Gate Hermes H1: F1 completo + F2.1 + F2.6 + F2.7 + F0.3. H1 puede correr en paralelo con F3.

## F3 — Producto y distribución

| Punto | Estado | Nota |
|---|---|---|
| F3.1 Instalación por equipo | Aprobado | Primera de F3; paralelo con F1/F2 |
| F3.2 Registro/adaptador | Aprobado | Carpeta ignorada, no trackeada ni en raíz |
| F3.3 --profile | Análisis | Después de F3.4 |
| F3.4 Separación persona/autonomía/permisos | Análisis | Paralelo con F3.1 |
| F3.5 npm/pnpm | Análisis | pnpm preferido; no retrasar |
| F3.6 Post-save | Análisis | Independiente |

Gate Hermes H2: H1 + permisos de dominio (F4.8) + F3 + auditoría/rollback.

## F4 — Hermes

| Etapa | Alcance | Dependencia |
|---|---|---|
| H0 Shell | Interfaz, configuración, registro de herramientas, esqueleto de permisos | Contrato de F1.1 |
| H1 Hermes dev-only | Desarrollo usando FlowTask | F1 + F2.1 + F2.6 + F2.7 + F0.3 |
| H2 Hermes generalista | Archivos, apps, terminal, navegador, automatizaciones | H1 + F4.8 + F3 + auditoría/rollback |

Gates:
- GATE HERMES H0 — ABIERTO: el contrato de F1.1 fue validado.
- GATE HERMES H1 — se puede iniciar en paralelo con F3.
- GATE HERMES H2 — se puede iniciar.

H2 no se construye desde cero: base de runtime existente + controlador, permisos e interfaz.

## Descartados

- Persona no técnica: el producto no apunta a ese perfil.
- Consistencia de IDs consecutivos: los CAs ya no usan consecutivos.
- Workspace compartible: workspaces deprecados.
- Purga automática de task_ids: overkill; manual suficiente.

## Independiente

- LSP + AST-Grep: no bloquea el loop ni Hermes.

## Versión

- La versión de FlowTask vive solo en .flowtask/package.json.
- README y docs no hardcodean versión.
- Bump por fase; release = bump + tag; hotfix = patch.
- Hermes 1.0 tiene repo/versión propios; FlowTask queda como plugin/motor con versión independiente.
- OpenCode no se bumpea desde FlowTask.

## Relación con Engram

El índice operativo está en architecture/provisional-roadmap-agent-loop-hermes-index. Este documento es la versión humana del plan; Engram conserva el estado operativo y las memorias por punto.
