---
name: zero-assumptions
description: "Protocolo Zero-Assumptions para agentes de FlowTask. Prohíbe suponer el estado de entidades sin consultar Engram, documentación, ferris-search o al desarrollador. Aplica a ca-writer, planner, inspector, constructor y validator."
license: MIT
compatibility: opencode
metadata:
  category: protocol
  scope: flowtask
---

skill({ name: "memory-protocol" })

# Protocolo Zero-Assumptions

## Propósito

Este skill define el protocolo Zero-Assumptions para los agentes de FlowTask. Prohíbe a los agentes cubiertos asumir el estado de cualquier entidad del proyecto sin verificarlo antes, bajo la consecuencia de generar implementaciones o análisis incorrectos.

## Agentes cubiertos

Este protocolo aplica EXCLUSIVAMENTE a:

- **ca-writer** — al clarificar requisitos y definir CAs
- **planner** — al generar planes de implementación
- **inspector** — al analizar el proyecto o responder preguntas
- **constructor** — al implementar artefactos del plan
- **validator** — al validar la implementación contra el plan

Los siguientes agentes NO están cubiertos: runner, logger, tester, plan-auditor, onboarder.

## Cobertura total — nada se da por supuesto

Ningún agente cubierto debe asumir el estado de:

- CAs existentes (si existe, qué decisiones tiene, qué criterios aprobó)
- Decisiones registradas en Engram (están actualizadas, hay conflictos)
- Archivos modificados (qué cambió, desde cuándo, por qué)
- Convenciones de proyecto (naming, layers, stack, patrones)
- Configuraciones del proyecto (stack, estructura, dependencias)
- Estado de repositorio git (ramas, commits, worktrees)
- Afirmaciones del usuario (no asumir que son correctas sin validación)

## Orden de resolución obligatorio

Cuando un agente necesite conocer el estado de algo y no lo tenga verificado, debe seguir este orden:

1. **Consultar Engram** — usar `mem_search`, `mem_context`, `mem_get_observation` para recuperar decisiones, CAs, patrones y heurísticas.
2. **Validar contra documentación y código** — leer archivos de documentación, código fuente, skills y agentes para confirmar o contrastar lo encontrado en Engram.
3. **Verificar claims externos con ferris-search** — usar `web_search` o `webfetch` para validar afirmaciones sobre APIs, librerías, frameworks, o cualquier dato factual externo al proyecto. Si ferris-search no está disponible, continuar al paso 4.
4. **Preguntar al desarrollador** — solo si los pasos 1, 2 y 3 no resolvieron la ambigüedad. Nunca fabricar una suposición.

> ⚠️ **Importante**: Saltarse pasos o asumir sin verificar puede generar implementaciones o análisis incorrectos.

## Validación de afirmaciones del usuario

Si el desarrollador afirma algo durante la conversación, el agente NO debe tomar esa afirmación como verdad sin verificarla. Existe un GAP potencial entre lo que el usuario cree y lo que realmente es cierto.

El agente debe:
1. Consultar Engram para verificar la afirmación
2. Contrastar con documentación y código
3. Si hay discrepancia, informar al desarrollador antes de actuar

## Consecuencia de violación

La consecuencia de violar el protocolo no es artificial — es natural: **implementaciones o análisis incorrectos basados en supuestos no verificados**.

Si un agente asume el estado de una entidad sin verificarlo, el resultado del trabajo puede ser incorrecto, inconsistente con decisiones previas, o basado en información desactualizada.

## Reglas fijas (no configurables)

Este protocolo NO es configurable por proyecto. Las reglas son fijas para todos los proyectos que usen FlowTask:

- **Zero-Assumptions activo**: siempre activo para ca-writer, planner, inspector, constructor, validator
- **Orden de resolución**: fijo — (1) Engram → (2) doc/código → (3) ferris-search → (4) preguntar
- **Cobertura**: total — todas las entidades del proyecto

## GAPs conocidos

- **GAP 1 — Agentes no cubiertos**: Resuelto en CA-ferris-validation. Constructor y validator ahora están cubiertos.
- **GAP 2 — Enforcement por diseño, no automático**: Si un agente no carga el skill o no sigue sus reglas, el sistema no lo detecta automáticamente. La consecuencia (implementaciones incorrectas) solo se ve al final. Inherente al modelo de skills de FlowTask.
- **GAP 3 — Documentación desactualizada**: El protocolo asume que documentación y código son fuentes confiables. En la práctica, la documentación puede estar obsoleta. El paso 3 (preguntar al desarrollador) es el safety net.

---

> **Nota**: Este skill debe cargarse después de `memory-protocol` para asegurar que las herramientas de consulta a Engram estén disponibles.
