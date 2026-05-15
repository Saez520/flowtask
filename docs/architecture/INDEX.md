# Índice de Fuentes — FlowTask

> **Nota (CA-008)**: Esta carpeta unifica `Architecture/` (18 archivos generados de repomix-output.xml) + `New Architecture/` (6 archivos de diseño conceptual) en `docs/architecture/`. Las referencias relativas entre archivos se mantienen intactas.

Conversión de `repomix-output.xml` (247 KB, 7,273 líneas) a archivos Markdown organizados por módulo para uso como fuentes en NotebookLM. El archivo XML original fue generado por Repomix y contiene una representación empaquetada del repositorio completo.

## Estadísticas globales

| Métrica | Valor |
|---------|-------|
| Archivos totales en el XML | 61 |
| Archivos incluidos en los módulos | 59 |
| Archivos filtrados (excluidos) | 2 |
| Módulos generados | 7 |
| Archivos Markdown de salida | 8 (INDEX + 7 módulos) |

**Archivos excluidos:**

| Archivo | Motivo |
|---------|--------|
| `.flowtask/checkpoints/.gitkeep` | Archivo vacío, sin valor documental |
| `.engram/config.json` | Autogenerado (`{"project_name": "flowtask"}`), sin configuración manual |

## Tabla de contenidos

| Módulo | Archivo | Archivos | Descripción |
|--------|---------|----------|-------------|
| 01 | [01-agentes.md](./01-agentes.md) | 10 | Agentes de FlowTask: definiciones de comportamiento de cada subagente del sistema de orquestación (runner, planner, constructor, validator, etc.) |
| 02 | [02-skills.md](./02-skills.md) | 9 | Skills del sistema: módulos de conocimiento especializado cargables bajo demanda (memory-protocol, plan-template, checkpoint-mixin, etc.) |
| 03 | [03-implementacion.md](./03-implementacion.md) | 7 | Núcleo de implementación del CLI: binario principal y librerías de soporte (flujo de instalación, generación de agentes, logging, UI) |
| 04 | [04-plugins.md](./04-plugins.md) | 10 | Sistema de plugins: clasificador de intención (flowtask-classifier) y punto de entrada del sistema de plugins |
| 05 | [05-comandos.md](./05-comandos.md) | 12 | Comandos FlowTask: definiciones de los comandos disponibles para el usuario (/run, /inspect, /init, /new-ca, /status, etc.) |
| 06 | [06-config-y-scripts.md](./06-config-y-scripts.md) | 9 | Configuración y scripts auxiliares: manifiestos de Engram, package.json, config de OpenCode/Claude, y scripts de sincronización |
| 07 | [07-readme-y-raiz.md](./07-readme-y-raiz.md) | 2 | Documentación raíz: README del proyecto y reglas de ignorados de Git (.gitignore) |

---

## Documentos de Diseño Conceptual (ex-`New Architecture/`)

Archivos de diseño arquitectónico consolidados desde `New Architecture/` (CA-008).

| Archivo | Descripción |
|---------|-------------|
| [flowtask-core.txt](./flowtask-core.txt) | Diagrama del ecosistema core: Runner, Plugins, Skills, Memoria (Engram) y Agentes |
| [handshake.txt](./handshake.txt) | Protocolo Handshake: identidad, continuidad y self-healing de agentes |
| [anatomia-workspace.txt](./anatomia-workspace.txt) | Anatomía del workspace: `.flowtask/` (estático) vs `.workspace/` + Engram (dinámico) |
| [instalacion.txt](./instalacion.txt) | Guía de instalación y configuración de FlowTask |
| [integracion-skills.txt](./integracion-skills.txt) | Integración de skills en el sistema de agentes |
| [Plugin-Link.txt](./Plugin-Link.txt) | Mecanismo de enlace de plugins |

## Documentos de Arquitectura Conceptual (`.txt` originales)

| Archivo | Pilar | Descripción |
|---------|-------|-------------|
| [worktree.txt](./worktree.txt) | P1 — Git Worktrees | Diseño conceptual de aislamiento con Git Worktrees |
| [sub-agent-archivista.txt](./sub-agent-archivista.txt) | P1 — Git Worktrees | Flujo del sub-agente Archivist |
| [engram-cloud.txt](./engram-cloud.txt) | P2 — Engram | Estructura de memoria de Engram y sincronización cloud |
| [LSP + AST-Grep.txt](./LSP + AST-Grep.txt) | P3 — LSP+AST-Grep | Comparativa de flujo actual vs optimizado (91% reducción) |
| [flujo-orquestacion.txt](./flujo-orquestacion.txt) | Transversal | Flujo de orquestación del Runner |
| [floswtask-sistematico.txt](./floswtask-sistematico.txt) | Transversal | Visión sistemática de FlowTask |
| [initializer.txt](./initializer.txt) | Transversal | Diseño del sub-agente Initializer |
| [SDD.txt](./SDD.txt) | Transversal | Specification-Driven Development en FlowTask |

---

Generado desde `repomix-output.xml` — snapshot del repositorio FlowTask. Los archivos preservan el contenido original 1:1 y el orden de aparición en el XML. Unificación de arquitectura completada en CA-008.
