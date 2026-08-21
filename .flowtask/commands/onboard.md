---
description: Evaluate developer experience level and assign a runner personality
agent: flowtask-runner
subtask: true
---
Activate the onboarder to evaluate developer level and assign a personality.

1. Detect the command as COMMAND:/onboard.
   - The user typed `/onboard` (possibly with additional text).
   - Extract any additional context the user provided.

2. Activate @flowtask-onboarder with the user's prompt.
   - Pass the full user message as context.
   - The onboarder will conduct the full flow autonomously:
     - Verify `project/stack` exists in Engram (error if not: "Ejecutá `/init` primero")
     - Detect stack changes and update if needed
     - Generate 4 questions based on the real project stack
     - Conduct the quiz one question at a time
     - Determine level by majority heuristic with tiebreakers
     - Assign personality: training→tutor-training, mid→tutor-mid, senior→tutor-senior
     - Inject personality between PERSONA_START/PERSONA_END markers in runner.md
      - Persist profile to `TARGET_DIR/config/profile.json`

3. After the onboarder completes:
   - If the onboarder assigned a personality, the runner now operates with that personality injected in runner.md. Acknowledge the new personality to the user.
   - If the onboarder reported that `project/stack` doesn't exist, relay the message: "Ejecutá `/init` primero para que FlowTask conozca tu proyecto."
   - No further action needed from the runner.

Important rules:
- Runner NEVER conducts the quiz itself — always delegate to @flowtask-onboarder
- Runner NEVER modifies runner.md personality content — the onboarder does it
- The onboarder maintains quiz state internally (one question at a time)
- The onboarder handles all edge cases: stack missing, quiz abandonment, marker absence
- Re-running `/onboard` is safe and idempotent — the personality content is replaced, not duplicated
