> **Historical:** this presentation preserves a roadmap and design claims that do not necessarily describe the current system. See [docs/README.md](docs/README.md).

# FlowTask — Presentation Guide

> Audience: AI Lead (technical)
> Main focus: Engram as a persistent memory system
> Format: Talking points by topic

---

## 1. What is FlowTask?

- An **orchestrated multi-agent system** for software development
- It is not a chatbot — it is a pipeline of specialized agents with shared memory
- Each agent has a bounded role, strict rules, and CANNOT leave its scope
- The developer talks to a SINGLE entry point: the **Runner** (orchestrator)
- It works on Claude Code and OpenCode (dual support)

---

## 2. Delegation System

**Key concept**: The Runner never executes — it only classifies and delegates.

```
Developer → Runner → Classifies intent → Delegates to the right agent
```

### Main flow (5 agents in sequence):

```
CA-Writer → Planner → Constructor → Validator
    ↑                                    |
    └──── Runner (orchestrates everything) ────────┘
```

1. **CA-Writer**: Defines the requirement (what will be done)
2. **Planner**: Generates the technical plan (how it will be done)
3. **Constructor**: Implements the plan (writes code)
4. **Validator**: Validates that the implementation meets the plan

### Other agents (they exist, do not go deeper):
- **Inspector**: Explores and answers questions about the project
- **Tester**: Generates tests
- **Logger**: Instruments logging
- **Initializer**: Scans and maps the project
- **Plan Auditor**: Audits complex plans

---

## 3. Key Rules per Agent (the 2 most important)

| Agent | Rule 1 | Rule 2 |
|-------|--------|--------|
| **Runner** | Never executes directly — only delegates | Never skips checkpoints without developer confirmation |
| **CA-Writer** | Leads the conversation until ambiguities are removed | Does not generate plan or code — only the spec |
| **Planner** | Generates a decision-complete plan (no assumptions) | Respects project conventions read from Engram |
| **Constructor** | Only implements what the plan says — nothing more | Does not make design decisions |
| **Validator** | Validates against the plan, not personal opinion | Maximum 2 rejections — then escalates to the developer |

---

## 4. The Execution Flow

```
CA-{ID}
```

**Step 1** — Does the CA exist? If not → CA-Writer creates it with the developer
**Step 2** — Planner generates the technical plan
**Step 3** — **Technical gate**: verifies plan/audit; if it passes, construction starts without waiting
**Step 4** — Constructor implements
**Step 5** — Validator validates
**Step 6** — If it rejects twice → escalates to the developer

- Agreed corrections run as a Hotfix (HF), without CA ceremony
- `--auto` does not add permissions: it declares that there is no routine wait

---

## 5. ⭐ ENGRAM — Persistent Memory (MAIN FOCUS)

### What is it?

- **Engram** is the shared memory system across all agents
- It persists across sessions — agents "remember" what happened before
- It is the difference between a stateless chatbot and a team with context

### What problem does it solve?

LLMs have no memory across sessions. Every conversation starts from scratch.
Engram gives FlowTask:
- **Continuity**: One agent resumes where another left off
- **Shared context**: All agents see the same decisions
- **Traceability**: Every decision is recorded with its "why"

### How do agents use it?

**Memory protocol (data contract):**
```
mem_save()    → Persists decisions, findings, states
mem_search()  → Searches historical information
mem_context() → Recovers recent events
mem_session_summary() → Closes a session with a report
```

**Each entry has structure:**
- **What**: What was done or found
- **Why**: Why that decision was made
- **Where**: Which files/modules it affects
- **Learned**: Lessons learned (optional)

### What does the Runner do with Engram when each session starts?

Every time the Runner starts (new conversation or session), it runs this flow:

1. **Classifies the developer's intent** (new CA? continue an existing one?)
2. **Searches Engram** for an existing instance map for that CA
   - `mem_search("flow-state/{CA-ID}/instances")`
3. **Recovers or assigns identity**:
   - If it finds a map → recovers the BaseName (e.g., "Aitana") and the active task_ids
   - If none exists → assigns the next available name from the list
4. **Decides: new thread or resumption?**
   - If there is an active task_id → builds a **Resume Prompt** with the last checkpoint
   - If not → creates an **Initial Prompt** with context injected from Engram
5. **Injects context** before delegating:
   - `mem_context()` + `mem_search()` → everything relevant about the CA
   - Wraps it in a `<project_context>` block inside the agent prompt
6. **Delegates to the agent** with all the information — the agent never starts from scratch

> **In short**: The Runner uses Engram as its "hard drive" — every new session is an intelligent resumption, not a cold start.

### Concrete use cases in FlowTask:

**1. Handshake Protocol (Agent identity)**
- Each CA has an assigned "base name" (e.g., Aitana, Kael, Lyra...)
- Agents are instantiated as `Aitana-planner`, `Aitana-constructor`
- This map is persisted in Engram → if the session crashes, it is recovered
- The Runner searches Engram before creating an agent: does it already exist? → resumes it

**2. Flow State (Flow status)**
- Each pipeline step stores its state in Engram
- If the Constructor finishes and the session closes, the Validator knows exactly where it left off
- Topic keys: `flow-state/{CA-ID}/planner`, `flow-state/{CA-ID}/constructor`, etc.

**3. Context Injection**
- Before invoking an agent, the Runner queries Engram
- It injects the relevant context into the agent prompt
- The agent does not start from scratch — it starts with prior decisions

**4. Checkpoint & Resume**
- If a thread is lost (timeout, crash), the Runner detects the failure
- It searches for the last checkpoint in Engram
- It relaunches the agent with a "Resume Prompt" that includes the mini-summary
- **Self-Healing**: clears the failed task_id and retries automatically

**5. Project Conventions**
- The Initializer scans the project and stores conventions in Engram
- The Planner reads them before generating a plan → respects existing patterns
- The Constructor reads them before implementing → consistent code

**6. Session Summaries**
- At the end of each flow, a summary is stored:
  - Goal, what was achieved, discoveries, next steps, key files
- This feeds the project's long-term memory

**7. Resilience (Buffer Protocol)**
- If Engram is unavailable, agents serialize to temporary files
- When Engram returns, they synchronize automatically
- No information is lost

### Why is it the jewel?

> Without Engram, FlowTask would be an agent pipeline without memory.
> With Engram, it is a team that learns, remembers, and recovers from failures.

Memory turns independent agents into a **coherent system with state**.

---

## 6. What's Next (Roadmap)

### Active stabilization

| Item | What it involves |
|------|------------------|
| task_id persistence in Handshake | The Runner assigns identity but sometimes does not persist it — fix in progress |
| Runner identity reinforcement | Ensure it always assumes its correct role when starting a session |
| CA ID consistency | The CA-Writer must verify the real sequence before assigning |
| Post-save verification in Engram | Confirm that data was actually saved before reporting success |

### Pipeline improvements

| Item | What it involves |
|------|------------------|
| Stricter Validator | Integration with Tester, runtime validation (not only static) |
| Context degradation mitigation | Progressive rule injection mechanism when context grows |
| Zero-Assumptions Protocol | Audit all agent prompts to eliminate unverified assumptions |

### Architectural evolution

| Item | What it involves |
|------|------------------|
| Parallel orchestration | Runner executing independent agents in parallel |
| FlowTask 2.0 — Hybrid Context | Engram as an MCP Server, LSP/ast-grep integration, ephemeral workspace |
| Shareable workspace | Protocol to share `.workspace` across teams without collisions |
| Purge Protocol | Automatic cleanup of expired task_ids in Engram |

### Integration: sdd-engram-plugin

- **Plugin to configure AI models directly per subagent** from the TUI
- SDD (Spec-Driven Development) profile management
- Allows changing provider/model for any agent without restarting
- Per-agent fallback: if a model fails, it falls back to the configured secondary model
- Bulk actions to assign models to the entire profile at once
- Profile versioning: preview and rollback before risky changes
- Automatic detection of the active profile
- **Why does it matter?** Granular control over which model each pipeline agent uses

---

## 7. Closing

**FlowTask is not just a wrapper around LLMs.**
It is a system of agents with:
- Strict, bounded roles
- A verifiable flow with checkpoints
- Shared persistent memory (Engram)
- Self-healing on failure
- And a roadmap toward intelligent orchestration

Memory is what transforms "loose agents" into a **team with context**.
