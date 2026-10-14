> **Histórico:** este snapshot conceptual conserva referencias al classifier y módulos retirados. No describe la arquitectura vigente. Consultá [../README.md](../README.md).

## 1. Arquitectura Global: El "Handshake" Modular

Este diagrama muestra cómo se conectan los módulos principales. El Runner no trabaja solo; orquestra la relación entre el Input, la Memoria (Engram) y los Sub-agentes.

```mermaid
flowchart TD
    ECO["FLOWTASK CORE ECOSYSTEM"]
    RUNNER["RUNNER (Orchestrator)<br/>(Identifica Intención -> Delega -> Reporta)"]
    PLUGINS["PLUGINS<br/>(Classifier)"]
    SKILLS["SKILLS<br/>(Protocols)"]
    MEMORIA["MEMORIA<br/>(Engram)"]
    AGENTES["AGENTES<br/>(Workers)"]
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
