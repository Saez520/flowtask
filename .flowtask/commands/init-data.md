---
description: Scan and index only data layer into Engram
agent: flowtask-initializer
subtask: true
---
Scan the data layer of this project:

## 0. CRITICAL - Verificar MCP Activo PRIMERO

Run: `mem_stats`

- Si la llamada **éxito** → MCP activo, continuar
- Si la llamada **falla** → Mostrar mensaje de reinicio y DETENERSE

**Mensaje si MCP inactivo:**
```
⚠️ MCP de Engram NO está activo. Reinicia OpenCode y ejecuta /init-data de nuevo.
```

---

## 1. Detect file types:
   - Look for files that interact with databases or external data sources
   - Common extensions: .ts, .py, .go, .rs, .js, .sql

## 2. Identify data directories:
   - Look for directories with names like: data, db, persistence, storage, accessor, datastore, dal, repo, repositories

## 3. Identify data access patterns:
   - ORM or query builder usage
   - Raw query patterns (SQL files, query strings)
   - Connection patterns (pools, transactions)
   - Migration tools if present

## 4. Extract data conventions:
   - Naming patterns for data classes
   - Method naming conventions
   - Query storage patterns
   - Transaction handling

## 5. Save to Engram:
   - mem_save(type: pattern, topic_key: project/data, title: "Data layer patterns")
   - mem_save(type: config, topic_key: project/stack) if database technology detected
   - Use mem_suggest_topic_key before saving

## 6. Report what was detected and saved.