---
name: graphify-protocol
description: "Contrato operativo compartido de consulta, degradación, comunicación y evidencia para el consumo del grafo Graphify por CA-writer y planner. Define la consulta MCP, la degradación a búsqueda normal y el schema de evidencia verificable."
license: MIT
compatibility: opencode
metadata:
  category: protocol
  scope: flowtask
---

skill({ name: "memory-protocol" })
skill({ name: "zero-assumptions" })

# Protocolo Graphify — Consumo del grafo por CA-writer y planner

## Propósito

Este skill define el contrato operativo compartido para que CA-writer y planner consuman el grafo Graphify mediante MCP, con degradación explícita a búsqueda normal y evidencia verificable de hallazgos.

## Precondiciones

Antes de consultar el grafo, el agente debe:

1. **Verificar disponibilidad Graphify** — consultar el estado/`graphPath` del contrato de `plan-habilitar` (no inferir por presencia del skill o binario).
2. **Usar únicamente la interfaz de integración MCP** definida por `plan-grafo`.
3. **Operar desde la raíz del repositorio principal** — exclusión explícita de worktrees.
4. **No consultar `.worktrees/`** — el alcance es exclusivamente el repositorio principal.

## Cadena de consulta

La cadena para cada necesidad de contexto del repositorio es secuencial:

```
1. graphify_query_graph (MCP) — herramienta de integración concreta del grafo
   ↓ si el MCP no está disponible o no devuelve resultado utilizable
2. búsqueda normal del proyecto
```

La cadena se detiene en la primera vía que devuelve un resultado utilizable. La
CLI histórica `graphify query` no forma parte de esta cadena: se conserva solo
como shim deprecated, no ejecuta consultas y termina con salida no exitosa.

## Clasificación de intentos

Cada intento de consulta se clasifica como:

- **`success`** — MCP devolvió referencias utilizables.
- **`unavailable`** — la integración MCP no está disponible.
- **`failed`** — MCP está disponible pero falló (error de red o transporte).
- **`empty`** — MCP funcionó correctamente pero no hay coincidencias.

## Mensajes de degradación

Los mensajes de degradación son observables, breves y no bloqueantes. No se
imprime la salida completa de herramientas ni secretos.

Cuando `graphify_query_graph` no produce contexto Graphify, se usa búsqueda
normal y se emite **literalmente**:

```
no pude consultar el grafo, estoy usando búsqueda normal
```

Esta frase es obligatoria cuando MCP no entrega contexto utilizable. No se
parafrasea ni se omite.

## Reglas de integridad

El agente **NUNCA** debe:

- Afirmar que un hallazgo proviene del grafo cuando proviene de búsqueda normal.
- Inventar nodos, rutas o símbolos que no fueron devueltos por Graphify.
- Consultar `.worktrees/` — el alcance es exclusivamente el repositorio principal.
- Presentar búsqueda normal como evidencia de grafo.
- Rellenar ausencia de resultados con inferencias no marcadas.

## Evidencia verificable del grafo (para planner)

La evidencia del planner vive **dentro del artifact de plan en Engram**
(`ca/CA-{ID}/artifact/plan`), en una sección top-level `## Evidencia verificable del grafo`.
No se crea un archivo de evidencia paralelo ni se guarda código fuente en Engram.

### Schema de entrada de evidencia

Cada evidencia usa el formato fijo `G-NNN`:

```markdown
## Evidencia verificable del grafo

- **G-001**
  - **Consulta:** `<consulta exacta enviada>`
  - **Vía:** `integración`
  - **Estado:** `consultado`
  - **Hallazgo:** `<hecho resumido, sin inferencia no marcada>`
  - **Referencias:** `<repo-relative path[:line-range] / symbol / Graphify node-edge IDs>`
  - **Fecha/commit:** `<timestamp o commit de la consulta>`
```

### Reglas de evidencia

- **`Vía`** solo puede ser `integración` para evidencia derivada de Graphify.
- La búsqueda normal no se presenta como evidencia de grafo.
- **`Referencias`** contiene rutas relativas verificables, símbolo o rango de líneas cuando exista, y node/edge IDs devueltos por Graphify si están disponibles.
- Una afirmación sin referencia concreta no es evidencia verificable.
- Si no hubo consulta Graphify, el planner declara: `Sin evidencia derivada del grafo: se usó búsqueda normal`.
- Si una consulta retornó `empty`, debe registrarlo como ausencia verificable, no rellenarlo con una inferencia.

## Responsabilidades por agente

### CA-writer

- Puede usar hallazgos del grafo para comprender el repositorio.
- **No transforma** esos hallazgos en un plan ni altera el formato del CA.
- Ejecuta la consulta MCP antes de cerrar el análisis.
- Si MCP falla o no devuelve referencias utilizables, continúa con búsqueda normal e informa la degradación.
- La ausencia del grafo **no es pregunta bloqueante** — continúa con su conversación de clarificación.

### Planner

- Exige que toda consulta de repositorio use MCP y la degradación documentada.
- **Antes de finalizar el plan**, inserta `## Evidencia verificable del grafo` en el artifact.
- Incluye una entrada por cada hallazgo que realmente provino de integración.
- Si el grafo no estuvo disponible, incluye la declaración de ausencia.
- Comunica la degradación al runner/desarrollador usando la frase exacta al caer a búsqueda normal.
- **Es el único que materializa evidencia Graphify en el plan.**

## Exclusiones

Este skill **NO** define ni implementa:

- Consultas MCP internas.
- Extracción de grafo.
- Servidor, parser o adaptadores CLI.
- Instalación/update de Graphify.
- Persistencia de estado.
- Generación de docs/media.
- Ciclo background.
- Consultas en `.worktrees/`.
- Una interfaz local alternativa; `graphify query` solo se conserva como shim deprecated y no ejecuta consultas.

## GAPs conocidos

- **GAP 1 — Enforcement por diseño**: Si un agente no carga el skill o no sigue sus reglas, el sistema no lo detecta automáticamente. La consecuencia (evidencia fabricada o degradación omitida) solo se ve al final.
- **GAP 2 — Disponibilidad inferida**: El agente puede asumir que el grafo está disponible sin verificar el estado/`graphPath`. El protocolo Zero-Assumptions mitiga esto.

---

> **Nota**: Este skill debe cargarse después de `memory-protocol` y `zero-assumptions` para asegurar que las herramientas de consulta a Engram y el protocolo de verificación estén disponibles.
