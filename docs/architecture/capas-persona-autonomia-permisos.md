# Capas de persona, autonomía y permisos

## Propósito

FlowTask separa en tres capas almacenadas y evaluadas por separado lo que el
runner ** dice**, lo que el runner ** hace sin preguntar** y lo que el runner
** está técnicamente permitido a hacer**. Cada capa tiene su propio contrato,
su propio archivo y su propia forma de fallo.

La separación evita que un cambio de tono amplíe la iniciativa o los límites, y
que un cambio de iniciativa amplíe los límites. La precedencia entre capas es
estructural y no depende del caso: `permisos > autonomía > persona`.

## Capas

| Capa | Pregunta que responde | Archivo | Efecto |
|------|-----------------------|---------|--------|
| Persona | ¿Cómo habla y cuánto explica? | `profile.json` | Tono y profundidad de la conversación. |
| Autonomía | ¿Qué hace sin preguntar? | `autonomy.json` | Iniciativa: si arranca trabajo por su cuenta o espera la orden. |
| Permisos | ¿Qué está técnicamente permitido? | `permissions.json` | Sobre técnico: qué herramientas y acciones puede ejecutar. |

Ninguna capa autoriza por sí sola. La persona no autoriza ni restringe: solo
define el tono. La autonomía declara la iniciativa y no amplía el sobre
técnico. El sobre de permisos es el único límite que acota la acción.

## Valores y esquema

**Persona.** `profile.json` conserva su forma vigente: `{level, persona,
onboarded}`. Los niveles válidos son `training`, `mid`, `senior` y `custom`. El
nivel heredado `junior` se acepta solo como alias de lectura y se normaliza a
`training`; ninguna escritura nueva lo emite.

**Autonomía.** `autonomy.json` es una capa nueva y separada, con versión de
esquema explícita:

```json
{ "version": 1, "profile": "assistant" }
```

Los valores de `profile` son exactamente tres:

| Valor | Semántica |
|-------|-----------|
| `assistant` | No inicia ejecución autónoma: espera una orden explícita por trabajo. |
| `autonomous-dev` | Ejecuta el loop completo bajo gates, auditoría, validación y permisos. |
| `hermes` | Opera dominios generalistas bajo la policy de capacidades y los permisos de dominio; sin esa policy no amplía el sobre técnico. |

**Permisos.** `permissions.json` es una capa nueva y separada:

```json
{ "version": 1, "envelope": "standard" }
```

`standard` es el único sobre técnico de esta fase y equivale al gate técnico
vigente: no agrega ninguna capacidad.

## Resolución por capa

Las fuentes lógicas son dos: `team` (base) y `project` (override). La
resolución se hace **por capa** y con **reemplazo completo**:

- Si el proyecto define la capa, el proyecto manda entero.
- Si el proyecto no la define, rige la base de equipo.
- Si ninguna la define, la capa está ausente.

No hay mezcla de campos entre fuentes: una capa resuelve completa o no resuelve.
Una capa inválida del proyecto **no** cae a la base de equipo: es inválida, y
eso es un fallo.

La precedencia de las capas, una vez resueltas, es:

```
permisos > autonomía > persona
```

## Precedencia

Para cualquier decisión, el orden es estructural:

1. **Permisos** define el límite técnico. Es el único que puede impedir una
   acción.
2. **Autonomía** define la iniciativa dentro de ese límite. Solo puede
   restringir; nunca amplía el sobre de permisos.
3. **Persona** define el tono. No participa de ninguna autorización.

Consecuencias observables:

- Una acción sugerida por la autonomía y fuera del sobre de permisos se deniega.
- Un cambio de persona no altera qué se hace sin preguntar ni qué está
  permitido.
- Un cambio de autonomía no altera el sobre de permisos.

## Fallo por capa

| Capa ausente o inválida | Comportamiento | Resultado |
|--------------------------|----------------|-----------|
| Permisos | Fallo operativo con mensaje | No se ejecuta ninguna acción con límites ampliados. |
| Autonomía | Fallo operativo con mensaje | No se inicia ninguna ejecución. |
| Persona | Aviso visible y continuación | Se continúa sin inyección de persona, con autonomía y permisos intactos. |

El fallo operativo de permisos o autonomía no tiene valor por defecto: no se
continúa con un valor inventado ni con límites ampliados. El fallo de persona
tampoco repara nada: no inventa un tono y no altera las otras capas.

## Puntos de enforcement

| Punto | Qué verifica | Alcance |
|-------|---------------|---------|
| Inyección en el runner | El valor de autonomía resuelto se inyecta en el agente runner entre sus marcadores. | Solo el runner. |
| Gate de permisos | Antes de aplicar la allowlist técnica, el gate valida que la capa de autonomía y la de permisos existan y sean válidas en el target. | Solo las herramientas del runner. |

El gate **no lee la autonomía para autorizar herramientas**: la autonomía no
autoriza. Si la capa de permisos o la de autonomía falta o es inválida, el gate
deniega con su mensaje operativo. Los agentes que no son el runner no quedan
sujetos a esta comprobación, y el gate universal de commits conserva su
comportamiento.

## Migración

Las instalaciones existentes siguen funcionando. `install` y `update` crean las
capas nuevas **solo cuando la capa no existe**:

| Capa ausente | Archivo creado | Contenido |
|--------------|----------------|-----------|
| Autonomía | `autonomy.json` | `{ "version": 1, "profile": "autonomous-dev" }` |
| Permisos | `permissions.json` | `{ "version": 1, "envelope": "standard" }` |

Los defaults de migración conservan el comportamiento instalado. Son una
migración, **no** un fallback de runtime: en ejecución, una capa ausente o
inválida es un fallo.

Una capa inválida nunca se repara con un default: la operación falla y el
archivo se conserva tal como estaba. Una capa válida se preserva. El cambio de
persona conserva su archivo y no toca las capas de autonomía y permisos.

Los archivos de capa viven junto a `profile.json` en el directorio de
configuración del target y se ignoran en git: son estado local, no contenido
versionado. La ruta definitiva de la base por equipo y del registro por proyecto
la definen las fases de instalación por equipo y de registro por proyecto; el
resolver de capas recibe fuentes lógicas y no fija esa ruta.

## Frontera con la policy de dominio

Esta fase define **solo el mecanismo de enforcement** del sobre técnico. La
policy de capacidades y los permisos de dominio de Hermes pertenecen a la fase
de permisos de dominio y no se implementan aquí.

En consecuencia, `hermes` declara la iniciativa para dominios generalistas, pero
sin la policy de capacidades y sin los permisos de dominio no amplía el sobre
técnico: el gate técnico vigente sigue siendo el límite.

## Verificación

~~~
node --test .flowtask/bin/test/capas-contrato.test.js
node --test .flowtask/bin/test/layers.test.js
node --test .flowtask/bin/test/layers-cli.test.js
node --test .flowtask/bin/test/runner-autonomy-injection.test.js
node --test .flowtask/bin/test/permission-gate-layers.test.js
~~~

La fuente normativa del contrato de autonomía por política es
[autonomia-operativa.md](./autonomia-operativa.md) y la del gate técnico es
[../permission-gate.md](../permission-gate.md).
