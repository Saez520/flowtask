# Worktree Manager interfaces

## Entrypoints and commands

The standalone commands are `create`, `complete`, `cleanup`, `recover`,
`list`, and `prune`. Global options include `--repo`, `--config`, and
`--json`; `--version` prints the tool version. Parent-only usage is:

```text
worktree.sh [--repo ABS] [--config ABS] create <id> [--base BRANCH]
worktree.sh [globales] complete <id> [--preserve-dirty]
worktree.sh [globales] cleanup <id> [--discard]
worktree.sh [globales] recover [<transaction-id>]
worktree.sh [globales] prune | list
```

Target-direct requires explicit target and parent identities:

```text
worktree.sh --repo <submodule> --parent-repo <parent> create <work-id> --target submodule --submodule-path <REL> --link-parent staged-only
worktree.sh --repo <submodule> --parent-repo <parent> link-parent <work-id> --target submodule --submodule-path <REL> --link-parent staged-only
worktree.sh --repo <submodule> --parent-repo <parent> abort <work-id> --target submodule --submodule-path <REL> --link-parent staged-only [--tx <TX_ID>]
worktree.sh --repo <submodule> --parent-repo <parent> complete <work-id> --target submodule --submodule-path <REL> --link-parent staged-only [--tx <TX_ID>]
worktree.sh --repo <submodule> --parent-repo <parent> recover [<transaction-id>] --target submodule --submodule-path <REL> --link-parent staged-only
```

The literals above are preserved from the executable usage contract. Legacy
invocations remain human-readable; `list` retains Git porcelain output unless
`--json` is explicitly selected.

## Configuration

Configuration is an optional `key=value` file selected by `--config`, or
`.worktree-manager.conf` in the repository. Supported keys are:

`worktrees_dir`, `branch_prefix`, `state_dir`, `backup_dir`,
`backup_ref_prefix`, `lock_dir`, `prepare_command`, `prepare_enabled`,
`verify_command`, `verify_enabled`, and `preserve_dirty`.

Each key may occur once. Unknown keys, malformed lines, invalid booleans, and
unsafe paths are rejected. `prepare_enabled=true` requires
`prepare_command`; `verify_enabled=true` requires `verify_command`.

## JSON contract

`--json` selects one JSON document on stdout. Diagnostics remain on stderr. The
top-level fields are `contract_version`, `tool_version`, `operation`, `result`,
`data`, `warnings`, and `error`. `contract_version` is integer `1` and the
current `tool_version` is string `1.0.0`. `data` contains operation-specific
fields; there is no general `data.output` field.

`result` is one of `success`, `failure`, `pending_intervention`, or
`no_pending_work`. Public exit codes are `0` for success/no pending work, `2`
for usage, `3` for invalid configuration/identity, `4` for resource lock, `5`
for conflict/intervention, and `6` for access/dependency. Contract version and
tool version are independent.

## MCP evidence status

`opencode.json` configures MCP servers for FlowTask, but no implemented
Worktree Manager MCP schema is present in the reviewed sources. This document
therefore makes no MCP capability claim.
