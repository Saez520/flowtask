> **Histórico:** este diseño conserva un contrato conceptual anterior del Initializer. La fuente vigente es `.flowtask/agents/initializer.md` y la configuración instalada.

# Diseño del sub-agente Initializer

```mermaid
flowchart TD
    CMD["[ Solicitud de inicialización ]"]
    INIT["flowtask-initializer<br/>(Escanea el código base)"]
    ENGRAM["ENGRAM<br/><br/>- project/stack<br/>- convenciones"]
    SKILL["SKILL: 'flujo-orquestacion'<br/><br/>Contrato de Enrutamiento:<br/>#quot;Si stack == Stack Técnico:<br/>USA TECH-LEAD-ORCHESTRATOR<br/>OMITE flowtask-validator<br/>OMITE flowtask-tester#quot;"]

    CMD --> INIT
    INIT -->|1. Puebla| ENGRAM
    INIT -->|2. Genera Skill| SKILL
```

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEYENDA 1: El Inicializador y Engram (Configuración por Proyecto)       │
├─────────────────────────────────────────────────────────────────────────┤
│ Muestra cómo el 'initializer' escanea el código base una única vez,     │
│ puebla la memoria de Engram con el stack y genera la skill de           │
│ enrutamiento dinámico que dicta las reglas inmutables para esa sesión.  │
└─────────────────────────────────────────────────────────────────────────┘
```
