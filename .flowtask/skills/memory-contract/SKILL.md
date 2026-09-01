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

Este skill es la única fuente normativa de persistencia en Engram para FlowTask.
Define namespaces canónicos, ownership, types, scopes, payloads, excepciones tipadas,
el invariante central de configuración vigente y la degradación ante indisponibilidad.

Para la guía práctica de uso diario, cargá `memory-protocol`.
Para la tabla de ownership derivada, cargá `topic-keys-convention`.
Para el protocolo de uso específico de checkpoints, cargá `checkpoint-mixin`.

---

## Namespaces Canónicos

Todo `topic_key` sigue el formato `{namespace}/CA-{ID}[/{sub-namespace}]`.

| Namespace | Owner | Lectores | Tipo de payload |
|-----------|-------|----------|-----------------|
| `ca/CA-{ID}/artifact/ca` | ca-writer | Runner, Planner, Constructor, Validator | `ca-artifact` |
| `ca/CA-{ID}/artifact/plan` | planner | Runner, Plan-Auditor, Constructor, Validator | `ca-artifact` |
| `ca/CA-{ID}/artifact/validacion` | validator | Runner | `ca-artifact` |
| `ca/CA-{ID}/artifact/audit` | plan-auditor | Runner, Validator | `ca-artifact` |
| `ca/CA-{ID}/artifact/logging-report` | logger | — | `ca-artifact` |
| `ca/CA-{ID}/artifact/tests-report` | tester | — | `ca-artifact` |
| `ca/project/artifact/project-context` | initializer | Todos | `ca-artifact` |
| `flow-state/CA-{ID}/create` | ca-writer | Runner | `decision` (CheckpointPayload) |
| `flow-state/CA-{ID}/plan` | planner | Runner | `decision` (CheckpointPayload) |
| `flow-state/CA-{ID}/audit` | plan-auditor | Runner | `decision` |
| `flow-state/{execution_id}/construct` | constructor | Runner | `decision` |
| `flow-state/{execution_id}/validate` | validator | Runner | `decision` |
| `flow-state/{ID}/tests` | tester | Runner | `decision` |
| `flow-state/{CA-ID}/review` | review-orchestrator | Runner | `decision` |
| `flow-state/{ID}/logging` | logger | Runner | `decision` |
| `flow-state/{ID}/init` | initializer | Runner | `decision` |
| `flow-state/CA-{ID}/inspect` | inspector | Runner | `decision` |
| `flow-state/CA-{ID}/instances` | runner | Runner (escritura exclusiva) | `decision` |
| `flow-state/no-ca/{agente}/{operation-id}` | agentes ligeros sin CA | Runner | `decision` |
| `project/stack` | initializer (owner) / onboarder (excepción: snapshot vigente) | Todos (read-only) | `config` |
| `project/conventions` | initializer | Todos (read-only) | `pattern` |
| `project/naming` | initializer | Todos (read-only) | `pattern` |
| `project/layers` | initializer | Todos (read-only) | `discovery` |
| `project/{layer}` | **initializer ONLY** | Todos (read-only) | `pattern` / `discovery` |
| `project/protected-files` | initializer | Todos (read-only) | `decision` |
| `project/config` | initializer | Todos (read-only) | `config` |
| `project/patterns` | initializer | Todos (read-only) | `pattern` |
| `project/heuristics/*` | todos los agentes (escritura compartida) | Todos | `pattern` |
| `personal/heuristics/*` | todos los agentes (escritura compartida, scope: personal) | Todos | `pattern` |
| `pending/{slug}` | runner, ca-writer, inspector (escritura compartida) | Agentes que necesiten conocer pendientes | `pending` |

**Reglas**:
- Prefijo `CA-` obligatorio en el ID (ej: `flow-state/CA-search-integration/plan`).
- `pending/{slug}` es una excepción explícita al prefijo `CA-` obligatorio.
- `flow-state/{CA-ID}` **NUNCA** se usa sin sub-namespace de agente.
- Cada agente escribe **SOLO** sus namespaces autorizados.

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

## Excepciones Tipadas

### CheckpointPayload (schema v2)

Los checkpoints de continuidad constituyen una excepción tipada al formato narrativo ordinario.
Usan este schema y conservan el estado estructurado necesario para reanudación:

```json
{
  "version": "2.0",
  "treatment_class": "complete | light",
  "state": "active | paused | completed",
  "updated_at": "timestamp",
  "sequence": 1,
  "topic_signature": {
    "ids": ["..."],
    "keywords": ["..."]
  },
  "flow_state": {
    "ca_id": "CA-{ID}",
    "agente": "{agente}",
    "instance_name": "{Name}",
    "resume_ref": "{task_id}"
  },
  "fresh_thread_marker": true
}
```

**Campos**:
- `version`: siempre `"2.0"`.
- `treatment_class`: `"complete"` (ca-writer, planner) o `"light"` (resto de agentes).
- `state`: `"active"`, `"paused"` o `"completed"`. `"completed"` marca el cierre y conserva la observación como traza.
- `sequence`: contador monotónico incremental por agente.
- `topic_signature`: firma del tema (opcional, backward-compatible).
- `flow_state`: estado específico del agente.
- `resume_ref`: obligatorio en tratamiento completo (ca-writer, planner). Referencia de reanudación.
- `fresh_thread_marker`: solo en tratamiento ligero sin CA.

### SessionSummary

El payload de cierre de sesión sigue esta estructura:

```typescript
interface SessionSummary {
  goal: string;
  accomplished: string[];
  discoveries: string[];
  next_steps: string[];
  relevant_files: string[];
}
```

El contrato completo de `mem_session_summary` vive en este skill. Los agentes lo invocan sin redefinirlo.

---

## Invariante Central de Configuración Vigente

Los archivos de configuración de agentes y skills enuncian solo reglas vigentes en positivo:
sin nombres de CAs de origen, sin comparaciones con modos reemplazados, sin historia de implementación.

**Roles responsables**:
- **Aplican**: constructor (al modificar archivos de `.flowtask/`).
- **Controlan**: plan-auditor (antes de aprobar un plan) y validator (después de la implementación).
- **Registran snapshots vigentes**: initializer, logger, tester (sin transformar esa responsabilidad en regla literal de redacción).
- **Consumen sin duplicar**: comandos y personas.

Las exclusiones normativas, riesgos, GAPs aceptados y restricciones activas permanecen expresados como salvedades vigentes cuando correspondan.

---

## Degradación sin Engram

Si el proveedor de memoria (MCP) no está disponible al persistir información:

1. Informá el bloqueo al usuario.
2. Solicitá decisión al usuario sobre cómo continuar.
3. **NO** persistas en archivos locales de fallback (JSON, buffers, archivos temporales).

La operación queda detenida hasta una decisión del usuario. No se crea ninguna fuente paralela de datos.

---

## Artifact Protocol

Los artifactos completos se persisten como observaciones Engram con `type: "ca-artifact"`.
El namespace canónico es `ca/CA-{ID}/artifact/{filename}`.

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
- `type` es siempre `ca-artifact`.
- `topic_key` sigue el namespace `ca/CA-{ID}/artifact/{filename}`.
- `title` debe ser descriptivo y buscable.
- `content` contiene el texto completo del artifacto.
- `mem_save_artifact` no existe como tool real: es un patrón documentado.

### Regla de lectura bajo demanda

Los artifactos con `type: "ca-artifact"` no se cargan en contexto operativo normal.

**Cuándo SÍ buscar artifactos:**
- La tarea explícitamente lo requiere.
- El agente está en modo investigación, auditoría o evolución.
- El Runner o el usuario lo solicita explícitamente.

**Cuándo NO buscar artifactos:**
- Durante la inicialización del agente.
- Durante búsquedas operativas de contexto.
- Durante `mem_context`.

**Protocolo de recuperación:**
1. `mem_search(query: "CA-{ID} {tipo}", type: "ca-artifact")`
2. Identificar el observation ID correcto por título.
3. `mem_get_observation(id: N)` para el contenido completo.

---

## Restricciones

- **NUNCA** uses `flow-state/{CA-ID}` sin sub-namespace de agente.
- **SIEMPRE** usa prefijo `CA-` en el ID del `topic_key`.
- **NUNCA** persistas en archivos locales ante caída de Engram.
- **NUNCA** migres ni sanees observaciones históricas.

---

## Fuente Única

Los artifactos de CAs se recuperan exclusivamente desde Engram:

1. `mem_search(query: "CA-{ID} {tipo}", type: "ca-artifact")`
2. `mem_get_observation(id: N)` para el contenido completo.
3. Si no aparece, reportar no encontrado al runner.

Los hotfixes y CAs previos se buscan bajo el ID original con el que fueron creados; los IDs históricos no se renombran.

---

## Naming Convention

Los títulos deben ser concisos y buscables.

**Bien**: `"Agregado endpoint de validación de usuarios"`

**Mal**: `"cambios varios"`

---

## Fuera de Alcance

`project-context.md` y su tratamiento de artefactos operativos quedan resueltos fuera de este contrato.
