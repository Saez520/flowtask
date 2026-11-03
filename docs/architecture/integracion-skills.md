# Current skills integration

Skills are instruction modules that can be loaded on demand. The canonical
source lives in `.flowtask/skills/`; there is no editorial skill registry that
replaces that directory.

## Loading

The runner or subagent loads a skill by name through the `skill` tool:

```text
skill({ name: "investigacion" })
skill({ name: "memory-protocol" })
skill({ name: "handshake-protocol" })
```

The name corresponds to the directory containing `SKILL.md`. Installation
copies these sources to the selected target; the executable contract remains in
the target installation, and the source in this repository remains
`.flowtask/skills/`.

## Responsibilities

- `investigacion` defines evidence-based research without writing files.
- `memory-protocol` and `memory-contract` define the use of Engram and its data.
- `handshake-protocol` manages identity and continuity when applicable.
- `checkpoint-mixin` preserves subagent checkpoints.
- `graphify-protocol` defines Graphify query, degradation, and evidence.
- The `review-*` skills provide the lenses for risk, readability,
  reliability, and resilience review.

A skill provides instructions; it does not register agents or replace the plugin
manifest. If an instruction on this page contradicts the installed `SKILL.md`,
the installed contract prevails and the conflict must be documented.
