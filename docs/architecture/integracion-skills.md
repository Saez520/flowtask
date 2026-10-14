# Integración vigente de skills

Las skills son módulos de instrucciones cargables bajo demanda. La fuente
canónica vive en `.flowtask/skills/`; no existe un skill registry editorial que
reemplace ese directorio.

## Carga

El runner o el subagente carga una skill por su nombre mediante la herramienta
`skill`:

```text
skill({ name: "investigacion" })
skill({ name: "memory-protocol" })
skill({ name: "handshake-protocol" })
```

El nombre corresponde al directorio que contiene `SKILL.md`. La instalación
copía estas fuentes al target seleccionado; el contrato ejecutable permanece en
la instalación del target y la fuente de este repositorio sigue siendo
`.flowtask/skills/`.

## Responsabilidades

- `investigacion` define investigación con evidencia sin escribir archivos.
- `memory-protocol` y `memory-contract` definen el uso de Engram y sus datos.
- `handshake-protocol` gestiona identidad y continuidad cuando aplica.
- `checkpoint-mixin` conserva checkpoints de subagentes.
- `graphify-protocol` define consulta, degradación y evidencia de Graphify.
- Las skills `review-*` aportan las lentes del review de riesgo, legibilidad,
  confiabilidad y resiliencia.

Una skill aporta instrucciones; no registra agentes ni sustituye el manifiesto
de plugins. Si una instrucción de esta página contradice el `SKILL.md` instalado,
prevalece el contrato instalado y el conflicto debe documentarse.
