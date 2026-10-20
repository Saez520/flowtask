# Worktree Manager documentation

This section documents the implemented Worktree Manager and its FlowTask
integration. It is English release material, not a replacement for executable
contracts. Commands, paths, configuration keys, schema fields, result values,
exit codes, and other technical literals remain exactly as implemented.

## Reading order

1. [Inventory](inventory.md) — coverage, ownership, source status, and checks.
2. [Architecture](architecture.md) — repository and responsibility boundaries.
3. [Interfaces](interfaces.md) — CLI, configuration, JSON, and MCP evidence.
4. [Operations](operations.md) — consent, safety, transactions, and recovery.
5. [Compatibility](compatibility.md) — standalone and consumer-facing matrices.
6. [Release](release.md) — publication gates and rollback handling.
7. [Phase evidence](../operations/worktree-phase-8/README.md) — provenance,
   snapshot, transport matrix, and digests of the integration phase.

## Source policy

The standalone Worktree Manager implementation and
`docs/cli-contract-v1.md` take precedence for lifecycle and interface facts.
FlowTask documentation is authoritative for the adapter and submodule
boundary. Unverified behavior is recorded as a gap and is not presented as a
capability. Runtime comments and human-readable script, CLI, and MCP messages
are outside this section.
