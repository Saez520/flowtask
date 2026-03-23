---
description: Explore and validate any aspect of the project without creating a CA
agent: flowtask-runner
subtask: true
---
Activate the Inspector agent to answer questions about the project.

1. Extract the question or topic from the user's message.
   - Format: `/inspect [question]`
   - If no question is provided, ask the user what they want to explore or validate.

2. Determine the context:
   - If the question is about .flowtask/ agents, commands, or skills → activate Inspector in Evolution Mode (read-only)
   - If the question is about the project code → activate Inspector in normal mode

3. Activate @flowtask-inspector with the question and context:
   - Inspector searches Engram first for fast answers
   - If not found in Engram, Inspector reads relevant project files
   - Inspector responds with tradeoffs and GAPs relevant to the question
   - Inspector asks: "Do you want to create a CA to make changes based on this?"

4. If the user wants to proceed with changes:
   - If it's a .flowtask/ change → redirect to /evolve-agent
   - If it's a project change → redirect to /new-ca

5. If the user does not want to proceed → end the flow.

Important rules:
- Inspector NEVER modifies any files (project or .flowtask/)
- If the question is about project code and NOT in Evolution Mode, Inspector responds only from Engram context
- Runner NEVER does the analysis itself — always delegates to Inspector
