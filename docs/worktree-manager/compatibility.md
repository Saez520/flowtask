# Worktree Manager compatibility and deprecation

Compatibility and deprecation are separate review dimensions. A status below
is qualified when the reviewed source does not establish a stronger guarantee.

## Standalone surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| Legacy human-readable invocation | Verified: remains human-readable and preserves legacy exit codes | Not verified as deprecated | `docs/cli-contract-v1.md` | Worktree Manager maintainers | Compare invocation behavior with the contract |
| `list` without `--json` | Verified: retains Git porcelain output | Not deprecated by reviewed source | `docs/cli-contract-v1.md` | Worktree Manager maintainers | Check exact porcelain output expectation |
| Explicit `--json` | Verified for contract version `1` | Schema breaks require a new contract version | `docs/cli-contract-v1.md` | Worktree Manager maintainers | Check fields, results, errors, and exit codes literally |
| Parent-only lifecycle | Verified for `create`, `complete`, `cleanup`, `recover`, `list`, `prune` | No additional deprecation verified | standalone README and CLI contract | Worktree Manager maintainers | Reconcile command list with executable usage |
| Target-direct operations | Verified for `link-parent`, `abort`, `complete`, `recover` with explicit identities | No additional deprecation verified | CLI contract and target-direct implementation | Worktree Manager maintainers | Check `--link-parent staged-only` and drift limits |
| Contract/tool version independence | Verified | Not applicable | `docs/cli-contract-v1.md` | Worktree Manager maintainers | Ensure neither version is presented as the other |

## Consumer-facing surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `.flowtask/scripts/worktree.sh` entrypoint | Verified as the FlowTask consumer entrypoint | Not verified as deprecated | `docs/architecture/worktree.md` and executable adapter | FlowTask maintainers | Check delegation remains intact |
| Legacy FlowTask records | Recovery translation is verified; broader compatibility is not guaranteed | Not verified as deprecated | `worktree-adapter.sh` and integration document | FlowTask maintainers | Review recovery-only translation |
| Submodule gitlink integration | Verified for the recorded submodule boundary | No portable distribution guarantee | `.gitmodules` and integration document | FlowTask maintainers | Check path/source and gitlink policy |
| Adapter commit/merge/push behavior | Not applicable: adapter does not own these operations | No deprecation claim | integration document | FlowTask maintainers | Reject any documentation that assigns this responsibility |
| Worktree Manager MCP interface | Not verified | Not applicable | No implemented contract found; `opencode.json` is insufficient | FlowTask maintainers | Keep this as a gap until an implementation contract exists |
