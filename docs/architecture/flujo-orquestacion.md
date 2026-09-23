# Flujo de orquestación del Runner

```mermaid
flowchart TD
    RUNNER["flowtask-runner<br/>(Lee skill y delega)"]
    SKILL["SKILL 'flujo-orquestacion' APLICA REGLAS"]

    SKILL --> SIL
    SKILL --> ESP

    subgraph SIL["AGENTE SILENCIADO (Flowtask Genérico)"]
        C["[X] flowtask-constructor"]
        T["[X] flowtask-tester"]
        V["[X] flowtask-validator"]
    end

    subgraph ESP["AGENTE ESPECIALIZADO USADO (Stack Técnico)"]
        TL["[?] TECH-LEAD-ORCHESTRATOR<br/>(Constructor Multi-capa)"]
        TE["[?] @AGENT-TEST-EXPERT<br/>(Pruebas JUnit/Mockito)"]
        CR["[?] @AGENT-CODE-REVIEWER<br/>(Vulnerabilidades/Arquitectura)"]
    end

    RUNNER --> SKILL
    C --> TL
    T --> TE
    V --> CR
```

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ LEYENDA 2: La Skill de Enrutamiento (Comparativa de Silencio)              │
├────────────────────────────────────────────────────────────────────────────┤
│ Ilustra el contrato de exclusión. El 'runner' lee la skill y               │
│ "silencia" (omite) a los validadores genéricos de Flowtask, cediendo       │
│ el control a los expertos nativos del sub-orquestador (ej. Stack Técnico). │
└────────────────────────────────────────────────────────────────────────────┘
```
