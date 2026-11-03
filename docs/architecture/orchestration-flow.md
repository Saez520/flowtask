> **Historical:** this conceptual flow contains references to retired protocols. See [../project-history.md](../project-history.md).

# Runner orchestration flow

```mermaid
flowchart TD
    RUNNER["flowtask-runner<br/>(Reads skill and delegates)"]
    SKILL["SKILL 'flujo-orquestacion' APPLIES RULES"]

    SKILL --> SIL
    SKILL --> ESP

    subgraph SIL["SILENCED AGENT (Generic Flowtask)"]
        C["[X] flowtask-constructor"]
        T["[X] flowtask-tester"]
        V["[X] flowtask-validator"]
    end

    subgraph ESP["SPECIALIZED AGENT USED (Technical Stack)"]
        TL["[?] TECH-LEAD-ORCHESTRATOR<br/>(Multi-layer Constructor)"]
        TE["[?] @AGENT-TEST-EXPERT<br/>(JUnit/Mockito tests)"]
        CR["[?] @AGENT-CODE-REVIEWER<br/>(Vulnerabilities/Architecture)"]
    end

    RUNNER --> SKILL
    C --> TL
    T --> TE
    V --> CR
```

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ LEGEND 2: The Routing Skill (Silence Comparison)                           │
├────────────────────────────────────────────────────────────────────────────┤
│ Illustrates the exclusion contract. The 'runner' reads the skill and       │
│ "silences" (omits) Flowtask's generic validators, handing                    │
│ control to the sub-orchestrator's native experts (e.g., Technical Stack).  │
└────────────────────────────────────────────────────────────────────────────┘
```
