# Worktree Manager documentation inventory

This inventory is the review index for the Worktree Manager documentation. The
standalone checkout materialized as a submodule is the source of truth for the
lifecycle, the configuration, the transactions, the target-direct behavior and
the CLI and MCP contracts. FlowTask owns only the consumer entrypoint, the
compatibility adapter, the bridge and the submodule integration.

Every topic below names one owning document, one owning maintainer group, the
source status of that topic and a checklist that a reviewer can execute
without undocumented knowledge.

| Topic | Owner | Document | Source status | Validation checklist |
|---|---|---|---|---|
| Architecture and boundaries | Worktree Manager maintainers | [architecture.md](architecture.md) | Verified against the standalone entrypoint, the Python package and the [FlowTask integration document](../architecture/worktree.md) | Check the ownership split, the explicit non-responsibilities and the links against both sources |
| Python runtime and module map | Worktree Manager maintainers | [architecture.md](architecture.md) | Verified against the materialized package; the module table matches the files of the package | Compare the module table with the files of `worktree_manager` and confirm that the entrypoint runs the package |
| Closure commit message composition | Worktree Manager maintainers | [architecture.md](architecture.md) | Verified against `worktree_manager.commit_message` and the consumer fallback | Confirm `commit_message` composes subject and body and that the consumer fallback strings stay exact |
| CLI and JSON contract | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against the [CLI contract](../../.flowtask/scripts/worktree-manager/docs/cli-contract-v1.md) and the executable usage of the dispatcher | Compare commands, options, fields, results, errors and exit codes literally |
| Configuration | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against the configuration loader of the package | Check the eleven keys, their defaults, the duplicate and unknown-key rejection and the path constraints |
| MCP transport and request protocol | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against the [MCP contract](../../.flowtask/scripts/worktree-manager/docs/mcp-contract.md) and the strict request validator | Compare the seven published tools, their fields, the request protocol and the nine-key envelope with the contract |
| Consent and destructive operations | Worktree Manager maintainers | [operations.md](operations.md) | Verified against the lifecycle, the request validator and the compatibility adapter | Review the discard and the preservation consent and confirm that no destructive command is run during a review |
| Pre-lock validation, plan and execution | Worktree Manager maintainers | [operations.md](operations.md) | Verified against the lifecycle and the contract sources | Check that a rejection leaves no marker, lock, journal, ref or worktree |
| Recovery, transactions and reconciliation | Worktree Manager maintainers | [operations.md](operations.md) | Verified against the recovery manager and the transaction journal | Check locks, journals, backups, conflicts and the intervention states |
| Standalone isolation | Worktree Manager maintainers | [architecture.md](architecture.md), [compatibility.md](compatibility.md) | Verified: the package answers the version and the seven tools without a consumer checkout | Confirm that the package reads no path, ref or variable of the consumer |
| Target-direct | Worktree Manager maintainers | [architecture.md](architecture.md), [interfaces.md](interfaces.md), [operations.md](operations.md) | Verified for the `staged-only` boundary and for the descriptor identity checks | Confirm that the target and the parent repository remain distinct and that the descriptor identity is compared with the request |
| Consumer adapter | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md), [compatibility.md](compatibility.md) | Verified against the [consumer entrypoint](../../.flowtask/scripts/worktree.sh), the [adapter](../../.flowtask/scripts/worktree-adapter.sh) and the implemented contracts | Check the declared compatibility, the absence of any legacy write and that no commit, merge or push is claimed |
| Compatibility and deprecation | Release maintainers | [compatibility.md](compatibility.md) | Verified where the contract has evidence; every gap is named instead of qualified | Review the standalone and the consumer matrices independently |
| Release | Release maintainers | [release.md](release.md) | Verified as a documentation-only procedure | Run the scope, source, contract, safety, compatibility, editorial, evidence, publication and version checks |
| Transition history | Worktree Manager maintainers | [history-bash-to-python.md](../../.flowtask/scripts/worktree-manager/docs/history-bash-to-python.md) | Verified against the current package layout and the published tags | Confirm the single historical account and that it does not duplicate the contracts |

## Source gaps

- `.flowtask/scripts/worktree.md` is not present in this checkout; the
  integration document and the executable scripts are the sources instead.
- The standalone contracts do not name the plan digest that the consumer always
  sends; the implemented contract is the reference until the contracts publish
  it.
- Runtime comments and human-readable messages are outside this section; they
  are reserved for the later language phase.

## Removed surfaces

| Removed surface | Status | Current equivalent |
|---|---|---|
| `lib/worktree-manager-core.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | The Python package `worktree_manager` |
| `lib/worktree-manager-target-direct.sh` | Removed: the file does not exist in the standalone checkout and it is not a supported alternative | `worktree_manager.target_direct_adapter` |
| Backup mirrors of the consumer state | Removed: no operation writes the legacy backup directory or the legacy backup references | The canonical state under the repository state directory and the canonical backup references |
| `FLOWTASK_*` environment variables | Inert: they are not a configuration surface and they change neither the configuration nor the authorization | `WORKTREE_MANAGER_<KEY>` for the configuration and `WORKTREE_MANAGER_TEST_*` for the tests |
