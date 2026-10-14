> **Histórico:** el modelo `.workspace` de este documento fue retirado del recorrido operativo. Consultá [../project-history.md](../project-history.md) y [../README.md](../README.md).

## 3. Anatomía del Workspace y persistencia

FlowTask separa los activos estáticos (.flowtask) de los datos dinámicos de ejecución (.workspace y Engram).

```text
PROYECTO/
├── .flowtask/              <-- [ESTÁTICO / INSTALACIÓN]
│   ├── agents/             # Prompts base de los agentes
│   ├── skills/             # MDs con protocolos (memory, etc.)
│   ├── plugins/            # Lógica de extensión (JS/TS)
│   └── bin/                # CLI y lógica de instalación
│
├── .workspace/             <-- [DINÁMICO / LOCAL]
│   ├── CA-001/             # Carpeta por Change Request
│   │   ├── ca.md           # Requisitos formalizados
│   │   └── plan.md         # Pasos de implementación
│   └── ...
│
└── ENGRAM (Global/DB)      <-- [DINÁMICO / PERSISTENTE]
    ├── flow-state/         # Checkpoints de sub-agentes
    ├── instances/          # Task IDs y Nombres (Handshake)
    └── architecture/       # Decisiones de diseño a largo plazo
```
