# FlowTask — Guía de Presentación

> Audiencia: Líder de IA (técnico)
> Foco principal: Engram como sistema de memoria persistente
> Formato: Talking points por tema

---

## 1. ¿Qué es FlowTask?

- Un sistema **multi-agente orquestado** para desarrollo de software
- No es un chatbot — es un pipeline de agentes especializados con memoria compartida
- Cada agente tiene un rol acotado, reglas estrictas, y NO puede salirse de su scope
- El desarrollador habla con UN solo punto de entrada: el **Runner** (orquestador)
- Funciona sobre Claude Code y OpenCode (soporte dual)

---

## 2. Sistema de Delegación

**Concepto clave**: El Runner nunca ejecuta — solo clasifica y delega.

```
Developer → Runner → Clasifica intención → Delega al agente correcto
```

### Flujo principal (5 agentes en secuencia):

```
CA-Writer → Planner → Constructor → Validator
    ↑                                    |
    └──── Runner (orquesta todo) ────────┘
```

1. **CA-Writer**: Define el requisito (qué se va a hacer)
2. **Planner**: Genera el plan técnico (cómo se hace)
3. **Constructor**: Implementa el plan (escribe código)
4. **Validator**: Valida que lo implementado cumple el plan

### Otros agentes (existen, no profundizar):
- **Inspector**: Explora y responde preguntas del proyecto
- **Tester**: Genera tests
- **Logger**: Instrumenta logging
- **Initializer**: Escanea y mapea el proyecto
- **Plan Auditor**: Audita planes complejos

---

## 3. Reglas Clave por Agente (las 2 más importantes)

| Agente | Regla 1 | Regla 2 |
|--------|---------|---------|
| **Runner** | Nunca ejecuta directamente — solo delega | Nunca salta checkpoints sin confirmación del dev |
| **CA-Writer** | Conduce conversación hasta eliminar ambigüedades | No genera plan ni código — solo la spec |
| **Planner** | Genera plan decision-complete (sin supuestos) | Respeta convenciones del proyecto leídas de Engram |
| **Constructor** | Solo implementa lo que dice el plan — nada más | No toma decisiones de diseño |
| **Validator** | Valida contra el plan, no contra opinión propia | Máximo 2 rechazos — luego escala al dev |

---

## 4. El Flujo de Ejecución

```
/run CA-{ID}
```

**Paso 1** — ¿Existe el CA? Si no → CA-Writer lo crea con el dev
**Paso 2** — Planner genera el plan técnico
**Paso 3** — **Checkpoint**: El dev revisa y aprueba (o corrige)
**Paso 4** — Constructor implementa
**Paso 5** — Validator valida
**Paso 6** — Si rechaza 2 veces → escala al dev

- El dev puede correr flujos parciales (solo planificación, solo validación)
- `--auto` salta el checkpoint (para cuando confías en el pipeline)

---

## 5. ⭐ ENGRAM — Memoria Persistente (FOCO PRINCIPAL)

### ¿Qué es?

- **Engram** es el sistema de memoria compartida entre todos los agentes
- Persiste entre sesiones — los agentes "recuerdan" lo que pasó antes
- Es la diferencia entre un chatbot sin estado y un equipo con contexto

### ¿Qué problema resuelve?

Los LLMs no tienen memoria entre sesiones. Cada conversación empieza de cero.
Engram le da a FlowTask:
- **Continuidad**: Un agente retoma donde otro dejó
- **Contexto compartido**: Todos los agentes ven las mismas decisiones
- **Trazabilidad**: Cada decisión queda registrada con su "por qué"

### ¿Cómo lo usan los agentes?

**Protocolo de memoria (contrato de datos):**
```
mem_save()    → Persiste decisiones, hallazgos, estados
mem_search()  → Busca información histórica
mem_context() → Recupera eventos recientes
mem_session_summary() → Cierra sesión con reporte
```

**Cada entrada tiene estructura:**
- **What**: Qué se hizo o encontró
- **Why**: Por qué se tomó esa decisión
- **Where**: Qué archivos/módulos afecta
- **Learned**: Lecciones aprendidas (opcional)

### ¿Qué hace el Runner con Engram al iniciar cada sesión?

Cada vez que el Runner arranca (nueva conversación o sesión), ejecuta este flujo:

1. **Clasifica la intención** del desarrollador (¿nuevo CA? ¿continuar uno existente?)
2. **Busca en Engram** si ya existe un mapa de instancias para ese CA
   - `mem_search("flow-state/{CA-ID}/instances")`
3. **Recupera o asigna identidad**:
   - Si encuentra mapa → recupera el BaseName (ej: "Aitana") y los task_ids activos
   - Si no existe → asigna el siguiente nombre disponible de la lista
4. **Decide: ¿nuevo hilo o reanudación?**
   - Si hay task_id activo → construye un **Resume Prompt** con el último checkpoint
   - Si no hay → crea un **Initial Prompt** con contexto inyectado desde Engram
5. **Inyecta contexto** antes de delegar:
   - `mem_context()` + `mem_search()` → todo lo relevante del CA
   - Lo envuelve en un bloque `<project_context>` dentro del prompt del agente
6. **Delega al agente** con toda la información — el agente nunca empieza de cero

> **En resumen**: El Runner usa Engram como su "disco duro" — cada sesión nueva es una reanudación inteligente, no un arranque en frío.

### Casos de uso concretos en FlowTask:

**1. Handshake Protocol (Identidad de agentes)**
- Cada CA tiene un "nombre base" asignado (ej: Aitana, Kael, Lyra...)
- Los agentes se instancian como `Aitana-planner`, `Aitana-constructor`
- Este mapa se persiste en Engram → si la sesión se cae, se recupera
- El Runner busca en Engram antes de crear un agente: ¿ya existe? → lo reanuda

**2. Flow State (Estado del flujo)**
- Cada paso del pipeline guarda su estado en Engram
- Si el Constructor termina y la sesión se cierra, el Validator sabe exactamente dónde quedó
- Topic keys: `flow-state/{CA-ID}/planner`, `flow-state/{CA-ID}/constructor`, etc.

**3. Context Injection (Inyección de contexto)**
- Antes de invocar un agente, el Runner consulta Engram
- Inyecta el contexto relevante en el prompt del agente
- El agente no empieza de cero — arranca con las decisiones previas

**4. Checkpoint & Resume**
- Si un hilo se pierde (timeout, crash), el Runner detecta el fallo
- Busca el último checkpoint en Engram
- Relanza el agente con un "Resume Prompt" que incluye el mini-resumen
- **Self-Healing**: limpia el task_id fallido y reintenta automáticamente

**5. Convenciones del Proyecto**
- El Initializer escanea el proyecto y guarda convenciones en Engram
- El Planner las lee antes de generar un plan → respeta patrones existentes
- El Constructor las lee antes de implementar → código consistente

**6. Session Summaries**
- Al final de cada flujo, se guarda un resumen:
  - Objetivo, lo logrado, descubrimientos, próximos pasos, archivos clave
- Esto alimenta la memoria a largo plazo del proyecto

**7. Resiliencia (Buffer Protocol)**
- Si Engram no está disponible, los agentes serializan a archivos temporales
- Cuando Engram vuelve, se sincronizan automáticamente
- Nunca se pierde información

### ¿Por qué es la joya?

> Sin Engram, FlowTask sería un pipeline de agentes sin memoria.
> Con Engram, es un equipo que aprende, recuerda y se recupera de fallos.

La memoria convierte agentes independientes en un **sistema coherente con estado**.

---

## 6. Lo que viene (Roadmap)

### Estabilización activa

| Item | Qué implica |
|------|-------------|
| Persistencia de task_id en Handshake | El Runner asigna identidad pero a veces no persiste — fix en progreso |
| Refuerzo de identidad del Runner | Asegurar que siempre asuma su rol correcto al iniciar sesión |
| Consistencia de IDs de CA | El CA-Writer debe verificar el consecutivo real antes de asignar |
| Verificación post-save en Engram | Confirmar que los datos realmente se guardaron antes de reportar éxito |

### Mejoras en pipeline

| Item | Qué implica |
|------|-------------|
| Validator más riguroso | Integración con Tester, validación de runtime (no solo estático) |
| Modo Hotfix | Flujo ligero para correcciones rápidas sin la formalidad de un CA completo |
| Mitigación de degradación de contexto | Mecanismo de inyección progresiva de reglas cuando el contexto crece |
| Protocolo Zero-Assumptions | Auditar prompts de todos los agentes para eliminar supuestos no verificados |

### Evolución arquitectónica

| Item | Qué implica |
|------|-------------|
| Orquestación paralela | Runner ejecutando agentes independientes en paralelo |
| FlowTask 2.0 — Hybrid Context | Engram como MCP Server, integración LSP/ast-grep, workspace efímero |
| Workspace compartible | Protocolo para compartir `.workspace` entre equipos sin colisiones |
| Purge Protocol | Limpieza automática de task_ids expirados en Engram |

### Integración: sdd-engram-plugin

- **Plugin para configurar modelos de IA directamente por sub-agente** desde el TUI
- Gestión de perfiles SDD (Spec-Driven Development)
- Permite cambiar provider/modelo para cualquier agente sin reiniciar
- Fallback por agente: si un modelo falla, cae al modelo secundario configurado
- Bulk actions para asignar modelos a todo el perfil de una vez
- Versionado de perfiles: preview y rollback antes de cambios riesgosos
- Detección automática del perfil activo
- **¿Por qué importa?** Control granular sobre qué modelo usa cada agente del pipeline

---

## 7. Cierre

**FlowTask no es solo un wrapper de LLMs.**
Es un sistema de agentes con:
- Roles estrictos y acotados
- Flujo verificable con checkpoints
- Memoria persistente compartida (Engram)
- Self-healing ante fallos
- Y un roadmap hacia orquestación inteligente

La memoria es lo que transforma "agentes sueltos" en un **equipo con contexto**.
