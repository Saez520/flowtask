---
description: Initialize FlowTask in current project
agent: flowtask-initializer
subtask: true
---
Initialize FlowTask in this project:

## 0. CRITICAL - Verificar MCP Activo PRIMERO

**NUNCA continues without this verification. Este paso es OBLIGATORIO.**

Run: `mem_stats` (herramienta MCP)

- Si la llamada **éxito** → MCP activo, continuar con paso 1
- Si la llamada **falla** → Mostrar mensaje de reinicio y DETENERSE

**Mensaje si MCP inactivo:**
```
══════════════════════════════════════════════════════
⚠️ MCP de Engram NO está activo

El servidor MCP no está disponible. Esto significa que
OpenCode no ha sido reiniciado después de configurar
el MCP en opencode.json.

PASOS:
1. Cierra OpenCode completamente
2. Abre OpenCode nuevamente
3. Ejecuta /init de nuevo

NO se ejecutará ningún escaneo hasta que el MCP esté activo.
══════════════════════════════════════════════════════
```

**Solo si MCP activo:** Continuar con los pasos 1-6.

---

## 1. Verify Engram installation

Run: `engram --version`

If Engram is NOT installed:
- macOS/Linux: Run `brew install gentleman-programming/tap/engram`
- Or download from: https://github.com/Gentleman-Programming/engram/releases
- Verify: `engram --version` should output a version number

If Engram IS installed but not running:
- Start the MCP server: `engram serve &`

## 2. Configure Engram MCP in opencode.json

Check if opencode.json exists and contains the engram MCP configuration.

If NOT configured, add this entry to the `mcp` section:
```json
"engram": {
  "type": "local",
  "command": ["engram", "mcp"],
  "enabled": true
}
```

## 3. Scan the project

Run parallel scans for all project layers:

### Detect technology stack
- Run `find . -maxdepth 3 -type f | head -100` to understand project structure
- Detect language: look for *.ts, *.py, *.go, *.rs, *.js, etc.
- Detect build tool: package.json, go.mod, Cargo.toml, etc.

### Scan layers (run in parallel if possible)
- Types/Models: Look for types, models, schemas, interfaces, structures directories
- Data: Look for data, db, persistence, storage, accessor, repo, repositories directories
- Business: Look for business, logic, domain, core, usecase, handler, manager, service directories
- API: Look for api, route, routes, endpoint, endpoints, handler, handlers, controller directories
- Config: Look for config, settings, properties, .env files

## 4. Populate Engram with project context

For each layer detected, save to Engram:

### Stack information
```
mem_save(
  type: "config",
  scope: "project",
  topic_key: "project/stack",
  title: "Project stack: {detected_name}",
  content: "Language: {lang}\nFramework: {framework}\nBuild: {build}"
)
```

### Layers structure
```
mem_save(
  type: "discovery",
  scope: "project",
  topic_key: "project/layers",
  title: "Project layers",
  content: "Layers detected:\n- types: {path}\n- data: {path}\n- business: {path}\n- api: {path}\n- config: {path}"
)
```

### Conventions per layer
```
mem_save(
  type: "pattern",
  scope: "project",
  topic_key: "project/{layer}",
  title: "{Layer} conventions",
  content: "**Path**: {path}\n**Naming**: {patterns}\n**Patterns**: {examples}"
)
```

Use `mem_suggest_topic_key` before each save for consistency.

## 5. Generate project-context.md

Create or update `project-context.md` with:
- Detected stack
- Layers structure
- Naming conventions summary
- Key patterns summary

## 6. Report status

Display:
- What was detected (stack, layers, patterns)
- What was saved to Engram
- How to start using FlowTask
