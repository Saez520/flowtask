# Project history

This file preserves the historical account of elements that existed in
FlowTask and were retired from the current system. It is a reference and
learning document: it does not describe how to execute, install, or reactivate anything named here.

Current capabilities are described in `README.md` and `docs/`.

---

## Retired commands

The following six commands existed as explicit FlowTask commands and
were removed from the canonical `.flowtask/commands/` directory, along with their
active mentions in the manifest, agents, plugin, operational documentation, and
architecture documentation.

Common deprecation evidence: the architecture documentation declared them
legacy commands that the runner no longer required (`docs/core-flowtask.md:97`, state
before removal), and the pending record `pending/deprecate-commands`
(Engram #3307) documents that the developer had declared them deprecated due to
redundancy with intent-based routing.

- **`init`** — Full project scan that detected the stack and populated
  context in Engram. Evidence: `docs/core-flowtask.md:97`; Engram #3307.
- **`new-ca`** — Guided creation of a CA from a developer description.
  Evidence: `docs/core-flowtask.md:97`; Engram #3307.
- **`run`** — Execution of the full flow for an existing CA. Evidence:
  `docs/core-flowtask.md:97`; Engram #3307.
- **`inspect`** — Direct entry to the Inspector for exploration and analysis without
  a CA. Evidence: `docs/core-flowtask.md:97`; Engram #3307.
- **`evolve-agent`** — Entry to FlowTask's agent evolution mode.
  Evidence: `docs/core-flowtask.md:97`; Engram #3307.
- **`status`** — Summary of FlowTask status and Engram statistics.
  Evidence: `docs/core-flowtask.md:97`; Engram #3307.

The per-layer commands `init-types`, `init-data`, `init-business`, `init-config`,
`init-api`, as well as `onboard` and `update`, remain current and were not
retired.

### Scope of the removal

The removal applied only to the canonical repository. Previous installations and
consumer projects were not modified, and no migration, cleanup, or compatibility
routine was added.

---

## Documentation retired from the main path

This section preserves concepts that existed but no longer describe current installation or execution.

### Old anatomy

`workspace-anatomy.md` presented `.flowtask` as a static installation, `.workspace` as the main dynamic data, and Engram as separate storage. The current model uses `.opencode/flowtask`, `.claude/flowtask`, `.vscode/flowtask`, or standalone `.flowtask` targets; new artifacts are stored in Engram and `.workspace` remains only as compatibility for old CAs.

### Archivist and sub-orchestrators

`archivist-sub-agent.md`, `systematic-flowtask.md`, `orchestration-flow.md`, and `initializer.md` described `flowtask-archivist`, `TECH-LEAD-ORCHESTRATOR`, and stack experts not registered in `opencode.json`. The actual close uses `.flowtask/scripts/worktree.sh` and the agents registered by the installed configuration.

### Classifier

`plugin-link.md` and the classifier READMEs described `FLOWTASK_CLASSIFICATION` injection. The current manifest marks `classifier-hook` and `classifier-tui` as `deprecated=true` and `enabled=false`; the installer omits them and cleans old installations. The source is preserved, but it does not belong to the normal path.

### Repomix/CA-008 snapshot

The previous index, `Flowtask-Architecture/README.md`, and `docs/architecture/flowtask-core.md` were generated around CA-008 and linked missing modules, the roadmap, and Archivist. They are preserved as background; use `docs/README.md`, `docs/core-flowtask.md`, and the new `docs/architecture/INDEX.md` for the present.

### Conceptual installation

`architecture/installation.md` did not describe interactive selection, manifest, markers, or derived configuration. The normative guide is now `docs/installation.md`.

### Unverified claims

`lsp-ast-grep.md`, `sdd.md`, and `flowtask-presentation.md` contain proposals, figures, or roadmap items not supported by current contracts. Do not cite them as available capabilities.

The historical documents that remain physically present begin with a notice that points to this file and to `docs/README.md`. They are not deleted because they may be external NotebookLM inputs.
