# Documentación de FlowTask

Esta carpeta separa operación vigente de diseños retirados. La fuente de verdad de contratos sigue siendo `.flowtask` y la configuración del target instalado.

## Empezar

- [README](../README.md)
- [Instalación y actualización](./installation.md)
- [Modelo técnico vigente](./core-flowtask.md)
- [Permission Gate](./permission-gate.md)

## Arquitectura vigente

- [Índice](./architecture/INDEX.md)
- [Handshake](./architecture/handshake.md)
- [Worktrees](./architecture/worktree.md)
- [Worktree Manager documentation](./worktree-manager/README.md) — English inventory, interfaces, operations, compatibility, and release procedure.
- [Skills](./architecture/integracion-skills.md)

## Roadmap

- [Plan de implementación — Agent Loop y Hermes](./roadmap/agent-loop-hermes.md) — fases, dependencias, gates de Hermes y convención de commits.

## Histórico

- [Historial](./project-history.md)

## Fuentes ejecutables

- `.flowtask/agents/` — contratos del runner y subagentes.
- `.flowtask/commands/` — comandos instalables.
- `.flowtask/skills/` — protocolos cargables.
- `.flowtask/plugins/flowtask-plugins.json` — manifiesto.
- `.flowtask/plugins/agent-model-selector/` — submodule del selector de modelos agnóstico.
- `.flowtask/bin/` — CLI e instalador.
- `.flowtask/scripts/` — scripts operativos.

Si una afirmación contradice CLI, instalador, manifiesto o contratos instalables, prevalece el código y el conflicto se corrige o se registra en `project-history`.
