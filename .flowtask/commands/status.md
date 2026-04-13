---
description: Show FlowTask and Engram memory statistics
agent: build
---
Show FlowTask status:

1. Call `mem_stats` to get memory statistics (sessions, observations, projects)

2. Search Engram for active workflows:
   - `mem_search(query: "flow state", type: "decision", scope: "project")` to find workflows in progress

3. Search Engram for recent CAs:
   - `mem_search(query: "CA-", type: "decision", scope: "project")` to list recent requirements

4. Search Engram for project initialization:
   - `mem_search(query: "project stack", scope: "project")` to check if project is initialized
   - `mem_search(query: "project conventions", scope: "project")` to check conventions loaded

5. Display a clear summary:
   - Memory statistics
   - Number of active workflows
   - Project initialization status
   - Recent CAs
