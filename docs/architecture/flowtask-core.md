> **Historical:** this conceptual snapshot preserves references to the classifier and retired modules. It does not describe the current architecture. See [../README.md](../README.md).

## 1. Global Architecture: The Modular "Handshake"

This diagram shows how the main modules connect. The Runner does not work alone; it orchestrates the relationship between Input, Memory (Engram), and Subagents.

```mermaid
flowchart TD
    ECO["FLOWTASK CORE ECOSYSTEM"]
    RUNNER["RUNNER (Orchestrator)<br/>(Identifies Intent -> Delegates -> Reports)"]
    PLUGINS["PLUGINS<br/>(Classifier)"]
    SKILLS["SKILLS<br/>(Protocols)"]
    MEMORIA["MEMORY<br/>(Engram)"]
    AGENTES["AGENTS<br/>(Workers)"]
    USER["USER INPUT"]
    WS["WORKSPACE"]
    FS["FS CHANGES"]

    ECO --> RUNNER
    RUNNER --> PLUGINS
    RUNNER --> SKILLS
    RUNNER --> MEMORIA
    RUNNER --> AGENTES
    PLUGINS --> USER
    SKILLS --> WS
    MEMORIA --> WS
    AGENTES --> FS
    USER --> WS
```
