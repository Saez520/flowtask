# Arquitectura vigente — FlowTask

Este índice contiene referencias actuales, no un snapshot Repomix. Los diseños retirados están en [../project-history.md](../project-history.md).

## Referencias operativas

- [handshake.md](./handshake.md) — identidad, continuidad y checkpoints; contrastar con `.flowtask/agents/runner.md` y `handshake-protocol`.
- [autonomia-operativa.md](./autonomia-operativa.md) — avance por política, pausa por excepción y decisiones de política registradas; contrastar con `.flowtask/agents/runner.md` y `agent-loop-run`.
- [capas-persona-autonomia-permisos.md](./capas-persona-autonomia-permisos.md) — las tres capas almacenadas (persona, autonomía, permisos), su resolución por capa, la precedencia `permisos > autonomía > persona` y el fallo por capa; contrastar con `autonomia-operativa.md` y `../permission-gate.md`.
- [orquestacion-paralela.md](./orquestacion-paralela.md) — independencia verificable, lote acotado, cola visible y contención de conflictos; contrastar con `.flowtask/skills/parallel-orchestration/SKILL.md` y `.flowtask/agents/runner.md`.
- [validacion.md](./validacion.md) — validación en caliente, evidencia ejecutada y veredicto único; contrastar con `.flowtask/agents/validator.md` y `validation-contract`.
- [pruebas-condicionales.md](./pruebas-condicionales.md) — pruebas por hueco, presupuesto 1/3/0 y herencia del reporte; contrastar con `.flowtask/agents/tester.md`, `.flowtask/agents/runner.md` y `.flowtask/agents/validator.md`.
- [verificacion-material.md](./verificacion-material.md) — verificación material, evidencia citable y herencia entre roles; contrastar con `.flowtask/skills/zero-assumptions/SKILL.md`.
- [contexto-degradacion.md](./contexto-degradacion.md) — degradación por niveles, reglas por momento y recuperación verificable; contrastar con `.flowtask/skills/context-degradation/SKILL.md` y `.flowtask/agents/runner.md`.
- [worktree.md](./worktree.md) — create, complete, cleanup, recover, prune, list y target-direct; contrastar con `.flowtask/scripts/worktree.sh` y `.flowtask/scripts/worktree-manager/`.
- [integracion-skills.md](./integracion-skills.md) — carga directa desde `.flowtask/skills` mediante `skill({ name: ... })`.
- [Worktree Manager documentation](../worktree-manager/README.md) — English architecture and release documentation for the implemented manager.

## Referencias relacionadas

- [../core-flowtask.md](../core-flowtask.md) — CA, hotfix, Graphify y plugins.
- [../permission-gate.md](../permission-gate.md) — permisos y review-stamp.
- [../installation.md](../installation.md) — targets, manifest y configuración derivada.

No agregar aquí agentes no registrados, Archivist, classifier activo por defecto, `.workspace` como workspace operativo, skill registry retirado ni archivos inexistentes.
