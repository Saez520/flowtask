> **Historical:** `flowtask-archivist` is not part of the current agent registry. See [../project-history.md](../project-history.md).

# Archivist subagent flow

```mermaid
flowchart TD
    SUBORQ["Sub-orchestrator Finishes<br/>Returns list: [UserDAO.java]"]
    ARCHIVIST["flowtask-archivist<br/>(Agent specialized in documenting)"]
    GITDIFF["git diff<br/>(Saves tokens:<br/>Only reads the 15<br/>new lines)"]
    ASTGREP["ast-grep / LSP<br/>(Analyzes syntax:<br/>#quot;It is a Join FETCH<br/>in the data layer#quot;)"]
    CRUZA["[ CROSS-CHECK WITH plan.md / ca.md ]"]
    PREGUNTA["Did it meet the plan?"]
    ENGRAM["ENGRAM DB<br/>Stores keys:<br/>- impl/{ID}/decisions<br/>- impl/{ID}/patterns"]

    SUBORQ --> ARCHIVIST
    ARCHIVIST -->|"1. Extracts Changes"| GITDIFF
    ARCHIVIST -->|"2. Understands Structure"| ASTGREP
    GITDIFF --> CRUZA
    ASTGREP --> CRUZA
    CRUZA --> PREGUNTA
    PREGUNTA --> ENGRAM
```

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEGEND 3: The Archivist Flow (Efficient Memory Management)              │
├─────────────────────────────────────────────────────────────────────────┤
│ Details how the 'archivist' uses 'git diff' and 'ast-grep' cross-checked │
│ with the plan to document (without judging) technical decisions and     │
│ patterns in Engram, saving tokens by not reading the whole project.     │
└─────────────────────────────────────────────────────────────────────────┘
```
