# PLAN DE IMPLEMENTACIÓN PARA CA-022

**CA:** CA-022  
**Requisito:** Modificar `/flowtask/install` para instalar FlowTask como aplicación unificada (core como código fuente + adaptador OpenCode vía npm link), actualizar documentación y persistir método en Engram  
**Tipo de intención:** Nueva funcionalidad  
**Complejidad:** Moderada  

---

## TL;DR

> **Resumen**: Modificar el script `flowtask install` para copiar el core (agents, skills) como código fuente, manejar el enlazado opcional del adaptador OpenCode vía npm link, actualizar el README.md y registrar el método en Engram.  
> **Entregables**: 
> - `.flowtask/bin/flowtask.js` modificado
> - README.md actualizado en el proyecto
> - Observación en Engram con topic_key `distribution/method`
> **Esfuerzo**: Short  
> **Paralelo**: NO (tareas secuenciales)  
> **Ruta crítica**: T1 → T2 → T3 → T4  

---

## Decisiones de diseño (CONFIRMADAS)

- [decisiones]: Mantener el core IDE-agnóstico copiando agents y skills como código fuente, mientras que el adaptador OpenCode es opcional y se enlaza vía npm link solo si existe el plugin — rationale: cumple con la visión de FlowTask como lógica de negocio reutilizable en múltiples frontends.
- [decisiones]: Usar `npm link` para el plugin solo si existe el directorio `.flowtask/plugins/flowtask-classifier` y contiene un `package.json` válido — rationale: evita errores cuando el plugin no está presente y permite que el core funcione independientemente.
- [decisiones]: Actualizar el README.md únicamente si el contenido actual difiere del nuevo contenido deseado — rationale: idempotencia y evitar escrituras innecesarias.
- [decisiones]: Guardar/actualizar la observación en Engram usando `topic_key: distribution/method` para permitir upsert y evitar duplicados — rationale: sigue las convenciones de Engram para decisiones evolutivas.
- [decisiones]: Si `npm link` falla, continuar con la instalación del core y registrar una advertencia — rationale: el core debe permanecer funcional para otros frontends incluso si falla el enlazado del adapter.

---

## Scope

**INCLUYE:**
- Modificación de `.flowtask/bin/flowtask.js` para implementar la lógica de instalación unificada.
- Actualización del `README.md` en la raíz del proyecto con las nuevas instrucciones.
- Guardado de la decisión de instalación en Engram.

**EXCLUYE:**
- Cambios en la estructura de directorios de FlowTask (agents, skills, plugins, etc.).
- Modificaciones a otros comandos de FlowTask (solo `/flowtask install`).
- Instalación de dependencias externas como OpenCode o Engram (asumido ya instalado).

---

## Capas afectadas

Evaluando el CA:
- [x] types/models: No aplica (no hay cambios en tipos)
- [x] data: No aplica
- [x] business: No aplica (la lógica de negocio está en los agents, pero se copian como código fuente, no se modifican)
- [ ] api/endpoints: No aplica
- [ ] tasks/workers: No aplica
- [x] config: Sí (README.md y potencialmente configuración de Engram, pero se maneja en el script)

---

## Skills a cargar (del proyecto)

Antes de implementar, consultar en Engram:

| Layer | Topic key |
|-------|-----------|
| Naming | `project/naming` |
| CLI patterns | `project/cli` |
| Documentation | `project/docs` |
| Engram usage | `project/engram` |

---

## Archivos a LEER primero

- `.flowtask/bin/flowtask.js` (actual)
- `README.md` (actual)
- `.flowtask/plugins/flowtask-classifier/package.json` (si existe)
- `.flowtask/agents/` (estructura)
- `.flowtask/skills/` (estructura)

---

## Artefactos a crear o modificar

Ejecutar en este orden:

| # | Operación | Descripción | Ruta | Notas |
|---|-----------|-------------|------|-------|
| 1 | MODIFICAR | Actualizar la función `install()` en `flowtask.js` para: copiar agents y skills, manejar plugin vía npm link, actualizar README, guardar en Engram | `.flowtask/bin/flowtask.js` | Incluir manejo de errores e idempotencia |
| 2 | MODIFICAR | Actualizar el README.md con instrucciones de instalación unificada | `README.md` | Solo si el contenido difiere |
| 3 | GUARDAR_EN_ENGRAM | Crear/actualizar observación en Engram con topic_key `distribution/method` | Engram (topic_key: distribution/method) | Upsert usando topic_key |

---

## Propiedades y configuración

No se requieren cambios en archivos de configuración más allá del README y Engram.

---

## Convenciones a aplicar

- Nombrado: Usar `camelCase` para variables y funciones en JavaScript (según existente en flowtask.js)
- Inyección de dependencias: No aplica (script de CLI)
- Manejo de errores: Usar try/catch para operaciones síncronas y verificar resultados de `spawnSync`
- Logging: Usar las funciones existentes `logSuccess`, `logError`, `logWarn`, `logInfo` para consistencia
- Engram: Usar `mem_save` con `topic_key` para upsert, estructura de contenido con **What**, **Why**, **Where**, **Learned**

---

## Criterios de aceptación del plan

Para cada tarea:

- [ ] La tarea tiene descripción actionable y específica
- [ ] La tarea menciona archivos concretos a modificar
- [ ] La tarea incluye consideraciones de idempotencia y manejo de errores
- [ ] La tarea tiene criterios de verificación claros

---

## QA Scenarios por tarea

### Tarea 1: Modificar flowtask.js

**Happy Path:**
- Herramienta: Node.js
- Pasos: 
  1. Ejecutar `node .flowtask/bin/flowtask.js install` en un proyecto de prueba vacío
  2. Verificar que se copie `.flowtask/agents/` → `.flowtask/agents/` en el proyecto
  3. Verificar que se copie `.flowtask/skills/` → `.opencode/skills/` en el proyecto
  4. Verificar que si existe `.flowtask/plugins/flowtask-classifier/` con package.json válido, se ejecute `npm link` en el plugin y luego `npm link <nombre>` en el proyecto
  5. Verificar que el README.md se actualice con el nuevo contenido
  6. Verificar que se cree/actualice la observación en Engram con topic_key `distribution/method`
- Esperado: Todas las operaciones exitosas, mensaje de instalación completa, sin errores

**Failure Case (plugin missing):**
- Herramienta: Node.js
- Pasos:
  1. Renombrar temporalmente `.flowtask/plugins/flowtask-classifier` a `.flowtask/plugins/flowtask-classifier-backup`
  2. Ejecutar `node .flowtask/bin/flowtask.js install` en un proyecto de prueba
  3. Verificar que la instalación continúe sin error
  4. Verificar que se copien agents y skills
  5. Verificar que el README.md se actualice
  6. Verificar que se guarde la observación en Engram
- Esperado: Instalación del core exitoso, advertencia sobre plugin faltante pero no falla

**Failure Case (npm link falla):**
- Herramienta: Node.js
- Pasos:
  1. En un proyecto donde el plugin existe pero se simula un fallo de npm link (ej. desconectando internet o revocando permisos)
  2. Ejecutar `node .flowtask/bin/flowtask.js install`
  3. Verificar que se copien agents y skills
  4. Verificar que se actualice el README.md
  5. Verificar que se guarde la observación en Engram
  6. Verificar que se registre un error pero la instalación continúe
- Esperado: Core instalado, advertencia de fallo en npm link, instalación continúa

### Tarea 2: Actualizar README.md

**Happy Path:**
- Herramienta: bash
- Pasos:
  1. Copiar el README.md actual a un backup
  2. Ejecutar el script modificado de flowtask install
  3. Comparar el README.md resultante con el contenido esperado
- Esperado: El README.md contiene las nuevas instrucciones de instalación unificada y mantiene las secciones relevantes existentes

**Failure Case (escritura fallida):**
- Herramienta: bash
- Pasos:
  1. Establecer permisos de solo lectura en README.md
  2. Ejecutar flowtask install
  3. Verificar que el script registre un warning pero no falle
- Esperado: Advertencia de que no se pudo actualizar README, pero la instalación continúa

### Tarea 3: Guardar en Engram

**Happy Path:**
- Herramienta: Engram CLI
- Pasos:
  1. Ejecutar flowtask install en un proyecto limpio
  2. Ejecutar `engram get --topic distribution/method`
  3. Verificar que la observación exista y contenga los campos What, Why, Where, Learned
- Esperado: Observación encontrada con contenido correcto

**Failure Case (Engram no disponible):**
- Herramienta: Engram CLI
- Pasos:
  1. Detener el servidor de Engram (si se ejecuta localmente)
  2. Ejecutar flowtask install
  3. Verificar que el script registre un warning pero continúe
- Esperado: Advertencia de que no se pudo guardar en Engram, pero la instalación del core continúa

---

## Verificación final

Antes de considerar el plan completo, verificar:

□ ¿El plan tiene ZERO decisiones para el implementador?  
□ ¿Todos los archivos mencionados existen o son "buscar en proyecto"?  
□ ¿Cada tarea tiene referencias a archivos?  
□ ¿Cada tarea tiene criterios de aceptación ejecutables?  
□ ¿Cada tarea tiene QA scenarios (happy + failure)?  
□ ¿Las dependencias están en orden correcto?  
□ ¿Las decisiones técnicas están confirmadas o marcadas como pendientes?  

✓ Plan CA-022 guardado en Engram (topic_key: plan/CA-022)  
✓ Estado: plan_generated  
✓ 3 tareas principales  
✓ Listo para ejecución.