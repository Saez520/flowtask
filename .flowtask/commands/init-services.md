---
description: Scan and index only services/business-logic layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the services/business-logic layer of this project:

1. Detect file types:
   - Look for files that contain business logic
   - Common extensions: .java, .ts, .tsx, .py, .go, .cs, .rb, .php

2. Identify service directories:
   - Look for directories with names like: service, services, manager, managers, usecase, usecases, handler, handlers, business, logic, domain, core, feature

3. Identify service patterns:
   - Dependency injection style: constructor injection, field injection, dependency inversion
   - Interface usage: service interfaces, implementations
   - Method patterns: CRUD operations, domain-specific operations
   - Error handling: exceptions, result types (Either, Result, Try), error codes
   - Logging patterns: log levels, structured logging

4. Extract service conventions:
   - Naming patterns for service classes
   - Method naming conventions
   - How services interact with repositories/data layer
   - How services expose functionality to API layer
   - Transaction boundaries if visible

5. Save to Engram:
   - mem_save(type: pattern, topic_key: project/services, title: "Service/business logic patterns")
   - mem_save(type: pattern, topic_key: project/conventions, title: "Project conventions") if new patterns found
   - Use mem_suggest_topic_key before saving

6. Report what was detected and saved.
