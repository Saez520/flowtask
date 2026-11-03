> **Historical:** this whitepaper was generated around CA-008 and preserves retired designs, roadmap items, and references. It does not describe the current installation or execution. See [docs/README.md](../docs/README.md).

# FlowTask Architecture — Technical Whitepaper

> **TL;DR**: FlowTask is a system of autonomous agents that execute development tasks in isolated environments, with persistent memory across sessions and radical context optimization to scale to large projects. This document explains the three pillars that make it possible and the roadmap toward its open-source version.

**Reading time**: ~5 minutes  
**Last update**: CA-008 (May 2026)  
**Full roadmap**: the CA-008 roadmap is preserved only as historical context in this document; it is not an executable guide.

---

## 1. What is FlowTask?

FlowTask is an **orchestrator of AI agents for software development**. Unlike a chatbot that writes code, FlowTask structures work into **Change Artifacts (CAs)** — formal units of change with requirements, plan, audit, construction, and validation. Each phase is executed by a specialized subagent (planner, constructor, validator, etc.) that works with persistent memory and optimized context.

### The flow of a CA

```
USER: "Flow for CA-018"
          │
          ▼
┌─────────────────────────────────────────────────┐
│  RUNNER (Orchestrator)                          │
│  Handshake → Assign identity (Kael-Planner...)  │
│  Delegate tasks sequentially                    │
└─────────────────────────────────────────────────┘
          │
          ├─ 1. CA-WRITER     → Formalize requirements in ca.md
          ├─ 2. PLANNER       → Generate implementation plan in Engram (ca/CA-{ID}/artifact/plan)
          ├─ 3. PLAN-AUDITOR  → Review coherence and references → audit.md in Engram (ca/CA-{ID}/artifact/audit)
          ├─ 4. CONSTRUCTOR   → Implement the plan (read plan.md from Engram, write code)
          └─ 5. VALIDATOR     → Verify acceptance criteria
```

Each CA produces versioned artifacts in Engram (ca/CA-{ID}/artifact/{filename}). Legacy CAs (~19) keep their artifacts in `.workspace/CA-{ID}/` as a fallback source (Dual-Source). Flow state is stored in **Engram** (persistent memory). If an agent fails or the session is interrupted, the Handshake Protocol allows the work to **resume exactly where it left off**.

---

## 2. The Three Technical Pillars

FlowTask rests on three pillars that differentiate it from conventional assistance tools:

### Pillar 1 — Isolation and Safety (Git Worktrees)

**What it is**: Each task delegated to subagents runs in an **isolated Git Worktree** (sandbox). Code is modified in that temporary environment. Only when the work is complete and verified does the **Archivist** integrate the changes into the main branch. If something fails, the isolated environment is discarded without affecting the project.

**Why it matters**: It is the guarantee that an autonomous agent **cannot corrupt the developer's code**. Without this pillar, FlowTask would be an assistance tool; with it, it is a delegable system with integrity safety.

**ASCII diagram**: See [`docs/architecture/worktree.md`](../docs/architecture/worktree.md) — conceptual design of the lifecycle with Git Worktrees.  
**Related artifact**: [`docs/architecture/archivist-sub-agent.md`](../docs/architecture/archivist-sub-agent.md) — Archivist subagent flow.

### Pillar 2 — Persistence and Self-Healing (Engram + Handshake)

**What it is**: **Engram** is the project's persistent memory. Each artifact (CA, plan, validation) and each flow state (flow-state) is stored with a structured `topic_key`. The **Handshake Protocol** assigns a stable identity to each agent (`BaseName-Agent`) and allows an agent, after a failure or interruption, to recover its state and continue where it left off.

**Why it matters**: Without persistent memory, every session starts blind. Without handshake, agents do not know who they are. This pillar turns FlowTask from a "chatbot that writes code" into a **system of agents with operational continuity**.

**Engram memory structure** (see [`docs/architecture/engram-cloud.md`](../docs/architecture/engram-cloud.md)):
- `project/*` — global project context (stack, conventions, layers)
- `ca/{ID}`, `plan/{ID}`, `validation/{ID}` — artifact snapshots
- `ca/CA-{ID}/artifact/{filename}` — full artifact content (ca-artifact)
- `flow-state/{ID}/*` — step-by-step control per CA
- `impl/{ID}/*` — implementation discoveries (decisions, patterns)

**Handshake Protocol** (see [`docs/architecture/handshake.md`](../docs/architecture/handshake.md)):
1. The Runner queries Engram: does a handshake exist for this CA?
2. If it is new: assign a BaseName from a predefined pool (Aitana, Kael, Lyra...)
3. If it is a continuation: recover `task_id`, read the last checkpoint, relaunch the agent with the full context

### Pillar 3 — Radical Context Optimization (LSP + AST-Grep)

**What it is**: The Planner currently uses **Glob + Grep** to discover files and read code — this sends **~1,400 lines (~2,200 tokens)** to the LLM, most of it noise. The combination of **LSP** (semantic symbol discovery) + **AST-Grep** (structural pattern extraction) reduces this to **19 exact lines (~180 tokens)**. A reduction of **91% of contextual noise**.

**Why it matters**: Context is the most expensive resource in LLM-based systems. Every token saved is speed, precision, and lower cost. This pillar allows FlowTask to scale to large projects without degradation.

**Comparison diagram**: See [`docs/architecture/lsp-ast-grep.md`](../docs/architecture/lsp-ast-grep.md) — current flow (Glob+Grep, 2,200 tokens) vs. optimized flow (LSP+AST-Grep, 180 tokens).

---

## 3. Roadmap (CA-008)

12 initiatives classified by impact level. **This roadmap is directional — it contains no dates or implementation strategies.** Each item will have its own CA when its execution time comes.

### Pillar 1 — Git Worktrees

| # | Item | Impact | Reference | Notes |
|---|------|--------|-----------|-------|
| P1.1 | Implement Git Worktree infrastructure for agent sandboxing | **HIGH** | Future CA | Each agent receives an ephemeral worktree. Creation, checkout, and automatic cleanup. |
| P1.2 | Archivist protocol: diff, review, and safe integration of changes | **HIGH** | Future CA | Diff between worktree and main branch. Pre-merge review. Atomic integration. |

### Pillar 2 — Engram + Handshake

| # | Item | Impact | Reference | Notes |
|---|------|--------|-----------|-------|
| P2.1 | `.workspace/` → Engram migration: mechanism analysis and implementation | **HIGH** | ✅ CA-ARTIFACTOS-ENGRAM | Dual-Source mechanism implemented. All 8 agents now persist artifacts in Engram. Legacy CAs (~19) with disk fallback. |
| P2.2 | #1081: Regression in Engram queries after update | **HIGH** | Engram #1081 | Agents stopped querying Engram proactively. |
| P2.3 | #1082: Progressive Rule Injection (Context Degradation) | **HIGH** | Engram #1082 | Runner loses coherence at ~100k tokens. |
| P2.4 | #1084: Zero-Assumptions Protocol | **HIGH** | Engram #1084 | Agents must validate against Engram before acting. |
| P2.5 | #1080: Runner Identity Instability | **MEDIUM** | Engram #1080 | Runner sometimes assumes the wrong role when starting a session. |

### Pillar 3 — LSP + AST-Grep

| # | Item | Impact | Reference | Notes |
|---|------|--------|-----------|-------|
| P3.1 | #1058: Integrate LSP + AST-Grep into the Planner | **HIGH** | Engram #1058 | Replace Glob+Grep with semantic discovery and structural extraction. 91% validation during execution. |
| P3.2 | #1083: Parallel Orchestration in Runner | **MEDIUM** | Engram #1083 | Run subagents in parallel when there are no sequential dependencies. |

### Cross-cutting — Governance and Structure

| # | Item | Impact | Reference | Notes |
|---|------|--------|-----------|-------|
| T.1 | `Flowtask-Architecture/` folder: technical whitepaper with the 3 pillars, roadmap, diagrams, and workflow | **HIGH** | This document | ✅ CA-008 deliverable. Foundational document for external developers. |
| T.2 | #1087: Validator — failure to detect runtime errors | **HIGH** | Engram #1087 | Validator does not detect runtime errors. It must be integrated with Tester. |
| T.3 | Unification of architecture folders: `Architecture/` + `New Architecture/` → `docs/architecture/` | **MEDIUM** | ✅ Completed in CA-008 | 24 files consolidated with updated references. |
| T.4 | #1086: Validator Reinforcement (Adversarial Mindset) | **MEDIUM** | Engram #1086 | Validator is lax. It needs a rigorous QA mindset. |

### Summary by Impact

| Impact | Count | Items |
|--------|-------|-------|
| **HIGH** | 9 | P1.1, P1.2, P2.1, P2.2, P2.3, P2.4, P3.1, T.1, T.2 |
| **MEDIUM** | 4 | P2.5, P3.2, T.3, T.4 |

---

## 4. Engram References (Pending)

| Ref | ID | Type | Title |
|-----|----|------|-------|
| #1057 | 1057 | architecture | Code discovery strategy in the Planner (predecessor of #1058) |
| #1058 | 1058 | decision | Pending: Integrate LSP + AST-Grep into the Planner |
| #1080 | 1080 | bugfix | Pending: Runner Identity Instability |
| #1081 | 1081 | bugfix | Pending: Regression in Engram queries after update |
| #1082 | 1082 | architecture | Pending: Progressive Rule Injection (Context Degradation) |
| #1083 | 1083 | architecture | Pending: Parallel Orchestration and Thinking in Runner |
| #1084 | 1084 | pattern | Pending: Zero-Assumptions Protocol (Proactive Validation) |
| #1086 | 1086 | pattern | Pending: Validator Subagent Reinforcement (Rigorous QA) |
| #1087 | 1087 | bugfix | Pending: Validator — Failure to detect runtime errors |

The 9 pending items (with Engram IDs) are distributed across the roadmap by pillar and impact.

---

## 5. Project Structure

```
FlowTask/
├── Flowtask-Architecture/    ← This whitepaper (CA-008)
│   └── README.md
├── .flowtask/                ← Agents, skills, plugins (static)
│   ├── agents/
│   ├── skills/
│   └── plugins/
├── .workspace/               ← Legacy CA artifacts (pre-ARTIFACTOS-ENGRAM)
│   └── CA-{ID}/
│       ├── ca.md             ← Legacy: new CAs use Engram
│       ├── plan.md           ← Legacy: new CAs use Engram
│       └── audit.md          ← Legacy: new CAs use Engram
├── docs/architecture/        ← Unified architecture documentation
│   ├── INDEX.md              ← Index of all documents
│   ├── 01-agentes.md .. 09-workspace.md  ← Modules from repomix-output.xml
│   ├── worktree.md, lsp-ast-grep.md  ← ASCII diagrams of the pillars
│   └── handshake.md, flowtask-core.md  ← Designs from New Architecture
├── .engram/                  ← Engram configuration (persistent memory)
└── src/                      ← Project source code
```

### Architecture documentation

All technical documentation is in [`docs/architecture/`](../docs/architecture/). The full index is in [`INDEX.md`](../docs/architecture/INDEX.md).

**Documents generated from repomix-output.xml** (modules 01-09):
- Agents, skills, implementation, plugins, commands, configuration, README, Engram, workspace

**Conceptual design documents** (originally in `New Architecture/`):
- [`flowtask-core.md`](../docs/architecture/flowtask-core.md) — Core ecosystem
- [`handshake.md`](../docs/architecture/handshake.md) — Handshake Protocol
- [`workspace-anatomy.md`](../docs/architecture/workspace-anatomy.md) — Workspace anatomy

**ASCII diagrams of the pillars**:
- [`worktree.md`](../docs/architecture/worktree.md) — Pillar 1: Git Worktrees
- [`archivist-sub-agent.md`](../docs/architecture/archivist-sub-agent.md) — Archivist flow
- [`engram-cloud.md`](../docs/architecture/engram-cloud.md) — Pillar 2: Engram structure
- [`lsp-ast-grep.md`](../docs/architecture/lsp-ast-grep.md) — Pillar 3: LSP+AST-Grep optimization

---

## 6. For External Developers

### How to contribute

1. **Read this whitepaper** (5 minutes) to understand the pillars and the roadmap.
2. **Explore `docs/architecture/`** for detailed technical documentation.
3. **Review active CAs** in `.workspace/` to see the workflow in action.
4. **Pick a roadmap item** — create a new CA following the flow: CA → Plan → Audit → Construction → Validation.

### How to create a new CA

```
Request for a new CA: "Description of the change"
```

This starts the FlowTask flow: the CA-Writer formalizes the requirements, the Planner generates the plan, the Plan-Auditor reviews coherence, the Constructor implements, and the Validator verifies.

### Suggested priority

**HIGH** items should be addressed before **MEDIUM** ones, but within the same level there is no predefined order. Urgency is defined by the project context.

---

## 7. Tradeoffs and Design Decisions

| ID | Tradeoff | Decision |
|----|----------|----------|
| T1 | Roadmap without dates, only impact | Full flexibility for priority changes. |
| T2 | Flowtask-Architecture inside the repo | A single versioned place of truth; the whitepaper lives alongside the code. |
| T3 | Architecture unification in `docs/architecture/` | Coherent documentation for public consumption. |
| T4 | The 10 pending items are independent CAs | CA-008 is not diluted; the roadmap is directional, not executive. |

---

*Whitepaper generated as a CA-008 deliverable — FlowTask Open Source Transformation Roadmap.*
