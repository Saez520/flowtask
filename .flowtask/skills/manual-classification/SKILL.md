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

**Mención de CA existente** ("CA-search-integration", "continúa con el CA", "el CA de X")
→ Flujo `/run CA-{ID}`.

**Pregunta o solicitud analítica sobre el proyecto** — preguntas sobre arquitectura, código, patrones, convenciones del proyecto ("¿cómo funciona X?", "¿qué convenciones usamos?", "¿dónde está definido Y?")
→ Delegar al inspector. El runner no explora el código directamente para responder estas preguntas.

**Nota**: instrucciones dirigidas al runner en segunda persona que pertenecen a su dominio (routing, clasificación, diagnóstico de orquestación, coordinación de CAs, mantenimiento de flujos) NO se delegan — el runner las resuelve directamente. Ver la sección "Dominio del runner" en runner.md.

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
