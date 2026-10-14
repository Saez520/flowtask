> **Histórico:** `flowtask-archivist` no forma parte del registro vigente de agentes. Consultá [../project-history.md](../project-history.md).

# Flujo del sub-agente Archivist

```mermaid
flowchart TD
    SUBORQ["Sub-orquestador Termina<br/>Devuelve lista: [UserDAO.java]"]
    ARCHIVIST["flowtask-archivist<br/>(Agente especializado en documentar)"]
    GITDIFF["git diff<br/>(Ahorra tokens:<br/>Solo lee las 15<br/>líneas nuevas)"]
    ASTGREP["ast-grep / LSP<br/>(Analiza sintaxis:<br/>#quot;Es un Join FETCH<br/>en capa de datos#quot;)"]
    CRUZA["[ CRUZA CON plan.md / ca.md ]"]
    PREGUNTA["¿Cumplió el plan?"]
    ENGRAM["ENGRAM DB<br/>Guarda claves:<br/>- impl/{ID}/decisions<br/>- impl/{ID}/patterns"]

    SUBORQ --> ARCHIVIST
    ARCHIVIST -->|"1. Extrae Cambios"| GITDIFF
    ARCHIVIST -->|"2. Entiende Estructura"| ASTGREP
    GITDIFF --> CRUZA
    ASTGREP --> CRUZA
    CRUZA --> PREGUNTA
    PREGUNTA --> ENGRAM
```

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEYENDA 3: El Flujo del Archivist (Gestión de Memoria Eficiente)        │
├─────────────────────────────────────────────────────────────────────────┤
│ Detalla cómo el 'archivist' usa 'git diff' y 'ast-grep' cruzados con    │
│ el plan para documentar (sin juzgar) las decisiones técnicas y          │
│ patrones en Engram, ahorrando tokens al no leer todo el proyecto.       │
└─────────────────────────────────────────────────────────────────────────┘
```
