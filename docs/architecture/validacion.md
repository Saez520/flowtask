# Validación en caliente: comprobaciones, evidencia y veredicto único

La validación en caliente comprueba una implementación mientras se construye,
con las herramientas del entorno y con evidencia ejecutada. Este documento
describe su arquitectura; el contrato canónico vive en
`.flowtask/skills/validation-contract/SKILL.md` y su implementación ejecutable
en `.flowtask/skills/validation-contract/scripts/validation-contract.js`.

## Propósito

La validación en caliente sustituye la inspección exclusivamente documental por
una comprobación ejecutada y trazable. Cada validación:

1. declara qué se alcanza y con qué criterios se evalúa;
2. ejecuta comprobaciones con las herramientas disponibles y registra el
   comando y su resultado;
3. distingue lo verificado de lo no verificado;
4. emite un veredicto único de tres estados;
5. deja una evidencia reutilizable para la ronda siguiente.

## Alcance

Aplica a la validación de una implementación dentro de un flujo de trabajo.

| Incluye | Excluye |
|---------|---------|
| Rondas `closure` e `intermediate` | Validación del repositorio completo por defecto |
| Alcance declarado por invocación | Aprobación parcial |
| Comprobaciones por invocación y descubrimiento por manifiestos | Corrección de la implementación |
| Escáner de referencias de coordinación | Instalación de dependencias |
| Evidencia ejecutada reutilizable | Consumo de red |
| Veredicto único de tres estados | Calificación numérica de la implementación |

## Rondas de validación

| Ronda | Qué valida | Resultado de un veredicto favorable |
|-------|------------|------------------------------------|
| `closure` | El plan completo y sus criterios de aceptación. | `final: true`: cierra la ejecución. |
| `intermediate` | Solo lo alcanzado, con alcance declarado. | `final: false`: la ejecución continúa. |

Una ronda intermedia existe para verificar lo alcanzado antes de seguir. No
exige el plan completo, no pide lo que todavía no existe y nunca cierra la
ejecución. La ronda de cierre es la única que puede producir `final: true`.

## Alcance declarado

Toda invocación declara su alcance. El alcance es el contrato de la
validación: sin alcance no hay veredicto posible.

| Clave | Regla |
|-------|-------|
| `schema_version` | Exactamente `"1"`. |
| `execution_id` | Identificador de la ejecución, no vacío. |
| `round` | `closure` o `intermediate`. |
| `environment` | `development` o `production`. Se registra; no altera el veredicto. |
| `project_root` | Ruta absoluta existente. Raíz de las rutas relativas y del directorio de trabajo. |
| `plan_ref` | Referencia al plan. Obligatoria en `closure`, opcional en `intermediate`. |
| `scope.goal` | Objetivo declarado, no vacío. |
| `scope.files` | Archivos funcionales del alcance, relativos al proyecto. Se escanean. |
| `scope.criteria` | Lista no vacía de criterios con `id`, `material` y `statement`. |

El descriptor admite además `checks`, `findings`, `manual_verified`,
`manual_unverified`, `design_decisions` y `scan`. Una clave desconocida se
rechaza en todos los niveles y produce un error estructurado, nunca una
excepción.

## Comprobaciones

Las comprobaciones se declaran por invocación. La lista es el único ajustable:

| Situación | Comportamiento |
|-----------|----------------|
| `checks` declarado | Se ejecutan exactamente las declaradas. |
| `checks` omitido | Se descubren por manifiestos del proyecto. |
| `checks: []` | No se ejecuta ninguna. Sin comprobación exitosa no hay veredicto favorable. |

El descubrimiento se apoya en los manifiestos del proyecto: scripts de un
manifiesto de paquetes, el directorio de pruebas propio del proyecto, la
configuración de pruebas de Python, el módulo de Go, el manifiesto de Rust, el
manifiesto de PHP y el archivo de construcción por `make`. La lista devuelta
está ordenada, sin duplicados y no se ejecuta durante el descubrimiento.

Cada comprobación declara `id`, `command`, `args`, `shell`, `timeout_ms`, `cwd`
y `criteria`. El comando se ejecuta sin shell por defecto; con `shell: true` la
lista de argumentos va vacía. El directorio de trabajo es relativo y vive
dentro de la raíz del proyecto. El límite de tiempo por comprobación va de 100
a 600000 milisegundos, con 120000 milisegundos por defecto.

Cada comprobación queda en uno de tres estados:

| Estado | Causa |
|--------|-------|
| `passed` | El comando terminó con salida 0. |
| `failed` | El comando terminó con salida distinta de 0, 126 o 127. |
| `unverified` | Tiempo de espera agotado, herramienta inexistente, permiso denegado, señal, límite de salida o error de ejecución. |

Una comprobación `failed` no prueba por sí sola el incumplimiento de un
criterio. Toda comprobación `failed` recibe una disposición explícita: se
vincula a un hallazgo bloqueante con criterio, ruta y evidencia, o se declara
como no verificada con causa conocida. Sin disposición, el resultado es un
fallo operativo.

## Esquema de evidencia

La evidencia tiene un esquema estable (`schema_version: "1"`) y la ronda
siguiente la reutiliza.

| Campo | Contenido |
|-------|-----------|
| `execution` | Identificador, ronda, entorno y referencia al plan. |
| `scope` | Objetivo, archivos y criterios declarados. |
| `checks` | Comprobaciones con comando, estado, causa, resultado y salida acotada. |
| `findings` | Hallazgos con severidad, criterio, ruta, línea y evidencia. |
| `criteria` | Estado por criterio (`verified`, `unverified`, `uncovered`, `failed`) y su evidencia. |
| `unverified` | Comprobaciones y verificaciones sin verificar, con su causa. |
| `design_decisions` | Decisiones de diseño con implementación, documentación y evidencia. |
| `counts` | Conteos de comprobaciones, criterios y hallazgos. |
| `verdict`, `final`, `reasons` | Resultado agregado y sus motivos. |

Los extractos de salida se acotan a 2000 caracteres por flujo y la evidencia de
un hallazgo a 240 caracteres. La evidencia no contiene logs completos ni
código fuente.

## Reglas de veredicto

El veredicto es único y su precedencia es fija:

1. Con al menos un hallazgo bloqueante, el veredicto es `REJECTED`.
2. Sin bloqueantes, el veredicto es `OPERATIONAL_FAILURE` cuando hay alguna
   comprobación no verificada, cuando queda un archivo sin escaneo verificable,
   cuando un criterio material queda sin cubrir, cuando una comprobación
   `failed` quedó sin disposición, cuando hay verificaciones manuales
   declaradas como no verificadas, cuando ninguna comprobación resultó
   exitosa o cuando no hay criterios materiales.
3. Sin bloqueantes y sin ninguno de esos casos, el veredicto es `APPROVED`.

`final` es verdadero únicamente con `APPROVED` en ronda `closure`.

El reporte publica conteos de comprobaciones, criterios y hallazgos. No
publica una calificación numérica: un número sugeriría aprobación parcial y no
se deriva de la evidencia.

## Validaciones no ligadas al plan

El plan declara el alcance de la implementación, no la lista exhaustiva de lo
que debe cumplirse. La validación en caliente comprueba además:

- las convenciones del proyecto, aunque el plan no las mencione;
- la higiene de coordinación en los archivos funcionales del alcance;
- el escáner de referencias de coordinación.

### Escáner de referencias de coordinación

El código funcional describe comportamiento del producto. Las referencias de
coordinación —el identificador de la ejecución, su namespace, el namespace de
los artifacts y las claves de coordinación— pertenecen a los artifacts de
coordinación del flujo.

El escáner se ejecuta automáticamente sobre `scope.files` y, cuando se
declara, sobre `scan.files`. Detecta valores concretos: identificadores de
ejecución, namespaces de artifacts, rutas de estado de flujo y valores
literales de claves de coordinación. Cada coincidencia es un hallazgo
bloqueante.

| Regla | Comportamiento |
|-------|----------------|
| Alcance | Solo los archivos funcionales declarados. |
| Recorridos de directorio | Excluyen `.git`, `.worktrees`, `node_modules`, `.flowtask`, el historial del proyecto y el registro de hoja de ruta. |
| Archivos explícitos | Un archivo funcional explícito dentro de `.flowtask/` sí se escanea. |
| Excepción de dominio | `allowed_literals` permite una cadena que el dominio exige. |
| Archivos ilegibles o binarios | Quedan como no verificados, nunca como hallazgo. |

Los placeholders de ejecución no son hallazgos.

## Reutilización por la ronda siguiente

La evidencia de una ronda queda en el artifact de validación. La ronda
siguiente recibe su referencia y no repite las comprobaciones ya
veredictadas. El estado por criterio viaja con la evidencia: un criterio
cubierto sigue cubierto y uno no verificado sigue declarado como no verificado,
con su causa.

Reutilizar la evidencia no habilita un veredicto favorable por sí sola: la
precedencia de los estados se aplica en cada ronda de forma independiente.

## Herencia de evidencia y contradicción

La evidencia verificada de una ronda se hereda con su fuente y su momento de
observación. La ronda siguiente no se re-verifica por rutina: no repite
comprobaciones ya veredictadas.

Un estado mutable se re-observa solo cuando la decisión depende de su valor
actual: es un registro nuevo, no una repetición del anterior.

| Situación | Efecto |
|-----------|--------|
| La evidencia heredada contradice una comprobación de la ronda | Se informa con ambas fuentes, no se emite veredicto favorable y no se cambia el alcance. |
| Un dato material no se puede confirmar | La comprobación queda no verificada con su causa y el veredicto es de fallo operativo, nunca de rechazo funcional. |
| Un dato periférico no se puede confirmar | Se declara como no verificado, con su causa, y no bloquea por sí sola. |

La contradicción no se resuelve por suposición ni se convierte en un rechazo
automático. El esquema de evidencia, la precedencia del veredicto y los códigos
de salida no cambian.

## Verificación ejecutable

Desde la raíz del repositorio:

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js discover --project-root . --json
```

```
node .flowtask/skills/validation-contract/scripts/validation-contract.js run --input <archivo|-> [--json]
```

`discover` lista las comprobaciones disponibles y no ejecuta nada. `run`
valida el descriptor, ejecuta las comprobaciones, escanea el alcance, agrega
el veredicto y publica el reporte; con `--input -` lee el descriptor de la
entrada estándar y con `--json` emite el resultado completo.

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
- Una referencia de coordinación en un archivo funcional bloquea.

## Referencias relacionadas

- [INDEX.md](./INDEX.md) — índice de la arquitectura vigente.
- [handshake.md](./handshake.md) — identidad, continuidad y checkpoints.
- [verificacion-material.md](./verificacion-material.md) — verificación material, evidencia citable y herencia entre roles.
- [../core-flowtask.md](../core-flowtask.md) — flujo principal de una ejecución.
- `.flowtask/agents/validator.md` — conducta del agente que ejecuta la
  validación.
- `.flowtask/agents/runner.md` — despacho por ronda y cierre de la ejecución.
