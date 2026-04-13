---
description: Scan and index only types/models layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the types/models layer of this project:

## 0. CRITICAL - Verificar MCP Activo PRIMERO

Run: `mem_stats`

- Si la llamada **éxito** → MCP activo, continuar
- Si la llamada **falla** → Mostrar mensaje de reinicio y DETENERSE

**Mensaje si MCP inactivo:**
```
⚠️ MCP de Engram NO está activo. Reinicia OpenCode y ejecuta /init-types de nuevo.
```

---

## 1. Detect file types:
   - Run `find . -maxdepth 4 -type f | head -100` to list files
   - Look for common type file extensions: .ts, .py, .go, .rs, .js
   - Focus on directories that contain type definitions

## 2. Identify type directories:
   - Look for directories with names like: types, models, schemas, interfaces, contracts, structures, domain

## 3. Extract naming conventions:
   - Detect naming patterns from filenames: PascalCase, snake_case, kebab-case, camelCase
   - Identify common suffixes: Model, Type, Schema, Interface, Document, Record
   - Check for singular vs plural naming

## 4. Extract type structure patterns:
   - Read sample type files to understand structure
   - Note common fields (id, createdAt, updatedAt, status, etc.)
   - Identify if there's a base/parent type pattern

## 5. Save to Engram:
   - mem_save(type: pattern, scope: "project", topic_key: project/types, title: "Types/models conventions")
   - mem_save(type: pattern, scope: "project", topic_key: project/naming, title: "Naming conventions") if new patterns found
   - Use mem_suggest_topic_key before saving

## 6. Report what was detected and saved.
