> **Histórico:** este diseño conserva sub-orquestadores y rutas conceptuales retiradas. No describe el flujo vigente. Consultá [../README.md](../README.md).

# Visión sistemática de FlowTask

```mermaid
flowchart TD
    subgraph L1["NIVEL 1: CAPA DE NEGOCIO Y METODOLOGÍA (Flowtask Core)"]
        RUNNER["flowtask-runner<br/>(Director de Flujo / Agnóstico)"]
        CAW["flowtask-ca-writer<br/>(Divide tareas SDD/BDD)"]
        PLN["flowtask-planner<br/>(Genera plan técnico)"]
        CHK["[ CHECKPOINT HUMANO ]<br/>(Aprueba el plan)"]
        RUNNER --> CAW
        RUNNER --> PLN
        RUNNER --> CHK
    end
    subgraph L2["NIVEL 2: CAPA DE SUB-ORQUESTACIÓN (Director Técnico)"]
        TL["TECH-LEAD-ORCHESTRATOR<br/>(Líder Java/Spring)"]
        A1["Recibe el plan y audita dependencias"]
        A2["Aplica Checklist de Gating"]
        TL --> A1
        TL --> A2
    end
    subgraph L3["NIVEL 3: CAPA DE EXPERTOS (Línea de Ensamblaje Estricta)"]
        DE["@AGENT-DATA-EXPERT<br/>(DAO, SQL)"]
        LE["@AGENT-LOGIC-EXPERT<br/>(Managers)"]
        AE["@AGENT-API-EXPERT<br/>(REST, Seguridad)"]
    end
    RUNNER -->|"Usa tool 'task' para delegar el código"| TL
    TL -->|"(task)"| DE
    TL -->|"(task)"| LE
    TL -->|"(task)"| AE
```

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ LEYENDA 4: Flujo Completo (Las 3 Capas de la Arquitectura)                 │
├────────────────────────────────────────────────────────────────────────────┤
│ Visión macro de la separación de responsabilidades: El 'runner'            │
│ como Director de Metodología, el 'TECH-LEAD-ORCHESTRATOR' como Tech Lead   │
│ y los subagentes hiper-especializados como Línea de Ensamblaje.            │
└────────────────────────────────────────────────────────────────────────────┘
```
