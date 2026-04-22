---
description: Update Engram binary to the latest version
agent: build
---
Update Engram to the latest version:

1. Execute the automated update script:
   - Call `./update-engram.ps1`

2. Verify the output:
   - If successful, it will report "ACTUALIZACION COMPLETADA CON EXITO"
   - If it fails, it will attempt an automatic rollback and report the error

3. Instructions for the agent:
   - If the update requires a restart of the MCP server, notify the user.
   - The script handles backup, process termination, and validation automatically.
