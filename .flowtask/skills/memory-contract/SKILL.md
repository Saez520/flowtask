---
name: memory-contract
description: "Contratos de datos, categorías oficiales, formato canónico de topic_key, protocolo de artifactos y resiliencia para FlowTask. Define qué datos se guardan y cómo se manejan los fallos. Carga este skill si necesitás los contratos estructurales de memoria."
license: MIT
compatibility: opencode
metadata:
  category: memory
  scope: flowtask
---

# Engram Memory Contract

Este skill define el contrato estructural de memoria para FlowTask, independiente de la implementación subyacente.
Si necesitás la guía práctica de uso diario, cargá `memory-protocol`.

---

## Contratos de Datos (Payloads)

### 1. SAVE_DECISION / SAVE_OBSERVATION

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
| `pending` | Propuesta o tarea identificada, no decidida y no asociada todavía a un CA aprobado. |

---

## Topic Key Convention

Todo `topic_key` debe seguir el formato canónico:

```text
{namespace}/CA-{ID}[/{sub-namespace}]
```

**Reglas**:
- Prefijo `CA-` **obligatorio** en el ID (ej: `plan/CA-search-integration`, no `plan/054`)
- `pending/{slug}` es un namespace oficial para pendientes no decididos y una excepción explícita al prefijo `CA-` obligatorio, igual que el ID especial `project` usado en `ca/project/artifact/project-context`.
- `flow-state/{ID}` **NUNCA** se usa sin sub-namespace
- Cada agente escribe **SOLO** sus namespaces autorizados

Para la tabla completa de ownership (quién escribe cada namespace), consultá `topic-keys-convention`.

---

## Artifact Namespace

Los artifactos completos se persisten como observaciones Engram con `type: "ca-artifact"`.
El namespace canónico es `ca/CA-{ID}/artifact/{filename}`.

| Archivo | topic_key | Agente que escribe |
|---------|-----------|-------------------|
| `ca.md` | `ca/CA-{ID}/artifact/ca` | ca-writer |
| `plan.md` | `ca/CA-{ID}/artifact/plan` | planner |
| `validacion.md` | `ca/CA-{ID}/artifact/validacion` | validator |
| `audit.md` | `ca/CA-{ID}/artifact/audit` | plan-auditor |
| `logging-report.md` | `ca/CA-{ID}/artifact/logging-report` | logger |
| `tests-report.md` | `ca/CA-{ID}/artifact/tests-report` | tester |
| `project-context.md` | `ca/project/artifact/project-context` | initializer |

> **Nota sobre `project-context.md`**: usa el ID especial `project`.

---

## Restricciones

- **NUNCA** uses `flow-state/{ID}` sin sub-namespace
- **SIEMPRE** usa prefijo `CA-` en el ID del `topic_key`

---

## Protocolo de Resiliencia (CA-005)

Si el proveedor de memoria (MCP) no está disponible:
1. Serializá el payload según el contrato anterior.
2. Guardalo en `.flowtask/.temp/operation-{timestamp}.json`.
3. Notificá al Runner del estado `Buffered`.
4. Para artifactos (`type: "ca-artifact"`), incluí el contenido completo del artifacto en el JSON de fallback.

El Runner sincronizará estos archivos automáticamente en la próxima ejecución exitosa.

---

## Artifact Protocol

Los artifactos completos generados por agentes NO se escriben como archivos en `.workspace/CA-{ID}/`.
Se persisten como observaciones Engram con `type: "ca-artifact"`.

### Regla de escritura: `mem_save_artifact`

```text
mem_save(
  type: "ca-artifact",
  topic_key: "ca/CA-{ID}/artifact/{filename}",
  title: "CA-{ID}: {descripción del artifacto}",
  scope: "project",
  content: {contenido completo del artifacto}
)
```

**Reglas**:
- `type` es siempre `ca-artifact`
- `topic_key` sigue el namespace `ca/CA-{ID}/artifact/{filename}`
- `title` debe ser descriptivo y buscable
- `content` contiene el texto completo del artifacto
- Nunca se crea archivo en `.workspace/CA-{ID}/` como fallback
- `mem_save_artifact` no existe como tool real: es un patrón documentado

### Antes vs Ahora

| Operación | Antes | Ahora |
|-----------|-------|-------|
| Guardar plan | `write_file(path: ".workspace/CA-{ID}/plan.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/plan", ...)` |
| Guardar CA | `write_file(path: ".workspace/CA-{ID}/ca.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/ca", ...)` |
| Guardar validación | `write_file(path: ".workspace/CA-{ID}/validacion.md", ...)` | `mem_save(type: "ca-artifact", topic_key: "ca/CA-{ID}/artifact/validacion", ...)` |

### Regla de lectura bajo demanda

Los artifactos con `type: "ca-artifact"` no se cargan en contexto operativo normal.

**Cuándo SÍ buscar artifactos:**
- La tarea explícitamente lo requiere
- El agente está en modo investigación, auditoría o evolución
- El Runner o el usuario lo solicita explícitamente

**Cuándo NO buscar artifactos:**
- Durante la inicialización del agente
- Durante búsquedas operativas de contexto
- Durante `mem_context`

**Protocolo de recuperación:**
1. `mem_search(query: "CA-{ID} {tipo}", type: "ca-artifact")`
2. Identificar el observation ID correcto por título
3. `mem_get_observation(id: N)` para el contenido completo

### Regla de precedencia

`memory-protocol` es el punto de verdad para la persistencia operativa de artifactos; este skill define el contrato y el namespace.

---

## Dual-Source Period

Durante la migración coexistieron dos fuentes:

| Fuente | Estado | Uso |
|--------|--------|-----|
| CAs nuevos | Engram | Fuente principal |
| CAs viejos (~19 en `.workspace/`) | Archivo | Fallback histórico |

**Regla de 3 pasos**:
1. Buscar en Engram
2. Fallback a archivo
3. Reportar no encontrado si no aparece en ninguno

---

## Naming Convention

Los títulos deben ser concisos y buscables.

**Bien**: `"Agregado endpoint de validación de usuarios"`

**Mal**: `"cambios varios"`
