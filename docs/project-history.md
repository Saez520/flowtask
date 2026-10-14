# Historial del proyecto

Este archivo conserva el relato histórico de elementos que existieron en
FlowTask y fueron retirados del sistema vigente. Es un documento de consulta y
aprendizaje: no describe cómo ejecutar, instalar ni reactivar nada de lo que
aquí se nombra.

Las capacidades vigentes se describen en `README.md` y en `docs/`.

---

## Comandos retirados

Los seis comandos siguientes existieron como comandos explícitos de FlowTask y
se retiraron del directorio canónico `.flowtask/commands/`, junto con sus
menciones activas en el manifiesto, los agentes, el plugin, la documentación
operativa y la documentación de arquitectura.

Evidencia común de deprecación: la documentación de arquitectura los declaraba
comandos legacy que el runner ya no requería (`docs/core-flowtask.md:97`, estado
anterior al retiro), y el registro pendiente `pending/deprecate-commands`
(Engram #3307) documenta que el desarrollador los había declarado deprecados por
redundancia con el enrutado por intención.

- **`init`** — Escaneo completo del proyecto que detectaba el stack y poblaba
  el contexto en Engram. Evidencia: `docs/core-flowtask.md:97`; Engram #3307.
- **`new-ca`** — Creación guiada de un CA a partir de una descripción del
  desarrollador. Evidencia: `docs/core-flowtask.md:97`; Engram #3307.
- **`run`** — Ejecución del flujo completo de un CA existente. Evidencia:
  `docs/core-flowtask.md:97`; Engram #3307.
- **`inspect`** — Entrada directa al Inspector para exploración y análisis sin
  CA. Evidencia: `docs/core-flowtask.md:97`; Engram #3307.
- **`evolve-agent`** — Entrada al modo de evolución de agentes de FlowTask.
  Evidencia: `docs/core-flowtask.md:97`; Engram #3307.
- **`status`** — Resumen de estado de FlowTask y de estadísticas de Engram.
  Evidencia: `docs/core-flowtask.md:97`; Engram #3307.

Los comandos por capa `init-types`, `init-data`, `init-business`, `init-config`,
`init-api`, así como `onboard` y `update`, permanecen vigentes y no fueron
retirados.

### Alcance del retiro

El retiro se aplicó únicamente al repositorio canónico. No se modificaron
instalaciones previas ni proyectos consumidores, y no se incorporó ninguna
rutina de migración, limpieza o compatibilidad.

---

## Documentación retirada del recorrido principal

Esta sección conserva conceptos que existieron, pero ya no describen instalación ni ejecución actual.

### Anatomía antigua

`anatomia-workspace.md` presentaba `.flowtask` como instalación estática, `.workspace` como datos dinámicos principales y Engram como almacenamiento separado. El modelo vigente usa targets `.opencode/flowtask`, `.claude/flowtask`, `.vscode/flowtask` o `.flowtask` standalone; los artifacts nuevos se guardan en Engram y `.workspace` solo queda como compatibilidad de CAs antiguos.

### Archivist y sub-orquestadores

`sub-agent-archivista.md`, `flowtask-sistematico.md`, `flujo-orquestacion.md` e `initializer.md` describían `flowtask-archivist`, `TECH-LEAD-ORCHESTRATOR` y expertos de stack no registrados en `opencode.json`. El cierre real usa `.flowtask/scripts/worktree.sh` y los agentes registrados por la configuración instalada.

### Classifier

`plugin-link.md` y los README del classifier describían inyección `FLOWTASK_CLASSIFICATION`. El manifest actual marca `classifier-hook` y `classifier-tui` `deprecated=true` y `enabled=false`; el installer los omite y limpia instalaciones antiguas. El source se conserva, pero no pertenece al camino normal.

### Snapshot Repomix/CA-008

El índice anterior, `Flowtask-Architecture/README.md` y `docs/architecture/flowtask-core.md` fueron generados alrededor de CA-008 y enlazaban módulos ausentes, roadmap y Archivist. Se conservan como antecedente; usar `docs/README.md`, `docs/core-flowtask.md` y el nuevo `docs/architecture/INDEX.md` para el presente.

### Instalación conceptual

`architecture/instalacion.md` no describía selección interactiva, manifest, markers ni configuración derivada. La guía normativa pasa a `docs/installation.md`.

### Claims no verificados

`lsp-ast-grep.md`, `sdd.md` y `presentacion-flowtask.md` contienen propuestas, cifras o roadmap no respaldados por contratos actuales. No citarlos como capacidades disponibles.

Los documentos históricos que permanecen físicamente comienzan con un aviso que remite a este archivo y a `docs/README.md`. No se eliminan porque pueden ser inputs externos de NotebookLM.
