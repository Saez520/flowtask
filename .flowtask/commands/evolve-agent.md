---
description: Evolve a FlowTask agent using the full CA → Plan → Implement cycle
agent: flowtask-runner
subtask: true
---
Activate Evolution Mode to evolve a FlowTask agent.

1. Extract the agent name and evolution description from the user's message.
   - Format: `/evolve-agent [agent-name] [description]`
   - Valid agent names: ca-writer, planner, plan-auditor, constructor, validator, inspector, runner, initializer, logger, tester
   - If no agent name is provided, ask the user which agent they want to evolve.
   - If no description is provided, ask the user what change they need.

2. Activate @flowtask-ca-writer in Evolution Mode:
   - Pass the agent name and evolution description
   - The CA-Writer will converse with the user, validate tradeoffs/GAPs, and generate a SPEC
   - CA-Writer saves the CA to Engram (topic_key: ca/CA-evolve-{agent}-{timestamp}/artifact/ca)

3. Once the CA is saved, activate @flowtask-planner:
    - Pass the CA topic_key and the Evolution Mode flag
    - The Planner generates a plan of changes to .flowtask/ files
    - Planner saves the plan to Engram (topic_key: ca/CA-evolve-{agent}-{timestamp}/artifact/plan)

4. ALWAYS activate @flowtask-plan-auditor in Evolution Mode (mandatory, regardless of task count):
   - Plan-Auditor reviews the plan of .flowtask/ changes
   - Reports blockers if any

5. Present the plan to the user.
5a. Aplicar Gate de Ejecución sobre el plan; abortar si falla.

6. Once Gate PASS and user confirmation ("ejecutar"), activate @flowtask-constructor in Evolution Mode:
   - Constructor modifies files in .flowtask/agents/, .flowtask/commands/, or .flowtask/skills/
   - Constructor reports what was changed

7. Confirm to the user that the agent was evolved successfully.

Important rules:
- Runner NEVER modifies .flowtask/ files directly
- Plan-Auditor is ALWAYS invoked in Evolution Mode (no task count threshold)
- Only .flowtask/ files are in scope — never project code files
- The user MUST confirm before Constructor runs (no --auto bypass in Evolution Mode)
