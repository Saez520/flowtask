# Arquitectura vigente — FlowTask

Este índice contiene referencias actuales, no un snapshot Repomix. Los diseños retirados están en [../project-history.md](../project-history.md).

## Referencias operativas

- [handshake.md](./handshake.md) — identidad, continuidad y checkpoints; contrastar con `.flowtask/agents/runner.md` y `handshake-protocol`.
- [worktree.md](./worktree.md) — create, complete, cleanup, recover, prune, list y target-direct; contrastar con `.flowtask/scripts/worktree.sh` y `lib/`.
- [Documento auxiliar del script worktree](../../.flowtask/scripts/worktree.md) — arquitectura detallada del gestor; es documentación y no un entrypoint ejecutable.
- [integracion-skills.md](./integracion-skills.md) — carga directa desde `.flowtask/skills` mediante `skill({ name: ... })`.

## Referencias relacionadas

- [../core-flowtask.md](../core-flowtask.md) — CA, hotfix, Graphify y plugins.
- [../permission-gate.md](../permission-gate.md) — permisos y review-stamp.
- [../installation.md](../installation.md) — targets, manifest y configuración derivada.

No agregar aquí agentes no registrados, Archivist, classifier activo por defecto, `.workspace` como workspace operativo, skill registry retirado ni archivos inexistentes.
