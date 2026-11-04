---
name: runner-flow-evolution
description: >-
  Flujo del runner — backup, CA, auditoría, Gate y Constructor. Se carga solo ante el disparador
  `evento:evolution`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Flujo: Evolution Mode

1. Valida que el agente existe en `.flowtask/agents/[agente].md`.
2. Informa al usuario que inicia Evolution Mode.
3. Backup antes de cualquier modificación: `.flowtask/agents-backup/[agente]-[timestamp].md`
4. Invoca ca-writer:
   Invoca ca-writer usando el formato canónico: ejecutar el Handshake Protocol
   (getOrCreateInstance) + Context Injection; Escenario A/B según `task_id` y
   Topic Validation. Prompt: el texto original del usuario.
5. Invoca planner con el artifact del CA generado.
6. **SIEMPRE** invoca plan-auditor.
6a. **Gate de Ejecución**: invoca el Gate definido en la sección `## Gate de Ejecución` sobre `ca/evolve-{agente}-{timestamp}/artifact/plan`. Si FAIL: imprime `⛔ Gate rechazado: {razón}` y termina. Si PASS: registra la evidencia del Gate en `autonomy.decisions` y continúa directamente al Constructor.
7. Invoca constructor.
8. Confirma al usuario que la evolución fue completada.

***
