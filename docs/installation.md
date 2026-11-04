# Installation and update

FlowTask operational guide. The current version lives in `.flowtask/package.json`. The CLI source is `.flowtask/bin/flowtask.js` and the installer/updater is in `.flowtask/bin/lib/installer.js`.

## Requirements

Git, Node.js, npm, and an interactive terminal. OpenCode, Claude Code, or VS Code are only required for the chosen target. Engram is checked and reported by the installer, but it is not installed automatically. The worktree manager requires Python 3.9 or later.

## Install the CLI

Use the repository's official URL, without inventing it in the documentation:

```bash
git clone <FLOWTASK_REPOSITORY_URL>
cd FlowTask/.flowtask
npm link
flowtask --version
```

## Install in a project

From the consumer root:

```bash
flowtask install
```

The installer interactively selects OpenCode, VS Code, and Claude Code targets. One or more can be checked; confirming without checking any installs standalone in `.flowtask/`. It then selects a personality: `training`, `mid`, `senior`, or `custom`. `--persona` skips personality selection, not target selection; without a TTY the installation fails explicitly.

During `install` it copies resources, skills, and scripts; for Claude it generates agents, commands, settings, MCP, `session-start.md`, and `CLAUDE.md`; for OpenCode it installs plugins from the manifest in `.opencode/plugins` and generates `.opencode/opencode.json` and `.opencode/tui.json`; it writes `config/profile.json`, `config/review.json`, `config/autonomy.json`, `config/permissions.json`, and `.installation-method` in the target; and it coordinates Graphify/ferris-search according to the installer's questions.

## Target configuration layers

Each installed target receives three configuration layers in `<target>/config/`:

| File | Layer | Values |
|---------|------|---------|
| `profile.json` | Persona (tone) | `level`: `training`, `mid`, `senior`, or `custom`; `persona`: tone identity; `onboarded`: onboarding status. |
| `autonomy.json` | Autonomy (initiative) | `version`: `1`; `profile`: `assistant`, `autonomous-dev`, or `hermes`. |
| `permissions.json` | Permissions (technical authority) | `version`: `1`; `envelope`: `standard`. |

`install` and `update` create `autonomy.json` and `permissions.json` only when the
layer does not exist, with `autonomous-dev` and `standard` as installation values,
so that the installed system keeps working. That default is a migration, not a
runtime fallback: at runtime, a missing or invalid layer is a failure with an
operational message. An invalid layer is never repaired with a default — the
operation fails and the file is preserved. `profile.json` keeps its current shape,
and a missing or invalid persona leaves a warning without altering autonomy or
permissions.

Layer precedence is `permissions > autonomy > persona`. To inspect the resolved
layers of a target:

```bash
flowtask layers resolve --target opencode
flowtask layers resolve --json
```

The full contract is in
[architecture/persona-autonomy-permissions-layers.md](architecture/persona-autonomy-permissions-layers.md).

## Targets

| Target | Installation | Derived files |
| --- | --- | --- |
| OpenCode | `.opencode/flowtask/` and `.opencode/skills/` | `.opencode/opencode.json`, `.opencode/tui.json`, `.opencode/plugins/` |
| Claude Code | `.claude/flowtask/` | `.claude/agents/`, `.claude/commands/`, `.claude/settings.json`, `.claude/session-start.md`, `.mcp.json`, `CLAUDE.md` |
| VS Code | `.vscode/flowtask/` | mirror of the VS Code target |
| Standalone | `.flowtask/` | agents, commands, skills, plugins, and scripts |

## Claude Code startup and skills

For a Claude Code target, `install` and `update` generate `.claude/session-start.md` and write the same startup block at the top of `CLAUDE.md`. The block asks a new session, without waiting for the user to request it, to load the Engram tools with ToolSearch, run `mem_context`, load project and personal heuristics, read the `investigacion`, `memory-protocol`, and `zero-assumptions` skills, and show the orchestrator identity line with the `{base_name}` placeholder resolved by the handshake.

The skill index is generated from the `## Skills disponibles` section of `runner.md`: every skill declared there is mapped to its installed `Read` path. The index does not list the whole skills directory. If a declared skill is missing from `.claude/flowtask/skills/`, generation fails with an error that names the missing skills.

`.claude/settings.json` receives a `SessionStart` hook that prints `.claude/session-start.md` through `cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"`, so the block also enters the session through the hook regardless of the working directory. The hook matcher covers `startup`, `resume`, `clear`, `compact`, and `fork`, so the startup context survives a lost or compacted context. The hook merge is additive and idempotent: it adds an entry only when the same matcher and command are absent, preserves hooks added by the user, and never replaces hook arrays through an object deep merge. If the existing `settings.json` or `.mcp.json` is not valid JSON, the installer reports the problem and leaves the file byte-identical instead of overwriting it.

`update` rewrites only the section delimited by `<!-- FLOWTASK:START -->` and `<!-- FLOWTASK:END -->` in `CLAUDE.md`; content outside those markers is preserved. The generated agents inherit no `model` field, so a model pinned in a generated agent comes from an external edit.

## Update

```bash
flowtask update
flowtask update --persona senior
```

`update` detects `.installation-method` markers, synchronizes the delta, preserves preservable paths, reinstalls plugins, regenerates configuration, and coordinates Graphify. Without a marker, run `install` first. On a Claude target it regenerates `CLAUDE.md`, `session-start.md`, and the skill index while preserving content outside the FlowTask markers; on OpenCode it regenerates the TUI declaration and cleans the legacy `tui.json` when it verifies the destination.

## Worktree Manager

The worktree manager is published once at the user's global level in
FlowTask's global directory (`$XDG_CONFIG_HOME/flowtask/worktree-manager`
or `~/.config/flowtask/worktree-manager`; on Windows `%APPDATA%/FlowTask/worktree-manager`).
The `.flowtask/scripts/worktree-manager/` submodule remains the source of the copy;
the consumer target receives no copy of the manager or the submodule.

The installer publishes a managed copy with an ownership marker
(`.flowtask-worktree-manager-owner.json`) that records the version, source
commit, and managed-file manifest. Destination classification is
`ABSENT`, `MANAGED`, `EXTERNAL`, or `AMBIGUOUS`; only the first two are published.
An `EXTERNAL` or `AMBIGUOUS` destination fails closed without modifying it.

`flowtask update` overwrites the managed copy, warns only when the version
changes, preserves unmanaged files, and deletes only files from the previous
manifest that no longer exist. An unmanaged file with the same name as a managed
one is overwritten because it belongs to the manifest.

Consumption resolves the copy in this order: global installation, consumer
repository, session directory. A valid checkout requires
`worktree_manager/__main__.py` and `worktree_manager/mcp_transport.py`. If no
location is valid, the operation fails with a message that names the expected
global path and the `flowtask install` action.

The standalone manager is published on npm as `worktree-for-agents`; it is installed
with npm or pnpm and does not expose a bin or `npx`. Its MCP publishes the seven operations
and the guide in `initialize.instructions`. The FlowTask integration keeps the
submodule and the global copy during the transition, and the bridge
`flowtask_worktree_consume` remains its surface. The npm package is
independent and coexists with the global copy; `node <package>/setup.mjs`
diagnoses which installation is active.

If the machine does not have a compatible Python (floor 3.9), the complete
installation is blocked with a diagnosis and a non-exit status, without leaving
partial state.

### Compatibility with previous installations

The `worktree.sh` entry point and the compatibility adapter remain available.
The generic configuration prevails: the path passed with `--config` and the
`.worktree-manager.conf` file are applied in that order, and the explicit path
excludes any read of the previous configuration.

The `.flowtask/config/worktree.json` file is read-only data. It is interpreted
only in two requests: a `complete --preserve-dirty` without `--config`, which
translates its `preserveDirty` value to `preserve_dirty=true` and declares the
applied compatibility through stderr; and an explicit `recover`, which imports a
previous transaction into the canonical state only once. An invalid previous
configuration blocks the operation with code 3 and mutates nothing. Recovery
never copies the canonical state back.

An identity conflict between the canonical transaction and the previous one blocks
the operation with code 5 and preserves both records. New installations do not
activate any previous path: no backup mirrors or inherited references are created.
No publication, definitive removal of the entry point, or unlimited compatibility
is announced; the deprecation phase comes later.

Installation does not expand permissions. The assistant consumes the manager with the
`flowtask_worktree_consume` tool; the manager's request protocol is not
authorized through the shell. See
[architecture/worktree.md](architecture/worktree.md) for the responsibility boundary and
[permission-gate.md](permission-gate.md) for consent.

## Plugins and Graphify

The manifest declares permission-gate, model-selector, and context-checkpoint; classifier-hook and classifier-tui are deprecated and disabled, so they are not installed by default. The context-checkpoint source gitlink may be empty if the submodule was not materialized, while a copy installed in `.opencode/plugins` belongs to the consumer project and does not prove the state of the source checkout.

Graphify is queried through `graphify_query_graph` via MCP. `flowtask graphify query --query <query>` only tests the deprecated shim and exits without querying locally.

## Diagnostics

```bash
flowtask --version
flowtask --help
git status --short
find .opencode/flowtask -maxdepth 2 -type f
find .opencode/plugins -maxdepth 2 -type f
```

Do not edit `opencode.json` manually to replace `update`. If there is no installation, run `install`; if there is a permissions/space error, fix it and retry `update`.
