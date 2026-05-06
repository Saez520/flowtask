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
- Prefijo `CA-` **obligatorio** en el ID (ej: `plan/CA-054`, no `plan/054`)
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

> Para la tabla completa de ownership (incluyendo tester, logger, sub-namespaces y resoluciones históricas), consulta `topic-keys-convention`.

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

El Runner sincronizará estos archivos automáticamente en la próxima ejecución exitosa.

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

## Naming Convention
Los títulos deben ser concisos y buscables. 
- **Mal**: `Guardando el estado del constructor para el CA-001`
- **Bien**: `Constructor CA-001: Implementación completada`
