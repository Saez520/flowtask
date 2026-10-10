# FlowTask

AI-driven development workflow system with persistent memory via Engram.

FlowTask provides specialized AI agents that work together to automate software development tasks — from requirements capture to implementation and validation. Artifacts (CAs, plans, audits, reports) are stored in Engram as ca-artifact type; Engram persists both artifact content and operational state. Legacy CA artifacts remain in .workspace/ as fallback (Dual-Source).

Current version: **1.22.0** (declared in `.flowtask/package.json`).

The system includes a **personality system** that adapts the runner's tone and depth based on your experience level, and **parallel worktree isolation** for running multiple development workflows simultaneously.

***

## Installation

### Step 1: Clone FlowTask

```bash
git clone git@your-gitlab-server/flowtask.git
```

### Step 2: Install globally with npm link

```bash
cd .flowtask
npm link

# Verify installation
flowtask --version
```

### Step 3: Install FlowTask in your project

```bash
cd ~/proyectos/mi-proyecto
flowtask install
```

### Updating FlowTask

```bash
cd .flowtask
git pull

cd ~/proyectos/mi-proyecto
flowtask update
```

### Configuración por instalación

FlowTask guarda su configuración propia en el directorio de la instalación activa:
`<flowtaskDir>/config/profile.json`, `<flowtaskDir>/config/graphify.json` y
`<flowtaskDir>/tui.json`. Este último es la declaración TUI canónica y se
regenera desde el manifest y las fuentes de la instalación; no se usa ningún
residuo anterior como fuente.

Durante `update`, el `tui.json` raíz y `CLAUDE.md` son residuos legacy del
consumidor: se eliminan automáticamente y no se regeneran. Graphify continúa
coordinándose como parte de la actualización. Si la ruta de instalación no
permite escribir, el mensaje indica revisar permisos/espacio y reintentar con
`flowtask update`.

### CLI Command Reference

| Command              | Description                             |
| -------------------- | --------------------------------------- |
| `flowtask install`   | Install FlowTask in the current project |
| `flowtask update`    | Update FlowTask in the current project  |
| `flowtask --help`    | Show help message                       |
| `flowtask --version` | Show version                            |

***

## Quick Start

### Initialize a new project

```bash
opencode
> /init
```

This will scan your project structure, detect the technology stack, and populate Engram with project context.

Or initialize specific layers:

```
/init-types      # Scan types/models
/init-data       # Scan data layer
/init-business   # Scan business logic
/init-config     # Scan configuration
/init-api        # Scan API endpoints
```

### Onboard to FlowTask (personality system)

```bash
> /onboard
```

The Onboarder agent runs a short technical quiz based on your project's actual stack to assess your experience level (training / mid / senior), then assigns a runner personality (tutor / coach / peer) that adapts the runner's tone, depth, and guidance style.

### Create a new acceptance criteria

```bash
> /new-ca CA-001
```

The CA-Writer agent will guide you through:

- Clarifying requirements and business rules
- Classifying intention type (Nueva funcionalidad / Optimización / Corrección / Integración / Cambio de alcance)
- Detecting AI-slop patterns (scope inflation, over-engineering, premature details)
- Confirming tradeoffs and known GAPs

The CA is saved to Engram as a ca-artifact (topic_key: ca/CA-001/artifact/ca). Legacy CAs also remain in `.workspace/CA-001/ca.md` as fallback.

### Run a development workflow

```bash
> /run CA-001
```

FlowTask will:

1. **CA-Writer** — clarifies requirements if the CA doesn't exist yet
2. **Planner** — generates a decision-complete plan in Engram (ca/CA-{ID}/artifact/plan) with fallback to `.workspace/` for legacy CAs
3. **Plan-Auditor** — reviews the plan (auto for >5 tasks; always in Evolution Mode)
4. **Checkpoint** — waits for your confirmation (`"ejecutar"`)
5. **Constructor** — implements following project conventions
6. **Validator** — reviews implementation against the plan (max 2 retries)

> **Parallel CAs**: Every CA runs in its own isolated **Git worktree** — see [Git Worktrees](#git-worktrees) below.

### Explore the project

```bash
> /inspect ¿cómo funciona el módulo de autenticación?
```

The Inspector searches Engram first, then reads relevant files. It always presents tradeoffs and GAPs without creating or modifying anything.

### Evolve a FlowTask agent

```bash
> /evolve-agent planner necesito que valide referencias antes de guardar el plan
```

Runs the full CA → Plan → Audit → Implement cycle, but scoped exclusively to `.flowtask/` files.

### Check status

```bash
> /status
```

Shows Engram memory statistics, active workflows, and project initialization status.

***

## Slash Commands Reference

| Command              | Agent               | Description                                              |
| -------------------- | ------------------- | -------------------------------------------------------- |
| `/init`              | Initializer         | Scan entire project and populate Engram context          |
| `/init-types`        | Initializer         | Scan types/models layer                                  |
| `/init-data`         | Initializer         | Scan data layer                                          |
| `/init-business`     | Initializer         | Scan business logic layer                                |
| `/init-config`       | Initializer         | Scan configuration                                       |
| `/init-api`          | Initializer         | Scan API endpoints                                       |
| `/new-ca`            | CA-Writer           | Create a new acceptance criteria                         |
| `/run`               | Runner              | Execute a full CA workflow                               |
| `/inspect`           | Inspector           | Explore and analyze the project                          |
| `/evolve-agent`      | All (via Runner)    | Evolve a FlowTask agent (Evolution Mode)                 |
| `/onboard`           | Onboarder           | Run technical quiz and assign runner personality         |
| `/status`            | Runner              | Show FlowTask and Engram status                          |
| `/update`            | Runner              | Update FlowTask in current project                       |

***

## How It Works

### Conversational interface

The runner is always active as the primary agent. You can speak directly to it without slash commands — it classifies your intent automatically. Commands still work but are optional.

When `FLOWTASK_CLASSIFICATION` is present in the incoming context, the runner consumes that tag as-is. The categories and their destinations:

| Classification          | Routes to                                               |
| ----------------------- | ------------------------------------------------------- |
| `COMMAND:/run CA-{ID}`  | Full CA workflow                                        |
| `COMMAND:/inspect`      | Inspector                                               |
| `COMMAND:/new-ca`       | CA-Writer                                               |
| `COMMAND:/evolve-agent` | CA-Writer in Evolution Mode                             |
| `COMMAND:/init`         | Initializer                                             |
| `COMMAND:/status`       | FlowTask and Engram status                              |
| `CA_MENTION:{ID}`       | CA-Writer                                               |
| `PROJECT_QUESTION`      | Inspector                                               |
| `CHANGE_REQUEST`        | CA-Writer                                               |
| `REVIEW_REQUEST`        | Review-orchestrator                                     |
| `AMBIGUO`               | Runner asks whether it is a new requirement, a project question, or something related to an existing CA |

When `FLOWTASK_CLASSIFICATION` is absent, the runner loads the `manual-classification` skill and classifies your message against explicit commands, existing-CA mentions, project questions, change requests without a CA, and ambiguous input. `REVIEW_REQUEST` is not one of that skill's rules — review intent is detected by the [Review flow](#review-flow) phrases instead.

### Personality system

The Onboarder agent (`/onboard`) evaluates your experience level through a short technical quiz based on your project's actual tech stack. Based on the results, it assigns one of four runner personalities:

| Personality | Level   | Style                                          |
| ----------- | ------- | ---------------------------------------------- |
| Tutor       | Training | Step-by-step guidance, explains every concept  |
| Tutor       | Mid     | Guided but assumes basic competence            |
| Coach       | Senior  | Minimal guidance, focuses on strategy          |
| Peer        | Default | Balanced default when no quiz has been run     |

The personality is injected into the runner agent definition and persists across sessions. You can re-run `/onboard` at any time to update it.

### Git Worktrees

Every CA runs in an isolated Git worktree, so parallel executions never share a working directory:

```bash
${FLOWTASK_SCRIPTS}/worktree.sh create <CA-ID> --base <base_branch_detectada>
```

The base branch is detected in the order `development → main → trunk → main`, and the runner passes it explicitly. If the worktree or the branch `worktree/<CA-ID>` already exist (interrupted session, resumption), `create` fails — reuse the existing worktree and continue instead of creating another one.

The worktree state is persisted in Engram under `flow-state/CA-{ID}/instances` as `constructor.worktree = { path, branch, base_branch }`, and the runner includes path and branch in the constructor's prompt.

On successful closure (Validator APPROVED):

1. Commit before closing.
2. Run `${FLOWTASK_SCRIPTS}/worktree.sh complete <CA-ID>`.
3. On success, the script squash-merges into the detected base branch and removes the worktree and branch.
4. If `complete` fails with a conflict, the worktree and branch are preserved and the constructor is re-escalated to resolve it.

#### worktree.sh subcommands

| Subcommand                                            | Purpose                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `create <execution-name> [--base <branch>]`          | Creates the isolated worktree and its branch                                                                  |
| `complete <execution-name> [--base <branch>]`        | Squash-merges into the base branch and removes worktree and branch                                            |
| `cleanup <execution-name> [--base <branch>]`         | Removes worktree and branch without merging                                                                   |
| `recover [<transaction-id>]`                         | Resumes an interrupted `--preserve-dirty` transaction from its last phase; without an argument takes the most recent pending one. Idempotent |
| `prune`                                              | Cleans stale Git metadata and reports unassociated directories; it never deletes orphan worktrees             |
| `list`                                               | Lists worktrees on disk — the source of truth for reconciliation                                              |

`list` output is cross-checked with `flow-state/*/instances` to detect `constructor.worktree` and report worktrees present on disk with no Engram counterpart.

### Artifact storage

Artifacts are stored in Engram as ca-artifact type, with Dual-Source fallback for legacy CAs:

| Artifact            | Engram topic_key                          | Legacy fallback                  |
| ------------------- | ----------------------------------------- | -------------------------------- |
| Acceptance Criteria | `ca/CA-{ID}/artifact/ca`                  | `.workspace/CA-{ID}/ca.md`       |
| Implementation Plan | `ca/CA-{ID}/artifact/plan`                | `.workspace/CA-{ID}/plan.md`     |
| Plan Audit          | `ca/CA-{ID}/artifact/audit`               | `.workspace/CA-{ID}/audit.md`    |
| Validation Report   | `ca/CA-{ID}/artifact/validacion`          | `.workspace/CA-{ID}/validacion.md` |
| Logging Report      | `ca/CA-{ID}/artifact/logging-report`      | `.workspace/CA-{ID}/logging-report.md` |
| Tests Report        | `ca/CA-{ID}/artifact/tests-report`        | `.workspace/CA-{ID}/tests-report.md` |

Engram stores artifact content as `type: "ca-artifact"` observations. The legacy `.workspace/CA-{ID}/` filesystem path is preserved for ~19 legacy CAs. New CAs (post-ARTIFACTOS-ENGRAM) write only to Engram.

### Skills system

FlowTask uses **OpenCode skills** for reusable protocol instructions. Skills are stored in `.flowtask/skills/`:

| Skill                  | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `checkpoint-mixin`     | Persistence protocol for subagent checkpoints      |
| `graphify-protocol`    | Mandatory Graphify query chain, degradation and evidence contract |
| `handshake-protocol`   | Identity, task_id assignment, and context injection |
| `heuristics`           | Developer heuristic storage and detection          |
| `investigacion`        | Evidence-based investigation and diagnosis without writing files |
| `manual-classification`| Fallback input classifier (when no tag arrives)    |
| `memory-contract`      | Data contracts, categories, and topic_key format   |
| `memory-protocol`      | Engram mem_* usage protocol                        |
| `plan-template`        | Standard plan structure template                   |
| `review-readability`   | R2 lens — naming, complexity, maintainability      |
| `review-reliability`   | R3 lens — tests, coverage, edge cases              |
| `review-resilience`    | R4 lens — fallbacks, retry, graceful degradation   |
| `review-risk`          | R1 lens — security, privilege, data exposure       |
| `topic-keys-convention`| Engram topic_key ownership rules                   |
| `zero-assumptions`     | Prohibits assuming entity state without verification |

FlowTask includes **15 skills** covering memory protocols, identity management, Graphify consumption, and the **4R review lenses** (Risk, Readability, Reliability, Resilience) for comprehensive code review.

Skills are loaded via `skill({ name: "..." })` before invocation.

### Engram topic keys

| Topic Key                              | Owner                     | What it stores                        |
| -------------------------------------- | ------------------------- | ------------------------------------- |
| `ca/CA-{ID}/artifact/ca`               | CA-Writer                 | Acceptance criteria content           |
| `ca/CA-{ID}/artifact/plan`             | Planner                   | Plan content                          |
| `ca/CA-{ID}/artifact/audit`            | Plan-Auditor              | Plan audit content                    |
| `ca/CA-{ID}/artifact/validacion`       | Validator                 | Validation report content             |
| `ca/CA-{ID}/artifact/logging-report`   | Logger                    | Logging report content                |
| `ca/CA-{ID}/artifact/tests-report`     | Tester                    | Tests report content                  |
| `hotfix/{id}/artifact/investigacion`   | Runner                    | Hotfix investigation evidence         |
| `hotfix/{id}/artifact/plan`            | Runner                    | Hotfix plan content                   |
| `hotfix/{id}/artifact/validacion`      | Validator                 | Hotfix validation report              |
| `flow-state/CA-{ID}/instances`         | Runner                    | Instance map + worktree + ca_status   |
| `flow-state/CA-{ID}/create`            | CA-Writer                 | CA creation state                     |
| `flow-state/CA-{ID}/plan`              | Planner                   | Plan generation state                 |
| `flow-state/CA-{ID}/audit`             | Plan-Auditor              | Audit state                           |
| `flow-state/CA-{ID}/construct`         | Constructor               | Implementation state                  |
| `flow-state/CA-{ID}/validate`          | Validator                 | Validation state                      |
| `flow-state/hotfix/{id}/instances`     | Runner                    | Hotfix instance map + worktree        |
| `flow-state/hotfix/{id}/construct`      | Constructor               | Hotfix implementation state           |
| `flow-state/hotfix/{id}/validate`      | Validator                 | Hotfix validation state               |
| `project/stack`                        | Initializer               | Tech stack                            |
| `project/conventions`                  | Initializer               | Project conventions                   |
| `project/{layer}`                      | Initializer               | Layer patterns (api, data, business…) |
| `impl/{ID}/patterns`                   | Constructor/Tester/Logger | Discovered technical patterns         |
| `impl/{ID}/decisions`                  | Constructor/Planner       | Design decisions                      |

### CA lifecycle and cleanup

Each CA tracks its state through Engram. When a workflow completes:

1. **Orphan task_id purge**: Stale subagent sessions are detected and cleaned up.
2. **CA closure**: The CA is marked `ca_status: "closed"` in Engram, releasing the instance name back to the pool.
3. **Session summary**: A structured summary is saved via `mem_session_summary` for future context recovery.

If a session is abandoned or lost, orphan CAs retain their instance name until a future session cleans them up.

### Execution Gate

The Execution Gate blocks the Constructor when the plan is not ready. It applies to every managed path that starts construction: `/run CA-{ID}` and `/evolve-agent`.

Three verifiable criteria, all of which must hold:

1. **Final plan exists**: `mem_search(query: "CA-{ID} plan", type: "ca-artifact", scope: "project")` returns at least one observation with `topic_key = ca/CA-{ID}/artifact/plan`.
2. **The plan body carries `gate_status`** with `blockers: NONE` and `pending_decisions: []`. A missing block fails the Gate.
3. **When `audit_required: true`** in the `gate_status`, `ca/CA-{ID}/artifact/audit` exists with `verdict: OKAY` and `blockers: NONE`.

On **FAIL** the runner emits a single line starting with `⛔ Gate rechazado: {razón concreta}` naming the condition to resolve (pending decision, blocker, missing or rejected audit, or absent `gate_status`). No Constructor is invoked and no worktree is created. On **PASS** the flow continues.

`--auto` does not exempt the Gate. It only skips the wait for explicit human confirmation; the Gate's checks are mandatory in every mode.

### Hotfix flow

A hotfix applies an agreed correction without creating a CA. The runner waits for the literal `ejecutar` event; this path invokes no CA-Writer, no Planner and no Plan-Auditor.

1. **Persist first** — build one normalized lowercase kebab-case slug from the agreed problem and form the ID `HF-{slug}` (do not duplicate an `HF-` prefix the operator already supplied). Query Engram for the candidate `hotfix/{id}` before writing; if it already exists, keep the base name and try `HF-{slug}-2`, `-3`, … sequentially until the first free candidate is found. The same ID is then reused verbatim across the `type: ca-artifact` artifacts, the `hotfix/{id}/artifact/*` namespaces, the flow-state, the prompts, the `execution_id`, the `artifact_namespace`, the worktree and the branch.
2. **Worktree and Constructor** — detect the base in the order `development → main → trunk → main`, then run `${FLOWTASK_SCRIPTS}/worktree.sh create hotfix/{id} --base {base_branch}`. The path is `.worktrees/hotfix/{id}` and the branch is `worktree/hotfix/{id}`. Resumptions reuse the existing worktree. State persists under `flow-state/hotfix/{id}/instances`, and the Constructor is dispatched with `execution_id=hotfix/{id}`, `artifact_namespace=hotfix/{id}`, path, branch and base branch.
3. **Validator and closure** — the Validator persists `hotfix/{id}/artifact/validacion` and its own flow-state. A rejection returns to the Constructor for up to two attempts, then escalates. On APPROVED, commit first, then run `${FLOWTASK_SCRIPTS}/worktree.sh complete hotfix/{id} --base {base_branch}`. A conflict preserves worktree and branch and escalates without cleaning up; a rejection caused by uncommitted destination changes also preserves everything and escalates to the developer. `list`, `prune` and the reconciliation cross hotfix worktrees with `flow-state/hotfix/{id}/instances` and report orphans.

The hotfix flow keeps the same isolation, checkpoints, retries and squash-merge closure as the CA flow, without touching the CA namespaces.

`--preserve-dirty` is an **opt-in transaction**: it captures the destination's eligible uncommitted changes into private refs (`refs/flowtask/backups/<tx-id>`, never in the public stash list), records each phase in `.flowtask/backups/<tx-id>/journal`, and restores fine-grained state at the end. Offer it **only on explicit human instruction** — never by default nor in an automated flow. Persisted config (`.flowtask/config/worktree.json` with `"preserveDirty": true`) counts as explicit human consent, and the script never writes it. If a preserving closure is interrupted, resume it with `worktree.sh recover [<tx-id>]`; repeating it is safe and idempotent. If the restoration ends pending-manual, show the developer the safe instructions the script prints — manual resolution is never automated.

### Review flow

The Review flow is triggered by review intent, detected from phrases such as "revisá el código", "hace un review", "revisa el diff", "revisa la rama", "revisa los archivos", "code review", "review de", "pre-commit review" or `/review`.

Scope is extracted from one of: a branch (`git diff {base_branch}...HEAD`), an explicitly supplied diff, a file list, or a PR/MR. When the scope is unclear the runner asks before invoking.

| Mode         | Scope                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `pre-commit` | Current staged or unstaged diff — the default when no other mode is given |
| `branch`     | `git diff {base_branch}...HEAD`                                        |
| `files`      | The listed file paths                                                   |
| `pr-mr`      | The diff of the given PR/MR                                             |
| `full-4r`    | Activated by critical paths, a diff over 400 lines, or an explicit request |

The runner dispatches `flowtask-review-orchestrator` with only `mode`, `worktree`, `branch`, `base_branch` and, when present, `error`. The `files` and `pr-mr` variants add just the path list or the PR/MR identifier. The diff is never attached or serialized, and neither lenses nor review frameworks are prescribed. Findings keep the contract `APPROVED | BLOCKED | CHANGES_REQUIRED` with severity, file/line, evidence, justification and recommendation.

### Graphify

Graphify maintains a persistent knowledge graph of the repository under `graphify-out/`. For its own repository-context needs the runner follows the query chain defined in `.flowtask/agents/runner.md`: the configured graph integration, then escalation to the Inspector.

```
1. graph integration (MCP) — the configured graph query tool
   ↓ unavailable, or no usable result
2. escalate to the Inspector
```

Queries always run from the main repository root, never from `.worktrees/`. When MCP yields no usable references the runner emits `no pude obtener referencias utilizables del grafo, escalando al Inspector` and delegates the exact question, scope, citable references, pending GAPs and a one-line record of the failed path. If the Inspector is unavailable it reports the missing evidence and escalates to the developer, without a normal project search and without invented context.

The agents that consume Graphify use the same MCP-only contract. If MCP does not provide usable context, they use normal project search and explicitly state that the result is not Graphify evidence.

The `flowtask-graphify-docs-media` background agent generates the graph's documentation and media (`graph.json`, `GRAPH_REPORT.md` and `graph.html` in `graphify-out/`). It runs only after explicit developer acceptance, in background, with `projectDir` pointing at the main repository, and never blocks the requested work.

***

## Workflow Diagram

```
1. /new-ca CA-001
   └── CA-Writer clarifies requirements
       └── Saves CA to Engram (ca/CA-001/artifact/ca)
       └── Saves flow state to Engram (flow-state/CA-001/create)

2. /run CA-001
   └── Runner reads the CA from Engram
       └── Execution Gate verifies plan + gate_status
       └── Creates Git worktree (.worktrees/CA-001/, branch worktree/CA-001)
       └── Planner generates plan (decision-complete)
            └── Saves plan to Engram (ca/CA-001/artifact/plan)
            └── Saves flow state (flow-state/CA-001/plan)
       └── Plan-Auditor reviews (auto if >5 tasks or Evolution Mode)
            └── Saves audit to Engram (ca/CA-001/artifact/audit)
            └── Saves flow state (flow-state/CA-001/audit)

3. "ejecutar"
   └── Constructor implements in the worktree, following project conventions
       └── Saves flow state (flow-state/CA-001/construct)

4. Validator reviews
   └── Saves validation to Engram (ca/CA-001/artifact/validacion)
   └── APPROVED → worktree.sh complete → squash-merge to detected base, cleanup
   └── REJECTED → retry Constructor (max 2 times)
       └── 2nd rejection → escalates to developer
```

***

## Project Structure

```
FlowTask/
├── .flowtask/
│   ├── bin/
│   │   ├── flowtask.js           # CLI entry point (npm link)
│   │   ├── ferris-search-darwin-arm64
│   │   └── ferris-search-windows-x64.exe
│   │   ├── lib/                  # Implementation code (installer, graphify, claude, ui)
│   │   └── test/                 # Test suites (7) for the CLI and its libraries
│   ├── package.json              # Version, plugin dependencies and bin config
│   ├── agents/                   # FlowTask agent definitions
│   │   ├── runner.md             # Primary orchestrator (always active)
│   │   ├── ca-writer.md          # Requirements clarification and CA generation
│   │   ├── planner.md            # Decision-complete plan generation
│   │   ├── plan-auditor.md       # Plan verification
│   │   ├── constructor.md        # Implementation
│   │   ├── validator.md          # Validation
│   │   ├── inspector.md          # Project exploration and analysis
│   │   ├── initializer.md        # Project scanning and Engram population
│   │   ├── logger.md             # Logging instrumentation
│   │   ├── tester.md             # Test generation
│   │   ├── onboarder.md          # Technical quiz and personality assignment
│   │   ├── review-orchestrator.md # 4R review orchestration
│   │   └── graphify-docs-media.md # Background graph documentation and media generation
│   ├── checkpoints/              # Checkpoint state storage
│   ├── claude/                   # Global Claude Code support/templates
│   │   ├── settings.json         # Claude Code settings template
│   │   └── mcp.json              # MCP server declaration template
│   ├── commands/                 # FlowTask slash commands
│   │   ├── init.md               # /init
│   │   ├── init-api.md           # /init-api
│   │   ├── init-business.md      # /init-business
│   │   ├── init-config.md        # /init-config
│   │   ├── init-data.md          # /init-data
│   │   ├── init-types.md         # /init-types
│   │   ├── new-ca.md             # /new-ca
│   │   ├── run.md                # /run
│   │   ├── inspect.md            # /inspect
│   │   ├── evolve-agent.md       # /evolve-agent
│   │   ├── onboard.md            # /onboard
│   │   ├── status.md             # /status
│   │   └── update.md             # /update
│   ├── config/                   # Configuration used by this installation
│   ├── personas/                 # Runner personality definitions
│   │   ├── tutor-mid.md
│   │   ├── tutor-senior.md
│   │   └── tutor-training.md
│   ├── plugins/
│   │   ├── flowtask-plugins.json      # Plugin manifest — declares the 5 components below
│   │   ├── flowtask-classifier-hook/  # Server-side classification plugin
│   │   │   ├── src/
│   │   │   └── dist/
│   │   ├── flowtask-classifier-tui/   # OpenCode UI classification plugin
│   │   │   ├── src/
│   │   │   └── dist/
│   │   ├── flowtask-model-selector/    # Model selection plugin
│   │   ├── flowtask-permission-gate/   # Permission and commit gate plugin
│   │   ├── flowtask-context-checkpoint/ # Context checkpoint plugin
│   │   └── flowtask.js           # Additional plugin entry point (not in the manifest)
│   ├── scripts/                  # Utility scripts
│   │   ├── version-watcher.ps1   # Engram version monitoring
│   │   ├── buffer-sync.ps1       # Buffer synchronization
│   │   └── worktree.sh           # Git worktree management (create/complete/cleanup/recover/prune/list)
│   ├── skills/                   # OpenCode skills (canonical source)
│   │   ├── checkpoint-mixin/
│   │   │   └── SKILL.md          # Checkpoint persistence protocol
│   │   ├── graphify-protocol/
│   │   │   └── SKILL.md          # Mandatory Graphify query chain and evidence contract
│   │   ├── handshake-protocol/
│   │   │   └── SKILL.md          # Identity and task_id assignment
│   │   ├── heuristics/
│   │   │   └── SKILL.md          # Developer heuristic storage and detection
│   │   ├── investigacion/
│   │   │   └── SKILL.md          # Evidence-based investigation without writing files
│   │   ├── manual-classification/
│   │   │   └── SKILL.md          # Fallback input classifier
│   │   ├── memory-contract/
│   │   │   └── SKILL.md          # Data contracts and topic_key format
│   │   ├── memory-protocol/
│   │   │   └── SKILL.md          # Engram mem_* usage protocol
│   │   ├── plan-template/
│   │   │   └── SKILL.md          # Plan structure template
│   │   ├── review-readability/
│   │   │   └── SKILL.md          # R2 lens — naming, complexity
│   │   ├── review-reliability/
│   │   │   └── SKILL.md          # R3 lens — tests, coverage
│   │   ├── review-resilience/
│   │   │   └── SKILL.md          # R4 lens — fallbacks, retry
│   │   ├── review-risk/
│   │   │   └── SKILL.md          # R1 lens — security, privilege
│   │   ├── topic-keys-convention/
│   │   │   └── SKILL.md          # Engram topic_key ownership rules
│   │   └── zero-assumptions/
│   │       └── SKILL.md          # Zero-assumptions protocol
│   ├── tui.json                  # Canonical TUI declaration (regenerated from the manifest)
│   └── .temp/                    # Local buffer for checkpoints
├── .opencode/                    # OpenCode configuration
│   ├── plugins/
│   ├── package.json
│   └── bun.lock
├── .temp/                        # Runtime buffer for checkpoints
├── .worktrees/                   # Isolated worktrees for CA and hotfix executions
├── docs/
│   └── architecture/             # Architecture docs (INDEX.md + 14 docs)
├── graphify-out/                 # Graphify graph outputs
├── Flowtask-Architecture/        # Architecture documentation
├── opencode.json                 # OpenCode configuration (agent registry, MCP)
├── update-engram.ps1             # Engram update script
├── core-flowtask.md              # Core FlowTask document
├── core-flowtask.pdf             # Core FlowTask document (PDF)
├── presentacion-flowtask.md      # Project presentation
├── .gitignore                    # Git ignore rules
└── .workspace/                   # Legacy artifact storage (pre-ARTIFACTOS-ENGRAM)
    └── CA-{ID}/
        ├── ca.md               ← Legacy — new CAs use Engram
        ├── plan.md             ← Legacy — new CAs use Engram
        ├── audit.md            ← Legacy — new CAs use Engram
        └── validacion.md       ← Legacy — new CAs use Engram
```

***

## FlowTask Agents

FlowTask includes **13 specialized agents** that work together to automate development workflows:

| Agent                   | Role                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `flowtask-runner`       | Primary orchestrator — always active, classifies intent, coordinates subagents   |
| `flowtask-ca-writer`    | Clarifies requirements, classifies intention, detects AI-slop, writes CA to file |
| `flowtask-planner`      | Generates decision-complete plans using **LSP + ast-grep** for semantic code discovery and structural extraction — reduces context noise by ~91% vs Glob+Grep |
| `flowtask-plan-auditor` | Verifies plan executability, file references, and QA scenarios                   |
| `flowtask-constructor`  | Implements plans following project conventions                                   |
| `flowtask-validator`    | Validates implementation against plan                                            |
| `flowtask-inspector`    | Answers questions about the project with tradeoffs and GAPs — read-only          |
| `flowtask-initializer`  | Scans project and populates Engram with project context                          |
| `flowtask-onboarder`    | Runs technical quiz based on project stack, assigns runner personality           |
| `flowtask-logger`       | Adds logging instrumentation                                                     |
| `flowtask-tester`       | Generates tests                                                                  |
| `flowtask-review-orchestrator` | Orchestrates 4R review lenses (Risk, Readability, Reliability, Resilience) |
| `flowtask-graphify-docs-media` | Background agent that generates graph documentation and media into `graphify-out/` |

### Evolution Mode

Evolution Mode lets you improve FlowTask agents using the same workflow used for your project. Use `/evolve-agent [agent-name] [description]` to:

1. Backup the existing agent before modifications
2. Clarify the change with CA-Writer
3. Plan the change with Planner (scoped to `.flowtask/` files only)
4. Audit the plan with Plan-Auditor (always invoked, no task threshold)
5. Confirm and execute with Constructor
6. The user must confirm before Constructor runs — no `--auto` bypass

***

## Deprecated Features / Funcionalidades deprecadas

El clasificador de FlowTask está deprecado y desactivado por defecto. La unidad incluye el hook automático `flowtask-classifier-hook` y el indicador visual `flowtask-classifier-tui`. Motivo: **los modelos ya son lo suficientemente inteligentes y con agent mode para saber a quién delegar**.

El código fuente se conserva en `.flowtask/plugins/flowtask-classifier-hook/` y `.flowtask/plugins/flowtask-classifier-tui/`. Para reactivarlo excepcionalmente, edita ambas entradas correspondientes del manifiesto `.flowtask/plugins/flowtask-plugins.json`, cambia `enabled` a `true` en las dos y ejecuta:

```bash
flowtask update
```

Ambas entradas deben cambiarse juntas: cualquier estado parcial se trata como desactivado. En ese caso, `flowtask update` retira las instalaciones existentes de ambos componentes y muestra la alerta exacta: `el plugin de clasificación fue deprecado`.

El toggle visual nativo de OpenCode no se sincroniza con el hook server-side; la activación oficial se gestiona únicamente mediante el manifiesto y `flowtask update`.

***

## Troubleshooting

### Engram not found

```bash
engram --version
brew install gentleman-programming/tap/engram
```

### MCP server not connecting

```bash
engram serve &
cat opencode.json | grep -A5 '"mcp"'
```

### Plugin not loading

```bash
ls ~/.config/opencode/plugins/
ls ~/.config/opencode/agents/
ls ~/.config/opencode/commands/
```

### Classifier plugins not compiling

Applies after re-enabling both classifier entries in the manifest. To rebuild the classifier hook (server-side):
```bash
cd .flowtask/plugins/flowtask-classifier-hook
npm install
npm run build
```

To rebuild the classifier TUI (OpenCode UI):
```bash
cd .flowtask/plugins/flowtask-classifier-tui
npm install
npm run build
```

### Worktree conflicts

If `worktree.sh complete` fails with conflicts, the worktree and branch are preserved:

```bash
cd .worktrees/CA-{ID}/
git status
# Resolve conflicts manually, then:
git add .
git commit -m "resolve conflicts"
# The FlowTask runner can re-escalate the constructor
```

For a hotfix the path is `.worktrees/hotfix/{id}/` on branch `worktree/hotfix/{id}`.

***

## License

MIT
