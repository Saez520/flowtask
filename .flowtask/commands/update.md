---
description: Update FlowTask installation: sync agents, skills, plugins and config
agent: flowtask-initializer
subtask: true
---
Update the FlowTask installation in the current project.

1. Detect installed targets from `.installation-method` markers.
2. Sync canonical agents, commands, skills, scripts and target configuration.
3. Reinstall manifest plugins and regenerate derived configuration.
4. Preserve supported artifacts and report failures.
5. Coordinate Graphify and report the result.

If no target exists, ask the developer to run `flowtask install`. Do not invoke `update-engram.ps1`.
