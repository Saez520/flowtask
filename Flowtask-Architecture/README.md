# FlowTask Architecture — Whitepaper Técnico

> **TL;DR**: FlowTask es un sistema de agentes autónomos que ejecutan tareas de desarrollo en entornos aislados, con memoria persistente entre sesiones, y optimización radical del contexto para escalar a proyectos grandes. Este documento explica los tres pilares que lo hacen posible y el roadmap hacia su versión open source.

**Tiempo de lectura**: ~5 minutos  
**Última actualización**: CA-008 (Mayo 2026)  
**Roadmap completo**: [`.workspace/CA-008/plan.md`](../.workspace/CA-008/plan.md)

---

## 1. ¿Qué es FlowTask?

FlowTask es un **orquestador de agentes de IA para desarrollo de software**. A diferencia de un chatbot que escribe código, FlowTask estructura el trabajo en **Change Artifacts (CAs)** — unidades formales de cambio con requisitos, plan, auditoría, construcción y validación. Cada fase es ejecutada por un sub-agente especializado (planner, constructor, validator, etc.) que trabaja con memoria persistente y contexto optimizado.

### El flujo de un CA

```
USUARIO: "/run CA-018"
          │
          ▼
┌─────────────────────────────────────────────────┐
│  RUNNER (Orquestador)                            │
│  Handshake → Asigna identidad (Kael-Planner...)  │
│  Delega tareas secuencialmente                   │
└─────────────────────────────────────────────────┘
          │
          ├─ 1. CA-WRITER     → Formaliza requisitos en ca.md
          ├─ 2. PLANNER       → Genera plan de implementación en plan.md
          ├─ 3. PLAN-AUDITOR  → Revisa coherencia y referencias → audit.md
          ├─ 4. CONSTRUCTOR   → Implementa el plan (lee plan.md, escribe código)
          └─ 5. VALIDATOR     → Verifica criterios de aceptación
```

Cada CA produce artefactos versionados en `.workspace/CA-{ID}/` y guarda su estado de flujo en **Engram** (memoria persistente). Si un agente falla o la sesión se interrumpe, el Handshake Protocol permite **reanudar exactamente donde quedó**.

---

## 2. Los Tres Pilares Técnicos

FlowTask se sostiene sobre tres pilares que lo diferencian de herramientas de asistencia convencionales:

### Pilar 1 — Aislamiento y Seguridad (Git Worktrees)

**Qué es**: Cada tarea delegada a sub-agentes se ejecuta en un **Git Worktree aislado** (sandbox). El código se modifica en ese entorno temporal. Solo cuando el trabajo está completo y verificado, el **Archivist** integra los cambios a la rama principal. Si algo falla, el entorno aislado se descarta sin afectar el proyecto.

**Por qué importa**: Es la garantía de que un agente autónomo **no puede corromper el código del desarrollador**. Sin este pilar, FlowTask sería una herramienta de asistencia; con él, es un sistema delegable con seguridad de integridad.

**Diagrama ASCII**: Ver [`docs/architecture/worktree.txt`](../docs/architecture/worktree.txt) — diseño conceptual del ciclo de vida con Git Worktrees.  
**Artefacto relacionado**: [`docs/architecture/sub-agent-archivista.txt`](../docs/architecture/sub-agent-archivista.txt) — flujo del sub-agente Archivist.

### Pilar 2 — Persistencia y Self-Healing (Engram + Handshake)

**Qué es**: **Engram** es la memoria persistente del proyecto. Cada artefacto (CA, plan, validación) y cada estado de flujo (flow-state) se almacena con `topic_key` estructurado. El **Handshake Protocol** asigna identidad estable a cada agente (`BaseName-Agente`) y permite que, ante un fallo o interrupción, el agente recupere su estado y continúe desde donde quedó.

**Por qué importa**: Sin memoria persistente, cada sesión empieza ciega. Sin handshake, los agentes no saben quiénes son. Este pilar convierte a FlowTask de "chatbot que escribe código" a **sistema de agentes con continuidad operativa**.

**Estructura de memoria de Engram** (ver [`docs/architecture/engram-cloud.txt`](../docs/architecture/engram-cloud.txt)):
- `project/*` — contexto global del proyecto (stack, convenciones, capas)
- `ca/{ID}`, `plan/{ID}`, `validation/{ID}` — snapshots de artefactos
- `flow-state/{ID}/*` — control paso a paso por CA
- `impl/{ID}/*` — descubrimientos de implementación (decisiones, patrones)

**Handshake Protocol** (ver [`docs/architecture/handshake.txt`](../docs/architecture/handshake.txt)):
1. El Runner consulta Engram: ¿existe handshake para este CA?
2. Si es nuevo: asigna BaseName de un pool predefinido (Aitana, Kael, Lyra...)
3. Si es continuación: recupera `task_id`, lee el último checkpoint, relanza al agente con el contexto completo

### Pilar 3 — Optimización Radical de Contexto (LSP + AST-Grep)

**Qué es**: El Planner actualmente usa **Glob + Grep** para descubrir archivos y leer código — esto envía **~1,400 líneas (~2,200 tokens)** al LLM, la mayoría ruido. La combinación **LSP** (descubrimiento semántico de símbolos) + **AST-Grep** (extracción por patrón estructural) reduce esto a **19 líneas exactas (~180 tokens)**. Una reducción del **91% del ruido contextual**.

**Por qué importa**: El contexto es el recurso más caro en sistemas basados en LLM. Cada token ahorrado es velocidad, precisión y menor costo. Este pilar permite que FlowTask escale a proyectos grandes sin degradación.

**Diagrama comparativo**: Ver [`docs/architecture/LSP + AST-Grep.txt`](../docs/architecture/LSP + AST-Grep.txt) — flujo actual (Glob+Grep, 2,200 tokens) vs flujo optimizado (LSP+AST-Grep, 180 tokens).

---

## 3. Roadmap (CA-008)

12 iniciativas clasificadas por nivel de impacto. **Este roadmap es direccional — no contiene fechas ni estrategias de implementación.** Cada ítem tendrá su propio CA cuando llegue su momento de ejecución.

### Pilar 1 — Git Worktrees

| # | Ítem | Impacto | Referencia | Notas |
|---|------|---------|------------|-------|
| P1.1 | Implementar infraestructura de Git Worktrees para sandbox de agentes | **ALTO** | CA futuro | Cada agente recibe un worktree efímero. Creación, checkout, y cleanup automático. |
| P1.2 | Protocolo del Archivist: diff, revisión e integración segura de cambios | **ALTO** | CA futuro | Diff entre worktree y rama principal. Revisión pre-merge. Integración atómica. |

### Pilar 2 — Engram + Handshake

| # | Ítem | Impacto | Referencia | Notas |
|---|------|---------|------------|-------|
| P2.1 | Migración `.workspace/` → Engram: análisis de viabilidad y estrategia | **ALTO** | Pendiente de análisis | ⚠️ Requiere análisis previo antes de ejecutar. |
| P2.2 | #1081: Regresión en consultas a Engram post-update | **ALTO** | Engram #1081 | Agentes dejaron de consultar Engram proactivamente. |
| P2.3 | #1082: Inyección Progresiva de Reglas (Context Degradation) | **ALTO** | Engram #1082 | Runner pierde coherencia a ~100k tokens. |
| P2.4 | #1084: Protocolo Zero-Assumptions | **ALTO** | Engram #1084 | Agentes deben validar contra Engram antes de actuar. |
| P2.5 | #1080: Inestabilidad de Identidad del Runner | **MEDIO** | Engram #1080 | Runner a veces asume rol incorrecto al iniciar sesión. |

### Pilar 3 — LSP + AST-Grep

| # | Ítem | Impacto | Referencia | Notas |
|---|------|---------|------------|-------|
| P3.1 | #1058: Integrar LSP + AST-Grep en el Planner | **ALTO** | Engram #1058 | Sustituir Glob+Grep por descubrimiento semántico y extracción estructural. Validación del 91% durante ejecución. |
| P3.2 | #1083: Orquestación Paralela en Runner | **MEDIO** | Engram #1083 | Ejecutar sub-agentes en paralelo cuando no hay dependencias secuenciales. |

### Transversal — Gobernanza y Estructura

| # | Ítem | Impacto | Referencia | Notas |
|---|------|---------|------------|-------|
| T.1 | Carpeta `Flowtask-Architecture/`: whitepaper técnico con los 3 pilares, roadmap, diagramas y flujo de trabajo | **ALTO** | Este documento | ✅ Entregable de CA-008. Documento fundacional para desarrolladores externos. |
| T.2 | #1087: Validator — fallo en detección de errores de Runtime | **ALTO** | Engram #1087 | Validator no detecta errores de runtime. Debe integrarse con Tester. |
| T.3 | Unificación de carpetas de arquitectura: `Architecture/` + `New Architecture/` → `docs/architecture/` | **MEDIO** | ✅ Completado en CA-008 | 24 archivos consolidados con referencias actualizadas. |
| T.4 | #1086: Refuerzo del Validator (Mentalidad Adversaria) | **MEDIO** | Engram #1086 | Validator es laxo. Necesita mentalidad QA rigurosa. |

### Resumen por Impacto

| Impacto | Cantidad | Ítems |
|---------|----------|-------|
| **ALTO** | 9 | P1.1, P1.2, P2.1, P2.2, P2.3, P2.4, P3.1, T.1, T.2 |
| **MEDIO** | 4 | P2.5, P3.2, T.3, T.4 |

---

## 4. Referencias de Engram (Pendientes)

| Ref | ID | Tipo | Título |
|-----|----|------|--------|
| #1057 | 1057 | architecture | Estrategia de descubrimiento de código en el Planner (antecedente de #1058) |
| #1058 | 1058 | decision | Pendiente: Integrar LSP + AST-Grep en el Planner |
| #1080 | 1080 | bugfix | Pendiente: Inestabilidad de Identidad del Runner |
| #1081 | 1081 | bugfix | Pendiente: Regresión en consultas a Engram post-update |
| #1082 | 1082 | architecture | Pendiente: Inyección Progresiva de Reglas (Context Degradation) |
| #1083 | 1083 | architecture | Pendiente: Orquestación y Pensamiento Paralelo en Runner |
| #1084 | 1084 | pattern | Pendiente: Protocolo Zero-Assumptions (Validación Proactiva) |
| #1086 | 1086 | pattern | Pendiente: Refuerzo del Sub-agente Validator (QA Riguroso) |
| #1087 | 1087 | bugfix | Pendiente: Validator — Fallo en detección de errores de Runtime |

Los 10 pendientes (9 con ID Engram + migración `.workspace`) están distribuidos en el roadmap por pilar e impacto.

---

## 5. Estructura del Proyecto

```
FlowTask/
├── Flowtask-Architecture/    ← Este whitepaper (CA-008)
│   └── README.md
├── .flowtask/                ← Agentes, skills, plugins (estático)
│   ├── agents/
│   ├── skills/
│   └── plugins/
├── .workspace/               ← Artefactos de CAs activos (dinámico)
│   └── CA-{ID}/
│       ├── ca.md
│       ├── plan.md
│       └── audit.md
├── docs/architecture/        ← Documentación de arquitectura unificada
│   ├── INDEX.md              ← Índice de todos los documentos
│   ├── 01-agentes.md .. 09-workspace.md  ← Módulos del repomix-output.xml
│   ├── worktree.txt, LSP + AST-Grep.txt  ← Diagramas ASCII de pilares
│   └── handshake.txt, flowtask-core.txt  ← Diseños de New Architecture
├── .engram/                  ← Configuración de Engram (memoria persistente)
└── src/                      ← Código fuente del proyecto
```

### Documentación de arquitectura

Toda la documentación técnica está en [`docs/architecture/`](../docs/architecture/). El índice completo está en [`INDEX.md`](../docs/architecture/INDEX.md).

**Documentos generados de repomix-output.xml** (módulos 01-09):
- Agentes, skills, implementación, plugins, comandos, configuración, README, Engram, workspace

**Documentos de diseño conceptual** (originalmente en `New Architecture/`):
- [`flowtask-core.txt`](../docs/architecture/flowtask-core.txt) — Ecosistema core
- [`handshake.txt`](../docs/architecture/handshake.txt) — Protocolo Handshake
- [`anatomia-workspace.txt`](../docs/architecture/anatomia-workspace.txt) — Anatomía del workspace

**Diagramas ASCII de los pilares**:
- [`worktree.txt`](../docs/architecture/worktree.txt) — Pilar 1: Git Worktrees
- [`sub-agent-archivista.txt`](../docs/architecture/sub-agent-archivista.txt) — Flujo del Archivist
- [`engram-cloud.txt`](../docs/architecture/engram-cloud.txt) — Pilar 2: Estructura Engram
- [`LSP + AST-Grep.txt`](../docs/architecture/LSP + AST-Grep.txt) — Pilar 3: Optimización LSP+AST-Grep

---

## 6. Para Desarrolladores Externos

### ¿Cómo contribuir?

1. **Lee este whitepaper** (5 minutos) para entender los pilares y el roadmap.
2. **Explora `docs/architecture/`** para la documentación técnica detallada.
3. **Revisa los CAs activos** en `.workspace/` para ver el flujo de trabajo en acción.
4. **Toma un ítem del roadmap** — crea un nuevo CA siguiendo el flujo: CA → Plan → Auditoría → Construcción → Validación.

### ¿Cómo crear un nuevo CA?

```
/new-ca "Descripción del cambio"
```

Esto inicia el flujo FlowTask: el CA-Writer formaliza los requisitos, el Planner genera el plan, el Plan-Auditor revisa coherencia, el Constructor implementa, y el Validator verifica.

### Prioridad sugerida

Los ítems **ALTO** deben abordarse antes que los **MEDIO**, pero dentro del mismo nivel no hay orden predefinido. La urgencia la define el contexto del proyecto.

---

## 7. Tradeoffs y Decisiones de Diseño

| ID | Tradeoff | Decisión |
|----|----------|----------|
| T1 | Roadmap sin fechas, solo impacto | Flexibilidad total ante cambios de prioridad. |
| T2 | Flowtask-Architecture dentro del repo | Un solo lugar de verdad versionado; el whitepaper convive con el código. |
| T3 | Unificación de arquitectura en `docs/architecture/` | Documentación coherente para consumo público. |
| T4 | Los 10 pendientes son CAs independientes | CA-008 no se diluye; el roadmap es direccional, no ejecutivo. |

---

*Whitepaper generado como entregable de CA-008 — Roadmap de Transformación Open Source de FlowTask.*
