# FlowTask Classifier Plugin

Plugin de OpenCode que clasifica automaticamente el input del usuario en categorias de intencion para el workflow de FlowTask.

## Descripcion

El plugin `flowtask-classifier` captura los mensajes del usuario y los clasifica en una de las 5 categorias predefinidas. Esta clasificacion se inyecta en el contexto del LLM como un mensaje system con el formato `[FLOWTASK_CLASSIFICATION: <categoria>]`, permitiendo que el runner tome decisiones basadas en el tipo de intencion detectada.

## Compilacion

```bash
npm run build
```

Este comando genera los archivos compilados en el directorio `dist/`:

- `dist/index.js` — Entry point del plugin
- `dist/classifier.js` — Logica de clasificacion
- `dist/index.d.ts` — Tipos TypeScript para index
- `dist/classifier.d.ts` — Tipos TypeScript para classifier

## Verificacion de actividad

Para confirmar que el plugin esta activo, revisar el system prompt del runner en `.flowtask/agents/runner.md`. El plugin deberia aparecer registrado en la seccion de plugins.

Tambien puedes verificar el comportamiento: cuando el usuario envia un input, deberia aparecer un mensaje system con la classificacion en la traza de prompts.

## Categorias de clasificacion

### 1. COMMAND

Comandos directos de FlowTask — prioridad maxima.

| Comando | Descripcion | Ejemplo |
|---------|-------------|---------|
| `/run CA-{ID}` | Ejecutar workflow para un caso de uso | `/run CA-42` |
| `/inspect` | Explorar el proyecto sin crear CA | `/inspect` |
| `/new-ca` | Crear un nuevo caso de uso | `/new-ca CA-123` |
| `/evolve-agent` | Evolucionar un agente FlowTask | `/evolve-agent planner` |
| `/init` | Inicializar FlowTask en el proyecto | `/init` |
| `/status` | Mostrar estado de FlowTask y Engram | `/status` |

### 2. CA_MENSION

Referencia a un caso de uso especifico mediante su ID.

- Detecta el patron `CA-\d+` en cualquier posicion del input
- Extrae el ID del CA para su uso en el contexto

**Ejemplos:**

- `"Revisa CA-123"` → `CA_MENTION:123`
- `"Que hiciste en CA-onboarder-agent?"` → `CA_MENTION:onboarder-agent`
- `"hola CA-999 mundo"` → `CA_MENTION:999`

### 3. PROJECT_QUESTION

Preguntas sobre el proyecto. Keywords detectadas (bilingue ES/EN):

- Espanyol: `¿`, `qué`, `como`, `cómo`, `por qué`, `para qué`, `cuál`, `cual`, `dónde`, `donde`
- Ingles: `why`, `what`, `how`, `explain`, `tell me`, `describe`

**Ejemplos:**

- `"¿Qué hace este archivo?"` → `PROJECT_QUESTION`
- `"How does the auth work?"` → `PROJECT_QUESTION`
- `"Explain the architecture"` → `PROJECT_QUESTION`

### 4. CHANGE_REQUEST

Solicitudes de cambio o accion sobre el proyecto. Keywords detectadas (bilingue ES/EN):

- Espanyol: `agrega`, `añade`, `cambia`, `crea`, `elimina`, `borra`, `modifica`, `mejora`, `corrije`, `implementa`
- Ingles: `add`, `fix`, `update`, `refactor`, `remove`, `delete`, `optimize`, `change`, `create`, `implement`

**Ejemplos:**

- `"agrega un endpoint nuevo"` → `CHANGE_REQUEST`
- `"fix the auth bug"` → `CHANGE_REQUEST`
- `"create a new service"` → `CHANGE_REQUEST`

### 5. Fallback

Si el input no coincide con ninguna categoria, retorna `null` (ambiguo). El runner decide como proceder en este caso.

**Ejemplos:**

- `"hola mundo"` → `null`
- `""` (vacio) → `null`

## Guia de extension

Para agregar nuevos patrones o keywords, editar `src/classifier.ts`:

1. **Agregar nuevos comandos**: Editar el array `COMMAND_PATTERNS` con un nuevo RegExp y label.

2. **Agregar nuevas keywords de pregunta**: Anadir al array `QUESTION_KEYWORDS`.

3. **Agregar nuevos verbos de accion**: Anadir al array `CHANGE_KEYWORDS`.

4. **Cambiar la logica de clasificacion**: Modificar la funcion `classify()` segun sea necesario.

Despues de modificar, ejecutar `npm run build` para compilar y actualizar `dist/`.

## Principios de diseño

- **Clasificacion conservadora**: Si hay duda, retorna `null` para evitar分類aciones incorrectas.
- **Soporte bilingue**: Keywords en espanyol e ingles.
- **Sin dependencias externas**: Utility pura, solo depende del SDK de OpenCode.
- **Orden de prioridad estricto**: COMMAND > CA_MENTION > PROJECT_QUESTION > CHANGE_REQUEST > Fallback