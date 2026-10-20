# Worktree Manager documentation release procedure

This procedure publishes documentation only. It does not change version
metadata, runtime behavior, comments, messages, tests, configuration, the
submodule, or protected Phase 8/9 artifacts.

## Preparation

- [ ] Confirm the candidate diff contains only the documentation paths of this
  section and the additive links in `docs/README.md` and
  `docs/architecture/INDEX.md`.
- [ ] Confirm the standalone source and FlowTask integration source are
  available for comparison.
- [ ] Confirm the inventory names an owner, source status, document, and
  executable checklist for every required topic.

## Submodule reference

- [ ] Confirm the manager is consumed as a submodule and that the registered
  gitlink is the single reference of its version.
- [ ] Confirm no vendored copy of the manager core is introduced and that the
  manager is not copied into an installed target.
- [ ] Confirm the version of the consumer lives in `.flowtask/package.json`
  only, that the version of the manager is not duplicated in the documentation
  of the consumer, and that the two versions are independent.
- [ ] Record the gitlink before and after, the head of the materialised
  submodule and the state of the publication of the standalone origin in the
  evidence of the phase.

## Contract verification

- [ ] Compare commands, options, paths, configuration keys, schema fields,
  result values, warnings, identifiers, and exit codes with the executable
  source and `docs/cli-contract-v1.md`.
- [ ] Confirm human-readable stdout, JSON stdout, and stderr diagnostics remain
  distinct.
- [ ] Confirm `data.output` is not introduced and JSON is never described as
  implicit.
- [ ] Confirm the seven tools, the request protocol and the nine-key envelope
  are published as implemented.
- [ ] Confirm the pre-lock validation, the plan and execution pair, the
  reconciliation and the transport fallback are described as implemented.

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

## Delivery

The integration of the manager into the consumer repository and the publication
of the standalone origin are separate steps, and each one requires its own
authorization.

- [ ] Record the gitlink of the branch that carries the integration and the
  head of the materialised submodule.
- [ ] Record the delivery state as `pending` until the integration in the
  consumer branch and the synchronization of the origin are authorized and
  performed.
- [ ] Confirm that the branch used as the base is still the declared base; a
  moved base requires a rebase and a complete revalidation of the suites
  before the delivery.
- [ ] Confirm that the evidence of the phase is published with the diff and
  that its digests verify.

## Publication and rollback

Publish only when every gate has evidence in the candidate diff or source
comparison. If a source is missing or a literal differs, stop publication and
record the topic and source as a gap. Rollback is a documentation revert of the
candidate documentation/index changes; it must not alter runtime state or
restore discarded worktree data.
