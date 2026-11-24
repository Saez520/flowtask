# Worktree Manager compatibility and deprecation

Compatibility and deprecation are separate review dimensions. The compatibility
status states whether a surface is supported; the deprecation status states
whether it is on its way out. A surface that has no published guarantee is
recorded as a gap and is never presented as a promise.

## Standalone surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `worktree.sh` POSIX entrypoint | Supported: it validates `python3` and runs `python3 -m worktree_manager` | Not deprecated | [worktree.sh](https://github.com/Saez520/worktree-manager/blob/main/worktree.sh) | Worktree Manager maintainers | Confirm that the entrypoint still delegates to the package |
| Parent-only CLI | Supported: `create`, `complete`, `cleanup`, `recover`, `list` and `prune` | Not deprecated | [cli-contract-v1.md](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md) | Worktree Manager maintainers | Reconcile the command list with the executable usage |
| `--json` contract version `1` | Supported: seven keys, stable `result` values and stable error codes | Not deprecated | [cli.py](https://github.com/Saez520/worktree-manager/blob/main/worktree_manager/cli.py) | Worktree Manager maintainers | Compare the fields, the results, the errors and the exit codes literally |
| `--request-json` and the nine-key envelope | Supported: the option accepts only the optional `--json` and publishes the same envelope as the MCP transport | Not deprecated | [cli-contract-v1.md](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md) | Worktree Manager maintainers | Check the mode restriction and the published keys |
| MCP transport and its seven tools | Supported: `initialize`, `ping`, `tools/list` and `tools/call` publish exactly seven tools | Not deprecated | [mcp-contract.md](https://github.com/Saez520/worktree-manager/blob/main/docs/mcp-contract.md) | Worktree Manager maintainers | Compare the published tools and their fields with the contract |
| Target-direct operations | Supported: `create`, `link-parent`, `abort`, `complete` and `recover` with explicit identities and `staged-only` | Not deprecated | [target_direct_adapter.py](https://github.com/Saez520/worktree-manager/blob/main/worktree_manager/target_direct_adapter.py) | Worktree Manager maintainers | Check the descriptor identity checks and the drift limits |
| `list` without `--json` | Supported: it retains the Git porcelain output | Not deprecated | [cli-contract-v1.md](https://github.com/Saez520/worktree-manager/blob/main/docs/cli-contract-v1.md) | Worktree Manager maintainers | Check the exact porcelain output expectation |
| Contract version and tool version independence | Supported: the contract version describes the schema and the tool version describes the build | Not applicable | [models.py](https://github.com/Saez520/worktree-manager/blob/main/worktree_manager/models.py) | Worktree Manager maintainers | Ensure neither version is presented as the other |
| Plan digest in the standalone contracts | Gap: the contracts do not name the plan digest that the consumer always sends; the implemented validator is the reference | Not applicable | [mcp_contract.py](https://github.com/Saez520/worktree-manager/blob/main/worktree_manager/mcp_contract.py) | Worktree Manager maintainers | Publish the plan digest in the standalone contracts |
| npm package `worktree-for-agents` | Supported: `npm install -g worktree-for-agents@latest` or `pnpm add -g worktree-for-agents@latest`; no bin and no `npx`; the tarball embeds the Python runtime and works offline once installed | Not deprecated | [installation.md](https://github.com/Saez520/worktree-manager/blob/main/docs/installation.md) | Worktree Manager maintainers | Install from the registry in a clean prefix and list seven tools over stdio |
| Guide in `initialize.instructions` | Supported: the literal guide text is published in `instructions` and repeated in `GUIDE.md` | Not deprecated | [mcp-contract.md](https://github.com/Saez520/worktree-manager/blob/main/docs/mcp-contract.md) | Worktree Manager maintainers | Compare the `instructions` value with the literal text |
| Global copy published from npm | Supported: FlowTask publishes one managed global copy of the published package and resolves it only from there | Not deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Check the marker origin, the published version and the global resolution |

## Consumer-facing surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `worktree_manager` MCP server in the user scope | Supported: registered once per user by `install` and `update`; the seven tools are consumed directly | Current | [installation.md](../installation.md) | FlowTask maintainers | Check that the entry uses the managed global directory on `PYTHONPATH` and that foreign entries are preserved |
| Managed per-project `worktree_manager` entry | Migrated: removed from `.opencode/opencode.json` and `.mcp.json` after the user-scope registration is available | Deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Verify that only the managed entry is removed and that the migration is idempotent |
| `.flowtask/config/worktree.json` and its `preserveDirty` value | Read-only: the Runner reads it to decide whether to pass `preserve_dirty: true` to `worktree_complete` | Deprecated | [runner-flow-ejecucion-ca](../../.flowtask/skills/runner-flow-ejecucion-ca/SKILL.md) | FlowTask maintainers | Confirm that no FlowTask code writes the file |
| `FLOWTASK_*` environment variables | Deprecated and inert: they change neither the configuration, nor the authorization, nor the execution | Deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Use `WORKTREE_MANAGER_<KEY>` for the configuration and `WORKTREE_MANAGER_TEST_*` for the tests |
| Commit, merge and push on behalf of the consumer | Not applicable: the manager executes the lifecycle and the Runner composes the closure message | Not applicable | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject any documentation that assigns this responsibility to a FlowTask shell adapter |
| Plan digest `plan_hash` | Gap: it is validated as a 64-character hexadecimal SHA-256, and the contracts do not publish its derivation | Not applicable | [mcp_contract.py](https://github.com/Saez520/worktree-manager/blob/main/worktree_manager/mcp_contract.py) | Worktree Manager maintainers | Publish the derivation of the plan digest in the contracts |

## Removed surfaces

| Removed surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `.flowtask/scripts/worktree.sh` consumer entrypoint | Removed: FlowTask consumes the manager only through MCP | Not available | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject any documentation that presents a FlowTask shell entrypoint |
| `.flowtask/scripts/worktree-adapter.sh` adapter | Removed: there is no compatibility boundary inside FlowTask | Not available | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject any documentation that presents an adapter as a consumption path |
| Submodule and gitlink integration | Removed: the manager is acquired from npm and the submodule, the gitlink and the checkout are no longer part of the repository | Not available | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject any documentation that resolves or validates a submodule checkout |
| `lib/worktree-manager-core.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | Not available | [worktree.sh](https://github.com/Saez520/worktree-manager/blob/main/worktree.sh) | Worktree Manager maintainers | Reject any documentation that offers it as an alternative |
| `lib/worktree-manager-target-direct.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | Not available | [worktree.sh](https://github.com/Saez520/worktree-manager/blob/main/worktree.sh) | Worktree Manager maintainers | Reject any documentation that offers it as an alternative |
| Writes of the legacy backup directory and of the legacy backup references | Removed: no FlowTask operation writes them; legacy import belongs to the standalone CLI contract | Not available | [operations.md](operations.md) | FlowTask maintainers | Reject any documentation that assigns the import to FlowTask |
| The alternative shell engine of the standalone | Removed: the Python package is the only lifecycle implementation | Not available | [history-bash-to-python.md](https://github.com/Saez520/worktree-manager/blob/main/docs/history-bash-to-python.md) | Worktree Manager maintainers | Reject any documentation that describes a second lifecycle |
| `flowtask_worktree_consume` consumer bridge tool | Removed: the gate no longer exposes it and the Runner consumes the seven `worktree_manager` MCP tools directly | Not available | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject documentation that presents it as available |

## Legacy suite

The legacy consumer suite was rebaselined against the canonical manager, and
the cases that drove the retired engine were removed with their recorded
reason. It is not a compatibility surface, and it is not a published contract.
