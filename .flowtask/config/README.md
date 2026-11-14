# flowtask/config — Ecosystem configuration

## Persona, autonomy, and permissions layers

Each installed target has its own layer configuration in
`<target>/config/`. The three files are local state: they are not versioned.

| File | Layer | Values |
|------|-------|--------|
| `profile.json` | Persona (tone) | `level`: `training`, `mid`, `senior`, `custom`. `persona`: tone identity. `onboarded`: onboarding state. |
| `autonomy.json` | Autonomy (initiative) | `version`: `1`. `profile`: `assistant` or `autonomous-dev`. |
| `permissions.json` | Permissions (technical envelope) | `version`: `1`. `envelope`: `standard`. |

- The precedence between layers is `permissions > autonomy > persona`: persona
  neither authorizes nor restricts, and autonomy does not widen the permissions
  envelope.
- `install` and `update` create `autonomy.json` and `permissions.json` **only when
  the layer does not exist**, with `assistant` and `standard` as the
  installation values. `assistant` is the lowest authority: the system waits for
  an explicit order per job. That default is a migration, not a runtime
  fallback: at runtime, a missing or invalid layer is a failure with an
  operational message.
- An interactive installation asks a single initiative question and recommends
  the minimum. `--autonomy <assistant|autonomous-dev>` selects the value without
  the question; the flag overwrites a valid layer, while the interactive answer
  applies only to absent layers. A valid layer is preserved without a choice.
- During `install` and `update`, an invalid layer is never repaired with a default:
  the operation fails and the file is preserved.
- The explicit `flowtask repair` is the only exception: it backs up the invalid
  file, writes the safe default, verifies the result, and preserves valid layers.
- A missing or invalid persona leaves a warning and execution continues without a
  persona, without touching autonomy or permissions.
- `flowtask layers resolve` shows the resolved layers of a target and the
  origin of each one.

The normative source of the three-layer contract is
`docs/architecture/persona-autonomy-permissions-layers.md`.

## Runner parity allowlist (runner-parity-allowlist.json)

`runner-parity-allowlist.json` records the intentional line deltas between the
canonical runner and the baseline used by `flowtask flows verify --baseline`.
Unlike the layer files above, this file is versioned so a clean checkout applies
the same allowlist.

- Format: a JSON array. Each entry declares exactly one of `line` or `sha256`,
  plus a non-empty `reason`:
  - `"line": string` is the exact literal text of the missing baseline line.
  - `"sha256": string` is the lowercase 64-character hexadecimal SHA-256 of the
    missing baseline line. It identifies the removed line without storing its
    text.
  - An entry with both properties, with neither, or with a malformed
    fingerprint invalidates the whole allowlist.
- Fingerprint input: the SHA-256 is computed over the UTF-8 bytes of the exact
  baseline line, after splitting the baseline by `\n` and excluding blank
  lines. The line is neither trimmed nor normalized.
- Compatibility: literal entries remain valid as written; no migration is
  required.
- Matching: for each baseline line absent from the composed document, an exact
  literal entry is consumed first and a fingerprint entry second. Each entry
  covers one occurrence, and duplicate occurrences are counted.
- `--baseline <ref>` applies the file automatically from
  `.flowtask/config/runner-parity-allowlist.json`.
- `--allow-deltas <json>` replaces the default file; both allowlists are never
  merged.
- Fail-closed: a line not covered by a literal entry or a fingerprint keeps
  parity red. A missing file means an empty allowlist. A present but unreadable,
  invalid, or ambiguous file fails with `runner_allowlist_invalid`, and no
  parity comparison is run.
- Report: `parity.missing` lists each uncovered line as
  `{ "line_number": integer, "sha256": string }`. It never includes the line
  text. The line number is 1-based over the baseline split by `\n`.
- The allowlist covers the recorded baseline only; it is not a general parity
  mechanism for arbitrary baselines.

Audit a fingerprint against the baseline and print its line number without
printing the line text:

```bash
git show <ref>:.flowtask/agents/runner.md \
  | node -e 'const c=require("crypto");let d="";process.stdin.on("data",x=>d+=x).on("end",()=>{const l=d.split("\n");const i=l.findIndex(x=>c.createHash("sha256").update(x,"utf8").digest("hex")===process.argv[1]);console.log(i<0?"not found":"line "+(i+1));process.exit(i<0?1:0)})' <sha256>
```

Replace `<ref>` with the parity baseline and `<sha256>` with the entry
fingerprint.

## Context budget (context-budget)

The runner's context budget gate is a **transparent tool gate via mutable
`tool.execute.after`**: it lives in the
`flowtask-permission-gate` plugin (post-execution hook + cheap pre-gate in
`tool.execute.before`).

- Per-call limits: `read=16,000` chars, `grep=8,000`, `glob=8,000`.
- Accumulated per runner turn: `32,000` chars delivered.
- Degradation by levels: narrowing notice, reduced delivery without preview, and
  omission by accumulated total. The runner sees what was omitted, the real size,
  and who to delegate to; it never sees a preview of the omitted content.
- Image/PDF attachments blocked for the runner (delegation to the Inspector).
- Thresholds are not exposed in messages: the applied budget is named, not
  its figure.
- If the size cannot be measured, a trace is recorded and the delivery is made
  without trimming.

### Golden rule

**The runner does not know the thresholds.** They are not exposed in the prompt
(`.flowtask/agents/runner.md`) or via env; they only live in the plugin and in this
optional override file:

- `context-budget.json.example` — documented default values (optional).
- For real overrides, copy to `context-budget.json` (fail-open: invalid or
  unreadable JSON → `console.warn` + defaults; it never throws).
- `bash` stays outside the gate (only the runner's `read`, `glob`, and `grep`).

Revalidate the hook mutation contract with
`.flowtask/plugins/flowtask-permission-gate/test/context-budget-smoke.mjs` when
updating OpenCode (version drift).

## Parallel orchestration (parallel)

The ability to advance in parallel is declared per project and is optional.

- `parallel.json.example` is optional: the example documents the shape, with no active value.
- To declare it, copy the example to `parallel.json` and set `maxParallel`.
- `maxParallel` is an integer greater than or equal to 2. Missing, `null`, or invalid is
  equivalent to capacity 1 and sequential advancement.
- A capacity is not invented: advancement without a declared default value is sequential, and
  the first observation window does not calibrate a figure.
- The FIFO queue preserves arrival order and shows the position of each job.
- Serialized integration: closing runs one at a time on the same base.
- The detail of notices follows `policy.profile`: development with references and the last
  verified command, production concise.
- Internal figures for locks or records are not exposed.

The normative source of the policy is the `parallel-orchestration` skill and its integration
lives in `.flowtask/agents/runner.md`.
