# FlowTask

AI-driven development workflow system with persistent memory via Engram.

FlowTask provides specialized AI agents that work together to automate software development tasks, from planning to implementation and validation.

---

## Requirements

- **OpenCode**: [Install OpenCode](https://opencode.ai/docs/)
- **Engram**: Persistent memory system for AI agents

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

---

## Installation

### Step 1: Clone FlowTask

```bash
# Clone the repository
git clone git@your-gitlab-server/flowtask.git ~/dev/flowtask
```

### Step 2: Install globally with npm link

```bash
# Navigate to the .flowtask directory
cd ~/dev/flowtask/.flowtask

# Install dependencies and link globally
npm link

# Verify installation
flowtask --version
```

### Step 3: Install FlowTask in your project

```bash
# Go to your project directory
cd ~/proyectos/mi-proyecto

# Install FlowTask for this project
flowtask install
```

### Step 4: Start using

```bash
# Start OpenCode
opencode

# Initialize FlowTask (scans your project)
/init

# Create a new acceptance criteria
/new-ca CA-001

# Run a development workflow
/run CA-001
```

### Updating FlowTask

To update to the latest version:

```bash
# Pull latest changes
cd ~/dev/flowtask
git pull

# Re-install in your projects
cd ~/proyectos/mi-proyecto
flowtask install
```

### Command Reference

| Command | Description |
|---------|-------------|
| `flowtask install` | Install FlowTask in the current project |
| `flowtask --help` | Show help message |
| `flowtask --version` | Show version |

---

## Quick Start

### Initialize a new project

```bash
opencode
> /init
```

This will:
- Scan your project structure
- Detect the technology stack
- Populate Engram with project context
- Generate a `project-context.md` summary

Or initialize specific layers:

```bash
/init-types      # Scan types/models
/init-repository # Scan data-access layer
/init-services   # Scan business logic
/init-config     # Scan configuration
/init-api        # Scan API endpoints
```

### Create a new acceptance criteria

```bash
> /new-ca CA-001
```

The CA-Writer agent will guide you through:
- Clarifying requirements
- Classifying intention type (Refactor/Build/Mid-sized/Collaborative/Architecture/Research)
- Detecting AI-slop patterns

Then save the CA to Engram.

### Run a development workflow

```bash
opencode
/run CA-001
```

FlowTask will guide you through:
1. **Plan**: Planner generates decision-complete plan in Engram
2. **Review**: Plan-Auditor verifies executability (auto for >5 tasks)
3. **Execute**: Constructor implements following project conventions
4. **Validate**: Validator reviews implementation against plan

### Check status

```bash
/status
```

Shows:
- Engram memory statistics
- Active workflows
- Project initialization status

---

## Project Structure

```
FlowTask/
├── opencode.json              # OpenCode config with FlowTask agents
├── AGENTS.md                 # Project rules and memory protocol
├── project-context.md        # Generated summary (after /init)
├── .flowtask/
│   ├── bin/
│   │   └── flowtask.js      # CLI entry point (npm link)
│   ├── package.json          # Plugin dependencies and bin config
│   ├── plugins/
│   │   └── flowtask.js      # OpenCode plugin
│   ├── agents/               # FlowTask agent definitions
│   │   ├── runner.md         # Orchestrator
│   │   ├── ca-writer.md      # Requirement clarification
│   │   ├── planner.md        # Plan generation
│   │   ├── plan-auditor.md   # Plan verification
│   │   ├── constructor.md    # Implementation
│   │   ├── validator.md      # Validation
│   │   ├── initializer.md    # Project scanning
│   │   ├── logger.md         # Logging instrumentation
│   │   └── tester.md         # Test generation
│   ├── skills/               # Reusable prompt fragments
│   │   ├── plan-template.md
│   │   └── output-verbosity.md
│   ├── commands/             # FlowTask slash commands
│   │   ├── init.md
│   │   ├── init-*.md
│   │   ├── run.md
│   │   └── status.md
│   └── prompts/              # Shared prompt fragments
│       ├── memory-protocol.md
│       ├── runner-context.md
│       └── flow-context.md
├── examples/
│   └── workflow-example.md   # Example workflow
└── docs/
    └── original/             # Original agent files (reference)
```

---

## Updating FlowTask

When a new version is available:

```bash
# Pull latest changes
cd ~/dev/flowtask
git pull

# Re-install in your projects
cd ~/proyectos/mi-proyecto
flowtask install
```

---

## FlowTask Agents

| Agent | Role |
|-------|------|
| `flowtask-runner` | Orchestrator - coordinates the workflow |
| `flowtask-ca-writer` | Clarifies requirements, classifies intention, detects AI-slop |
| `flowtask-planner` | Generates decision-complete implementation plans |
| `flowtask-plan-auditor` | Verifies plan executability and references |
| `flowtask-constructor` | Implements plans following Engram conventions |
| `flowtask-validator` | Validates implementation against plan |
| `flowtask-initializer` | Scans project and populates memory |
| `flowtask-logger` | Adds logging instrumentation |
| `flowtask-tester` | Generates tests |

---

## Workflow

```
1. /new-ca CA-001
   └── CA-Writer clarifies requirements
       └── Saves CA to Engram (ca/001)
       └── Updates flow-state: ca_created

2. /run CA-001
   └── Runner orchestrates
       └── Planner generates plan (decision-complete)
       └── Saves plan to Engram (plan/001)
       └── Updates flow-state: plan_generated
       └── Plan-Auditor reviews (auto for >5 tasks)
       └── Updates flow-state: plan_reviewed

3. "ejecutar"
   └── Constructor implements
       └── Saves implementation to Engram
       └── Updates flow-state: implemented

4. Validator reviews
   └── Updates flow-state: completed/failed
```

---

## How It Works

FlowTask uses **Engram** for persistent memory across sessions. Instead of writing files to disk for agent communication, everything is stored in Engram:

- Requirements (CAs) → `mem_save(type: requirement, topic_key: ca/{ID})`
- Implementation plans → `mem_save(type: architecture, topic_key: plan/{ID})`
- Validation reports → `mem_save(type: discovery, topic_key: validation/{ID})`
- Project conventions → `mem_save(type: pattern, topic_key: project/{layer})`
- Design decisions → `mem_save(type: decision, topic_key: impl/{ID}/decisions)`
- Implementation → `mem_save(type: discovery, topic_key: impl/{ID}/{artifact})`

This allows FlowTask agents to:
- Remember decisions across sessions
- Share context without file I/O
- Survive context compaction
- Search past decisions and patterns

---

## Troubleshooting

### Engram not found

```bash
# Check if engram is installed
engram --version

# If not installed, install it
brew install gentleman-programming/tap/engram
```

### MCP server not connecting

```bash
# Start engram server in background
engram serve &

# Or check if MCP is configured in opencode.json
cat opencode.json | grep -A5 '"mcp"'
```

### Plugin not loading

```bash
# Check if plugin is in the right location
ls ~/.config/opencode/plugins/
ls ~/.config/opencode/agents/
ls ~/.config/opencode/commands/
```

---

## License

MIT
