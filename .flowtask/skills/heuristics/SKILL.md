---
name: heuristics
description: >-
  Protocolos para que los agentes de FlowTask aprendan, almacenen, carguen
  y detecten heurísticas del desarrollador. Define el contrato para pares
  clave→valor en dos niveles: personal (cross-proyecto) y project (específico).
  Cargar cuando el agente necesite guardar, cargar o proponer heurísticas.
---

# Heuristics Skill — Memoria idiomática del desarrollador

## Propósito y Resumen

Este skill define los **protocolos para que los agentes de FlowTask aprendan y recuerden cómo se expresa el desarrollador**: atajos, apodos, frases idiomáticas que usa para referirse a elementos del proyecto. Los agentes cargan esta skill cuando necesitan guardar, cargar o proponer heurísticas.

Las heurísticas son pares simples `clave → valor` almacenados en dos niveles de scope:

| Nivel | Scope Engram | Propósito | Ejemplo |
|-------|-------------|-----------|---------|
| **Personal** | `personal` | Expresiones del desarrollador que aplican a todos sus proyectos | `"dale gas"` → `ejecutá sin preguntar` |
| **Proyecto** | `project` | Expresiones específicas de un proyecto concreto | `"el script"` → `scripts/test.sh` |

**Regla de override**: si la misma key existe en ambos niveles para un mismo proyecto, **gana la de proyecto** (la más específica).

> **Nota sobre el alcance**: Esta skill define QUÉ hacer (contratos, pasos, formatos). No implementa funciones ejecutables — los agentes ejecutan los pasos manualmente usando las herramientas disponibles (`mem_save`, `mem_search`, su propio LLM para la fase 2). Esto es consistente con todas las skills de FlowTask: son protocolos inyectados en contexto, no bibliotecas de código.

---

## Normalización de Keys (`heuristics_normalize`)

Antes de almacenar o buscar una heurística, la key debe normalizarse para evitar duplicados por variaciones tipográficas.

### Reglas

1. Convertir a **minúsculas**.
2. Eliminar **tildes y acentos** (á→a, é→e, í→i, ó→o, ú→u, ü→u, ñ→n).
3. Reemplazar **espacios y guiones bajos** por guiones (`-`).
4. Colapsar **guiones múltiples** en uno solo.
5. Eliminar **caracteres especiales** excepto guiones y alfanuméricos (a-z, 0-9, -).

### Función conceptual

```
normalize_key(raw_key: string) → normalized_key: string
```

### Ejemplos

| Raw key | Normalized key |
|---------|---------------|
| `"Dale gas"` | `"dale-gas"` |
| `"el script"` | `"el-script"` |
| `"correr_pruebas"` | `"correr-pruebas"` |
| `"la  config!!"` | `"la-config"` |
| `"Camilo's script"` | `"camilos-script"` |
| `"CORRER -- TODO"` | `"correr-todo"` |
| `"acción rápida"` | `"accion-rapida"` |

---

## Almacenamiento (`heuristics_save`)

Guarda una heurística en Engram como par clave→valor en el scope indicado.

### Protocolo

```
heuristics_save(key: string, value: string, scope: "project" | "personal")
```

### Pasos

1. **Normalizar key**: `normalized = normalize_key(key)`.
2. **Construir topic_key**: `"{scope}/heuristics/{normalized}"`.
   - Scope `project` → topic_key: `project/heuristics/{normalized}`
   - Scope `personal` → topic_key: `personal/heuristics/{normalized}`
3. **Guardar con `mem_save`**:
   ```
   mem_save(
     type: "pattern",
     scope: "{scope}",
     topic_key: "{scope}/heuristics/{normalized}",
     title: "Heuristic: {key}",
     content:
       What: Heurística `{key}` → `{value}` en scope `{scope}`
       Why: Enseñanza explícita del desarrollador O detectada por co-ocurrencia
       Where: scope `{scope}` — visible en {todos los proyectos | este proyecto}
       Key: {key}
       Normalized: {normalized}
       Value: {value}
       Tag: [heuristic]
   )
   ```

4. **Tag `[heuristic]`**: Incluido en el content para facilitar búsquedas por prefijo con `mem_search`. La búsqueda `mem_search(query: "heuristic")` encontrará todas las heurísticas gracias a este tag y al title con formato `Heuristic: {key}`.

### Comportamiento de upsert

Misma key normalizada en el mismo scope = upsert automático (último escribe gana). Engram maneja el upsert vía `topic_key` — si ya existe una observación con el mismo `topic_key`, se actualiza.

---

## Carga (`heuristics_load`)

Carga todas las heurísticas del proyecto actual, combinando las personales y las del proyecto con la regla de override.

### Protocolo

```
heuristics_load(project_name: string) → Map<string, { original_key, value, scope }>
```

### Pasos

1. **Query 1 — Proyecto**:
   ```
   mem_search(query: "heuristic", scope: "project")
   ```
   Busca todas las observaciones con tag `[heuristic]` y title `Heuristic: *` en el scope del proyecto actual.

2. **Query 2 — Personal**:
   ```
   mem_search(query: "heuristic", scope: "personal")
   ```
   Busca todas las heurísticas personales (cross-proyecto).

3. **Parsear resultados**: Extraer `key` y `value` del content de cada observación. Usar `Normalized` del content como clave del diccionario.

4. **Merge con override**:
   - Insertar primero **todas las heurísticas personales** en el diccionario.
   - Luego **sobrescribir con las de proyecto** (proyecto gana).
   - Resultado: diccionario `{ normalized_key: { original_key, value, scope } }`.

### Formato de retorno para inyección en contexto

Las heurísticas cargadas se formatean así para ser inyectadas en el bloque `<project_context>`:

```
## Heurísticas cargadas (N total)
- `{original_key}` → `{value}` [proyecto]
- `{original_key}` → `{value}` [personal]
```

Si no hay heurísticas, se omite la sección o se muestra `(ninguna)`.

### Degradación ante fallo de Engram

Si `mem_search` falla (Engram no disponible): retornar mapa vacío `{}`. **No bloquear al agente**. Opcionalmente registrar en `.flowtask/.temp/` para sincronización futura (protocolo CA-005).

---

## Detección híbrida (`heuristics_detect`)

Protocolo para que los agentes detecten patrones en la conversación y propongan nuevas heurísticas. El mecanismo tiene **dos fases**: co-ocurrencia por contexto (barata, sin LLM) y LLM como juez de equivalencia (solo para candidatos que superan la fase 1).

---

### Fase 1 — Co-ocurrencia por contexto (sin LLM)

El agente rastrea frases o términos que aparecen en el mismo contexto operativo (mismo archivo, misma acción como "ejecutar"/"correr"/"testear", mismo comando).

#### Tracking data structure (en memoria, no persistido)

```
{
  phrase: {
    entities: Set<entity>,           // entidades con las que co-ocurre
    count_per_entity: Map<entity, int> // conteo por entidad
  }
}
```

#### Algoritmo

1. Cuando el agente observa que una frase candidata aparece en el mismo contexto que una **entidad concreta** (archivo, ruta, comando, valor), incrementa el contador para ese par `(frase, entidad)`.
2. Cuando una frase co-ocurre **≥3 veces** con la misma entidad, se marca como **candidata** para la fase 2.
3. Una vez marcada, se **resetea el contador** para esa frase (evita re-propuestas en la misma sesión si el desarrollador rechaza).

#### Ejemplo

El desarrollador dice "el script" 3 veces en contexto donde también se menciona `scripts/test.sh` → candidata para fase 2.

---

### Fase 2 — LLM como juez de equivalencia (solo para candidatas)

Para cada candidata detectada en fase 1, el agente consulta al LLM para evaluar si la frase candidata es equivalente a una heurística existente o si es nueva.

#### Prompt para el LLM

```
Evalúa si la frase '{candidate_phrase}' usada en el contexto de '{entity}' 
es equivalente a alguna heurística existente. 

Heurísticas existentes (proyecto):
{project_heuristics}

Heurísticas existentes (personales):
{personal_heuristics}

Si es equivalente, indica cuál. Si no, determina si es una heurística nueva 
que merece ser propuesta. Responde con un JSON:

{
  "action": "alias" | "new" | "ignore",
  "target_heuristic": string | null,
  "confidence": 0-1
}
```

#### Interpretación del resultado

| Condición | Acción |
|-----------|--------|
| `action == "alias"` y `confidence ≥ 0.7` | Proponer alias al desarrollador |
| `action == "new"` y `confidence ≥ 0.7` | Proponer creación de nueva heurística |
| `confidence < 0.7` o `action == "ignore"` | Descartar silenciosamente |
| LLM no disponible (error/timeout) | Descartar la candidata (falso negativo aceptado) |

---

### Propuesta al desarrollador

**NUNCA guardar automáticamente. SIEMPRE preguntar antes.**

#### Formato para alias

> *"He notado que usás '{phrase}' en el mismo contexto que '{existing_key}' (que ya sé que es `{existing_value}`). ¿Querés que recuerde '{phrase}' como equivalente?"*

#### Formato para heurística nueva

> *"He notado que decís '{phrase}' frecuentemente refiriéndote a `{entity}`. ¿Querés que lo recuerde como heurística para este proyecto?"*

#### Si el desarrollador responde afirmativamente

Ejecutar `heuristics_save(phrase, entity, scope)`:
- Para alias: usar el mismo scope de la heurística existente.
- Para nuevas: scope `project` por defecto.

#### Si el desarrollador rechaza

Registrar la frase como **rechazada** en memoria de sesión (ver siguiente sección).

---

### Tracking de rechazos

- Mantener un `Set rejected_phrases` en memoria (scope: sesión actual).
- **No se persiste** — en la próxima sesión se reinicia.
- Si el desarrollador rechaza una propuesta, agregar la frase al set.
- Si una candidata está en `rejected_phrases`, no volver a proponerla en la misma sesión aunque vuelva a co-ocurrir ≥3 veces.
- **Tradeoff aceptado**: posible re-propuesta en sesiones futuras. El umbral ≥3 ya minimiza falsos positivos.

---

## Enseñanza explícita (`heuristics_teach`)

El desarrollador puede indicar explícitamente que guarde una heurística sin esperar a que el sistema la detecte.

### Expresiones que debe reconocer el agente

- *"Acordate de que cuando digo X me refiero a Y"*
- *"Guardá esto como heurística: X → Y en este proyecto"*
- *"Esto aplicalo a todos mis proyectos: X → Y"*
- *"Recordá: X significa Y"*
- *"Cuando diga X, es Y"*
- *"X = Y para este proyecto"*

### Determinación del scope

| Expresión del desarrollador | Scope |
|----------------------------|-------|
| "todos mis proyectos", "siempre", "en cualquier proyecto" | `personal` |
| "en este proyecto", "acá", "para este" | `project` |
| Sin indicación explícita | `project` (default) |

### Protocolo

1. Detectar si el mensaje del desarrollador coincide con alguno de los patrones de enseñanza.
2. Extraer `X` (key) e `Y` (value) del mensaje.
3. Determinar el scope según las reglas de la tabla.
4. Ejecutar `heuristics_save(key=X, value=Y, scope=determinado)`.
5. Confirmar al desarrollador:
   > *"✓ Heurística guardada: '{X}' → '{Y}' [{scope}]. La recordaré en {alcance}."*

Donde `{alcance}` es:
- Para `project`: "este proyecto"
- Para `personal`: "todos tus proyectos"

---

## Manejo de errores y degradación

### Engram no disponible durante `heuristics_load`

- Retornar mapa vacío `{}`.
- No bloquear al agente.
- Opcionalmente loguear en `.flowtask/.temp/` (protocolo CA-005).

### Engram no disponible durante `heuristics_save`

- Guardar en `.flowtask/.temp/operation-{timestamp}.json` con el payload completo.
- Notificar al desarrollador: *"⚠ Engram no disponible. La heurística se guardó localmente y se sincronizará cuando Engram esté disponible."*

### `mem_search` retorna error

- Tratar como "sin resultados" (no propagar error).
- El agente continúa normalmente.

### LLM no disponible durante Fase 2

- Descartar la candidata silenciosamente.
- No proponer nada al desarrollador.
- **Falso negativo aceptado**: es mejor no preguntar que preguntar sin criterio.

---

## Limitaciones conocidas

### GAPs y tradeoffs (del CA-012)

- **Obsolescencia automática**: No hay mecanismo para detectar heurísticas que dejaron de ser válidas (script renombrado, ruta movida). Si una heurística está rota, el agente preguntará al desarrollador — es manejable en la práctica.

- **Heurísticas compartidas en equipo**: `personal` es individual por definición. No hay mecanismo para compartir heurísticas entre varios desarrolladores del mismo proyecto. Compartir requeriría otro mecanismo (archivo en repo, etc.).

- **Vectorización diferida**: La detección por similitud vectorial (sin depender de llamadas LLM) está fuera de scope para V1. Solo se justificaría con cientos de heurísticas donde la latencia del LLM sea un problema. Para esta V1, el LLM como juez es suficiente.

### Dependencias

- **Engram**: La skill depende de Engram para persistencia y carga. Si Engram no está disponible, el sistema funciona degradado (sin heurísticas) pero no se bloquea.
- **LLM**: La Fase 2 de detección requiere acceso al LLM del agente. Si no está disponible, se descartan las candidatas silenciosamente.

### Scope del mecanismo

- Esta skill define el mecanismo de almacenamiento + carga + detección + enseñanza.
- **No modifica agentes individuales** para que "usen" heurísticas — esa integración es incremental y queda a criterio de cada agente.
- La carga automática se centraliza en `handshake-protocol` (Context Injection), evitando modificar N agentes.
