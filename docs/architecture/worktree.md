# Diseño conceptual de aislamiento con Git Worktrees

```mermaid
flowchart TD
    MAIN["RAMA PRINCIPAL (Local/Dev)<br/>El 'flowtask-runner' reside aquí de forma segura."]
    subgraph WT["GIT WORKTREE AISLADO (Sandbox)"]
        WTINFO["Entorno paralelo temporal (ej. /.worktrees/CA-001/)"]
        TEAM["TECH-LEAD-ORCHESTRATOR Y SUB-AGENTES EXPERTOS<br/>- Escriben código y modifican archivos.<br/>- Ejecutan pruebas unitarias (si rompen algo,<br/>solo se rompe este entorno aislado)."]
    end
    ARCH["EVALUACIÓN Y MEMORIA (flowtask-archivist)<br/>Usa 'git diff' entre el Worktree y la Rama Principal<br/>para extraer los patrones y guardar en Engram."]
    MAIN2["RAMA PRINCIPAL (Local/Dev)<br/>?? El código funcional y auditado se une a tu rama."]

    MAIN -->|"1. Delega y aísla (Crea Worktree)"| WT
    WT -->|"2. Sub-orquestador reporta éxito"| ARCH
    ARCH -->|"3. Integración Segura (Merge/Apply)"| MAIN2
```

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ LEYENDA 5: Ciclo de Vida y Aislamiento (Git Worktrees)                  │
├─────────────────────────────────────────────────────────────────────────┤
│ Demuestra la mitigación de riesgos. El 'runner' delega la tarea a un    │
│ 'Git Worktree' (una copia aislada del proyecto). Los sub-agentes        │
│ codifican y prueban allí sin afectar la rama principal. Solo cuando el  │
│ trabajo termina y el 'archivist' documenta el 'diff', el código se      │
│ integra a la rama del desarrollador humano.                             │
└─────────────────────────────────────────────────────────────────────────┘
```
