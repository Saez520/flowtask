# FlowTask

FlowTask is an AI-assisted development workflow system. A runner receives the developer's conversation, investigates the repository, coordinates the appropriate flow, and preserves operational context in Engram.

It is not an isolated chatbot: it combines persistent memory, isolated execution through Git worktrees, validation, and an installable integration for OpenCode, Claude Code, and VS Code.

Current version: run `flowtask --version` (source: `.flowtask/package.json`).

## What it solves

- Keeps decisions, artifacts, and state across sessions through Engram.
- Isolates each CA or hotfix in its own worktree and branch.
- Enables conversational work without depending on legacy coordination commands.
- Installs and updates resources, plugins, and derived configuration as a delta.
- Includes review, permissions, runner personality, and Graphify support.

## How it is used

After installation, talk to the runner from the configured IDE. The runner identifies questions, changes, reviews, and agreed executions.

Commands in the installed environment: `/init-types`, `/init-data`, `/init-business`, `/init-config`, `/init-api`, `/onboard`, and `/update`. Reviews are requested by describing the scope or by using `/review` when the runtime supports it. An agreed hotfix runs when the runner has already persisted the diagnosis and the developer explicitly accepts the agreed correction.

## Getting started

1. See [docs/installation.md](docs/installation.md) to install or update.
2. Read [docs/README.md](docs/README.md) to choose documentation.
3. See [docs/core-flowtask.md](docs/core-flowtask.md) for the technical model.
4. See [docs/permission-gate.md](docs/permission-gate.md) for permissions and review-stamps.
5. See [docs/project-history.md](docs/project-history.md) for retired or legacy elements.

## Minimal structure

`.flowtask/` — canonical source for the CLI, contracts, and plugins.

`.opencode/` — OpenCode installation/configuration, if applicable.

`.claude/` — Claude Code installation/configuration, if applicable.

`.vscode/` — VS Code installation/configuration, if applicable.

`docs/` — public documentation.

`graphify-out/` — Graphify outputs when generated.

## License

MIT
