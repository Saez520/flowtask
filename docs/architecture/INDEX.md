# Current architecture — FlowTask

This index contains current references, not a Repomix snapshot. Retired designs are in [../project-history.md](../project-history.md).

## Operational references

- [handshake.md](./handshake.md) — identity, continuity, and checkpoints; compare with `.flowtask/agents/runner.md` and `handshake-protocol`.
- [autonomia-operativa.md](./autonomia-operativa.md) — progress by policy, pause by exception, and recorded policy decisions; compare with `.flowtask/agents/runner.md` and `agent-loop-run`.
- [capas-persona-autonomia-permisos.md](./capas-persona-autonomia-permisos.md) — the three stored layers (persona, autonomy, permissions), their per-layer resolution, the `permissions > autonomy > persona` precedence, and per-layer failure; compare with `autonomia-operativa.md` and `../permission-gate.md`.
- [orquestacion-paralela.md](./orquestacion-paralela.md) — verifiable independence, bounded batch, visible queue, and conflict containment; compare with `.flowtask/skills/parallel-orchestration/SKILL.md` and `.flowtask/agents/runner.md`.
- [validacion.md](./validacion.md) — live validation, executed evidence, and a single verdict; compare with `.flowtask/agents/validator.md` and `validation-contract`.
- [pruebas-condicionales.md](./pruebas-condicionales.md) — gap-driven tests, 1/3/0 budget, and report inheritance; compare with `.flowtask/agents/tester.md`, `.flowtask/agents/runner.md`, and `.flowtask/agents/validator.md`.
- [verificacion-material.md](./verificacion-material.md) — material verification, citable evidence, and inheritance across roles; compare with `.flowtask/skills/zero-assumptions/SKILL.md`.
- [contexto-degradacion.md](./contexto-degradacion.md) — degradation by levels, rules by moment, and verifiable recovery; compare with `.flowtask/skills/context-degradation/SKILL.md` and `.flowtask/agents/runner.md`.
- [worktree.md](./worktree.md) — create, complete, cleanup, recover, prune, list, and target-direct; compare with `.flowtask/scripts/worktree.sh` and `.flowtask/scripts/worktree-manager/`.
- [integracion-skills.md](./integracion-skills.md) — direct loading from `.flowtask/skills` through `skill({ name: ... })`.
- [Worktree Manager documentation](../worktree-manager/README.md) — English architecture and release documentation for the implemented manager.

## Related references

- [../core-flowtask.md](../core-flowtask.md) — CA, hotfix, Graphify, and plugins.
- [../permission-gate.md](../permission-gate.md) — permissions and review-stamp.
- [../installation.md](../installation.md) — targets, manifest, and derived configuration.

Do not add unregistered agents, Archivist, classifier enabled by default, `.workspace` as an operational workspace, retired skill registry, or nonexistent files here.
