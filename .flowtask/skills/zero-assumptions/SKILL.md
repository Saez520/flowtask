---
name: zero-assumptions
description: "Principio agnóstico para evitar suposiciones no verificadas sobre el estado de entidades, requisitos y contexto."
license: MIT
compatibility: opencode
metadata:
  category: protocol
  scope: flowtask
---

# Protocolo Zero-Assumptions

## Propósito

Este skill define un principio para evitar resultados incorrectos por asumir como cierto algo que no ha sido verificado. Antes de actuar sobre una entidad, requisito o afirmación, valida su estado contra fuentes disponibles y adecuadas.

## Nada se da por supuesto

No se debe asumir el estado de:

- CAs existentes (si existe, qué decisiones tiene, qué criterios aprobó)
- Decisiones registradas (si están actualizadas o tienen conflictos)
- Archivos modificados (qué cambió, desde cuándo, por qué)
- Convenciones de proyecto (naming, layers, stack, patrones)
- Configuraciones del proyecto (stack, estructura, dependencias)
- Estado de repositorio git (ramas, commits, worktrees)

Las afirmaciones recibidas deben tratarse como información que requiere validación, no como hechos confirmados.

Sigue tu cadena de validación definida en tu propio contrato. Esta skill no prescribe herramientas ni orden de consulta.

## Manejo de incertidumbre y discrepancias

Si las fuentes disponibles no permiten confirmar un dato, declara la incertidumbre y solicita la información necesaria antes de tratarlo como un hecho. Si las fuentes discrepan, informa la discrepancia y evita ocultarla o resolverla mediante una suposición.

## Consecuencia de violación

La consecuencia de ignorar este principio es natural: **implementaciones o análisis incorrectos basados en supuestos no verificados**.

---
