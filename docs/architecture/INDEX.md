# Arquitectura vigente — FlowTask

Este índice contiene referencias actuales, no un snapshot Repomix. Los diseños retirados están en [../project-history.md](../project-history.md).

## Referencias operativas

- [handshake.md](./handshake.md) — identidad, continuidad y checkpoints; contrastar con `.flowtask/agents/runner.md` y `handshake-protocol`.
- [autonomia-operativa.md](./autonomia-operativa.md) — avance por política, pausa por excepción y decisiones de política registradas; contrastar con `.flowtask/agents/runner.md` y `agent-loop-run`.
- [validacion.md](./validacion.md) — validación en caliente, evidencia ejecutada y veredicto único; contrastar con `.flowtask/agents/validator.md` y `validation-contract`.
- [worktree.md](./worktree.md) — create, complete, cleanup, recover, prune, list y target-direct; contrastar con `.flowtask/scripts/worktree.sh` y `.flowtask/scripts/worktree-manager/`.
- [Evidencia de la retirada del acoplamiento legacy](../operations/worktree-phase-9/README.md) — gate de entrada, compatibilidad declarada, snapshot y digests de la fase.
- [integracion-skills.md](./integracion-skills.md) — carga directa desde `.flowtask/skills` mediante `skill({ name: ... })`.
- [Worktree Manager documentation](../worktree-manager/README.md) — English architecture and release documentation for the implemented manager.

## Referencias relacionadas

- [../core-flowtask.md](../core-flowtask.md) — CA, hotfix, Graphify y plugins.
- [../permission-gate.md](../permission-gate.md) — permisos y review-stamp.
- [../installation.md](../installation.md) — targets, manifest y configuración derivada.

No agregar aquí agentes no registrados, Archivist, classifier activo por defecto, `.workspace` como workspace operativo, skill registry retirado ni archivos inexistentes.
