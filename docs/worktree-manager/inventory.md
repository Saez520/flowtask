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
| MCP integration | Worktree Manager maintainers | [interfaces.md](interfaces.md) | Verified against the standalone contract and the materialised submodule | Compare the seven published tools, the request protocol and the nine-key envelope with the contract |
| Consent and destructive operations | Worktree Manager maintainers | [operations.md](operations.md) | Verified against lifecycle and recovery contract | Review discard/preserve consent and ensure no destructive command is run during review |
| Recovery and transactions | Worktree Manager maintainers | [operations.md](operations.md) | Verified against CLI contract and lifecycle sources | Check locks, journals, backups, conflicts, and intervention states |
| Pre-lock validation and plan execution | Worktree Manager maintainers | [operations.md](operations.md) | Verified against the lifecycle and the contract sources | Check that a rejection leaves no marker, lock, journal, ref, or worktree |
| Transport detection and fallback | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md) | Verified against the consumer contract and the adapter | Check that the fallback only replaces a transport that never received the request |
| Subtree/target-direct integration | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md) | Verified for the `staged-only` boundary | Confirm target and parent repositories remain distinct |
| Consumer adapter behavior | FlowTask maintainers | [architecture.md](architecture.md), [operations.md](operations.md) | Verified against `worktree.sh`, `worktree-adapter.sh`, and `worktree.md` availability | Check legacy translation is recovery-only and no commit/merge/push is claimed |
| Compatibility | Release maintainers | [compatibility.md](compatibility.md) | Verified where the contract has evidence; unknowns remain qualified | Review standalone and consumer matrices independently |
| Deprecations | Release maintainers | [compatibility.md](compatibility.md) | No additional deprecation is verified by the reviewed sources | Do not convert historical or unportable references into a promise |
| Release procedure | Release maintainers | [release.md](release.md) | Verified as a documentation-only procedure | Run link, literal, English-prose, protected-scope, and gap checks |
| Phase evidence | FlowTask maintainers | [operations/worktree-phase-8](../operations/worktree-phase-8/README.md) | Verified for the provenance, the snapshot and the matrix | Verify the digests, the reconstruction commands and the recorded limits |

## Source gaps

- `.flowtask/scripts/worktree.md` is not present in this checkout; the
  integration source and executable scripts are used instead.
- The standalone contracts do not name the plan digest that the consumer always
  sends; the implemented contract is the reference until they are published.
- The legacy consumer suite keeps the exit codes of the crash hooks of the
  previous backend; the gap is registered and is not repaired here.
- Runtime comments and human-readable messages remain outside this inventory;
  they are reserved for the later language phase.
