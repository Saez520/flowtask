> **Historical:** this cloud synchronization design is not part of the current operational guide. See [../README.md](../README.md).

# Engram memory structure and cloud synchronization

```mermaid
flowchart TD
    AGENTE["AI Agent / Local Environment"]
    SQLITE["Local SQLite (Source of truth)"]
    SCOPE{"Scope Validation"}
    ALL{"Does it use '--all'?"}
    PROJECT{"Does it use '--project'?"}
    BLOQUEADO["BLOCKED<br/>(Intentional block)"]
    CLOUD["ENGRAM CLOUD<br/>(Isolated and safe replica)"]

    AGENTE --> SQLITE
    SQLITE -->|"Synchronization attempt (Opt-in)"| SCOPE
    SCOPE --> ALL
    SCOPE --> PROJECT
    ALL -->|"YES"| BLOQUEADO
    PROJECT -->|"YES"| CLOUD
```

```text
[ ENGRAM MEMORY ]
       │
       ├──→ [ GLOBAL PROJECT CONTEXT ] (Initialized by flowtask-initializer)
       │      ├─ project/stack         → Technologies used
       │      ├─ project/conventions   → Rules and conventions
       │      └─ project/{layer}       → Patterns per layer (e.g., api, data, business)
       │
       ├──→ [ ARTIFACT SNAPSHOTS ] (Key results of each task)
       │      ├─ ca/{ID}               → Acceptance Criteria snapshot (CA-Writer)
       │      ├─ plan/{ID}             → Implementation Plan snapshot (Planner)
       │      ├─ plan-audit/{ID}       → Audit results (Plan-Auditor)
       │      └─ validation/{ID}       → Validation report (Validator)
       │
       ├──→ [ FLOW STATES ] (Step-by-step control per ID)
       │      ├─ flow-state/{ID}/create    → Current CA creation state
       │      ├─ flow-state/{ID}/plan      → Current plan generation state
       │      ├─ flow-state/{ID}/audit     → Plan review state
       │      ├─ flow-state/{ID}/construct → Code/implementation phase state
       │      └─ flow-state/{ID}/validate  → Test/validation phase state
       │
       └──→ [ IMPLEMENTATION DISCOVERIES ]
              ├─ impl/{ID}/decisions   → Design decisions made
              └─ impl/{ID}/patterns    → New technical patterns discovered
```
