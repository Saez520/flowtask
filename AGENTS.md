# FlowTask — Project Rules

You are working in a **FlowTask** project. FlowTask is an AI-driven development
workflow system with persistent memory via Engram.

## Quick Start

1. Run `/init` if not already initialized for this project
2. Run `/new-ca CA-{ID}` to create requirements
3. Run `/run CA-{ID}` to start the workflow
4. Review the plan, confirm with "ejecutar"
5. Constructor implements, Validator reviews
6. Iterate until APPROVED

## Memory Protocol

You have access to Engram persistent memory via MCP tools.
**Load the memory-protocol skill** when you need to use Engram:

```
skill({ name: "memory-protocol" })
```

Key rules:
- Save decisions, discoveries, and patterns to Engram after significant work
- Search Engram before making assumptions about the project
- Call `mem_session_summary` before ending every session
- After compaction: call `mem_context` immediately

## Searching Project Context

When you need project conventions, patterns, or context:

```
mem_context(project: current-directory)
mem_search(q: "project conventions")
mem_search(q: "project naming")
mem_search(q: "project patterns {layer}")
mem_search(q: "project stack")
```

## FlowTask Agents

FlowTask provides specialized agents:

| Agent | When to use |
|-------|-------------|
| `@flowtask-ca-writer` | Clarify requirements, classify intention, detect AI-slop |
| `@flowtask-planner` | Generate decision-complete implementation plans |
| `@flowtask-plan-auditor` | Verify plan executability (auto for >5 tasks) |
| `@flowtask-constructor` | Implement plans following Engram conventions |
| `@flowtask-validator` | Validate implementation against plan |
| `@flowtask-logger` | Add logging instrumentation |
| `@flowtask-tester` | Generate tests |
| `@flowtask-initializer` | Scan project and populate Engram |

The **FlowTask Runner** (`@flowtask-runner`) is your main point of contact.
It orchestrates everything. You don't invoke subagents directly.

## Project Context

If `project-context.md` exists, read it first. It contains a summary of
the project structure, conventions, and patterns detected by `/init`.

Full details are always in Engram memory — `project-context.md` is just a summary.

## Starting a New Task

```
1. Run /new-ca CA-001 to create requirements
2. The CA-Writer clarifies requirements and classifies intention
3. Run /run CA-001 to start workflow
4. Planner generates decision-complete plan in Engram
5. Plan-Auditor reviews plan (auto for >5 tasks)
6. Review plan, confirm with "ejecutar"
7. Constructor implements → Validator reviews
8. Iterate if needed
```

## Engram Update Rules

Every agent MUST update Engram when:
- Completes a phase → update `flow-state/{ID}/[agent-namespace]`
- Makes a design decision → save to `impl/{ID}/decisions`
- Discovers a new pattern → save to `project/{layer}`
- Completes implementation → save to `impl/{ID}/{artifact}`

## Commands

- `/init` — Initialize FlowTask in this project (scan and populate Engram)
- `/init-types` — Scan only types/models layer
- `/init-data` — Scan only data layer
- `/init-business` — Scan only business logic layer
- `/init-config` — Scan only configuration files
- `/init-api` — Scan only API/endpoints layer
- `/new-ca CA-{ID}` — Create a new CA with guided clarification
- `/run CA-{ID}` — Execute workflow for a case
- `/status` — Show FlowTask and Engram status
- `/inspect [pregunta]` — Explore and validate any aspect of the project without creating a CA
- `/evolve-agent [agente] [descripción]` — Evolve a FlowTask agent using the full CA → Plan → Implement cycle

## Agent Evolution Mode

Modo especial que permite a los sub-agentes modificar archivos en `.flowtask/`.

### Reglas del modo

| Regla | Descripción |
|-------|-------------|
| **Runner** | NUNCA modifica `.flowtask/` — solo orquesta |
| **Sub-agentes** | SÍ pueden modificar `.flowtask/` cuando están en Evolution Mode |
| **Alcance** | `.flowtask/agents/`, `.flowtask/commands/`, `.flowtask/skills/` únicamente |
| **Activación** | Solo mediante `/evolve-agent` — nunca se activa solo |

### Flujo de Evolution Mode

```
/evolve-agent [agente] [descripción]
  ↓
Runner invoca CA-Writer (Evolution Mode)
  ↓
CA-Writer conversa con el usuario, valida tradeoffs/GAPs, genera SPEC
  ↓
Runner invoca Planner
  ↓
Planner genera plan de cambios en .flowtask/
  ↓
Runner invoca Plan-Auditor (SIEMPRE en Evolution Mode)
  ↓
Runner presenta plan al usuario → usuario valida con "ejecutar"
  ↓
Runner invoca Constructor (Evolution Mode)
  ↓
Constructor modifica archivos en .flowtask/
```

### Agentes con acceso en Evolution Mode

| Agente | Puede modificar `.flowtask/` |
|--------|------------------------------|
| Runner | ❌ NUNCA |
| CA-Writer | ✅ Solo leer en Evolution Mode |
| Planner | ✅ Solo leer en Evolution Mode |
| Plan-Auditor | ✅ Solo leer en Evolution Mode |
| Constructor | ✅ Leer y escribir en Evolution Mode |
| Inspector | ✅ Solo leer en Evolution Mode |
