# FlowTask Workflow Example

This document shows a complete FlowTask workflow from start to finish.

---

## Step 1: Initialize Project

```bash
cd your-project
opencode
> /init
```

**What happens:**

1. FlowTask checks if Engram is installed
2. If not, it shows installation instructions
3. Configures Engram MCP in opencode.json
4. Scans the project structure
5. Populates Engram with project context

**Engram stores:**
- Technology stack
- Project layers
- Naming conventions
- API patterns
- Service patterns

---

## Step 2: Start a New Workflow

```bash
> /run CA-001
```

**Runner asks:**
```
CA-001 not found. Please describe the requirement you need to implement.
```

**You respond:**
```
I need to add a user registration endpoint that validates email
and password strength, then stores the user in the database.
```

**Runner saves to Engram:**
```
mem_save(
  type: "requirement",
  topic_key: "ca/001",
  title: "CA-001: User registration endpoint",
  content: "Endpoint that validates email/password, stores user"
)
```

---

## Step 3: Planning Phase

Runner activates `@flowtask-planner`

**Planner asks:**
```
Before generating the plan, I need to clarify:
1. Is this a modification or new creation?
2. What database is involved?
3. Does it require a new endpoint or modify existing?
4. Are there external systems involved?
```

**You respond:**
```
1. New creation
2. PostgreSQL
3. New endpoint POST /api/users/register
4. No external systems
```

**Planner generates plan and saves to Engram:**
```
mem_save(
  type: "architecture",
  topic_key: "plan/001",
  content: "## Plan for CA-001

  ### Skills to load
  - project/api (for endpoint patterns)
  - project/data (for database access)
  - project/business (for business logic)

  ### Artifacts to create
  | # | Op | Artifact | Path | Notes |
  | 1 | CREATE | UserDTO | types/UserDTO.ts | email, password |
  | 2 | CREATE | CreateUserDTO | types/CreateUserDTO.ts | validation rules |
  | 3 | CREATE | UserRepository | repository/UserRepository.ts | DB operations |
  | 4 | CREATE | UserService | service/UserService.ts | business logic |
  | 5 | CREATE | POST /register | controller/UserController.ts | endpoint |

  ### Conventions to apply
  - Naming: PascalCase for classes
  - Validation: class-validator
  - Error handling: custom exceptions
  "
)

mem_save(
  type: "decision",
  topic_key: "flow-state/001",
  content: "plan_generated"
)
```

**Runner shows:**
```
✓ Plan ready in Engram (topic_key: plan/001)
Review it and respond "ejecutar" to continue, or indicate corrections.
```

---

## Step 4: Approval

**You review the plan and respond:**
```
> ejecutar
```

---

## Step 5: Execution Phase

Runner activates `@flowtask-constructor`

**Constructor:**
1. Retrieves plan from Engram
2. Retrieves conventions from Engram:
   ```
   mem_search(q: "project/api")
   mem_search(q: "project/naming")
   ```
3. Implements artifacts in order:
   - Creates UserDTO
   - Creates CreateUserDTO with validation
   - Creates UserRepository
   - Creates UserService
   - Creates UserController endpoint

4. After each artifact:
   ```
   mem_save(
     type: "discovery",
     topic_key: "impl/001/user-service",
     content: "Created UserService with register method"
   )
   ```

5. Updates flow state:
   ```
   mem_save(
     type: "decision",
     topic_key: "flow-state/001",
     content: "implemented"
   )
   ```

**Runner shows:**
```
✓ Implementation completed. Starting validation.
```

---

## Step 6: Validation Phase

Runner activates `@flowtask-validator`

**Validator:**
1. Retrieves plan from Engram
2. Retrieves conventions from Engram
3. Inspects implemented code
4. Validates:
   - All artifacts created ✓
   - Naming follows conventions ✓
   - Validation logic correct ✓
   - Error handling present ✓

5. Generates report:
   ```
   mem_save(
     type: "discovery",
     topic_key: "validation/001",
     content: "## Validation Report CA-001
   
     **Score:** 95/100
     **Result:** APPROVED
   
     ### Blockers
     (none)
   
     ### Minor issues
     1. Could add unit tests for UserService
        - Suggestion: Use @flowtask-tester
   
     ### Artifacts validated
     | # | Artifact | Status |
     | 1 | UserDTO | ✓ |
     | 2 | CreateUserDTO | ✓ |
     | 3 | UserRepository | ✓ |
     | 4 | UserService | ✓ |
     | 5 | UserController | ✓ |
     "
   )
   ```

**Runner shows:**
```
✅ APPROVED — Score: 95/100
Report in Engram (topic_key: validation/001)
Ready for your final review.
```

---

## Step 7: Session Summary

Before ending session:
```
mem_session_summary(
  content: "## Goal
     User registration endpoint for CA-001

     ## Accomplished
     - Created 5 artifacts (DTO, Repository, Service, Controller)
     - Implemented email/password validation
     - Set up PostgreSQL integration

     ## Next Steps
     - Add unit tests (minor issue from validator)

     ## Relevant Files
     - types/UserDTO.ts
     - types/CreateUserDTO.ts
     - repository/UserRepository.ts
     - service/UserService.ts
     - controller/UserController.ts
     "
)
```

---

## Flow State in Engram

After completion, Engram contains:

```
ca/001          → Requirement document
plan/001        → Implementation plan
impl/001/*      → Implementation artifacts (5 memories)
validation/001  → Validation report
flow-state/001  → "completed"
```

---

## Searching Past Work

Later, when working on a similar feature:
```
> I need to add a password reset endpoint

FlowTask searches Engram:
mem_search(q: "user endpoint registration")

Finds:
- CA-001 (related work)
- UserController (existing pattern)
- UserService (existing logic)

Returns relevant context to help implement the new feature
```
