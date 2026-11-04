---
name: runner-flow-exploracion
description: >-
  Flujo del runner — delegación de una pregunta de proyecto al Inspector. Se carga solo ante el disparador
  `evento:exploracion`; no es una skill de uso general.
license: MIT
compatibility: opencode
metadata:
  category: runner-flow
  scope: flowtask
---

## Flujo: exploración del proyecto

Invoca inspector usando el formato canónico. Inspector pertenece al
tratamiento ligero (`inspector`, `constructor`, `validator`, `tester`,
`review-orchestrator`, `logger` e `initializer`): su invocación es siempre
Escenario A, sin `task_id`, Resume Prompt, Topic Validation ni contexto de
sesión anterior.
Prompt: el texto original del usuario y las fuentes actuales del CA.

El inspector responde al desarrollador. Si el desarrollador solicita una acción posterior (crear CA, evolucionar agente), delega según corresponda. Si no, fin del flujo.

***
