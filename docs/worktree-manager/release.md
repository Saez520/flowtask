# Worktree Manager documentation release procedure

This procedure publishes documentation only. It does not change version
metadata, runtime behavior, comments, messages, tests, configuration, the
published package, or the protected artifacts of the previous phases. Every gate
below is a pass or fail check, and a failed gate stops the publication and is
recorded as a gap.

## Scope gate

- [ ] Confirm the candidate diff contains only the documents of
  `docs/worktree-manager/` and, when a link is broken, the navigation lines of
  `docs/README.md` and `docs/architecture/INDEX.md`.
- [ ] Confirm the diff contains no runtime, configuration, test, published
  package, version, or evidence path.
- [ ] Confirm the diff contains no comment or message change; those belong to
  the later language phase.
- [ ] Confirm the previous phase artifacts and the protected artifacts of the
  other phases are untouched.
- [ ] Confirm that the published tags and the transition history are the only
  trace of the purged evidence.

## Source gate

- [ ] Confirm the base commit and the published npm version of
  `worktree-for-agents` declared by the phase, and that they did not move.
- [ ] Confirm that the declared package version is available in the registry and
  that the reviewed sources match the standalone repository at
  `https://github.com/Saez520/worktree-manager`.
- [ ] Confirm every source consulted for the comparison is available in the
  installed package or in the standalone repository: the entrypoint, the package,
  the manager contracts and the transition history, the consumer entrypoint, the
  adapter and the integration document.
- [ ] Record every unavailable source as a named gap instead of replacing it
  with an inferred behavior.

## Contract gate

- [ ] Compare the commands, the options, the paths, the configuration keys and
  their defaults, the schema fields, the result values, the warnings, the
  identifiers and the exit codes with the executable source and with
  `docs/cli-contract-v1.md`.
- [ ] Confirm that the target-direct syntax places `--parent-repo` after the
  `target-direct` action, and that the five actions are the published ones.
- [ ] Confirm that the seven-key JSON envelope and the nine-key protocol
  envelope are published as implemented, and that `data.output` is not
  introduced and JSON is never described as implicit.
- [ ] Confirm that the seven MCP tools, their fields and their required fields
  are published as implemented.
- [ ] Confirm the human-readable stdout, the JSON stdout and the stderr
  diagnostics remain distinct.
- [ ] Confirm the pre-lock validation, the plan and execution pair, the
  reconciliation and the transport fallback are described as implemented.

## Safety gate

- [ ] Check the consent, `--discard`, `--preserve-dirty`, the locks, the
  journals, the backups, the conflicts and the `pending_intervention` wording.
- [ ] Check the parent-only, the target-direct, the distribution and the
  adapter boundaries separately.
- [ ] Ensure no claim implies an automatic merge, an automatic push, a silent
  discard, or a recovery presented as a success.
- [ ] Confirm that no destructive lifecycle command is executed while the
  documentation is reviewed.

## Compatibility gate

- [ ] Review the standalone and the consumer-facing matrices independently;
  every row must have a compatibility status, a deprecation status, evidence,
  an owner and a review.
- [ ] Confirm that the removed surfaces are named as removed, and that no
  removed surface is presented as supported.
- [ ] Confirm that the deprecated surfaces are marked read-only and that their
  replacement is named.
- [ ] Confirm that every gap is named as a gap, and that no unlimited
  compatibility or unannounced removal is promised.

## Editorial gate

- [ ] Resolve every relative link of every document of the section.
- [ ] Confirm the new editorial prose is English while the technical literals
  remain exactly as implemented.
- [ ] Confirm the navigation prose of the consumer documentation is unchanged
  and that only a broken link was repaired.
- [ ] Search the documents for coordination identifiers, execution paths and
  temporary paths, and confirm that none is present.

## Evidence gate

- [ ] Record, for every gate above, the pass or fail result and the location
  of the observation that supports it.
- [ ] Confirm that a mismatch between a document and a source is resolved in
  the document or recorded as a gap; the publication does not continue with a
  known mismatch.
- [ ] Confirm that the published tags and the transition history remain the
  only trace of the purged evidence, and that no phase digest is republished.

## Publication and rollback gate

- [ ] Publish only when every gate has evidence in the candidate diff or in a
  source comparison.
- [ ] Confirm that the delivery to the main branch and the synchronization of
  the origin are separate steps, each one with its own authorization, and that
  the delivery state is recorded as pending until they are performed.
- [ ] Confirm that the branch used as the base is still the declared base; a
  moved base requires a rebase and a complete revalidation of the suites
  before the delivery.
- [ ] Confirm that the rollback is a documentation revert of the candidate
  documentation and index changes; it must not alter runtime state and it
  must not restore discarded worktree data.

## Version gate

- [ ] Confirm that the version of the consumer lives in
  `.flowtask/package.json` only, and that this change does not modify it.
- [ ] Confirm that the documentation does not duplicate any version number of
  the consumer, and that the contract version and the tool version of the
  standalone remain described as independent.
