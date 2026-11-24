# flowtask-permission-gate

OpenCode permission gate for FlowTask. The plugin applies FlowTask policies at
the tool boundary: the Runner allowlist, the universal review-stamp commit gate,
the permissions layer check, and the context budget for read tools.

## Installation

The plugin is distributed as the npm package `flowtask-permission-gate` and
registered by FlowTask for the OpenCode user:

```bash
flowtask install
flowtask update
```

Consumers do not copy the package into a project and do not install it
directly. The OpenCode user configuration registers it once with the compatible
range `flowtask-permission-gate@^2.0.0` and the `configDir` and `runtimeRoot`
options. OpenCode resolves the package from the npm registry on the first load
and after a version change; later starts use the resolved package.

An installation that kept a local managed copy is migrated by `flowtask install`
or `flowtask update`: the absolute entry is replaced by the npm range and the
copy is removed only when it carries the FlowTask ownership marker. A directory
without the marker is preserved.

## What it enforces

- **Runner allowlist.** The runner's shell tool is `shell`, and `bash` receives
  exactly the same command analysis with the same result for the same command.
  Authorized inspection and management commands run; destructive, writing,
  installing, and ambiguous commands are denied with the delegation message.
  Only the enumerated subagents, MCP tools, and Graphify queries are authorized.
- **Code Mode transport.** An `execute` script is authorized only when it
  reaches the MCP surface through literal calls — `tools.engram.<tool>`,
  `tools.graphify.query_graph`, and `tools.worktree_manager.<capability>` — with
  at least one invocation. `fetch`, `eval`, `Function`, `require`, `process`,
  any other namespace, a tool outside the surface, a non-literal reference, or a
  mixed script rejects the whole script with the delegation message and no
  effect.
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
- The `execute` script analysis is static: a reference that is not literal (a
  computed name, an intermediate alias, or a third segment) is rejected.
- The plugin does not restart OpenCode; a new version is loaded on the next
  restart.

## License

MIT
