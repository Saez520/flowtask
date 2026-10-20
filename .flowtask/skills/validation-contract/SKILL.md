---
name: validation-contract
description: >-
  Contrato ejecutable de validación en caliente. Define las rondas de cierre e
  intermedia, el alcance declarado por invocación, la ejecución de
  comprobaciones con las herramientas del entorno, la evidencia ejecutada
  reutilizable y el veredicto único de tres estados: aprobado, rechazo
  funcional y fallo operativo.
license: MIT
compatibility: opencode
metadata:
  category: validation
  scope: flowtask
---

# Validation Contract — Validación en caliente con evidencia ejecutada

## Propósito

Este contrato define cómo se valida una implementación en caliente: qué
comprobaciones se ejecutan, cómo se registra la evidencia, cómo se clasifica lo
verificado y lo no verificado, y cuál es el veredicto único que surge de esa
evidencia.

El contrato produce hechos verificables y un veredicto de tres estados. No
produce una calificación numérica, ni una aprobación parcial, ni un máximo de
rondas. Quien consume el resultado lee la evidencia y decide por separado.

## Alcance

Aplica a toda validación de una implementación dentro de un flujo de trabajo y
cubre:

- las rondas `closure` e `intermediate` y su alcance declarado;
- el descriptor de invocación y sus reglas de validación;
- el descubrimiento y la ejecución de comprobaciones con herramientas del
  entorno;
- el escáner de referencias de coordinación en los archivos funcionales;
- el esquema de evidencia reutilizable por la ronda siguiente;
- la herencia de evidencia y el tratamiento de la contradicción;
- la agregación del veredicto con precedencia única;
- la interfaz de línea de comandos y sus códigos de salida.

El contrato no corrige la implementación, no instala dependencias, no escribe
archivos, no usa la red y no valida el repositorio completo por defecto: valida
lo que el alcance declarado le entrega.

## Invocación por ronda

| Ronda | Qué valida | ¿Cierra la ejecución? |
|-------|------------|-----------------------|
| `closure` | El plan completo y sus criterios de aceptación. | Sí, con `APPROVED` y `final: true`. |
| `intermediate` | Solo lo alcanzado, con alcance declarado. | No. |

Una ronda `intermediate` declara qué se alcanza y con qué criterios se evalúa.
No exige el plan completo, no pide lo que todavía no existe y no habilita el
cierre. Su `APPROVED` produce `final: false` y la continuación de la ronda.

Una ronda `closure` exige la referencia al plan. Es la única ronda que puede
producir `final: true`.

## Alcance declarado

Toda invocación declara su alcance. Sin alcance no hay contrato válido ni
aprobación posible.

| Clave | Regla |
|-------|-------|
| `schema_version` | Exactamente `"1"`. |
| `execution_id` | Identificador de la ejecución, no vacío. |
| `round` | `closure` o `intermediate`. |
| `environment` | `development` o `production`. Se registra y no participa en la agregación. |
| `project_root` | Ruta absoluta existente. Raíz de las rutas relativas y del directorio de trabajo. |
| `plan_ref` | Referencia al plan. Obligatoria en `closure`, opcional en `intermediate`. |
| `scope.goal` | Objetivo de la validación, no vacío. |
| `scope.files` | Archivos funcionales del alcance, relativos al proyecto. Se escanean. |
| `scope.criteria` | Lista no vacía de criterios. Cada criterio declara `id`, `material` y `statement`. |

Los identificadores de criterio son únicos. Cada criterio material debe quedar
cubierto por una comprobación exitosa o por una verificación manual para que el
veredicto pueda ser favorable.

El descriptor admite además `checks`, `findings`, `manual_verified`,
`manual_unverified`, `design_decisions` y `scan`. Cualquier clave desconocida se
rechaza en todos los niveles.

## Comprobaciones

Las comprobaciones se declaran por invocación. La lista es el único ajustable:

| Situación | Comportamiento |
|-----------|----------------|
| `checks` declarado | Se ejecutan exactamente las comprobaciones declaradas. |
| `checks` omitido | Se descubren por manifiestos del proyecto. |
| `checks: []` | No se ejecuta ninguna comprobación. Sin comprobación exitosa no hay veredicto favorable. |

Cada comprobación declara `id`, `command`, `args`, `shell`, `timeout_ms`, `cwd`,
`criteria` y `description`. El comando se ejecuta sin shell por defecto; con
`shell: true` la lista de argumentos va vacía. El directorio de trabajo es
relativo y vive dentro de la raíz del proyecto. El límite de tiempo por
comprobación va de 100 a 600000 milisegundos, con 120000 milisegundos por
defecto.

El entorno disponible cambia el conjunto de comprobaciones alcanzable. Nunca
cambia la precedencia de los estados ni el resultado del veredicto para una
misma entrada.

Cada comprobación se clasifica en uno de tres estados:

| Estado | Cuándo |
|--------|--------|
| `passed` | El comando terminó con salida 0. |
| `failed` | El comando terminó con salida distinta de 0, 126 o 127. |
| `unverified` | Tiempo de espera agotado, herramienta inexistente, permiso denegado, señal, límite de salida o error de ejecución. |

Una comprobación `failed` no es por sí sola un hallazgo funcional. Toda
comprobación `failed` recibe una disposición explícita: se vincula a un hallazgo
bloqueante con criterio, ruta y evidencia, o se declara como no verificada con
causa conocida. Sin disposición, el resultado es un fallo operativo.

## Evidencia

La evidencia se persiste con esquema estable y la ronda siguiente la reutiliza.

| Campo | Contenido |
|-------|-----------|
| `schema_version` | `"1"`. |
| `generated_at` | Marca de tiempo de la ejecución. |
| `execution` | Identificador, ronda, entorno y referencia al plan. |
| `scope` | Objetivo, archivos y criterios declarados. |
| `checks` | Comprobaciones con comando, estado, resultado y salida acotada. |
| `findings` | Hallazgos con severidad, criterio, ruta, línea y evidencia. |
| `criteria` | Estado por criterio y su evidencia. |
| `unverified` | Comprobaciones y verificaciones que quedaron sin verificar, con su causa. |
| `design_decisions` | Decisiones de diseño con implementación, documentación y evidencia. |
| `counts` | Conteos de comprobaciones, criterios y hallazgos. |
| `verdict`, `final`, `reasons` | Resultado agregado y sus motivos. |

Los extractos de salida se acotan a 2000 caracteres por flujo y la evidencia de
un hallazgo se acota a 240 caracteres. La evidencia nunca contiene logs
completos ni código fuente.

El reporte en Markdown incluye el JSON de evidencia embebido. Publica conteos
de comprobaciones, criterios y hallazgos; no publica una calificación numérica.

## Reglas de veredicto

El veredicto es único y tiene precedencia fija:

1. Con al menos un hallazgo bloqueante, el veredicto es `rejected`.
2. Sin bloqueantes, el veredicto es `operational_failure` si hay alguna
   comprobación no verificada, si queda algún archivo sin escaneo verificable, si
   un criterio material queda sin cubrir, si una comprobación `failed` quedó
   sin disposición, si hay verificaciones manuales declaradas como no verificadas,
   si ninguna comprobación resultó exitosa o si no hay criterios materiales.
3. Sin bloqueantes y sin ninguno de esos casos, el veredicto es `approved`.

`final` es verdadero únicamente en ronda `closure` con veredicto `approved`.

Un comando fallido no prueba el incumplimiento de un criterio. Un reporte
favorable parcial no habilita un veredicto favorable.

## Referencias de coordinación

El escáner se ejecuta automáticamente sobre los archivos funcionales del
alcance y, opcionalmente, sobre los archivos declarados en `scan.files`.

Detecta valores concretos: identificadores de ejecución, namespaces de artifacts,
rutas de estado de flujo y valores literales de claves de coordinación. Cada
coincidencia es un hallazgo bloqueante.

| Regla | Comportamiento |
|-------|----------------|
| Alcance | Solo los archivos funcionales declarados. |
| Recorridos de directorio | Excluyen `.git`, `.worktrees`, `node_modules`, `.flowtask`, el historial del proyecto y el registro de hoja de ruta. |
| Archivos explícitos | Un archivo funcional explícito dentro de `.flowtask/` sí se escanea. |
| Excepciones de dominio | `scan.allowed_literals` permite una cadena que el dominio exige. |
| Archivos ilegibles o binarios | Quedan como no verificados, nunca como hallazgo. |

Los placeholders de ejecución no son hallazgos. La ausencia de un valor concreto
no habilita un veredicto favorable por sí sola.

## Verificación ejecutable

El operador verifica el contrato ejecutándolo. Desde la raíz del repositorio:

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js discover --project-root . --json
```

El subcomando `discover` lista las comprobaciones disponibles por manifiestos del
proyecto, ordenadas y sin duplicados. No ejecuta nada.

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js run --input <archivo|-> [--json]
```

El subcomando `run` valida el descriptor, ejecuta las comprobaciones, escanea
el alcance, agrega el veredicto y publica el reporte. Con `--input -` lee el
descriptor de la entrada estándar. Con `--json` emite el resultado completo.

| Código | Significado |
|--------|-------------|
| 0 | Aprobado. |
| 1 | Rechazo funcional. |
| 2 | Fallo operativo. |
| 3 | Contrato inválido o error de uso. |

## Límites duros

- El contrato no escribe archivos, no instala dependencias, no corrige código y
  no usa la red.
- Un descriptor inválido produce un error estructurado y nunca una excepción.
- Una clave desconocida, en cualquier nivel, invalida el descriptor.
- La aprobación exige al menos un criterio material cubierto y al menos una
  comprobación exitosa.
- Un fallo operativo no es un rechazo funcional ni una evidencia favorable.
- El entorno declarado no cambia el veredicto.
- Un hallazgo de coordinación en un archivo funcional bloquea.

## Reutilización por la ronda siguiente

La evidencia de una ronda queda disponible para la siguiente. La ronda siguiente
recibe la referencia al reporte anterior y no repite las comprobaciones ya
verificadas.

El estado por criterio viaja con la evidencia: un criterio cubierto sigue
cubierto y uno no verificado sigue declarado como no verificado, con su causa.
Reutilizar la evidencia no habilita un veredicto favorable por sí sola: la
precedencia de los estados se aplica a cada ronda de forma independiente.

## Herencia de evidencia y contradicción

La evidencia verificada de una ronda se hereda con su fuente y su momento de
observación. La ronda siguiente no se re-verifica por rutina: no repite
comprobaciones ya veredictadas y lo que ya está verificado no se vuelve a
verificar.

Un estado mutable se re-observa solo cuando la decisión depende de su valor
actual: es un registro nuevo, no una repetición del anterior.

| Situación | Efecto |
|-----------|--------|
| La evidencia heredada contradice una comprobación de la ronda | Se informa con ambas fuentes, no se emite veredicto favorable y no se cambia el alcance. |
| Un dato material no se puede confirmar | La comprobación queda `unverified` con su causa y el veredicto es `operational_failure`, nunca `rejected`. |
| Un dato periférico no se puede confirmar | Se declara como no verificado, con su causa, y no bloquea por sí sola. |

La contradicción no se resuelve por suposición ni se convierte en un rechazo
automático. El esquema de evidencia, la precedencia del veredicto y los códigos
de salida no cambian.