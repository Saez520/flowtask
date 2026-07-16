# PLAN DE IMPLEMENTACIÓN CA-023

## TL;DR

> **Resumen**: Crear documentación README.md para el plugin flowtask-classifier que incluya descripción, instrucciones de compilación, categorías de clasificación con ejemplos y guía de extensión.
> **Entregables**: Archivo `.flowtask/plugins/flowtask-classifier/README.md`
> **Esfuerzo**: Quick
> **Paralelo**: NO (tarea única de documentación)
> **Ruta crítica**: Crear README.md → Verificar criterios de aceptación

---

## Decisiones de diseño (CONFIRMADAS)

- [Estructura del README]: Encabezado → Descripción → Compilación → Verificación → Categorías → Extensión — Rationale: Estándar de documentación de plugins OpenCode.
- [Categorías a documentar]: Las 5 categorías del classifier.ts más los sub-tipos de COMMAND — Rationale: Criterios de aceptación específicos del CA.
- [Ejemplos por categoría]: Incluir al menos un ejemplo por cada categoría y sub-tipo de comando — Rationale: Facilitar comprensión del plugin.

---

## Scope

**INCLUYE:**

- Archivo README.md en la raíz del plugin
- Descripción del propósito del plugin
- Instrucciones de compilación (npm run build)
- Verificación de actividad del plugin
- Las 5 categorías de clasificación con ejemplos concretos
- Guía de extensión indicando src/classifier.ts

**EXCLUYE:**

- Código adicional (el plugin ya está implementado en CA-022)
- Tests (no aplica para documentación)
- Modificación de otros archivos del plugin

---

## Capas afectadas

- [ ] types/models
- [ ] data
- [ ] business
- [ ] api/endpoints
- [ ] tasks/workers
- [ ] config
- [x] **docs** — Documentación README.md

---

## Archivos a LEER primero

| Archivo | Propósito |
|---------|-----------|
| `src/classifier.ts` | Referencia para las 5 categorías y sub-tipos de comandos |
| `package.json` | Verificar scripts de build disponibles |

---

## Artefactos a crear o modificar

| # | Operación | Descripción | Ruta | Notas |
|---|-----------|-------------|------|-------|
| 1 | CREAR | README.md con documentación completa del plugin | `.flowtask/plugins/flowtask-classifier/README.md` | Basado en classifier.ts y criterios de aceptación |

---

## Propiedades y configuración

No aplica — es documentación pura.

---

## Convenciones a aplicar

- **Nombrado**: No aplica
- **Inyección**: No aplica
- **Transacciones**: No aplica
- **Manejo de errores**: No aplica
- **Logging**: No aplica

---

## Criterios de aceptación del plan

- [x] La tarea tiene descripción actionables (no vaga)
- [x] La tarea tiene referencias a archivos existentes (classifier.ts, package.json)
- [x] La tarea tiene criterios de aceptación executables (verificables leyendo el README)
- [x] La tarea tiene QA scenarios (happy path + failure)

---

## QA Scenarios

### Tarea 1: Crear README.md

**Happy Path:**

- Herramienta: read (verificar archivo creado)
- Pasos: Crear archivo README.md con todo el contenido especificado
- Esperado: Archivo existe en `.flowtask/plugins/flowtask-classifier/README.md` con todas las secciones requeridas

**Verificación de criterios específicos:**

- [ ] Archivo existe en la raíz del plugin
- [ ] Las 5 categorías están documentadas: COMMAND (/run, /inspect, /new-ca, /evolve-agent, /init, /status), CA_MENTION, PROJECT_QUESTION, CHANGE_REQUEST, fallback (null)
- [ ] Guía de extensión indica editar `src/classifier.ts`
- [ ] Instrucciones de compilación muestran `npm run build`

---

## Verificación final

```
□ ¿El plan tiene ZERO decisiones para el implementador?
□ ¿Todos los archivos mencionados existen o son "buscar en proyecto"?
□ ¿Cada tarea tiene referencias a archivos?
□ ¿Cada tarea tiene criterios de aceptación executables?
□ ¿Cada tarea tiene QA scenarios (happy + failure)?
□ ¿Las dependencias están en orden correcto?
□ ¿Las decisiones técnicas están confirmadas o marcadas como pendientes?
```

---

## Self-Review: Gap Classification

| Tipo | Qué hacer |
|------|-----------|
| **CRÍTICO** | Ninguno — el requisito está claro |
| **MENOR** | Ninguno |
| **AMBIGUO** | Ninguno |

---

## Después de guardar

Plan guardado y listo para ejecución. Al ser una tarea simple de documentación (≤5 tareas), no se invoca Plan-Auditor.

---

## NOTAS ADICIONALES PARA EL CONSTRUCTOR

El README.md debe incluir las siguientes secciones exactamente:

1. **Descripción del plugin**: Breve explicación de que el plugin clasifica automáticamente el input del usuario en categorías de intención para el workflow de FlowTask.

2. **Instrucciones de compilación**: Sección con el comando `npm run build` y explicación de que genera los archivos en `dist/`.

3. **Verificación de actividad**: Cómo verificar que el plugin está activo (probablemente verificando que está registrado en opencode.json o comparable).

4. **Las 5 categorías de clasificación** (con ejemplos):
   - **COMMAND** (con sub-tipos):
     - `/run CA-{ID}` — ejecutar workflow
     - `/inspect` — explorar proyecto
     - `/new-ca` — crear nuevo caso
     - `/evolve-agent` — evolucionar agente
     - `/init` — inicializar FlowTask
     - `/status` — mostrar estado
   - **CA_MENTION** — referencia a CA específico (ej: "Revisa CA-123")
   - **PROJECT_QUESTION** — pregunta sobre el proyecto (ej: "¿Cómo funciona esto?")
   - **CHANGE_REQUEST** — solicitud de cambio (ej: "agrega un endpoint")
   - **fallback (null)** — input ambiguo que no clasifica

5. **Guía de extensión**: Explicar que para agregar/modificar categorías se debe editar `src/classifier.ts`.
