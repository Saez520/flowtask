# FlowTask documentation

This folder separates current operation from retired designs. The source of truth for contracts remains `.flowtask` and the configuration of the installed target.

## Getting started

- [README](../README.md)
- [Installation and update](./installation.md)
- [Current technical model](./core-flowtask.md)
- [Permission Gate](./permission-gate.md)

## Current architecture

- [Index](./architecture/INDEX.md)
- [Handshake](./architecture/handshake.md)
- [Worktrees](./architecture/worktree.md)
- [Worktree Manager documentation](./worktree-manager/README.md) — English inventory, interfaces, operations, compatibility, and release procedure.
- [Skills](./architecture/integracion-skills.md)

## Roadmap

- [Implementation plan — Agent Loop and Hermes](./roadmap/agent-loop-hermes.md) — phases, dependencies, Hermes gates, and commit convention.

## Historical

- [History](./project-history.md)

## Executable sources

- `.flowtask/agents/` — runner and subagent contracts.
- `.flowtask/commands/` — installable commands.
- `.flowtask/skills/` — loadable protocols.
- `.flowtask/plugins/flowtask-plugins.json` — manifest.
- `.flowtask/plugins/agent-model-selector/` — submodule for the agnostic model selector.
- `.flowtask/bin/` — CLI and installer.
- `.flowtask/scripts/` — operational scripts.

If a statement contradicts the CLI, installer, manifest, or installable contracts, the code prevails and the conflict is corrected or recorded in `project-history`.
