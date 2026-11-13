---
name: higiene-de-codigo
description: Regla de higiene y estilo para el código que produce el pipeline. Documenta solo lo que la declaración no expresa, elige el mecanismo del archivo vecino y prohíbe el código muerto, los bloques comentados, la procedencia o historia y las referencias de coordinación.
license: MIT
compatibility: opencode
metadata:
  category: hygiene
  scope: flowtask
---

# Higiene de código

## Propósito

Esta skill define qué documentar, cómo elegir el mecanismo y qué eliminar del código que produce el pipeline. Es agnóstica al lenguaje y se aplica a cualquier archivo funcional.

---

## Regla de documentación

Documentá solo lo que la declaración no expresa por sí misma:

- nulabilidad y valores válidos;
- unidades, formato y rangos;
- mutación del estado y alias observables;
- precondiciones y condición de error;
- efectos laterales y orden observable;
- semántica oculta que la firma no revela.

Si la declaración ya lo dice, no lo repitas: el comentario que parafrasea el nombre agrega ruido y envejece mal.

---

## Cómo elegir el mecanismo

1. Usá el mecanismo que el archivo vecino ya usa —docstring, JSDoc, comentario de bloque o anotación— para que el estilo sea local y consistente.
2. Si el archivo vecino no usa ninguno, aplicá el estándar de documentación del lenguaje.
3. Si sigue sin estar claro, no documentes lo que la declaración ya dice.

El mecanismo se elige por el contexto del archivo, no por preferencia global ni por una tabla de lenguajes.

---

## Prohibiciones absolutas

- **Código muerto**: código inalcanzable, ramas sin consumidor, funciones o constantes sin uso, parámetros que nadie pasa. Se elimina; no se conserva "por si acaso".
- **Bloques de código comentados**: código desactivado con comentarios. Se elimina; el historial ya lo conserva.
- **Procedencia o historia en comentarios**: autoría, fechas, versiones anteriores, "antes era así", "cambiado en el refactor", enlaces a revisiones o cualquier narración de cómo llegó el código a su forma actual.
- **Identificadores de requisitos o coordinación**: referencias a la lista única de `## Referencias prohibidas` dentro de código, comentarios, nombres o textos funcionales.

---

## Referencias prohibidas

Lista única: **CA, HF, tickets, issues, branches, worktrees, planes, `execution_id` y namespaces**.

- Es la única fuente de la lista: el planner, el plan-auditor y el validator la referencian por esta ruta y sección; no la enumeran ni la duplican.
- Alcance: código, comentarios, nombres de archivos y símbolos, constantes, strings y documentación inline de archivos funcionales.
- Exclusiones: artifacts de coordinación de `.flowtask/`, registros y checkpoints de Engram, mensajes de commit y `docs/project-history.md`.
- Excepción: una cadena literal que el dominio exige —API, contrato, configuración o valor persistido— se escribe por el valor funcional que aporta, sin atribuirla a la ejecución.

---

## Ejemplos no normativos

Los ejemplos de esta sección son no normativos; no crean obligaciones por lenguaje.

```text
# Narra lo que la declaración ya dice
# Devuelve el nombre del usuario
nombre()

# Expresa una precondición y un efecto que la firma no revela
# Requiere sesión válida; devuelve null si el usuario no existe.
nombre()
```

---

## Límites

- La densidad y la calidad de los comentarios no son binarias: se reportan como hallazgo MENOR, nunca como bloqueo.
- "Funcional vs imperativo" y el tamaño de clase son decisiones de diseño: viven en `project/conventions` o en el plan, nunca en esta skill ni en la puerta del constructor.
- Esta skill no crea una etapa nueva del flujo ni cambia el comportamiento del producto.

---

## Aplicación

- El constructor la carga antes de escribir o modificar código funcional.
- El validator verifica como binarios solo código muerto, bloques comentados, procedencia o historia y referencias prohibidas.
- El planner y el plan-auditor la usan como referencia de la lista única al verificar la higiene del plan.
