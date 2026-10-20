# Worktree Manager interfaces

## Entrypoints and commands

The standalone entrypoint is `worktree.sh`, a POSIX script that runs
`python3 -m worktree_manager`. The global options are `--repo ABS`,
`--config ABS`, `--json` and `--version`. `--version` prints the tool version
`1.0.0` and rejects any additional argument with exit code `2`.

The parent-only commands are `create`, `complete`, `cleanup`, `recover`,
`list`, and `prune`:

```text
worktree.sh [--repo ABS] [--config ABS] [--json] create <work-id> [--base BRANCH] [--init-submodules] [--prepare] [--verify]
worktree.sh [globales] complete <work-id> [--preserve-dirty]
worktree.sh [globales] cleanup <work-id> [--discard]
worktree.sh [globales] recover [<transaction-id>]
worktree.sh [globales] prune
worktree.sh [globales] list
```

`create` resolves the base branch when `--base` is absent, preferring
`development`, then `main`, then `trunk`, and falling back to `main`.
`--init-submodules`, `--prepare` and `--verify` are off by default;
`--prepare` and `--verify` require `prepare_command` and `verify_command` in
the configuration, and the request is rejected as `invalid_configuration`
before any worktree or branch exists.

Target-direct is a subcommand with its own action, and `--parent-repo` is
placed after that action:

```text
worktree.sh [--repo ABS] target-direct <action> <work-id> --parent-repo <parent> [--target submodule] [--submodule-path <REL>] [--base BRANCH] [--link-parent staged-only] [--descriptor PATH]
```

The five actions are `create`, `link-parent`, `abort`, `complete` and
`recover`. `--parent-repo` is required, `--target` accepts only `submodule`
and defaults to `submodule`, `--link-parent` accepts only `staged-only` and
defaults to `staged-only`, and `--base` defaults to `main`. `--submodule-path`
is required by `create`. When `--descriptor` is absent, the descriptor path is
derived from the common Git directory of the target repository and the
identifier of the work; every action other than `create` compares the
persisted descriptor identity with the target repository, the parent repository
and the transaction identifier of the command, and a mismatch is rejected as
`invalid_descriptor` with exit code `3`.

The default presentation is human-readable: the output publishes the
`operation:` line, the `result:` line and one `key: value` line per data
field, and an error message goes to stderr. `list` retains Git porcelain
output unless `--json` is explicitly selected, and legacy invocations never
opt into JSON implicitly.

## Configuration

Configuration is an optional `key=value` file selected by `--config`, or
`.worktree-manager.conf` in the repository root. A file passed with `--config`
must be an existing absolute file. The eleven supported keys and their
defaults are:

| Key | Default | Constraint |
|---|---|---|
| `worktrees_dir` | `.worktrees` | Must not start with `-` |
| `branch_prefix` | `worktree/` | — |
| `state_dir` | `worktree-manager` | Safe relative path |
| `backup_dir` | `backups` | Not an absolute path and without `..` |
| `backup_ref_prefix` | `worktree-manager/backups` | Without `..` |
| `lock_dir` | `locks` | Safe relative path |
| `prepare_command` | `''` (empty) | Required when `prepare_enabled=true` |
| `verify_command` | `''` (empty) | Required when `verify_enabled=true` |
| `prepare_enabled` | `false` | `true` or `false` |
| `verify_enabled` | `false` | `true` or `false` |
| `preserve_dirty` | `false` | `true` or `false` |

Each key may occur once. Unknown keys, malformed lines, invalid booleans and
unsafe paths are rejected as `invalid_configuration` with exit code `3`. A
value that contains a null byte or a line break is rejected as well. The
environment variable `WORKTREE_MANAGER_<KEY>`, with the key in upper case,
replaces the value read from the file.

## JSON contract

`--json` selects one JSON document on stdout. Diagnostics remain on stderr. The
seven top-level fields are `contract_version`, `tool_version`, `operation`,
`result`, `data`, `warnings`, and `error`. `contract_version` is the integer
`1` and `tool_version` is the string `1.0.0`. `data` contains
operation-specific fields; there is no general `data.output` field, because the
human-readable text of the dispatcher is never included in the JSON data
object.

The request protocol and the MCP transport publish the same nine-key
envelope: `contract_version`, `tool_version`, `operation`, `repository`,
`result`, `data`, `warnings`, `error` and `transaction_id`. `error` is `null`
or an object with `code`, `message` and `exit_code`. `transaction_id` is a
string or `null`, and it is `null` when no transaction exists. The contract
version describes the JSON schema and it is independent of the tool version;
a breaking schema change requires a new contract version.

`result` is one of `success`, `failure`, `pending_intervention`, or
`no_pending_work`.

| Exit code | Meaning |
|---|---|
| `0` | Success or no pending work |
| `2` | Usage |
| `3` | Invalid configuration or identity |
| `4` | Resource lock |
| `5` | Conflict or intervention |
| `6` | Access or dependency |

The command line reports a lock contention as `operation_failed` with exit code
`5`, and a target-direct descriptor phase violation as `invalid_descriptor`
with exit code `4`. A failure whose type does not provide a reliable subtype is
reported as `operation_failed` with exit code `5`; a client reads the stable
code and does not parse the message.

## Request protocol

`--request-json <file|->` reads one canonical request document and publishes
the nine-key envelope, with or without `--json`. The option must be used
alone: any other argument, including a subcommand, is rejected as
`usage_error` with exit code `2`. The source is a file path or `-`, which
reads the document from standard input.

The request document names the tool in its `operation` field, with or without
the `worktree_` prefix, and the envelope publishes the absolute repository path
in `repository`. The request is never expressed as the arguments of the
lifecycle commands. An accepted request and a rejected request publish the
same shape, so a client never parses two document formats.

## MCP transport

The standalone publishes a standard service over stdio:

```sh
python3 -m worktree_manager.mcp_transport
```

It implements `initialize`, `ping`, `tools/list` and `tools/call`, and it
publishes exactly seven tools:

| Tool | Fields | Required |
|---|---|---|
| `worktree_create` | `repo`, `work_id`, `base`, `dry_run`, `parent_repo`, `submodule_path`, `confirm`, `plan_hash`, `init_submodules`, `prepare`, `verify` | `repo`, `work_id` |
| `worktree_complete` | `repo`, `work_id`, `base`, `dry_run`, `authorization`, `confirm`, `plan_hash`, `transaction_id`, `preserve_dirty`, `target_direct`, `parent_repo` | `repo`, `work_id` |
| `worktree_cleanup` | `repo`, `work_id`, `base`, `dry_run`, `authorization`, `confirm`, `plan_hash`, `discard`, `discard_consent` | `repo`, `work_id` |
| `worktree_recover` | `repo`, `transaction_id`, `dry_run`, `authorization`, `confirm`, `target_direct`, `parent_repo` | `repo` |
| `worktree_list` | `repo` | `repo` |
| `worktree_prune` | `repo`, `dry_run`, `authorization`, `confirm`, `plan_hash` | `repo` |
| `worktree_status` | `repo`, `work_id` | `repo`, `work_id` |

A call requires an absolute path of an existing repository; the working
directory of the process is never used as a repository default. A field
outside its row is rejected as an unknown field, and a missing required field
is rejected, in both cases before any effect. `dry_run`, `discard`,
`preserve_dirty`, `discard_consent`, `target_direct`, `confirm`,
`init_submodules`, `prepare` and `verify` are booleans, and `work_id`,
`base`, `transaction_id`, `authorization`, `parent_repo` and `submodule_path`
are strings.

`confirm` is the canonical confirmation. A destructive operation requires it
and the manager derives the authorization from it. `authorization` is the
literal `I_AUTHORIZE_THIS_CALL` and it is not retained between requests. A
confirmation that disagrees with an authorization is rejected as
`authorization_mismatch`. A discard requires the separate `discard_consent`
boolean.

`plan_hash` is the SHA-256 of the canonical plan of the request, published as
64 hexadecimal characters, and any other form is rejected as
`plan_hash_must_be_sha256`. The manager publishes it in the preflight of a
mutating operation and rejects an execute whose plan digest or whose planned
transaction identifier does not match that preflight. A completion publishes
the planned transaction identifier and reuses it.

A target-direct creation, a target-direct completion and a target-direct
recovery have no safe simulation: they are rejected as `unsupported_dry_run`
with exit code `3` when a dry run is requested.
