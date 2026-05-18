# FlowTask

AI-driven development workflow system with persistent memory via Engram.

FlowTask provides specialized AI agents that work together to automate software development tasks — from requirements capture to implementation and validation. Artifacts (CAs and plans) are stored as workspace files; Engram persists only operational state and snapshots.

***

## Requirements

- **OpenCode**: [Install OpenCode](https://opencode.ai/docs/)
- **Engram**: Persistent memory system for AI agents (MCP-based)
- **LSP** (Language Server Protocol): Semantic code discovery — see [docs/architecture/LSP + AST-Grep.txt](docs/architecture/LSP%20+%20AST-Grep.txt)
- **ast-grep**: Structural pattern matching via AST — see [docs/architecture/LSP + AST-Grep.txt](docs/architecture/LSP%20+%20AST-Grep.txt)

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
flowtask uptade
```

### Command Reference

| Command              | Description                             |
| -------------------- | --------------------------------------- |
| `flowtask install`   | Install FlowTask in the current project |
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

### Create a new acceptance criteria

```bash
> /new-ca CA-001
```

The CA-Writer agent will guide you through:

- Clarifying requirements and business rules
- Classifying intention type (Nueva funcionalidad / Optimización / Corrección / Integración / Cambio de alcance)
- Detecting AI-slop patterns (scope inflation, over-engineering, premature details)
- Confirming tradeoffs and known GAPs

The CA is saved to `.workspace/CA-001/ca.md`.

### Run a development workflow

```bash
> /run CA-001
```

FlowTask will:

1. **CA-Writer** — clarifies requirements if the CA doesn't exist yet
2. **Planner** — generates a decision-complete plan in `.workspace/CA-001/plan.md`
3. **Plan-Auditor** — reviews the plan (auto for >5 tasks; always in Evolution Mode)
4. **Checkpoint** — waits for your confirmation (`"ejecutar"`)
5. **Constructor** — implements following project conventions
6. **Validator** — reviews implementation against the plan (max 2 retries)

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

### Artifact storage

Artifacts are stored as files in `.workspace/`, not in Engram:

| Artifact            | File path                          |
| ------------------- | ---------------------------------- |
| Acceptance Criteria | `.workspace/CA-{ID}/ca.md`         |
| Implementation Plan | `.workspace/CA-{ID}/plan.md`       |
| Plan Audit          | `.workspace/CA-{ID}/audit.md`      |
| Validation Report   | `.workspace/CA-{ID}/validacion.md` |

Engram stores only operational metadata (flow states, snapshots, project conventions). This lets agents survive context compaction and share state across sessions without duplicating the full content.

### Engram topic keys

| Topic Key                   | Owner                     | What it stores                        |
| --------------------------- | ------------------------- | ------------------------------------- |
| `ca/{ID}`                   | Runner (via CA-Writer)    | CA snapshot                           |
| `plan/{ID}`                 | Runner (via Planner)      | Plan snapshot                         |
| `plan-audit/{ID}`           | Plan-Auditor              | Audit results                         |
| `validation/{ID}`           | Validator                 | Validation report                     |
| `flow-state/{ID}/create`    | CA-Writer                 | CA creation state                     |
| `flow-state/{ID}/plan`      | Planner                   | Plan generation state                 |
| `flow-state/{ID}/audit`     | Plan-Auditor              | Audit state                           |
| `flow-state/{ID}/construct` | Constructor               | Implementation state                  |
| `flow-state/{ID}/validate`  | Validator                 | Validation state                      |
| `project/stack`             | Initializer               | Tech stack                            |
| `project/conventions`       | Initializer               | Project conventions                   |
| `project/{layer}`           | Initializer               | Layer patterns (api, data, business…) |
| `impl/{ID}/patterns`        | Constructor/Tester/Logger | Discovered technical patterns         |
| `impl/{ID}/decisions`       | Constructor/Planner       | Design decisions                      |

***

## Workflow Diagram

```
1. /new-ca CA-001
   └── CA-Writer clarifies requirements
       └── Saves CA to .workspace/CA-001/ca.md
       └── Saves flow state to Engram (flow-state/001/create)
       └── Runner saves snapshot (ca/001)

2. /run CA-001
   └── Runner reads CA snapshot from Engram
       └── Planner generates plan (decision-complete)
           └── Saves plan to .workspace/CA-001/plan.md
           └── Saves flow state (flow-state/001/plan)
       └── Plan-Auditor reviews (auto if >5 tasks or Evolution Mode)
           └── Saves audit to .workspace/CA-001/audit.md
           └── Saves flow state (flow-state/001/audit)

3. "ejecutar"
   └── Constructor implements following project conventions
       └── Saves flow state (flow-state/001/construct)

4. Validator reviews
   └── Saves validation to .workspace/CA-001/validacion.md
   └── APPROVED → flow complete
   └── REJECTED → retry Constructor (max 2 times)
```

***

## Project Structure

```
FlowTask/
├── .claude/                      # OpenCode CLI environment
│   ├── agents/                   # OpenCode agent definitions
│   │   └── flowtask-*.md         # FlowTask subagents
│   └── skills/                   # OpenCode skills
│       ├── excalidraw/
│       │   └── SKILL.md          # Diagram/visualization skill
│       ├── output-verbosity/
│       │   └── SKILL.md          # Output formatting skill
│       └── ...
├── .flowtask/
│   ├── bin/
│   │   └── flowtask.js           # CLI entry point (npm link)
│   ├── package.json              # Plugin dependencies and bin config
│   ├── agents/                   # FlowTask agent definitions
│   │   ├── runner.md             # Primary orchestrator (always active)
│   │   ├── ca-writer.md          # Requirements clarification and CA generation
│   │   ├── planner.md            # Decision-complete plan generation
│   │   ├── plan-auditor.md       # Plan verification
│   │   ├── constructor.md         # Implementation
│   │   ├── validator.md          # Validation
│   │   ├── inspector.md          # Project exploration and analysis
│   │   ├── initializer.md        # Project scanning and Engram population
│   │   ├── logger.md             # Logging instrumentation
│   │   └── tester.md             # Test generation
│   ├── checkpoints/             # Checkpoint state storage
│   ├── claude/                   # FlowTask CLI environment (OpenCode)
│   ├── plugins/
│   │   └── flowtask-classifier/  # Input classification plugin (TypeScript)
│   │       ├── src/
│   │       │   └── index.ts      # Plugin entry point
│   │       └── dist/             # Compiled output
│   ├── scripts/                  # Utility scripts
│   │   ├── version-watcher.ps1   # Engram version monitoring
│   │   ├── buffer-sync.ps1       # Buffer synchronization
│   │   └── update-engram.ps1     # Engram update script
│   ├── skills/                   # OpenCode skills
│   │   ├── checkpoint-mixin/
│   │   │   └── SKILL.md          # Checkpoint persistence protocol
│   │   ├── memory-protocol/
│   │   │   └── SKILL.md          # Engram mem_* usage protocol
│   │   ├── plan-template/
│   │   │   └── SKILL.md          # Plan structure template
│   │   ├── manual-classification/
│   │   │   └── SKILL.md          # Fallback input classifier
│   │   └── topic-keys-convention/
│   │       └── SKILL.md          # Engram topic_key ownership rules
│   └── commands/                 # FlowTask slash commands
│       ├── init.md               # /init
│       ├── init-*.md             # /init-types, /init-data, etc.
│       ├── new-ca.md             # /new-ca
│       ├── run.md                # /run
│       ├── inspect.md            # /inspect
│       ├── evolve-agent.md        # /evolve-agent
│       ├── status.md             # /status
│       └── update.md              # /update
├── .opencode/                    # Additional OpenCode skills
│   └── skills/
├── docs/                         # Additional documentation
├── Flowtask-Architecture/       # Architecture documentation
├── presentacion-flowtask.md      # Project presentation
├── opencode.json                 # OpenCode configuration
├── tui.json                      # TUI configuration
├── update-engram.ps1             # Engram update script (root)
└── .workspace/                   # Generated per project (git-ignored)
    └── CA-{ID}/
        ├── ca.md
        ├── plan.md
        ├── audit.md
        └── validacion.md
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
| `flowtask-logger`       | Adds logging instrumentation                                                     |
| `flowtask-tester`       | Generates tests                                                                  |

### Evolution Mode

Evolution Mode lets you improve FlowTask agents using the same workflow used for your project. Use `/evolve-agent [agent-name] [description]` to:

1. Clarify the change with CA-Writer
2. Plan the change with Planner (scoped to `.flowtask/` files only)
3. Audit the plan with Plan-Auditor (always invoked, no task threshold)
4. Confirm and execute with Constructor
5. The user must confirm before Constructor runs — no `--auto` bypass

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

### Classifier plugin not compiling

```bash
cd .flowtask/plugins/flowtask-classifier
npm install
npm run build
```

***

## License

MIT
