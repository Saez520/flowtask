> **Historical:** the `.workspace` model in this document was retired from the operational path. See [../project-history.md](../project-history.md) and [../README.md](../README.md).

## 3. Workspace anatomy and persistence

FlowTask separates static assets (.flowtask) from dynamic execution data (.workspace and Engram).

```text
PROJECT/
├── .flowtask/              <-- [STATIC / INSTALLATION]
│   ├── agents/             # Base agent prompts
│   ├── skills/             # MDs with protocols (memory, etc.)
│   ├── plugins/            # Extension logic (JS/TS)
│   └── bin/                # CLI and installation logic
│
├── .workspace/             <-- [DYNAMIC / LOCAL]
│   ├── CA-001/             # Folder per Change Request
│   │   ├── ca.md           # Formalized requirements
│   │   └── plan.md         # Implementation steps
│   └── ...
│
└── ENGRAM (Global/DB)      <-- [DYNAMIC / PERSISTENT]
    ├── flow-state/         # Subagent checkpoints
    ├── instances/          # Task IDs and Names (Handshake)
    └── architecture/       # Long-term design decisions
```
