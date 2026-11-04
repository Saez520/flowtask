# Worktree Manager documentation

This section documents the implemented Worktree Manager and its FlowTask
integration. It is English release material, not a replacement for executable
contracts. Commands, paths, configuration keys, schema fields, result values,
exit codes, and other technical literals remain exactly as implemented.

## Reading order

1. [Inventory](inventory.md) — coverage, ownership, source status, gaps and
   removed surfaces.
2. [Architecture](architecture.md) — Python runtime, module map, and the
   standalone and consumer boundaries.
3. [Interfaces](interfaces.md) — CLI, configuration, JSON, request protocol,
   and MCP.
4. [Operations](operations.md) — consent, safety, transactions, recovery, and
   the declared compatibility of the adapter.
5. [Compatibility](compatibility.md) — standalone and consumer-facing matrices
   of compatibility and deprecation.
6. [Release](release.md) — publication gates and rollback handling.

## Source policy

The standalone Worktree Manager implementation, distributed as the npm package
`worktree-for-agents`, and its `docs/cli-contract-v1.md` and `docs/mcp-contract.md`
take precedence for the lifecycle and the interface facts. The FlowTask
integration document is authoritative for the adapter, the bridge and the global
publication boundary. Unverified behavior is recorded as a gap and is not
presented as a capability. Runtime comments and human-readable script, CLI, and
MCP messages are outside this section.
