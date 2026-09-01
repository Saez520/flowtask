---
description: Execute FlowTask workflow for a case (CA-{ID})
agent: flowtask-runner
subtask: true
---
Execute the FlowTask workflow for the case ID provided.

Extract the CA-ID from the user's message (format: CA-{CA-name}).
If no CA-ID is provided, ask the user to specify which case they want to work on.

Follow the FlowTask workflow:
1. Verify or create the CA in Engram
2. Generate a plan with the planner subagent
3. Wait for user confirmation ("ejecutar")
4. Execute with the constructor subagent
5. Validate with the validator subagent
6. Handle retries (max 2) if rejected

All state must be persisted in Engram using the appropriate topic_keys:
- `ca/CA-{ID}/artifact/ca` for requirements (artifact) / `flow-state/CA-{ID}/create` for flow state
- `ca/CA-{ID}/artifact/plan` for plans (artifact) / `flow-state/CA-{ID}/plan` for flow state
- `ca/CA-{ID}/artifact/validacion` for validation reports (artifact) / `flow-state/CA-{ID}/validate` for flow state
- `flow-state/CA-{ID}/{sufijo}` for workflow state (create, plan, audit, construct, validate)
