---
name: zero-assumptions
description: "Protocolo operativo de verificación material: orden de fuentes, registro de evidencia citable, herencia entre roles y pausa por dato material no confirmado."
license: MIT
compatibility: opencode
metadata:
  category: protocol
  scope: flowtask
---

# Protocolo Zero-Assumptions

## Propósito

Este skill define un protocolo verificable para evitar resultados incorrectos por asumir como cierto algo que no ha sido verificado. Antes de actuar sobre una entidad, requisito o afirmación, valida su estado contra fuentes disponibles y adecuadas y deja constancia del resultado de esa validación.

## Nada se da por supuesto

No se debe asumir el estado de:

- Casos de aceptación existentes (si existe, qué decisiones tiene, qué criterios aprobó)
- Decisiones registradas (si están actualizadas o tienen conflictos)
- Archivos modificados (qué cambió, desde cuándo, por qué)
- Convenciones de proyecto (naming, layers, stack, patrones)
- Configuraciones del proyecto (stack, estructura, dependencias)
- Estado de repositorio git (ramas, commits, worktrees)

Las afirmaciones recibidas deben tratarse como información que requiere validación, no como hechos confirmados.

## Material y periférico

Un dato es **material** cuando su valor cambia una decisión, el alcance, un criterio, un permiso, la seguridad o un entregable. Ante la duda, el dato es material y lo verifica quien decide.

Un dato es **periférico** cuando su valor no cambia ninguna de esas cosas. Un dato periférico puede continuar con el estado `[No verificado]` declarado, sin bloquear el trabajo.

## Orden de verificación

El orden fijo de consulta es:

1. **Memoria del proyecto** — requisitos, decisiones y convenciones ya registradas.
2. **Documentación, código y estado del repositorio** — lo que el proyecto declara y lo que el repositorio muestra. El grafo de conocimiento y la lectura directa instrumentan este paso.
3. **La persona** — la autoridad que decide.

El orden solo se altera con un motivo declarado en `order_exception`. Si la memoria del proyecto no está disponible, se declara `missing_source`, se continúa con la siguiente fuente y la ausencia de fuente no confirma nada: no habilita el dato.

## Registro de evidencia

Cada dato material deja un registro dentro del artifact que contiene la decisión. No hay registro global, archivo paralelo ni namespace propio.

VerificationRecord v1:

```json
{
  "schema": "verification-record/v1",
  "id": "VR-001",
  "datum": "Regla vigente del protocolo de verificación",
  "materiality": "material",
  "source_kind": "document_or_code",
  "source_ref": ".flowtask/skills/zero-assumptions/SKILL.md:1-40",
  "status": "verified",
  "observed_at": "2026-10-20T00:00:00Z",
  "order_exception": null,
  "missing_source": null,
  "note": null
}
```

Reglas del registro:

- `verified` exige un `source_ref` resoluble.
- `unverified` exige `missing_source` o `note`, y solo es admisible para un dato periférico.
- `discrepant` exige `note` con las dos fuentes en conflicto y en qué discrepan.
- `materiality` es `material` o `peripheral`; `source_kind` es `memory`, `document_or_code`, `repository_state` o `person`; `status` es `verified`, `unverified` o `discrepant`.
- `observed_at` es una marca de tiempo ISO-8601.
- No hay puntaje de confianza: el estado y la fuente bastan.

## Incertidumbre y discrepancia

Un dato material no confirmado no se presenta como hecho: se convierte en decisión pendiente o en pausa. Un dato periférico no confirmado continúa como `[No verificado]`. Si dos fuentes se contradicen, la contradicción se informa con ambas fuentes y no se resuelve por suposición.

## Pausa por dato material no confirmado

Cuando un dato material no se puede confirmar, la ejecución se pausa con el motivo vigente:

| Situación | Motivo |
|-----------|--------|
| Falta la decisión o la confirmación de la persona. | `authority_block` |
| La fuente necesaria no está disponible o es ilegible. | `progress_unavailable` |
| Sin el dato no hay hipótesis ni progreso verificable. | `no_verifiable_progress` |

La pausa se informa con el mensaje de tres líneas:

~~~
⏸ Pausa por excepción: {motivo}
Estado conservado: {trabajo; artifacts; cambios; última ronda confirmada}
Para reanudar: {condición exacta}
~~~

El detalle se ajusta al `policy.profile` vigente: el perfil de desarrollo detalla `source_ref` y `observed_at`; el perfil de producción mantiene la fuente y el estado concisos. La verificación mínima para reanudar es la misma en ambos perfiles.

## Alcance por rol

| Rol | Alcance |
|-----|---------|
| Redacta, planifica y explora | Verifica el dato material en el orden vigente y registra la evidencia. |
| Construye y valida | Hereda la evidencia verificada y verifica solo el dato nuevo material. |
| Orquesta | Verifica el routing, el gate y el diagnóstico. |

## Herencia de evidencia

La evidencia verificada se hereda con su `source_ref` y su `observed_at`; no se re-verifica por rutina. Un estado mutable se re-observa solo cuando la decisión depende de su valor actual: es un registro nuevo, no una repetición. Una contradicción con la evidencia heredada se registra como `discrepant` y pausa antes de imponer un cambio de alcance.

## Consecuencia de violación

La consecuencia de ignorar este principio es natural: **implementaciones o análisis incorrectos basados en supuestos no verificados**.

La ausencia de rastro de verificación es detectable por el operador al revisar el artifact. No hay bloqueo automático: el cumplimiento se verifica por auditoría y la duda se resuelve por pausa.

## Verificación

~~~
node --test .flowtask/bin/test/zero-assumptions-enforcement.test.js
~~~

---
