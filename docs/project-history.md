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
