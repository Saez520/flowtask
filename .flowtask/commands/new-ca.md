---
description: Create a new Acceptance Criteria (CA) with guided clarification
agent: flowtask-runner
subtask: true
---
Create a new Acceptance Criteria (CA) with guided clarification:

1. Extract the CA-ID from the user's message (format: CA-{CA-name}).
   If no ID is provided, ask for one.

2. If the user provided a brief description along with the ID, note it.
   If not, ask what they need to implement.

3. Route through the runner: the runner performs the handshake and then activates @flowtask-ca-writer.

4. The ca-writer will:
   - Guide a conversation to clarify business requirements
   - Ask about edge cases, failure conditions, and business rules
   - When real doubts or material decisions remain, keep the CA in `draft` and continue clarification
   - When the requirement is resolved, formalize and save the complete CA to Engram (topic_key: ca/CA-{ID}/artifact/ca)
   - Include tradeoffs and GAPs with the delivery; do not request a separate approval when no blocker remains

5. Report to the user that the CA is ready in Engram only after artifact and snapshot persistence are confirmed. If blockers remain, keep clarification open and do not announce availability.

Example usage:
> /new-ca CA-onboarder-agent
> /new-ca CA-onboarder-agent: I need to add user authentication
> /new-ca
