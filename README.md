# FlowTask

**v1.9.0** — AI-driven development workflow system with persistent memory via Engram.

FlowTask provides specialized AI agents that work together to automate software development tasks — from requirements capture to implementation and validation. Artifacts (CAs, plans, audits, reports) are stored in Engram as ca-artifact type; Engram persists both artifact content and operational state. Legacy CA artifacts remain in .workspace/ as fallback (Dual-Source).

The system includes a **personality system** that adapts the runner's tone and depth based on your experience level, and **parallel worktree isolation** for running multiple development workflows simultaneously.

***

## Requirements

- **OpenCode**: [Install OpenCode](https://opencode.ai/docs/)
- **Engram**: Persistent memory system for AI agents (MCP-based) — see [docs/architecture/LSP + AST-Grep.txt](docs/architecture/LSP%20+%20AST-Grep.txt)
- **LSP** (Language Server Protocol): Semantic code discovery
- **ast-grep**: Structural pattern matching via AST
- **ferris-search**: Web search and content fetching via MCP

### Install Engram

```bash
# macOS / Linux
brew install gentleman-programming/tap/engram

# Or download from releases
# https://github.com/Gentleman-Programming/engram/releases
```

Verify installation:

```bash
engram --version
```

***

## Installation

### Step 1: Clone FlowTask

```bash
git clone git@your-gitlab-server/flowtask.git ~/dev/flowtask
```

### Step 2: Install globally with npm link

```bash
cd ~/dev/flowtask/.flowtask
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
cd ~/dev/flowtask
git pull

cd ~/proyectos/mi-proyecto
flowtask update
```

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

> **Parallel CAs**: The first active CA runs in your normal working branch. A second parallel CA automatically creates an isolated **Git worktree** — see [Git Worktrees](#git-worktrees) below.

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

The `flowtask-classifier` plugin intercepts your input and injects a `FLOWTASK_CLASSIFICATION` tag into context before the runner sees it:

| Classification          | Detected when                             |
| ----------------------- | ----------------------------------------- |
| `COMMAND:/run CA-{ID}`  | You type `/run CA-001`                    |
| `COMMAND:/inspect`      | You type `/inspect`                       |
| `COMMAND:/new-ca`       | You type `/new-ca`                        |
| `COMMAND:/evolve-agent` | You type `/evolve-agent`                  |
| `COMMAND:/init`         | You type `/init`                          |
| `COMMAND:/status`       | You type `/status`                        |
| `CA_MENTION:{ID}`       | You reference "CA-018", etc.              |
| `PROJECT_QUESTION`      | You ask a question about the project      |
| `CHANGE_REQUEST`        | You request a change without a CA         |
| Fallback                | Ambiguous — runner asks for clarification |

If the classifier is inactive, the runner falls back to the `manual-classification` skill.

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

FlowTask supports **parallel CA execution** using Git worktrees for isolation:

- **First active CA**: Runs in your normal working branch (no worktree).
- **Second+ parallel CA**: Automatically creates an isolated worktree via `.flowtask/scripts/worktree.sh create <CA-ID> --base development`.

When a parallel CA completes successfully (Validator APPROVED):
1. The worktree is merged back via `worktree.sh complete <CA-ID>`.
2. Squash-merge to `development`, then worktree and branch are cleaned up.
3. If a merge conflict occurs, the constructor is re-escalated to resolve it.

The worktree state is persisted in Engram under `flow-state/CA-{ID}/instances` as `constructor.worktree`.

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
| `handshake-protocol`   | Identity, task_id assignment, and context injection |
| `heuristics`           | Developer heuristic storage and detection          |
| `manual-classification`| Fallback input classifier (when auto is inactive)  |
| `memory-protocol`      | Engram mem_* usage protocol                        |
| `plan-template`        | Standard plan structure template                   |
| `topic-keys-convention`| Engram topic_key ownership rules                   |

Skills are loaded via `skill({ name: "..." })` before invocation.

### Engram topic keys

| Topic Key                   | Owner                     | What it stores                        |
| --------------------------- | ------------------------- | ------------------------------------- |
| `ca/{ID}`                   | Runner (via CA-Writer)    | CA snapshot                           |
| `plan/{ID}`                 | Runner (via Planner)      | Plan snapshot                         |
| `plan-audit/{ID}`           | Plan-Auditor              | Audit results                         |
| `validation/{ID}`           | Validator                 | Validation report                     |
| `flow-state/{ID}/instances` | Runner                    | Instance map + worktree + ca_status   |
| `flow-state/{ID}/create`    | CA-Writer                 | CA creation state                     |
| `flow-state/{ID}/plan`      | Planner                   | Plan generation state                 |
| `flow-state/{ID}/audit`     | Plan-Auditor              | Audit state                           |
| `flow-state/{ID}/construct` | Constructor               | Implementation state                  |
| `flow-state/{ID}/validate`  | Validator                 | Validation state                      |
| `project/stack`             | Initializer               | Tech stack                            |
| `project/conventions`       | Initializer               | Project conventions                   |
| `project/{layer}`           | Initializer               | Layer patterns (api, data, business…) |
| `ca/CA-{ID}/artifact/{filename}` | All agents | Artifact content (ca-artifact type) |
| `impl/{ID}/patterns`        | Constructor/Tester/Logger | Discovered technical patterns         |
| `impl/{ID}/decisions`       | Constructor/Planner       | Design decisions                      |

### CA lifecycle and cleanup

Each CA tracks its state through Engram. When a workflow completes:

1. **Orphan task_id purge**: Stale subagent sessions are detected and cleaned up.
2. **CA closure**: The CA is marked `ca_status: "closed"` in Engram, releasing the instance name back to the pool.
3. **Session summary**: A structured summary is saved via `mem_session_summary` for future context recovery.

If a session is abandoned or lost, orphan CAs retain their instance name until a future session cleans them up.

***

## Workflow Diagram

```
1. /new-ca CA-001
   └── CA-Writer clarifies requirements
       └── Saves CA to Engram (ca/CA-001/artifact/ca)
       └── Saves flow state to Engram (flow-state/001/create)
       └── Runner saves snapshot (ca/001)

2. /run CA-001
   └── Runner reads CA snapshot from Engram
       ├── [1st CA] → normal working directory
       └── [2nd+ CA] → creates Git worktree (.worktrees/CA-001/)
       └── Planner generates plan (decision-complete)
            └── Saves plan to Engram (ca/CA-001/artifact/plan)
           └── Saves flow state (flow-state/001/plan)
       └── Plan-Auditor reviews (auto if >5 tasks or Evolution Mode)
            └── Saves audit to Engram (ca/CA-001/artifact/audit)
           └── Saves flow state (flow-state/001/audit)

3. "ejecutar"
   └── Constructor implements following project conventions
       └── Saves flow state (flow-state/001/construct)

4. Validator reviews
   └── Saves validation to Engram (ca/CA-001/artifact/validacion)
   └── APPROVED → flow complete
       ├── [worktree CA] → squash-merge to development, cleanup
       └── [normal CA]   → done
   └── REJECTED → retry Constructor (max 2 times)
       └── 2nd rejection → escalates to developer
```

***

## Project Structure

```
FlowTask/
├── .claude/                      # OpenCode CLI environment
│   ├── agents/                   # OpenCode agent definitions
│   │   ├── flowtask-ca-writer.md
│   │   ├── flowtask-constructor.md
│   │   ├── flowtask-initializer.md
│   │   ├── flowtask-inspector.md
│   │   ├── flowtask-logger.md
│   │   ├── flowtask-onboarder.md
│   │   ├── flowtask-plan-auditor.md
│   │   ├── flowtask-planner.md
│   │   ├── flowtask-tester.md
│   │   └── flowtask-validator.md
│   ├── commands/                 # Slash command definitions (mirror)
│   └── flowtask/                 # FlowTask CLI environment
├── .flowtask/
│   ├── bin/
│   │   ├── flowtask.js           # CLI entry point (npm link)
│   │   ├── ferris-search-darwin-arm64
│   │   └── ferris-search-windows-x64.exe
│   │   └── lib/                  # Binary libraries
│   ├── package.json              # Plugin dependencies and bin config
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
│   │   └── onboarder.md          # Technical quiz and personality assignment
│   ├── agents-backup/            # Evolution Mode agent backups
│   ├── checkpoints/              # Checkpoint state storage
│   ├── claude/                   # FlowTask CLI environment (OpenCode)
│   │   └── settings.json         # OpenCode settings
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
│   ├── exports/                  # Exported data (e.g., commit-history.csv)
│   ├── personas/                 # Runner personality definitions
│   │   ├── tutor-default.md
│   │   ├── tutor-mid.md
│   │   ├── tutor-senior.md
│   │   └── tutor-training.md
│   ├── plugins/
│   │   ├── flowtask-classifier/  # Input classification plugin (TypeScript)
│   │   │   ├── src/
│   │   │   │   ├── index.ts      # Plugin entry point
│   │   │   │   └── classifier.ts # Classification logic
│   │   │   └── dist/             # Compiled output
│   │   └── flowtask.js           # Additional plugin
│   ├── scripts/                  # Utility scripts
│   │   ├── version-watcher.ps1   # Engram version monitoring
│   │   ├── buffer-sync.ps1       # Buffer synchronization
│   │   └── worktree.sh           # Git worktree management (create/complete/cleanup)
│   ├── skills/                   # OpenCode skills (canonical source)
│   │   ├── checkpoint-mixin/
│   │   │   └── SKILL.md          # Checkpoint persistence protocol
│   │   ├── handshake-protocol/
│   │   │   └── SKILL.md          # Identity and task_id assignment
│   │   ├── heuristics/
│   │   │   └── SKILL.md          # Developer heuristic storage and detection
│   │   ├── manual-classification/
│   │   │   └── SKILL.md          # Fallback input classifier
│   │   ├── memory-protocol/
│   │   │   └── SKILL.md          # Engram mem_* usage protocol
│   │   ├── plan-template/
│   │   │   └── SKILL.md          # Plan structure template
│   │   └── topic-keys-convention/
│   │       └── SKILL.md          # Engram topic_key ownership rules
│   └── .temp/                    # Local buffer for checkpoints
├── .opencode/                    # OpenCode configuration
│   ├── plugins/
│   ├── package.json
│   └── bun.lock
├── docs/                         # Additional documentation
├── Flowtask-Architecture/        # Architecture documentation
├── CLAUDE.md                     # Runner definition (always active)
├── opencode.json                 # OpenCode configuration
├── tui.json                      # TUI configuration
├── update-engram.ps1             # Engram update script
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

### Evolution Mode

Evolution Mode lets you improve FlowTask agents using the same workflow used for your project. Use `/evolve-agent [agent-name] [description]` to:

1. Backup the existing agent to `.flowtask/agents-backup/`
2. Clarify the change with CA-Writer
3. Plan the change with Planner (scoped to `.flowtask/` files only)
4. Audit the plan with Plan-Auditor (always invoked, no task threshold)
5. Confirm and execute with Constructor
6. The user must confirm before Constructor runs — no `--auto` bypass

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

To rebuild the classifier hook (server-side):
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

If a parallel CA's merge fails with conflicts:

```bash
cd .worktrees/CA-{ID}/
git status
# Resolve conflicts manually, then:
git add .
git commit -m "resolve conflicts"
# The FlowTask runner can re-escalate the constructor
```

***

## License

MIT
