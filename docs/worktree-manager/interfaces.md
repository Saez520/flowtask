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

## MCP transport

The standalone publishes a standard service over stdio:

```sh
python3 -m worktree_manager.mcp_transport
```

It implements `initialize`, `ping`, `tools/list` and `tools/call`, and it
publishes exactly seven tools: `worktree_create`, `worktree_complete`,
`worktree_cleanup`, `worktree_recover`, `worktree_list`, `worktree_prune` and
`worktree_status`. A call requires an absolute path of an existing repository;
the working directory of the process is never used as a repository default.
Unknown arguments are rejected, and a rejected call publishes the same
nine-key envelope as an accepted one.

A client starts the service, reads the published tools and closes the session
as soon as the answer is read. The consumer in FlowTask starts the service with
the standalone checkout on the Python path.

## Request protocol

Both transports publish the same nine-key envelope: `contract_version`,
`tool_version`, `operation`, `repository`, `result`, `data`, `warnings`, `error`
and `transaction_id`. A rejected request publishes the same shape, so a client
never parses two document formats.

The request is canonical and it is sent the same way over both transports: as a
single JSON document with `--request-json <file|->` on the command line, and as
the arguments of a `tools/call` on the stdio service. A request is never
expressed as the arguments of the lifecycle commands, and it is never combined
with a subcommand or with another flag.

| Operation | Tool | Fields |
|---|---|---|
| `create` | `worktree_create` | `repo`, `work_id`, `base`, `dry_run`, `parent_repo`, `submodule_path`, `confirm`, `plan_hash`, `init_submodules`, `prepare`, `verify` |
| `complete` | `worktree_complete` | `repo`, `work_id`, `base`, `dry_run`, `authorization`, `confirm`, `plan_hash`, `transaction_id`, `preserve_dirty`, `target_direct`, `parent_repo` |
| `cleanup` | `worktree_cleanup` | `repo`, `work_id`, `base`, `dry_run`, `authorization`, `confirm`, `plan_hash`, `discard`, `discard_consent` |
| `recover` | `worktree_recover` | `repo`, `transaction_id`, `dry_run`, `authorization`, `confirm`, `target_direct`, `parent_repo` |
| `list` | `worktree_list` | `repo` |
| `prune` | `worktree_prune` | `repo`, `dry_run`, `authorization`, `confirm`, `plan_hash` |
| `status` | `worktree_status` | `repo`, `work_id` |

`repo` is always the absolute path of an existing repository. A field outside
its row is rejected as an unknown field, and a missing required field is
rejected, in both cases before any effect.

`confirm` is the canonical confirmation. A destructive operation requires it
and the manager derives the authorization from it. `authorization` is the
literal `I_AUTHORIZE_THIS_CALL` and it is not retained between requests. A
discard requires the separate `discard_consent` boolean.

`plan_hash` is the SHA-256 of the canonical plan of the request. The manager
publishes it in the preflight of a mutating operation and rejects an execute
whose plan digest or whose planned transaction identifier does not match that
preflight. A completion publishes the planned transaction identifier and
reuses it.
