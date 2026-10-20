# Worktree Manager compatibility and deprecation

Compatibility and deprecation are separate review dimensions. The compatibility
status states whether a surface is supported; the deprecation status states
whether it is on its way out. A surface that has no published guarantee is
recorded as a gap and is never presented as a promise.

## Standalone surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `worktree.sh` POSIX entrypoint | Supported: it validates `python3` and runs `python3 -m worktree_manager` | Not deprecated | [worktree.sh](../../.flowtask/scripts/worktree-manager/worktree.sh) | Worktree Manager maintainers | Confirm that the entrypoint still delegates to the package |
| Parent-only CLI | Supported: `create`, `complete`, `cleanup`, `recover`, `list` and `prune` | Not deprecated | [cli-contract-v1.md](../../.flowtask/scripts/worktree-manager/docs/cli-contract-v1.md) | Worktree Manager maintainers | Reconcile the command list with the executable usage |
| `--json` contract version `1` | Supported: seven keys, stable `result` values and stable error codes | Not deprecated | [cli.py](../../.flowtask/scripts/worktree-manager/worktree_manager/cli.py) | Worktree Manager maintainers | Compare the fields, the results, the errors and the exit codes literally |
| `--request-json` and the nine-key envelope | Supported: the option is used alone and publishes the same envelope as the MCP transport | Not deprecated | [cli-contract-v1.md](../../.flowtask/scripts/worktree-manager/docs/cli-contract-v1.md) | Worktree Manager maintainers | Check the mode restriction and the published keys |
| MCP transport and its seven tools | Supported: `initialize`, `ping`, `tools/list` and `tools/call` publish exactly seven tools | Not deprecated | [mcp-contract.md](../../.flowtask/scripts/worktree-manager/docs/mcp-contract.md) | Worktree Manager maintainers | Compare the published tools and their fields with the contract |
| Target-direct operations | Supported: `create`, `link-parent`, `abort`, `complete` and `recover` with explicit identities and `staged-only` | Not deprecated | [target_direct_adapter.py](../../.flowtask/scripts/worktree-manager/worktree_manager/target_direct_adapter.py) | Worktree Manager maintainers | Check the descriptor identity checks and the drift limits |
| `list` without `--json` | Supported: it retains the Git porcelain output | Not deprecated | [cli-contract-v1.md](../../.flowtask/scripts/worktree-manager/docs/cli-contract-v1.md) | Worktree Manager maintainers | Check the exact porcelain output expectation |
| Contract version and tool version independence | Supported: the contract version describes the schema and the tool version describes the build | Not applicable | [models.py](../../.flowtask/scripts/worktree-manager/worktree_manager/models.py) | Worktree Manager maintainers | Ensure neither version is presented as the other |
| Plan digest in the standalone contracts | Gap: the contracts do not name the plan digest that the consumer always sends; the implemented validator is the reference | Not applicable | [mcp_contract.py](../../.flowtask/scripts/worktree-manager/worktree_manager/mcp_contract.py) | Worktree Manager maintainers | Publish the plan digest in the standalone contracts |

## Consumer-facing surface

| Surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `.flowtask/scripts/worktree.sh` entrypoint | Supported: the consumer entrypoint that delegates to the adapter | Not deprecated | [worktree.sh](../../.flowtask/scripts/worktree.sh) | FlowTask maintainers | Check that the delegation remains intact |
| `.flowtask/scripts/worktree-adapter.sh` adapter | Supported: the compatibility boundary of the consumer | Not deprecated | [worktree-adapter.sh](../../.flowtask/scripts/worktree-adapter.sh) | FlowTask maintainers | Check the declared compatibility and the absence of any legacy write |
| Submodule and gitlink integration | Supported: the registered gitlink is the single reference of the version; no portable distribution is promised | Not deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Check the path, the source and the gitlink policy |
| `.flowtask/config/worktree.json` and its `preserveDirty` value | Deprecated, read-only: it is read only for a `complete --preserve-dirty` without `--config` | Deprecated | [worktree-adapter.sh](../../.flowtask/scripts/worktree-adapter.sh) | FlowTask maintainers | Move new configuration to `--config` or `.worktree-manager.conf` |
| `.flowtask/backups` and `refs/flowtask/backups` | Deprecated, read-only import: they are read only by an explicit parent-only `recover`, and no operation writes them | Deprecated | [compatibility-evidence.json](../operations/worktree-phase-9/compatibility-evidence.json) | FlowTask maintainers | Confirm that the import is declared and that nothing is written back |
| `FLOWTASK_*` environment variables | Deprecated and inert: they change neither the configuration, nor the authorization, nor the execution | Deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Use `WORKTREE_MANAGER_<KEY>` for the configuration and `WORKTREE_MANAGER_TEST_*` for the tests |
| `flowtask_worktree_consume` bridge tool | Supported: one tool restricted to the FlowTask runner identity | Not deprecated | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Check that the arguments are reduced to the canonical request fields |
| Commit, merge and push on behalf of the consumer | Not applicable: the adapter does not own these operations | Not applicable | [worktree.md](../architecture/worktree.md) | FlowTask maintainers | Reject any documentation that assigns this responsibility to the adapter |
| Plan digest `plan_hash` | Gap: it is validated as a 64-character hexadecimal SHA-256, and the contracts do not publish its derivation | Not applicable | [mcp_contract.py](../../.flowtask/scripts/worktree-manager/worktree_manager/mcp_contract.py) | Worktree Manager maintainers | Publish the derivation of the plan digest in the contracts |

## Removed surfaces

| Removed surface | Compatibility status | Deprecation status | Evidence | Owner | Review |
|---|---|---|---|---|---|
| `lib/worktree-manager-core.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | Not available | [worktree.sh](../../.flowtask/scripts/worktree-manager/worktree.sh) | Worktree Manager maintainers | Reject any documentation that offers it as an alternative |
| `lib/worktree-manager-target-direct.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | Not available | [worktree.sh](../../.flowtask/scripts/worktree-manager/worktree.sh) | Worktree Manager maintainers | Reject any documentation that offers it as an alternative |
| Writes of the legacy backup directory and of the legacy backup references | Removed: no operation writes them; they are read only in the explicit import | Not available | [compatibility-evidence.json](../operations/worktree-phase-9/compatibility-evidence.json) | FlowTask maintainers | Verify that the import is declared and that the canonical state is never copied back |
| The alternative shell engine of the standalone | Removed: the Python package is the only lifecycle implementation | Not available | [python-backend.md](../../.flowtask/scripts/worktree-manager/docs/python-backend.md) | Worktree Manager maintainers | Reject any documentation that describes a second lifecycle |

## Legacy suite

The legacy consumer suite was rebaselined against the canonical manager, and
the cases that drove the retired engine were removed with their recorded
reason. It is not a compatibility surface, and it is not a published contract.
