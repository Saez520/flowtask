---
description: Show FlowTask and Engram memory statistics
agent: build
---
Show FlowTask status:

1. Call `mem_stats` to get memory statistics (sessions, observations, projects)

2. Search Engram for active workflows:
   - `mem_search(q: "flow-state")` to find workflows in progress (searches all sub-namespaces: create, plan, audit, construct, validate)

3. Search Engram for recent CAs:
   - `mem_search(q: "type:requirement")` to list recent requirements

4. Search Engram for project initialization:
   - `mem_search(q: "project/stack")` to check if project is initialized
   - `mem_search(q: "project/conventions")` to check conventions loaded

5. Display a clear summary:
   - Memory statistics
   - Number of active workflows
   - Project initialization status
   - Recent CAs
