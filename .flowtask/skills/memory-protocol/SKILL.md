---
name: memory-protocol
description: Protocolo agnóstico de memoria para FlowTask. Define el contrato de datos para persistencia y búsqueda sin depender de la implementación CLI específica.
license: MIT
compatibility: opencode
metadata:
  category: memory
  scope: flowtask
---

# Engram Memory Protocol (Agnostic Contract)

## Propósito
Este skill define el **Contrato de Intención** para la memoria de FlowTask. Los agentes deben seguir este esquema de datos independientemente de si la persistencia es local, remota (MCP) o mediante buffer temporal.

---

## Contratos de Datos (Payloads)

### 1. SAVE_DECISION / SAVE_OBSERVATION
Utilizado para persistir estados, decisiones o hallazgos.

**Esquema:**
```typescript
interface MemoryPayload {
  title: string;       // Corto, descriptivo (ver Naming)
  type: string;        // Categoría oficial
  scope: "project";    // Siempre "project" para FlowTask
  topic_key?: string;  // Identificador estable para updates/upserts
  content: {
    What: string;      // Qué se hizo/encontró
    Why: string;       // Motivación o razón
    Where: string;     // Archivos o módulos afectados
    Learned?: string;  // Gotchas o lecciones aprendidas (opcional)
  }
}
```

### 2. SESSION_SUMMARY
Resumen obligatorio al finalizar un flujo de trabajo.

**Esquema:**
```typescript
interface SessionSummary {
  goal: string;
  accomplished: string[];
  discoveries: string[];
  next_steps: string[];
  relevant_files: string[];
}
```

---

## Categorías Oficiales (types)

| Type | Descripción |
|---|---|
| `ca-artifact` | Artefacto completo (archivo) generado por un agente como output de tarea. No es memoria operativa. |
| `decision` | Snapshots de estado, flow state, resultados de agentes. |
| `architecture` | Decisiones estructurales cross-CA. |
| `bugfix` | Fix crítico que afecta futuras implementaciones. |
| `pattern` | Convenciones de código o patrones de diseño detectados. |
| `config` | Stack, herramientas, configuración del proyecto. |
| `discovery` | Hallazgos exploratorios o reportes de validación. |

---

## Topic Key Convention

Todo `topic_key` debe seguir el formato canónico:

```
{namespace}/CA-{ID}[/{sub-namespace}]
```

**Reglas**:
- Prefijo `CA-` **obligatorio** en el ID (ej: `plan/CA-search-integration`, no `plan/054`)
- `flow-state/{ID}` **NUNCA** se usa sin sub-namespace
- Cada agente escribe **SOLO** sus namespaces autorizados

### Ownership (resumido)

| Agente | Namespaces |
|--------|-----------|
| ca-writer | `ca/CA-{ID}`, `flow-state/CA-{ID}/create` |
| planner | `plan/CA-{ID}`, `flow-state/CA-{ID}/plan` |
| plan-auditor | `plan-audit/CA-{ID}`, `flow-state/CA-{ID}/audit` |
| constructor | `impl/CA-{ID}/*`, `flow-state/CA-{ID}/construct` |
| validator | `validation/CA-{ID}`, `flow-state/CA-{ID}/validate` |
| initializer | `project/*` (solo lectura para los demás) |
| ca-writer, planner, plan-auditor, validator, logger, tester, initializer | `ca/CA-{ID}/artifact/{filename}` |

> Para la tabla completa de ownership (incluyendo tester, logger, sub-namespaces y resoluciones históricas), consulta `topic-keys-convention`.

### Artifact namespace (`ca/CA-{ID}/artifact/{filename}`)

Los artifactos completos (output de agentes) se persisten como observaciones Engram con `type: "ca-artifact"`. No son archivos en `.workspace/`.

**Filename mapping:**

| Archivo | topic_key | Agente que escribe |
|---------|-----------|-------------------|
| `ca.md` | `ca/CA-{ID}/artifact/ca` | ca-writer |
| `plan.md` | `ca/CA-{ID}/artifact/plan` | planner |
| `validacion.md` | `ca/CA-{ID}/artifact/validacion` | validator |
| `audit.md` | `ca/CA-{ID}/artifact/audit` | plan-auditor |
| `logging-report.md` | `ca/CA-{ID}/artifact/logging-report` | logger |
| `tests-report.md` | `ca/CA-{ID}/artifact/tests-report` | tester |
| `project-context.md` | `ca/project/artifact/project-context` | initializer |

> **Nota sobre `project-context.md`**: El artifacto `project-context.md` no tiene CA-{ID} asociado. Usa el ID especial `project` en el namespace: `ca/project/artifact/project-context`.

### Restricciones

- **NUNCA** escribas a `project/{layer}` si no eres Initializer
- **NUNCA** uses `flow-state/{ID}` sin sub-namespace
- **SIEMPRE** usa prefijo `CA-` en el ID del topic_key
- **SIEMPRE** busca (`mem_search`) antes de escribir

---

## Protocolo de Resiliencia (CA-005)

Si el proveedor de memoria (MCP) no está disponible:
1. El agente debe serializar el payload según el contrato anterior.
2. Guardar en `.flowtask/.temp/operation-{timestamp}.json`.
3. Notificar al Runner del estado "Buffered".
4. Para artifactos (`type: "ca-artifact"`), el contenido completo del artifacto se incluye en el JSON de fallback. NO se escribe en `.workspace/CA-{ID}/` ni siquiera en modo fallback.

El Runner sincronizará estos archivos automáticamente en la próxima ejecución exitosa.

> **Artifactos en fallback**: Cuando un agente no puede persistir un artifacto vía `mem_save`, el artifacto completo se guarda en `.flowtask/.temp/operation-{timestamp}.json` con `type: "ca-artifact"` y el `topic_key` correspondiente. El Runner sincronizará estos buffers con Engram cuando el MCP vuelva a estar disponible. En ningún caso se crean archivos en `.workspace/` como fallback.

---

## Herramientas Abstraídas

Los agentes invocan estas funciones. La implementación subyacente (MCP tools) se encarga de mapear estos parámetros.

- `mem_save(payload)`: Persiste una observación.
- `mem_search(query, filters)`: Busca información histórica.
- `mem_context(limit)`: Recupera los eventos más recientes.
- `mem_session_summary(summary)`: Cierra la sesión con un reporte.
- `mem_suggest_topic_key(title, type)`: Sugiere un topic_key estable para el contenido.

---

## Protocolo Pre-Write

Antes de ejecutar `mem_save`, sigue estos pasos:

1. **Buscar**: `mem_search(query: "{título o contenido esperado}", scope: "project")` — verifica si ya existe contenido similar.
2. **Verificar ownership**: consulta la tabla de ownership arriba. ¿Eres el dueño del namespace? Si no lo eres, NO escribas ahí.
3. **Resolver dudas**: si no estás seguro del topic_key, usa `mem_suggest_topic_key(title: "...", type: "...")`.

---

## Artifact Protocol (CA-ca-artifact-protocol)

Los artifactos completos generados por agentes (ca.md, plan.md, validacion.md, audit.md, logging-report.md, tests-report.md, project-context.md) NO se escriben como archivos en `.workspace/CA-{ID}/`. Se persisten como observaciones Engram con `type: "ca-artifact"`.

### Regla de escritura: `mem_save_artifact`

Todo agente que necesite persistir un artifacto completo usa este patrón en lugar de `write_file` a `.workspace/`:

```
mem_save(
  type: "ca-artifact",
  topic_key: "ca/CA-{ID}/artifact/{filename}",
  title: "CA-{ID}: {descripción del artifacto}",
  scope: "project",
  content: {contenido completo del artifacto}
)
```

**Reglas**:
- `type` es **SIEMPRE** `"ca-artifact"` — esto permite filtrar artifactos en búsquedas
- `topic_key` sigue el namespace `ca/CA-{ID}/artifact/{filename}` — ver tabla de filename mapping arriba
- `title` debe ser descriptivo y buscable: `"CA-{ID}: {Tipo de artifacto}"` (ej. `"CA-ca-artifact-protocol: Plan de implementación"`)
- `content` contiene el texto completo del artifacto (markdown). No se trunca ni se resume
- **NUNCA** se escribe archivo en `.workspace/CA-{ID}/` para CAs nuevos
- La función `mem_save_artifact` NO existe como tool real — es un **patrón documentado** que encapsula los parámetros anteriores

**Antes vs Ahora:**

| Operación | Antes | Ahora |
|-----------|-------|-------|
| Guardar plan | `write_file(path: ".workspace/CA-{ID}/plan.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/plan", ...)` |
| Guardar CA | `write_file(path: ".workspace/CA-{ID}/ca.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/ca", ...)` |
| Guardar validación | `write_file(path: ".workspace/CA-{ID}/validacion.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/validacion", ...)` |

### Regla de lectura bajo demanda

Los artifactos con `type: "ca-artifact"` **NO se cargan en contexto operativo normal**. Solo se recuperan bajo demanda cuando la tarea del agente lo requiere explícitamente.

**Cuándo SÍ buscar artifactos:**
- La tarea explícita lo requiere (ej. "leé el plan del CA-X")
- El agente está en modo investigación, auditoría o evolución
- El runner o el usuario lo solicita explícitamente

**Cuándo NO buscar artifactos:**
- Durante la inicialización del agente
- Durante búsquedas operativas de contexto (`mem_search` sin `type: "ca-artifact"`)
- Durante `mem_context` (aunque pueden aparecer por sesión reciente — riesgo bajo aceptado, ver GAP 2)

**Protocolo de recuperación:**
```
1. mem_search(query: "CA-{ID} {tipo}", type: "ca-artifact")
2. Identificar el observation ID correcto por título
3. mem_get_observation(id: N) → contenido completo del artifacto
```

**Ejemplo — leer el plan del CA-ca-artifact-protocol:**
```
mem_search(query: "CA-ca-artifact-protocol plan", type: "ca-artifact")
→ encuentra observación con título "CA-ca-artifact-protocol: Plan de implementación"
mem_get_observation(id: {id})
→ contenido completo del plan
```

### Regla de precedencia

Si las instrucciones de un agente dicen explícitamente `write_file(path: ".workspace/...")` o `read_file(path: ".workspace/...")`, este protocolo de artifactos tiene **precedencia**: el agente debe usar `mem_save(type: "ca-artifact", ...)` para escritura y `mem_search(type: "ca-artifact")` + `mem_get_observation` para lectura. La skill `memory-protocol` es el punto de verdad para la persistencia de artifactos.

---

## Dual-Source Period (transitorio)

Durante el período de transición (antes de la migración de CAs históricos), coexisten dos fuentes de verdad para artifactos:

| CAs | Dónde están los artifactos | Cómo leerlos |
|-----|---------------------------|-------------|
| **Nuevos** (post CA-ca-artifact-protocol) | Engram, `type: "ca-artifact"` | `mem_search(type: "ca-artifact")` + `mem_get_observation` |
| **Viejos** (~19 CAs en `.workspace/`) | Archivos en `.workspace/CA-{ID}/` | `read_file(path: ".workspace/CA-{ID}/{filename}")` |

**Regla para agentes que leen artifactos**:
1. **Primero** buscar en Engram con `mem_search(query: "CA-{ID}", type: "ca-artifact")`
2. **Si no se encuentra**, hacer fallback a archivo: `read_file(".workspace/CA-{ID}/{filename}")`
3. **Si no existe en ninguna fuente**, reportar "artifacto no encontrado"

Este período dual-source terminará cuando se ejecute el CA de migración de CAs históricos (fuera del scope de este CA).

---

## Naming Convention
Los títulos deben ser concisos y buscables. 
- **Mal**: `Guardando el estado del constructor para el CA-onboarder-agent`
- **Bien**: `Constructor CA-onboarder-agent: Implementación completada`
