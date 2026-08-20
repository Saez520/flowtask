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
   ↓ si no está disponible, devuelve ok:false, está vacío o no produce
     referencias utilizables
3. escalar automáticamente al Inspector
```

La consulta se ejecuta desde la raíz del repositorio principal y nunca consulta
`.worktrees/`. Ante cualquier resultado no utilizable de la primera vía Graphify
aplicable —incluidos resultado vacío, integración o CLI no disponibles, `ok:false`,
exit code `1` o ausencia de referencias utilizables— se detiene la cadena y se
emite exactamente:

```
no pude obtener referencias utilizables del grafo, escalando al Inspector
```

La evidencia y los resultados se resumen sin volcar secretos ni salidas
completas. Las afirmaciones inciertas llevan `[Inferencia]`, `[Especulación]`
o `[No verificado]`; la ausencia de resultados no se rellena con suposiciones.

## Frontera Runner / Inspector

El Runner responde directamente cuando Engram o Graphify permiten diagnosticar
sin suponer. Cuando la primera vía Graphify aplicable no entrega referencias
utilizables, escala automáticamente al Inspector con:

- pregunta y alcance exactos;
- hallazgos verificables y sus fuentes;
- vías consultadas y fallos/degradaciones;
- incertidumbres, tradeoffs y GAPs pendientes.

Cuando Graphify y Engram no bastan para responder con evidencia, se escala al
Inspector; la búsqueda normal del proyecto no reemplaza esa escalada. La búsqueda normal no se presenta como evidencia Graphify. Si no pude consultar el grafo, estoy usando búsqueda normal.

El contrato de delegación no cambia y no convierte una inferencia en hecho ni
autoriza al Runner a escribir. Si el Inspector no está disponible, el Runner
reporta explícitamente que no pudo obtener evidencia porque el Inspector no está
disponible y escala al desarrollador. En ese caso no usa búsqueda normal ni
inventa contexto. El Inspector no se modifica por este contrato. Runner nunca escribe archivos de producto ni configuración.

## Conversación y transición a ejecución

Durante la investigación el Runner presenta diagnóstico, tradeoffs y GAPs, y
espera una decisión explícita. El evento literal `ejecutar` es la única
transición a la ejecución de una corrección acordada.

Antes de despachar al Constructor, construye una sola vez un slug descriptivo
normalizado en minúsculas y kebab-case a partir del problema acordado, y forma
el ID `HF-{slug}`. Si el operador ya entrega `HF-`, no dupliques el prefijo.
Consulta Engram por el candidato completo `hotfix/{id}` antes de persistir.
Ante una colisión, conserva el nombre base y prueba `HF-{slug}-2`, luego
`-3`, etc., hasta encontrar el primer candidato libre; no sobrescribas ni
mezcles historiales. Los IDs temporales históricos no se renombran.

Persiste los artifacts completos:

- `hotfix/{id}/artifact/investigacion`;
- `hotfix/{id}/artifact/plan`.

El mismo ID elegido se reutiliza exactamente en flow-state, prompts, worktree,
branch, `execution_id` y `artifact_namespace`. Los namespaces internos siguen
siendo `hotfix/{id}`. El hotfix no pasa por ca-writer, planner ni plan-auditor.

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
