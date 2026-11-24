# Installation and update

FlowTask operational guide. The current version lives in `.flowtask/package.json`. The CLI source is `.flowtask/bin/flowtask.js` and the installer/updater is in `.flowtask/bin/lib/installer.js`.

## Requirements

Git, Node.js, npm, and an interactive terminal. OpenCode, Claude Code, or VS Code are only required for the chosen target. Engram is checked and reported by the installer, but it is not installed automatically. Python 3.9 or later is optional: it enables the worktree manager, and FlowTask installs and updates without it.

## Install the CLI

Use the repository's official URL, without inventing it in the documentation:

```bash
git clone <FLOWTASK_REPOSITORY_URL>
cd FlowTask/.flowtask
npm link
flowtask --version
```

## Install FlowTask for Claude Code

Claude Code uses a single runtime per operating-system account, not a copy per
project. From the consumer project:

```bash
flowtask install --target claude --persona senior
flowtask install --target claude --autonomy autonomous-dev
```

`--target` selects the target explicitly and accepts a repeated flag or a
comma-separated list. Without a TTY, `install` fails unless `--target` is
provided. `--persona` accepts `training`, `mid`, `senior`, or `custom`; it is
optional and there is no tone question.

`--autonomy` accepts `assistant` or `autonomous-dev`. It is the only explicit
choice that raises the installation default; without the flag, a valid layer is
preserved and an absent one receives `assistant`. The same flag is available for
`flowtask update`.

`--allow-engram-tools` is available for `install` and `update`. Without it,
Claude Code asks for approval the first time a session calls an Engram tool.
With it, `install` adds `mcp__engram__*` to the user-level
`permissions.allow` list; the merge is additive and idempotent, so existing
rules and every other key are preserved.

The first installation in the account creates the user-level runtime and
registers the current project. Running the same command in another project
reuses the existing runtime and only adds the new registration. With
`--global`, the command installs or refreshes only the runtime, the layers, the
global surfaces, and the user plugins; it does not register the project. The
same flag is available for `flowtask update`.

### The single installation question

When a target has no autonomy layer, an interactive installation asks one
question: `How much initiative should FlowTask take on this machine?`. The first
option, recommended and selected by default, is to wait for an explicit
go-ahead for every job; the second lets FlowTask start work on its own. The
prompt uses product language only and never shows internal values, layer names,
or paths. The answer applies only to layers that are absent.

The question is skipped for a valid layer, when `--autonomy` is provided, or
when no interactive terminal is available. In those cases a valid layer is
preserved and an absent layer receives `assistant`. `--autonomy` overwrites a
valid choice; it never repairs an invalid layer.

### Preflight and rollback

Before writing, `install` and `update` validate the user-level autonomy and
permissions layers. An invalid layer fails the operation with the operational
message, preserves the file byte for byte, and does not write a registration.

Managed surfaces are captured before they are written. A failure in any target
aborts the whole operation, restores the captured configuration and files, and
removes the transaction backups. The command exits non-zero, reports the cause,
and asks the developer to retry with `flowtask install` (or `flowtask update`)
and to add `--verbose` for diagnostics. Optional web search and Graphify
coordination keep their non-fatal behavior and stay outside the transaction.

### User-level runtime

The runtime lives once per operating-system account under FlowTask's global
configuration directory: `$XDG_CONFIG_HOME/flowtask` or `~/.config/flowtask` on
macOS and Linux, and `%APPDATA%/FlowTask` on Windows. Claude Code's
`CLAUDE_CONFIG_DIR` only changes the Claude-specific surfaces (settings and
agents), not the runtime location.

The layout is:

```text
<global-config>/flowtask/
├── runtime.json              # schema 2 manifest: payloads, previous versions, plugins, targets
├── projects.json             # registered project index by real path and destinations
├── bin/session-start.mjs     # stable SessionStart launcher for Claude Code
├── config/
│   ├── profile.json          # one persona per user
│   ├── autonomy.json
│   ├── permissions.json
│   └── identity.json         # base name shown by the runner identity
├── plugins/
│   └── <plugin-name>/        # local user-scope plugins with an ownership marker; npm-distributed plugins are not copied
└── versions/
    └── <version>-<hash12>/   # runner, agents, commands, skills, scripts, bin/lib
```

The manifest declares two payload variants per version: `canonical` (OpenCode,
VS Code, and standalone) and `claude`. Each variant keeps its own files and
digests. The payload id is derived from the version, the source digests, and the
persona/autonomy descriptor; the generated runner and startup document are
excluded so the id never depends on their content or location.

Payloads are staged under `versions/.staging-*` and published with a rename.
`runtime.json` is replaced atomically, so an open session keeps the payload it
already loaded and the next session reads the new payload as a whole. The
previous payload of each variant is retained until the next update; no project
pins a version. The runtime is self-sufficient: skills, scripts, agents,
commands, and helper modules resolve from the payload with absolute paths.

The Claude-specific user surfaces remain in the Claude user directory:

```text
<claude-user-dir>/agents/flowtask-runner.md   # main-thread runner agent
<claude-user-dir>/settings.json               # SessionStart hook
```

### Project registration

A project is registered by a small file inside an ignored folder. The rule is
the same for every destination:

| Target | Registration folder |
| --- | --- |
| Claude Code | `<project>/.claude/flowtask/` |
| OpenCode | `<project>/.opencode/flowtask/` |
| VS Code | `<project>/.vscode/flowtask/` |
| Standalone | `<project>/.flowtask/` |

```text
<registration-folder>/
├── .gitignore      # contains "*"
└── project.json    # schema, real project path, registration date and runtime version
```

`project.json` is the only condition that activates FlowTask in a project. A
registration copied from another project does not activate because the stored
real path does not match. The global index records the real path and the
destinations that registered it; it is rebuilt from the registrations that still
exist on install and update.

Registration never copies the engine. Claude Code additionally materializes what
it discovers per project:

- agent definitions in `.claude/agents/flowtask-*.md`;
- commands in `.claude/commands/`;
- the `agent: "flowtask-runner"` key in `.claude/settings.local.json`.

OpenCode and the other destinations keep only the registration and a generated
`config/review.json`; their agents, skills, and plugins are discovered from the
global runtime configuration.

`.claude/settings.local.json` is the personal settings file of the project and
is not committed. The installer writes only the `agent` key there and preserves
every other key. `.claude/settings.json` is never written by FlowTask.

Generated agents and commands carry the exact marker
`<!-- FLOWTASK:MANAGED v1 -->`. A pre-existing command without that marker is
adopted when its content matches exactly the form generated by previous
versions (the same command without the marker line); it then receives the
marker and is managed from that point on. A command whose content differs is
preserved and reported. Agents named `flowtask-*` belong to FlowTask. The
runtime is never copied into the project. The installer does not write
`CLAUDE.md`, project hooks, or project MCP servers; the only project
configuration it writes is the `agent` key in the local settings file.

Generated agent definitions do not invoke the platform skill tool. Each skill
declaration in an agent body is rendered as a direct read of the file inside the
active runtime payload
(`<global-config>/flowtask/versions/<payload-id>/skills/<skill>/SKILL.md`);
canonical `.flowtask/skills/...` references are rewritten to the same payload.
Skills named only as catalog entries are listed at the end of the agent with
their absolute paths, and every generated agent states that a failed read must
be declared. When a declared skill is not installed in the payload, generation
stops and reports the skill and the agent that declared it
without writing a partial agent set.

The registration folder is ignored by its own `.gitignore`. Materialized agents,
commands, and the local settings file are added to `.git/info/exclude` when they
are not already ignored. The repository root `.gitignore` is never modified. If
the exclude file cannot
be updated, registration continues and reports the condition.

### Startup hook and gate

`install` adds one `SessionStart` handler to the user-level
`~/.claude/settings.json`, with the matcher
`^(startup|resume|clear|compact|fork)$`. The handler runs the stable launcher
with the Node.js executable used at installation time; it does not depend on
the PATH of a graphical application.

The launcher:

1. ignores subagent sessions;
2. resolves `$CLAUDE_PROJECT_DIR`, or the nearest registered ancestor;
3. validates the registration and its real path;
4. stays silent when the project is not registered;
5. emits the startup block, the skill index, and the pointer to read the
   runner from the runtime when the project is registered.

The hook payload is capped at 10,000 bytes by Claude Code. FlowTask fails the
installation if the generated startup document reaches that limit. The runner
is not emitted by the hook: the block instructs the session to read the
adapted runner from the payload. A missing runtime or an unsupported
registration schema produces one actionable line and the session continues.

The hook merge is additive and idempotent: it adds only the FlowTask command,
preserves every other hook and top-level setting, and never replaces hook
arrays through an object merge. `update` and `uninstall` remove only the
FlowTask command.

### Runner anchoring

`install` and `update` generate `~/.claude/agents/flowtask-runner.md` from the
active runtime payload and add `agent: "flowtask-runner"` to the project's
`.claude/settings.local.json`. Claude Code applies that user-level agent to the
main thread, so the runner role is the system prompt from the first turn: the
session does not need to read the runner file or wait for the developer to ask
for the personality.

The generated system prompt composes three parts:

- an anchoring contract that requires loading the Engram tools, running
  `mem_context`, loading heuristics, reading the startup skills, and showing
  `[capa: orquestador] <base name>`; the same contract declares a missing memory
  source and stops instead of continuing with another source;
- the adapted runner body: platform metadata is stripped, skill calls become
  absolute `Read` paths inside the active payload, and skills named without a
  call receive an appendix with their path;
- the runner constraints that already live in the canonical body.

The SessionStart hook remains active as a backup and as the skill index. Its
pointer to read the runner is not required when the session is already running as
`flowtask-runner`.

The base name is stored once per installation in
`<global-config>/flowtask/config/identity.json`:

```json
{"version":1,"baseName":"Aitana"}
```

Edit `baseName` and run `flowtask update` to regenerate the agent. The value must
be 1-40 letters, marks, apostrophes, spaces, or hyphens, and the name `Hermes` is
reserved. An invalid file fails the operation without being overwritten.

An existing `flowtask-runner.md` without the FlowTask marker, a different
`agent` value, and a malformed `.claude/settings.local.json` are preserved and
reported. In those cases the project is not activated as runner until the
condition is resolved; the hook keeps providing the startup index.

Manual verification:

1. **First turn in a registered project.** Confirm
   `.claude/flowtask/project.json`, `agent: "flowtask-runner"` in
   `.claude/settings.local.json`, and `~/.claude/agents/flowtask-runner.md`. Open
   a new session and send `hola`; the first response starts with
   `[capa: orquestador] Aitana` (or the configured name). In
   `~/.claude/projects/<project-slug>/<session-id>.jsonl`, no read of the runtime
   `runner.md` happens before that response.
2. **Memory before the repository.** In a new session, ask for the repository
   status. In the JSONL, the first tool after the request is
   `mcp__engram__mem_context` (ToolSearch may come first); no Bash, Read, Grep, or
   Glob precedes it.
3. **Declared missing memory.** In a disposable environment
   (`CLAUDE_CONFIG_DIR=$(mktemp -d)`), install FlowTask, remove the user-scope
   Engram server (`claude mcp remove --scope user engram`), open a session, and
   send `hola`. The response contains
   `⛔ Fuente no disponible: memoria del proyecto (Engram). No continúo sin ella. Para reanudar: verificá el registro MCP de Engram y volvé a intentar.`
   and does not run git or read documentation.
4. **Unregistered project.** Open a session in a temporary Git repository
   without `flowtask install`; the runner identity does not appear.
5. **Identity propagation.** Change `baseName` in `identity.json`, run
   `flowtask update`, open a new session, and confirm the new name in the first
   response.

### Engram MCP

Engram is registered once in the user scope through the official Claude Code
CLI:

```bash
claude mcp add --scope user engram -- engram mcp
```

FlowTask verifies the scope before and after adding. If the CLI is unavailable
or the write fails, the installation continues with a warning: it does not edit
`~/.claude.json` on its own and reports the exact command to register Engram
manually. A pre-existing user-scope registration is preserved and is not
removed by `uninstall`.

Project-owned servers such as Graphify remain in the project `.mcp.json`.
FlowTask does not merge `~/.claude.json` and does not write `mcpServers` into
`settings.json`.

### Tool permissions

FlowTask does not pre-approve MCP tools by default. In the `default` permission
mode, Claude Code discovers the Engram tools but asks for approval before the
first call; a headless session cannot answer that prompt. `flowtask install
--allow-engram-tools` (or `flowtask update --allow-engram-tools`) adds the
`mcp__engram__*` wildcard to the user-level `permissions.allow` list.

The merge preserves every existing rule and top-level setting, adds the
wildcard only when it is absent, and does not rewrite the file when nothing
changes. If the settings file is malformed, or `permissions` or
`permissions.allow` has an unexpected shape, FlowTask fails without overwriting
it. Once accepted, the rule belongs to the user configuration: `uninstall`
removes the FlowTask hook but leaves the allowlist entry in place.

### Update

```bash
flowtask update
flowtask update --persona senior
flowtask update --allow-engram-tools
flowtask update --verbose
```

`update` refreshes the user-level runtime once and refreshes the current project
when it is registered or carries a legacy installation. In an unregistered
project it updates the global installation and reports that the project was not
registered; it never registers a project on its own. Repeated updates do not
duplicate the hook, the MCP entry, the agents, or the registration. The
registration keeps its original `registeredAt` value.

`update` compares every managed copy by content, not by size or modification
time. A managed file edited by hand is restored to its canonical copy and its
path is reported; a file that already matches is counted as unchanged. The
comparison covers the runtime payloads and launcher, the user plugins, the
project registration, the generated `review.json`, and the generated Claude
agents and commands. A difference outside the expected content restores the file
and reports it.

These surfaces are preserved and never reported as restored: `CA-*` workspaces,
`workspace/`, `.workspace/`, valid persona, autonomy and permissions layers, and
user files inside a registration folder. The runtime lives outside the project,
so its restored paths are reported as absolute paths. An absent, unreadable or
incompatible runtime manifest fails closed: FlowTask does not overwrite a runtime
without ownership evidence.

By default the command prints a framed dashboard of fixed width: one row per
phase with its elapsed time and state, one row per environment under `sync` with
the restored, updated and unchanged counts, each restored path below the rows
with the `↺` glyph and the `<target>: <path>` prefix, warnings and errors
grouped inside the frame, and a footer with the environment and warning counts,
the total time, and a final status badge. A managed mirror that cannot be
verified ends the update as a failed result to review; it is never reported as
`COMPLETE`. Without an interactive terminal, with `NO_COLOR` or with `TERM=dumb`,
the same dashboard is printed without color or ANSI escape sequences. `--verbose`
prints the per-step detail for every target instead, including the restored
files.

### Claude Code model selector

When the Claude target is selected during `install` or the project is registered
with Claude Code, the same run installs the `flowtask-model` plugin from the
marketplace published by the selector submodule. FlowTask calls the plugin
manager at user scope with the marketplace root of the pinned submodule, so the
plugin is added to the user plugin store under `~/.claude` and no file is copied
into the project. The installed version is the submodule pin declared by the
manifest entry `marketplaceRoot`, and the entrypoint is validated inside the
marketplace source before installing.

The manager calls behind that step are the documented ones:

```bash
claude plugin marketplace add <flowtask-dir>/plugins/agent-model-selector --scope user
claude plugin install flowtask-model@agent-model-selector --scope user
claude plugin update flowtask-model@agent-model-selector --scope user
```

A failure is reported with its cause and next action, does not count as an
update failure, and leaves the rest of the target intact; the dashboard adds a
`selector` row in the `warn` state. Running `flowtask update` again retries the
operation.

A machine without FlowTask installs the same plugin from the public repository:

```bash
claude plugin marketplace add Saez520/agent-model-selector
claude plugin install flowtask-model@agent-model-selector
```

Remove the plugin with
`claude plugin uninstall flowtask-model@agent-model-selector`.

### Uninstall

```bash
flowtask uninstall --yes
flowtask uninstall --project --yes
```

The global form removes the runtime, the user plugins, the FlowTask hook, the
Engram registration that FlowTask added, the OpenCode user surface, and the
registrations and generated files of every project listed in the index. It stops
before deleting the runtime when a project cannot be cleaned, so no project is
left pointing at a missing runtime. It removes
`~/.claude/agents/flowtask-runner.md` only when no project still references it;
a preserved key (a different value or malformed settings) keeps the agent and
produces a warning. User hooks, user skills, user agents, user plugins, user
commands, and user MCP servers are preserved. If the MCP removal fails, the
runtime and its manifest are preserved so the operation can be retried with
`flowtask update` or the reported command.

`--project` removes only the current project registration for every destination,
its generated files, and the `agent` key from `.claude/settings.local.json` (the
file is removed when no other keys remain). The runtime, the user-level agent,
and other projects keep working. Without `--yes`, an interactive confirmation is
required; without a TTY and without `--yes`, the command fails with the required
action.

### Migration from per-project installations

Installations that copied the runtime into a project are migrated
conservatively. The migration:

- creates or reuses the user-level runtime;
- copies `profile.json`, `autonomy.json`, and `permissions.json` to the global
  configuration only when the destination is missing, validating them first;
- removes a legacy `profile.json`, `autonomy.json`, or `permissions.json` when
  the global layer already exists and is valid, even if its content differs:
  the user-level layer is authoritative and the legacy copy is never a runtime
  source;
- preserves a legacy layer only when that layer or its global destination is
  invalid, and reports it for manual review;
- registers the project;
- removes legacy `skills/`, `scripts/`, `agents/`, `commands/`, the installation
  marker, and the generated `.claude/session-start.md`;
- removes only `profile.json`, `autonomy.json`, `permissions.json`, and
  `review.json` from the legacy configuration folder, preserving
  `graphify.json` and unknown files;
- removes the exact legacy hook
  `cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"` from project settings,
  preserving every other hook;
- removes the `<!-- FLOWTASK:START -->` block from `CLAUDE.md`, preserving text
  outside the markers;
- removes `mcpServers.engram` from `.mcp.json` only when it matches the FlowTask
  template exactly, preserving Graphify and other servers.

Malformed settings or MCP files are not overwritten; the migration reports
them for manual review. Repeating the migration produces no new changes.

## Other targets

OpenCode, VS Code, and standalone use the same user-level runtime and the same
registration rule. They can be selected explicitly with `--target opencode`,
`--target vscode`, or `--target standalone`.

| Target | Global surface | Project files |
| --- | --- | --- |
| OpenCode | `<global-config>/flowtask/` plus `<opencode-config>/opencode.json` | `.opencode/flowtask/project.json`, generated review, model selector |
| Claude Code | `<global-config>/flowtask/` plus `<claude-user-dir>/settings.json` and `agents/flowtask-runner.md` | `.claude/flowtask/project.json`, generated agents and commands |
| VS Code | `<global-config>/flowtask/` | `.vscode/flowtask/project.json`, generated review |
| Standalone | `<global-config>/flowtask/` | `.flowtask/project.json`, generated review |

None of these targets copies the engine into the project. The OpenCode global
configuration declares the FlowTask agents with their payload paths, the payload
skills directory, the global permission gate by npm package spec and the local
context checkpoint plugin, the FlowTask commands, the default agent only when
absent, and the Engram MCP only when absent. A consumer's own agents, skills,
plugins, commands, MCP servers, and settings are preserved. A JSONC OpenCode
configuration fails closed without writing.

The permission gate is registered as the npm package
`flowtask-permission-gate@^2.0.0`; OpenCode resolves and caches it on the first
load, so that load needs access to the npm registry. The context checkpoint is
installed once in `<global-config>/flowtask/plugins/flowtask-context-checkpoint`
and registered from there. The model selector remains a project plugin. Claude
Code installs its model selector at user scope and keeps it in the plugins store
under `~/.claude`, not in the project.

OpenCode is also the only target that offers the web search MCP, installed once
per user as described in [Web search MCP (OpenCode only)](#web-search-mcp-opencode-only).

## Web search MCP (OpenCode only)

OpenCode can install a web search MCP that remains available across every
project in the operating-system account. The offer appears only when OpenCode is
one of the selected or detected targets. Claude Code, VS Code, and standalone
installations never offer it and never receive the entry.

The MCP is installed once per user:

- Configuration: `~/.config/opencode/opencode.json`.
- Binary: `~/.opencode/bin/ferris-search` (`ferris-search.exe` on Windows).

The first interactive installation asks once whether to install it. If the entry
already exists in the user configuration, FlowTask preserves it, even when it is
disabled, and does not ask again. Without a TTY the offer is skipped and the
omission is reported.

Both `install` and `update` reconcile the two surfaces: they keep a single copy
in the user configuration and remove any project-local `mcp.ferris-search` entry
from the OpenCode configuration. The run reports whether the user-level entry
was configured or installed and whether the local copy was retired or was
already absent.

When the user-level write cannot complete, the command shows the cause and the
next action, continues without web search, and leaves the project installation
registered. The next `flowtask update` retries the user-level installation.

## Configuration layers

Persona (tone), autonomy (initiative), and permissions (technical envelope) live
once per user in `<global-config>/flowtask/config/`. The installer does not offer
a per-project override.

| File | Layer | Values |
|---------|------|---------|
| `profile.json` | Persona (tone) | `level`: `training`, `mid`, `senior`, or `custom`; `persona`: `tutor-training`, `tutor-mid`, `tutor-senior`, or `custom`; `onboarded`: onboarding status; `quiz_completed_at`: ISO-8601 date or `null`; `stack_snapshot`: stack object or `null`; `quiz_answers`: quiz history array. |
| `autonomy.json` | Autonomy (initiative) | `version`: `1`; `profile`: `assistant` or `autonomous-dev`. |
| `permissions.json` | Permissions (technical authority) | `version`: `1`; `envelope`: `standard`. |

`install` and `update` create `autonomy.json` and `permissions.json` only when the
layer does not exist, with `assistant` and `standard` as installation values.
`assistant` is the lowest authority: the installed system waits for an explicit
order per job. A valid layer is preserved; an explicit `--autonomy` choice
overwrites a valid layer with the selected value, and the interactive answer
applies only to absent layers. That default is a migration, not a runtime
fallback: at runtime, a missing or invalid layer is a failure with an
operational message. An invalid layer is never repaired with a default — the
operation fails and the file is preserved. `profile.json` uses the six-field
shape, and a missing or invalid persona — including a tutor without its file or
a custom persona without text — leaves a visible warning and continues without
tone, without altering autonomy or permissions. An old three-field profile is
preserved with the missing quiz fields empty, and extra top-level keys survive
on disk.

The resolver combines three logical sources: a project definition when present,
then the user configuration, then a team base. Fields are never mixed between
sources. The installer and the onboarder write only the user configuration.
`authority status` and `repair` read and restore that same directory.

Layer precedence is `permissions > autonomy > persona`. To inspect the resolved
layers:

```bash
flowtask layers resolve
flowtask layers resolve --target opencode
flowtask layers resolve --json
```

Every target resolves the same user configuration; `--json` includes `configDir`
and reports `source: "user"` when no project or team layer overrides it.

The full contract is in
[architecture/persona-autonomy-permissions-layers.md](architecture/persona-autonomy-permissions-layers.md).

## Update for other targets

```bash
flowtask update
flowtask update --global
flowtask update --persona senior
```

`update` detects destinations from their registrations and legacy markers and
refreshes the user runtime, the layers, the OpenCode user surface, the Claude
user surfaces, and the user plugins once. It then refreshes the current project
registration when one exists; an unregistered project only receives the global
update and a warning. For OpenCode, `update` also retries the user-level web
search installation described above. If no installation is found, run `install`
first. A second update leaves the same runtime, configuration, and
registrations.

## Worktree Manager

The installer downloads the worktree manager from the public npm registry as
`worktree-for-agents@latest` and publishes it once at the user's global level in
FlowTask's global directory (`$XDG_CONFIG_HOME/flowtask/worktree-manager`
or `~/.config/flowtask/worktree-manager`; on Windows `%APPDATA%/FlowTask/worktree-manager`).
The consumer target receives no copy of the manager.

The published copy is managed with an ownership marker
(`.flowtask-worktree-manager-owner.json`) that records `source: "npm"`, the
installed version, and the managed-file manifest. Destination classification is
`ABSENT`, `MANAGED`, `EXTERNAL`, or `AMBIGUOUS`; only the first two are published.
An `EXTERNAL` or `AMBIGUOUS` destination fails closed without modifying it. A
managed copy published with `source: "submodule"` is overwritten and its marker
records the npm origin.

`flowtask update` overwrites the managed copy, warns only when the version
changes, preserves unmanaged files, and deletes only files from the previous
manifest that no longer exist. An unmanaged file with the same name as a managed
one is overwritten because it belongs to the manifest.

Consumption resolves the manager only from the global installation. A valid
installation requires `worktree_manager/__main__.py` and
`worktree_manager/mcp_transport.py`. If the global copy is missing or broken,
the operation fails with a message that names the expected global path and the
`flowtask install` action.

When the MCP probe succeeds, `install` and `update` register the server once in
the user scope: `mcp.worktree_manager` in the OpenCode user configuration and
the `worktree_manager` user-scope entry in Claude Code. The entry uses the
Python interpreter resolved on the machine — `py -3`, `python3`, or `python` on
Windows, and `python3` or `python` on macOS and Linux — with
`-m worktree_manager.mcp_transport` and the managed global directory on
`PYTHONPATH`. The OpenCode entry writes the absolute path of the interpreter, so
the server does not depend on `PATH` or on the working directory. A Store app
execution alias is never accepted as Python: it is probed first, and only a
real 3.9+ interpreter is registered. When the Claude Code CLI is unavailable,
the entry is merged into the user state file with a backup and a read-back
verification. A foreign `worktree_manager` entry is preserved with a warning;
an unreadable or invalid document is not modified.

`install --global` and `update --global` prepare the manager and register the
user-scope MCP without writing any project file. A project `install` or `update`
ensures the same user-scope registration and then removes the managed
`worktree_manager` entry from the project's `.opencode/opencode.json` and
`.mcp.json`. The project entry is removed only when the user-scope entry is
confirmed as managed by FlowTask; a failed registration or a preserved foreign
entry keeps the project entry and emits the corresponding warning. The
migration is idempotent and a later `update` retries it.

The standalone manager is published on npm as `worktree-for-agents`; it does not
expose a bin or `npx`. Its MCP publishes the seven operations and the guide in
`initialize.instructions`. The Runner consumes those seven tools directly. The
standalone CLI remains an external contract of the package; FlowTask does not
ship or consume a shell entrypoint for it.

If the download fails because the registry is unreachable or the package is
incomplete, `install` and `update` continue with the rest of the installation
and warn that worktrees are not available, with the cause and the required
action (`flowtask update` when the registry is reachable). A failed update leaves
the previous copy untouched.

If the machine does not have a usable Python 3.9+ (including the case where
only a Microsoft Store app execution alias exists), `install` and `update`
continue with the rest of the installation and warn that worktrees are not
available, with the cause and the required action: install Python 3.9+ and run
`flowtask update`. No manager copy is published when the interpreter does not
respond, so a broken copy never replaces a valid one; an update leaves the
previous copy untouched.

### Standalone compatibility

FlowTask ships no consumer `worktree.sh` entrypoint and no adapter. The
standalone CLI and its compatibility contract are documented in the package;
they are not a FlowTask consumption path.

The `.flowtask/config/worktree.json` file stays read-only data: the Runner reads
its `preserveDirty` value to decide whether to pass `preserve_dirty: true` to
`worktree_complete`. It never writes the file. Legacy transaction import and
configuration translation belong to the standalone CLI contract and are not
performed by FlowTask.

Windows is a release gate: the manager acquisition, the user-scope registration
in OpenCode and Claude Code, and the removal of the per-project entry must be
verified on a Windows machine before publishing.

Installation does not expand permissions. The Runner consumes the manager through the
seven tools of its MCP server; the manager's request protocol is not
authorized through the shell. See
[architecture/worktree.md](architecture/worktree.md) for the responsibility boundary and
[permission-gate.md](permission-gate.md) for consent.

## Plugins and Graphify

The manifest declares permission-gate, model-selector, and context-checkpoint; classifier-hook and classifier-tui are deprecated and disabled, so they are not installed by default. The permission gate is a user-scope plugin distributed as the npm package `flowtask-permission-gate@^2.0.0`: the OpenCode user configuration registers a single `{"package": "flowtask-permission-gate@^2.0.0", "options": {...}}` entry, and the installer never copies it into the runtime. The context checkpoint remains a user-scope local plugin: installation copies it once into `<global-config>/flowtask/plugins/flowtask-context-checkpoint`, writes its ownership marker, verifies the copy, and registers a single global `{"package": "<absolute path>", "options": {...}}` entry. A directory without the marker is preserved and reported.

`install` and `update` migrate an existing installation: the old absolute gate entry is replaced by the npm spec, and an owned copy under `<global-config>/flowtask/plugins/flowtask-permission-gate` is removed. A directory at that path without the FlowTask marker is preserved. The migration is idempotent, and `runtime.json` records the gate with `{"source": "npm", "package": "flowtask-permission-gate@^2.0.0", "managed": true}`. The model selector remains a project plugin. The context-checkpoint source gitlink may be empty if the submodule was not materialized; the user-scope copy is what the runtime publishes.

### Permission gate package

The gate is a standalone npm package, `flowtask-permission-gate`, with its own
README and MIT license. It requires an OpenCode runtime with the V2 plugin API;
its only runtime dependency is `@opencode/plugin`, and it does not depend on the
Model Context Protocol SDK. The package tarball ships `dist`, `README.md`,
`LICENSE`, and the package metadata; `prepack` rebuilds `dist` from source.

`install` and `update` do not publish. Publication and authentication are a
separate operational step. Consumers use the compatible range
`flowtask-permission-gate@^2.0.0`, so a patch or minor release is picked up
without pinning an exact version and without another installer change. Because
the gate is loaded from npm, the first OpenCode start after installation or
after a version change needs access to the registry; later starts use the
package already resolved by OpenCode.

Graphify is queried through `graphify_query_graph` via MCP. `flowtask graphify query --query <query>` only tests the deprecated shim and exits without querying locally.

## Diagnostics

```bash
flowtask --version
flowtask --help
git status --short
find "$XDG_CONFIG_HOME/flowtask" -maxdepth 3 -type f
find .claude/flowtask .opencode/flowtask .vscode/flowtask .flowtask -maxdepth 2 -name project.json
cat "${XDG_CONFIG_HOME:-$HOME/.config}/flowtask/config/identity.json"
head -n 20 "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents/flowtask-runner.md"
cat .claude/settings.local.json
claude mcp get engram
```

The OpenCode configuration key for agents is `agents`; `agent` is deprecated upstream. `install` and `update` migrate the `flowtask-*` entries of `agent` into `agents`, keeping the model and variant already chosen as `provider/model#variant`, and `uninstall` removes both keys.

Do not edit `opencode.json` manually to replace `update`. If there is no installation, run `install`; if there is a permissions/space error, fix it and retry `update`.
