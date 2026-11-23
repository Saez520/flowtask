# flowtask-permission-gate

OpenCode permission gate for FlowTask. The plugin applies FlowTask policies at
the tool boundary: the Runner allowlist, the universal review-stamp commit gate,
the permissions layer check, and the context budget for read tools.

## Installation

The plugin is installed and updated as a managed user-scope copy by FlowTask:

```bash
flowtask install
flowtask update
```

Consumers do not copy the package into a project and do not install it
directly. The OpenCode user configuration registers it once with its absolute
package path and the `configDir` and `runtimeRoot` options.

## What it enforces

- **Runner allowlist.** Authorized inspection and management commands run;
  destructive, writing, installing, and ambiguous commands are denied with the
  delegation message. Only the enumerated subagents, MCP tools, and Graphify
  queries are authorized.
- **Permissions layer.** The Runner does not execute with expanded limits when
  the autonomy or permissions layer is missing or invalid. The denial names the
  layer, the file, the cause, and the action.
- **Review stamp.** A commit requires a valid stamp unless it is a trivial
  `--no-verify`/`--no-review` bypass. The stamp is JSON with an ISO-8601 `ts`
  and the current branch; it is valid for the configured TTL and is not
  consumed when validated.
- **Config resolution.** `review.json` is looked up in this order:
  `.opencode/flowtask/config/review.json`, then
  `.flowtask/config/review.json`, relative to the commit workdir. A relative
  `stampPath` is resolved against that workdir. In a registered project, a
  missing or invalid config blocks the commit; `enabled: false` is the explicit
  opt-out.
- **Context budget.** Broad `read`, `glob`, and `grep` requests are announced,
  large deliveries are reduced without a preview, and image/PDF attachments are
  delegated. Thresholds are never exposed in messages.

## Configuration

`review.json`:

```json
{
  "enabled": true,
  "stampPath": ".opencode/flowtask/config/.review-stamp",
  "stampTtlMinutes": 30
}
```

`context-budget.json` (optional, fail-open to defaults):

```json
{
  "readThreshold": 16000,
  "grepThreshold": 8000,
  "globThreshold": 8000,
  "turnAccumulated": 32000,
  "preventiveReadStatLimit": 51200,
  "preventiveGlobPatterns": ["**/*", "**"],
  "blockedPaths": ["node_modules"]
}
```

Both files are read from `.opencode/flowtask/config/` first and from
`.flowtask/config/` as the fallback.

## Known limits

- A valid stamp is not consumed, and the stamp is not bound to a specific diff.
- Commit detection covers `git commit`, `git -C`, `git -c`, `--git-dir`, and
  `cd ... && git commit`. It does not inspect commits started by the worktree
  manager or through nested shells.
- The plugin does not restart OpenCode; a new version is loaded on the next
  restart.

## License

MIT
