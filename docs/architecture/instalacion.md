> **Historical:** this conceptual guide was replaced by [../installation.md](../installation.md). It does not describe current target selection or derived configuration.

## 5. The Installation System (Multi-Environment)

How FlowTask "clones" itself to work in different environments (OpenCode, Claude Code, Standalone).

```mermaid
flowchart TD
    SRC["FLOWTASK SOURCE"] --> INST["INSTALLER.JS"]
    INST --> OC["opencode"]
    INST --> CL["claude"]
    INST --> ST["standalone"]
    OC --> OCM["Merges opencode.json + .opencode/skills/"]
    CL --> CLM["Generates CLAUDE.md + .claude/agents/"]
    ST --> STM["Copies .flowtask/ (agents, skills, plugins)"]
```
