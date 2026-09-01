---
name: graphify-protocol
description: "Contrato operativo compartido de consulta, degradación, comunicación y evidencia para el consumo del grafo Graphify por CA-writer y planner. Define la cadena obligatoria de consulta, el contrato de la herramienta local, los mensajes de degradación y el schema de evidencia verificable."
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

Este skill define el contrato operativo compartido para que CA-writer y planner consuman el grafo Graphify con degradación obligatoria, comunicación explícita del fallback y evidencia verificable de hallazgos.

## Precondiciones

Antes de consultar el grafo, el agente debe:

1. **Verificar disponibilidad Graphify** — consultar el estado/`graphPath` del contrato de `plan-habilitar` (no inferir por presencia del skill o binario).
2. **Usar únicamente la interfaz de integración y la herramienta local exacta** definida por `plan-grafo`.
3. **Operar desde la raíz del repositorio principal** — exclusión explícita de worktrees.
4. **No consultar `.worktrees/`** — el alcance es exclusivamente el repositorio principal.

## Cadena obligatoria de consulta

La cadena para cada necesidad de contexto del repositorio es **secuencial y no salteable**:

```
1. graphify_query_graph (MCP) — herramienta de integración concreta del grafo
    ↓ (si el MCP no está disponible o no devuelve resultado utilizable)
2. herramienta local: node .flowtask/bin/flowtask.js graphify query --query <query-string>
    ↓ (si no está disponible, devuelve ok:false o no produce resultado utilizable)
3. búsqueda normal del proyecto
```

**Regla de terminación**: La cadena se detiene en la primera vía que devuelve un resultado utilizable.

**Regla de no-skip**: Ninguna vía puede omitirse. Si el MCP falla pero la CLI local funciona, se informa degradación parcial. Si ambas fallan, se usa búsqueda normal.

## Contrato de la herramienta local

La herramienta local consumida es exactamente la definida por `plan-grafo`:

### Entrada

- **Una única query string no vacía**
- Ejecución desde la raíz del repositorio principal
- Sin MCP, red ni servidor

### Salida (stdout)

**Una única línea JSON** con la estructura:

```json
{
  "ok": boolean,
  "source": "local",
  "query": string,
  "results": array,
  "diagnostic": string | null
}
```

- `source` es siempre `"local"`
- `results` es un array (puede estar vacío)
- `diagnostic` es string o null
- **Los diagnósticos no contaminan stdout** — stderr es exclusivo para diagnósticos

### Modos de fallo

| Condición | ok | source | results | diagnostic | exit code | Interpretación |
|-----------|----|----|---------|------------|-----------|----------------|
| Query vacía | `false` | `"local"` | `[]` | accionable | `1` | Fallo de entrada |
| Archivo ausente/ilegible/inválido | `false` | `"local"` | `[]` | accionable | `1` | Fallo de lectura |
| Error de lectura | `false` | `"local"` | `[]` | accionable | `1` | Fallo de transporte |
| Grafo válido sin coincidencias | `true` | `"local"` | `[]` | `null` | `0` | Consulta válida, sin matches |
| Grafo válido con coincidencias | `true` | `"local"` | `[...]` | `null` | `0` | Éxito con resultados |

### Semántica de resultados

- **`ok:false`** → señal para degradar a búsqueda normal (query vacía, archivo ausente/ilegible/inválido o error de lectura)
- **`ok:true` con `results:[]`** → consulta local válida sin coincidencias; **no se presenta como fallo de transporte**
- **`ok:true` con `results:[...]`** → éxito con hallazgos verificables

## Clasificación de intentos

Cada intento de consulta se clasifica como:

- **`success`** — la vía devolvió un resultado utilizable (`ok:true` con `results` no vacío)
- **`unavailable`** — la vía no está disponible (integración no configurada, binario ausente)
- **`failed`** — la vía está disponible pero falló (`ok:false`, exit code `1`, error de red)
- **`empty`** — la vía funcionó correctamente pero no hay coincidencias (`ok:true`, `results:[]`)

## Mensajes de degradación

Los mensajes de degradación son **observables, breves y no bloqueantes**. No se imprime la salida completa de herramientas ni secretos; se registra solo fase, causa resumida y vía elegida.

### Degradación parcial (MCP falla, CLI local funciona)

Cuando el MCP `graphify_query_graph` no produce contexto Graphify **y** la herramienta local concreta funciona, el agente informa:

```
[Graphify] MCP no disponible — usando herramienta local: node .flowtask/bin/flowtask.js graphify query --query <query-string>
```

### Degradación completa (MCP y CLI local fallan)

Cuando el MCP no produce contexto Graphify **y** la herramienta local concreta devuelve `ok:false` (incluido exit code `1`), se usa búsqueda normal y se emite **literalmente**:

```
no pude consultar el grafo, estoy usando búsqueda normal
```

**Esta frase es obligatoria** cuando ambas vías Graphify fallan. No se parafrasea ni se omite.

## Reglas de integridad

El agente **NUNCA** debe:

- Afirmar que un hallazgo proviene del grafo cuando proviene de búsqueda normal
- Inventar nodos, rutas o símbolos que no fueron devueltos por Graphify
- Consultar `.worktrees/` — el alcance es exclusivamente el repositorio principal
- Presentar búsqueda normal como evidencia de grafo
- Rellenar ausencia de resultados con inferencias no marcadas

## Evidencia verificable del grafo (para planner)

La evidencia del planner vive **dentro del artifact de plan en Engram** (`ca/CA-{ID}/artifact/plan`), en una sección top-level `## Evidencia verificable del grafo`. No se crea un archivo de evidencia paralelo ni se guarda código fuente en Engram.

### Schema de entrada de evidencia

Cada evidencia usa el formato fijo `G-NNN`:

```markdown
## Evidencia verificable del grafo

- **G-001**
  - **Consulta:** `<consulta exacta enviada>`
  - **Vía:** `integración` | `local`
  - **Estado:** `consultado`
  - **Hallazgo:** `<hecho resumido, sin inferencia no marcada>`
  - **Referencias:** `<repo-relative path[:line-range] / symbol / Graphify node-edge IDs>`
  - **Fecha/commit:** `<timestamp o commit de la consulta>`
```

### Reglas de evidencia

- **`Vía`** solo puede ser `integración` o `local` para evidencia derivada del grafo
- **La búsqueda normal no se presenta como evidencia de grafo**
- **`Referencias`** contiene rutas relativas verificables, símbolo o rango de líneas cuando exista, y node/edge IDs devueltos por Graphify si están disponibles
- **Una afirmación sin referencia concreta no es evidencia verificable**
- Si no hubo consulta Graphify, el planner declara: `Sin evidencia derivada del grafo: se usó búsqueda normal`
- Si una consulta retornó `empty`, debe registrarlo como ausencia verificable, no rellenarlo con una inferencia

## Responsabilidades por agente

### CA-writer

- Puede usar hallazgos del grafo para comprender el repositorio
- **No transforma** esos hallazgos en un plan ni altera el formato del CA
- Ejecuta la cadena de consulta antes de cerrar el análisis
- Si la CLI local devuelve `ok:false`/exit 1, continúa con búsqueda normal e informa la degradación
- La ausencia del grafo **no es pregunta bloqueante** — continúa con su conversación de clarificación

### Planner

- Exige que toda consulta de repositorio use la cadena completa
- **Antes de finalizar el plan**, inserta `## Evidencia verificable del grafo` en el artifact
- Incluye una entrada por cada hallazgo que **realmente provino de integración/local**
- Si el grafo no estuvo disponible o la CLI local devolvió `ok:false`, incluye la declaración de ausencia
- Comunica la degradación al runner/desarrollador usando la frase exacta al caer a búsqueda normal
- **Es el único que materializa evidencia Graphify en el plan**

## Exclusiones

Este skill **NO** define ni implementa:

- Consultas MCP internas
- Extracción de grafo
- Servidor, parser o adaptadores CLI
- Instalación/update de Graphify
- Persistencia de estado
- Generación de docs/media
- Ciclo background
- Consultas en `.worktrees/`
- Una interfaz local alternativa

Esas responsabilidades pertenecen a `plan-habilitar` y `plan-grafo`.

## GAPs conocidos

- **GAP 1 — Enforcement por diseño**: Si un agente no carga el skill o no sigue sus reglas, el sistema no lo detecta automáticamente. La consecuencia (evidencia fabricada o degradación omitida) solo se ve al final.
- **GAP 2 — Disponibilidad inferida**: El agente puede asumir que el grafo está disponible sin verificar el estado/`graphPath`. El protocolo Zero-Assumptions mitiga esto.

---

> **Nota**: Este skill debe cargarse después de `memory-protocol` y `zero-assumptions` para asegurar que las herramientas de consulta a Engram y el protocolo de verificación estén disponibles.
