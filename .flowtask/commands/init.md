---
description: Initialize FlowTask in current project
agent: flowtask-initializer
subtask: true
---
Initialize FlowTask in this project:

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
- Detect language: look for *.java, *.ts, *.py, *.go, *.rs, etc.
- Detect build tool: package.json, pom.xml, build.gradle, go.mod, Cargo.toml, etc.

### Scan layers (run in parallel if possible)
- Types/Models: Look for dto, entity, model, type, schema, interface directories
- Data Access: Look for repository, dao, data, persistence, db directories
- Services: Look for service, manager, handler, usecase, business directories
- API: Look for controller, route, api, endpoint, router directories
- Config: Look for config, settings, properties, .env files

## 4. Populate Engram with project context

For each layer detected, save to Engram:

### Stack information
```
mem_save(
  type: "config",
  topic_key: "project/stack",
  title: "Project stack: {detected_name}",
  content: "Language: {lang}\nFramework: {framework}\nBuild: {build}"
)
```

### Layers structure
```
mem_save(
  type: "discovery",
  topic_key: "project/layers",
  title: "Project layers",
  content: "Layers detected:\n- types: {path}\n- data-access: {path}\n- services: {path}\n- api: {path}\n- config: {path}"
)
```

### Conventions per layer
```
mem_save(
  type: "pattern",
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
