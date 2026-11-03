> **Historical:** this design preserves an earlier conceptual contract for the Initializer. The current source is `.flowtask/agents/initializer.md` and the installed configuration.

# Initializer subagent design

```mermaid
flowchart TD
    CMD["[ Initialization request ]"]
    INIT["flowtask-initializer<br/>(Scans the codebase)"]
    ENGRAM["ENGRAM<br/><br/>- project/stack<br/>- conventions"]
    SKILL["SKILL: 'flujo-orquestacion'<br/><br/>Routing Contract:<br/>#quot;If stack == Technical Stack:<br/>USE TECH-LEAD-ORCHESTRATOR<br/>OMIT flowtask-validator<br/>OMIT flowtask-tester#quot;"]

    CMD --> INIT
    INIT -->|1. Populates| ENGRAM
    INIT -->|2. Generates Skill| SKILL
```

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEGEND 1: The Initializer and Engram (Per-Project Configuration)        │
├─────────────────────────────────────────────────────────────────────────┤
│ Shows how the 'initializer' scans the codebase once,                    │
│ populates Engram memory with the stack, and generates the dynamic       │
│ routing skill that dictates the immutable rules for that session.       │
└─────────────────────────────────────────────────────────────────────────┘
```
