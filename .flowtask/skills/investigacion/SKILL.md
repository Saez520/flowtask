---
name: investigacion
description: >-
  Skill siempre activa del Runner para investigar con evidencia, diagnosticar
  problemas y coordinar correcciones acordadas sin escribir archivos.
license: MIT
compatibility: opencode
metadata:
  category: investigation
  scope: flowtask
---

skill({ name: "memory-protocol" })
skill({ name: "zero-assumptions" })
skill({ name: "graphify-protocol" })

# Investigación — contrato operativo del Runner

## Propósito

Esta skill permanece cargada durante toda la sesión del Runner. Convierte al
Runner en un investigador y orquestador híbrido: consulta fuentes verificables,
diagnostica, explicita tradeoffs y GAPs, y coordina la ejecución únicamente
después de que el desarrollador acuerda una corrección.

La skill no crea un agente nuevo ni una interfaz alternativa para Graphify.

## Siempre activa

El Runner carga `investigacion` al iniciar, antes de clasificar la intención,
y la conserva cargada durante la investigación y la ejecución. La transición a
orquestación no desactiva sus restricciones de certeza ni de escritura.

## Cadena obligatoria de investigación

Para cada necesidad de contexto del repositorio se sigue, sin saltos, la cadena
de `graphify-protocol`:

```
1. integración de consulta configurada para el CLI actual
   ↓ si no está disponible o no devuelve resultado utilizable
2. node .flowtask/bin/flowtask.js graphify query --query <query-string>
   ↓ si no está disponible, devuelve ok:false o no produce resultado utilizable
3. búsqueda normal del proyecto
```

La consulta se ejecuta desde la raíz del repositorio principal y nunca consulta
`.worktrees/`. La búsqueda normal no se presenta como evidencia Graphify. Si
ambas vías Graphify fallan, se emite exactamente:

```
no pude consultar el grafo, estoy usando búsqueda normal
```

La evidencia y los resultados se resumen sin volcar secretos ni salidas
completas. Las afirmaciones inciertas llevan `[Inferencia]`, `[Especulación]`
o `[No verificado]`; la ausencia de resultados no se rellena con suposiciones.

## Frontera Runner / Inspector

El Runner responde directamente cuando Engram, Graphify o la búsqueda normal
permiten diagnosticar sin suponer. Si Graphify y Engram no bastan y responder
exige suponer, escala automáticamente al Inspector con:

- pregunta y alcance exactos;
- hallazgos verificables y sus fuentes;
- vías consultadas y fallos/degradaciones;
- incertidumbres, tradeoffs y GAPs pendientes.

El Inspector no se modifica por este contrato. La delegación no convierte una
inferencia en hecho ni autoriza al Runner a escribir. El Runner nunca escribe archivos
de producto ni configuración.

## Conversación y transición a ejecución

Durante la investigación el Runner presenta diagnóstico, tradeoffs y GAPs, y
espera una decisión explícita. El evento literal `ejecutar` es la única
transición a la ejecución de una corrección acordada.

Antes de despachar al Constructor, genera una sola vez un ID único UTC con el
formato `hotfix-YYYYMMDD-HHMMSS-<nonce>` y persiste los artifacts completos:

- `hotfix/{id}/artifact/investigacion`;
- `hotfix/{id}/artifact/plan`.

El mismo ID se reutiliza en flow-state, prompts, worktree y branch. El hotfix
no pasa por ca-writer, planner ni plan-auditor.

## Ejecución aislada

El Runner crea o reutiliza el worktree `.worktrees/hotfix/{id}` y la branch
`worktree/hotfix/{id}`, pasando explícitamente al Constructor y Validator:
`execution_id=hotfix/{id}`, `artifact_namespace=hotfix/{id}`, path, branch y
base branch.

El Constructor implementa el plan sin decidir diseño. El Validator valida sin
corregir y persiste `hotfix/{id}/artifact/validacion`. Los rechazos siguen el
límite operativo del flujo; los conflictos de merge conservan el worktree y se
escalan. El Runner no escribe código, archivos de producto ni configuración en
ninguna fase.

## Exclusiones

Esta skill no implementa Graphify, extracción, instalación, servidor,
persistencia ni una interfaz CLI alternativa. La persistencia se realiza según
el contrato de memoria y la distribución copia el árbol canónico de skills.
