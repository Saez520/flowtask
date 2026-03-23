---
description: Scan and index only business logic layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the business logic layer of this project:

## 0. CRITICAL - Verificar MCP Activo PRIMERO

Run: `mem_stats`

- Si la llamada **éxito** → MCP activo, continuar
- Si la llamada **falla** → Mostrar mensaje de reinicio y DETENERSE

**Mensaje si MCP inactivo:**
```
⚠️ MCP de Engram NO está activo. Reinicia OpenCode y ejecuta /init-business de nuevo.
```

---

## 1. Detect file types:
   - Look for files that contain business logic
   - Common extensions: .ts, .py, .go, .rs, .js

## 2. Identify business logic directories:
   - Look for directories with names like: business, logic, domain, core, usecase, usecases, handler, handlers, manager, managers, service, services, feature, features

## 3. Identify business patterns:
   - Dependency injection style
   - Interface usage patterns
   - Method patterns for operations
   - Error handling patterns
   - Logging patterns

## 4. Extract business conventions:
   - Naming patterns for business classes
   - Method naming conventions
   - How business layer interacts with data layer
   - How business layer exposes functionality to API layer

## 5. Save to Engram:
   - mem_save(type: pattern, topic_key: project/business, title: "Business logic patterns")
   - mem_save(type: pattern, topic_key: project/conventions, title: "Project conventions") if new patterns found
   - Use mem_suggest_topic_key before saving

## 6. Report what was detected and saved.