---
description: Create a new Acceptance Criteria (CA) with guided clarification
agent: flowtask-ca-writer
subtask: true
---
Create a new Acceptance Criteria (CA) with guided clarification:

1. Extract the CA-ID from the user's message (format: CA-{NUMBER}).
   If no ID is provided, ask for one.

2. If the user provided a brief description along with the ID, note it.
   If not, ask what they need to implement.

3. Activate @flowtask-ca-writer with the CA-ID and description.

4. The ca-writer will:
   - Guide a conversation to clarify business requirements
   - Ask about edge cases, failure conditions, and business rules
   - Generate a structured CA draft
   - Save the approved CA to Engram (topic_key: ca/{ID})

5. Report to the user that the CA is ready in Engram.

Example usage:
> /new-ca CA-001
> /new-ca CA-001: I need to add user authentication
> /new-ca
