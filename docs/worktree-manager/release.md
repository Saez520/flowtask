# Worktree Manager documentation release procedure

This procedure publishes documentation only. It does not change version
metadata, runtime behavior, comments, messages, tests, configuration, the
submodule, or protected Phase 8/9 artifacts.

## Preparation

- [ ] Confirm the candidate diff contains only `docs/worktree-manager/` and
  additive links in `docs/README.md` and `docs/architecture/INDEX.md`.
- [ ] Confirm the standalone source and FlowTask integration source are
  available for comparison.
- [ ] Confirm the inventory names an owner, source status, document, and
  executable checklist for every required topic.

## Contract verification

- [ ] Compare commands, options, paths, configuration keys, schema fields,
  result values, warnings, identifiers, and exit codes with the executable
  source and `docs/cli-contract-v1.md`.
- [ ] Confirm human-readable stdout, JSON stdout, and stderr diagnostics remain
  distinct.
- [ ] Confirm `data.output` is not introduced and JSON is never described as
  implicit.
- [ ] Confirm MCP is reported only as verified when an implementation contract
  exists; otherwise retain the explicit gap.

## Safety and compatibility review

- [ ] Check consent, `--discard`, `--preserve-dirty`, locks, journals,
  backups, conflicts, and `pending_intervention` wording.
- [ ] Check parent-only, target-direct, subtree/gitlink, and adapter boundaries
  separately.
- [ ] Review compatibility and deprecation matrices independently; every row
  must have status, evidence, owner, and review fields.
- [ ] Ensure no claim implies automatic merge, push, silent discard, or
  recovery-as-success.

## Editorial and scope gates

- [ ] Resolve every relative link from the repository root.
- [ ] Confirm new editorial prose is English while technical literals remain
  unchanged.
- [ ] Search the diff for runtime comments/messages and reject Phase 11 scope.
- [ ] Search the diff for implementation, configuration, test, submodule, and
  Phase 8/9 paths and reject any out-of-scope change.
- [ ] Record every unavailable source as a named gap; do not fill it with an
  inferred capability.

## Publication and rollback

Publish only when every gate has evidence in the candidate diff or source
comparison. If a source is missing or a literal differs, stop publication and
record the topic and source as a gap. Rollback is a documentation revert of the
candidate documentation/index changes; it must not alter runtime state or
restore discarded worktree data.
