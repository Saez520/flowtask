> **Historical:** this design preserves sub-orchestrators and retired conceptual paths. It does not describe the current flow. See [../README.md](../README.md).

# Systematic view of FlowTask

```mermaid
flowchart TD
    subgraph L1["LEVEL 1: BUSINESS AND METHODOLOGY LAYER (Flowtask Core)"]
        RUNNER["flowtask-runner<br/>(Flow Director / Agnostic)"]
        CAW["flowtask-ca-writer<br/>(Splits SDD/BDD tasks)"]
        PLN["flowtask-planner<br/>(Generates technical plan)"]
        CHK["[ HUMAN CHECKPOINT ]<br/>(Approves the plan)"]
        RUNNER --> CAW
        RUNNER --> PLN
        RUNNER --> CHK
    end
    subgraph L2["LEVEL 2: SUB-ORCHESTRATION LAYER (Technical Director)"]
        TL["TECH-LEAD-ORCHESTRATOR<br/>(Java/Spring Lead)"]
        A1["Receives the plan and audits dependencies"]
        A2["Applies the Gating Checklist"]
        TL --> A1
        TL --> A2
    end
    subgraph L3["LEVEL 3: EXPERT LAYER (Strict Assembly Line)"]
        DE["@AGENT-DATA-EXPERT<br/>(DAO, SQL)"]
        LE["@AGENT-LOGIC-EXPERT<br/>(Managers)"]
        AE["@AGENT-API-EXPERT<br/>(REST, Security)"]
    end
    RUNNER -->|"Uses the 'task' tool to delegate code"| TL
    TL -->|"(task)"| DE
    TL -->|"(task)"| LE
    TL -->|"(task)"| AE
```

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ LEGEND 4: Complete Flow (The 3 Architecture Layers)                        │
├────────────────────────────────────────────────────────────────────────────┤
│ Macro view of the separation of responsibilities: the 'runner'             │
│ as Methodology Director, 'TECH-LEAD-ORCHESTRATOR' as Tech Lead,            │
│ and hyper-specialized subagents as the Assembly Line.                      │
└────────────────────────────────────────────────────────────────────────────┘
```
