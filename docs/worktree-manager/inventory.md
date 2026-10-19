# Worktree Manager documentation inventory

This inventory is the review index for the Worktree Manager documentation. The
standalone checkout is the source of truth for lifecycle, configuration,
transactions, target-direct behavior, and the CLI contract. FlowTask owns only
the consumer entrypoint, adapter, and submodule integration.

| Topic | Owner | Document | Source status | Validation checklist |
|---|---|---|---|---|
| Architecture and boundaries | Worktree Manager maintainers | [architecture.md](architecture.md) | Verified against the standalone README and FlowTask integration document | Check ownership, non-responsibilities, and links against both source documents |
| CLI and JSON contract | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against `docs/cli-contract-v1.md` and executable usage | Compare commands, options, fields, results, errors, and exit codes literally |
| Configuration | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against `parse_config` and standalone README | Check `key=value`, duplicate/unknown-key rejection, and path constraints |
| MCP integration | FlowTask maintainers | [interfaces.md](interfaces.md) | Gap: configured MCP servers are not evidence of a Worktree Manager MCP contract | Search implementation and contract sources; publish no unsupported MCP schema |
| Consent and destructive operations | Worktree Manager maintainers | [operations.md](operations.md) | Verified against lifecycle and recovery contract | Review discard/preserve consent and ensure no destructive command is run during review |
| Recovery and transactions | Worktree Manager maintainers | [operations.md](operations.md) | Verified against CLI contract and lifecycle sources | Check locks, journals, backups, conflicts, and intervention states |
| Subtree/target-direct integration | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md) | Verified for the `staged-only` boundary | Confirm target and parent repositories remain distinct |
| Consumer adapter behavior | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md) | Verified against `worktree.sh`, `worktree-adapter.sh`, and `worktree.md` availability | Check legacy translation is recovery-only and no commit/merge/push is claimed |
| Compatibility | Release maintainers | [compatibility.md](compatibility.md) | Verified where the contract has evidence; unknowns remain qualified | Review standalone and consumer matrices independently |
| Deprecations | Release maintainers | [compatibility.md](compatibility.md) | No additional deprecation is verified by the reviewed sources | Do not convert historical or unportable references into a promise |
| Release procedure | Release maintainers | [release.md](release.md) | Verified as a documentation-only procedure | Run link, literal, English-prose, protected-scope, and gap checks |

## Source gaps

- `.flowtask/scripts/worktree.md` is not present in this checkout; the
  integration source and executable scripts are used instead.
- `opencode.json` configures `engram` and `ferris-search`, but it does not
  provide a Worktree Manager MCP contract. MCP support is therefore not
  published as implemented.
- Runtime comments and human-readable messages remain outside this inventory;
  they are reserved for the later language phase.
