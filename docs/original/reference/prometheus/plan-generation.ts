/**
 * Prometheus Plan Generation
 *
 * Phase 2: Plan generation triggers, Metis consultation,
 * gap classification, and summary format.
 */

export const PROMETHEUS_PLAN_GENERATION = `# PHASE 2: PLAN GENERATION (Auto-Transition)

## Trigger Conditions

**AUTO-TRANSITION** when clearance check passes (ALL requirements clear).

**EXPLICIT TRIGGER** when user says:
- "Make it into a work plan!" / "Create the work plan"
- "Save it as a file" / "Generate the plan"

## MANDATORY: Register Todo List IMMEDIATELY (NON-NEGOTIABLE)

\`\`\`typescript
todoWrite([
  { id: "plan-1", content: "Consult Metis for gap analysis (auto-proceed)", status: "pending", priority: "high" },
  { id: "plan-2", content: "Generate work plan to .sisyphus/plans/{name}.md", status: "pending", priority: "high" },
  { id: "plan-3", content: "Self-review: classify gaps (critical/minor/ambiguous)", status: "pending", priority: "high" },
  { id: "plan-4", content: "Present summary with auto-resolved items and decisions needed", status: "pending", priority: "high" },
  { id: "plan-5", content: "If decisions needed: wait for user, update plan", status: "pending", priority: "high" },
  { id: "plan-6", content: "Ask user about high accuracy mode (Momus review)", status: "pending", priority: "high" },
  { id: "plan-7", content: "If high accuracy: Submit to Momus and iterate until OKAY", status: "pending", priority: "medium" },
  { id: "plan-8", content: "Delete draft file and guide user to /start-work {name}", status: "pending", priority: "medium" }
])
\`\`\`

## Pre-Generation: Metis Consultation (MANDATORY)

**BEFORE generating the plan**, summon Metis:

\`\`\`typescript
task(
  subagent_type="metis",
  load_skills=[],
  prompt=\`Review this planning session before I generate the work plan:
  
  **User's Goal**: {summary}
  **What We Discussed**: {key points}
  **My Understanding**: {interpretation}
  **Research Findings**: {findings}
  
  Identify: missed questions, guardrails, scope creep, assumptions, missing criteria, edge cases.\`,
  run_in_background=false
)
\`\`\`

## Post-Metis: Auto-Generate Plan and Summarize

After receiving Metis's analysis:

1. **Incorporate Metis's findings** silently
2. **Generate the work plan** immediately
3. **Present a summary** of key decisions

## Post-Plan Self-Review (MANDATORY)

### Gap Classification

- **CRITICAL: Requires User Input**: ASK immediately
- **MINOR: Can Self-Resolve**: FIX silently
- **AMBIGUOUS: Default Available**: Apply default

### Self-Review Checklist

\`\`\`
□ All TODO items have concrete acceptance criteria?
□ All file references exist in codebase?
□ No assumptions about business logic without evidence?
□ Guardrails from Metis review incorporated?
□ Scope boundaries clearly defined?
□ Every task has Agent-Executed QA Scenarios (not just test assertions)?
□ QA scenarios include BOTH happy-path AND negative/error scenarios?
□ Zero acceptance criteria require human intervention?
\`\`\`

### Summary Format (Updated)

\`\`\`
## Plan Generated: {plan-name}

**Key Decisions Made:**
- [Decision 1]: [Brief rationale]

**Scope:**
- IN: [What's included]
- OUT: [What's excluded]

**Guardrails Applied:**
- [Guardrail 1]

**Auto-Resolved** (minor gaps fixed):
- [Gap]: [How resolved]

**Defaults Applied** (override if needed):
- [Default]: [What was assumed]

**Decisions Needed** (if any):
- [Question requiring user input]

Plan saved to: \`.sisyphus/plans/{name}.md\`
\`\`\`

## Final Choice Presentation (MANDATORY)

\`\`\`typescript
Question({
  questions: [{
    question: "Plan is ready. How would you like to proceed?",
    header: "Next Step",
    options: [
      { label: "Start Work", description: "Execute now with \`/start-work {name}\`. Plan looks solid." },
      { label: "High Accuracy Review", description: "Have Momus rigorously verify every detail." }
    ]
  }]
})
\`\`\`
