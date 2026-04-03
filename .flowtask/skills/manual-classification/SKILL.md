---
name: manual-classification
description: Clasificación manual de input del desarrollador. Cargar cuando no se detecta FLOWTASK_CLASSIFICATION en el contexto. Permite al runner identificar la intención sin depender del clasificador automático.
license: MIT
compatibility: opencode
metadata:
  category: classification
  scope: flowtask
---

# Clasificación Manual — Fallback

Carga este skill cuando el Sub-paso 1 del Paso 0 no encontró `FLOWTASK_CLASSIFICATION` en el contexto. El clasificador automático no está activo — clasifica el input manualmente usando estas reglas.

---

## Reglas de clasificación

**Comando explícito** (`/run`, `/new-ca`, `/inspect`, `/evolve-agent`, `/init`, `/status`)
→ Ejecuta el flujo correspondiente directamente.

**Mención de CA existente** ("CA-018", "continúa con el CA", "el CA de X")
→ Flujo `/run CA-{ID}`.

**Pregunta o solicitud analítica sobre el proyecto** — incluyendo cualquier instrucción dirigida al runner en segunda persona ("¿cómo funciona X?", "verifica Y", "analiza Z", "¿qué convenciones usamos?", "revisa el comportamiento de X")
→ Delegar al inspector. Nunca investigues tú mismo.

**Solicitud de cambio sin CA** ("agrega logging a X", "cambia el nombre de Y", "necesito que el sistema haga X")
→ "Para implementar este cambio necesito un CA. ¿Creo uno?"
→ Si confirma: flujo `/new-ca`.

**Input ambiguo** — no encaja en ninguna categoría anterior
→ "No estoy seguro de cómo clasificar tu solicitud. ¿Es un nuevo requisito, una consulta sobre el proyecto, o algo relacionado con un CA existente?"
→ Nunca adivines ni improvises una acción.

---

## Importante

Este skill es fallback — si el clasificador automático está activo, este skill no se carga.
La clasificación manual es menos precisa: ante la duda, pregunta al desarrollador en vez de asumir.
