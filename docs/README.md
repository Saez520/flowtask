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
- [Skills](./architecture/integracion-skills.md)

## Histórico

- [Historial](./project-history.md)

## Fuentes ejecutables

- `.flowtask/agents/` — contratos del runner y subagentes.
- `.flowtask/commands/` — comandos instalables.
- `.flowtask/skills/` — protocolos cargables.
- `.flowtask/plugins/flowtask-plugins.json` — manifiesto.
- `.flowtask/bin/` — CLI e instalador.
- `.flowtask/scripts/` — scripts operativos.

Si una afirmación contradice CLI, instalador, manifiesto o contratos instalables, prevalece el código y el conflicto se corrige o se registra en `project-history`.
