---
description: Scan and index only configuration files into Engram
agent: flowtask-initializer
subtask: true
---
Scan the configuration layer of this project:

## 0. CRITICAL - Verificar MCP Activo PRIMERO

Run: `mem_stats`

- Si la llamada **éxito** → MCP activo, continuar
- Si la llamada **falla** → Mostrar mensaje de reinicio y DETENERSE

**Mensaje si MCP inactivo:**
```
⚠️ MCP de Engram NO está activo. Reinicia OpenCode y ejecuta /init-config de nuevo.
```

---

## 1. Detect configuration files:
   - Run `find . -maxdepth 3 -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.toml" -o -name "*.properties" -o -name "*.env*" -o -name "*.config.*" -o -name "*.conf" \) | head -50`
   - Common config files: package.json, tsconfig.json, pom.xml, build.gradle, docker-compose.yml, .env, .env.example, config.js, settings.json, application.yml

## 2. Identify configuration patterns:
   - Environment variables: .env files, process.env usage, config objects
   - Configuration formats: JSON, YAML, TOML, properties files, INI
   - Secrets management: env files, vault, AWS Secrets Manager, etc.
   - Configuration hierarchy: development, staging, production configs

## 3. Extract configuration conventions:
   - Naming patterns for config keys
   - Environment variable naming conventions
   - How configuration is loaded/accessed in code
   - Default values and override patterns

## 4. Identify build/deployment configs:
   - Docker: Dockerfile, docker-compose.yml, .dockerignore
   - CI/CD: .gitlab-ci.yml, .github/workflows, Jenkinsfile
   - Package managers: package.json, pom.xml, build.gradle, go.mod

## 5. Save to Engram:
   - mem_save(type: config, scope: "project", topic_key: project/config, title: "Configuration files and patterns")
   - mem_save(type: config, scope: "project", topic_key: project/stack, title: "Project stack") if build configs found
   - Use mem_suggest_topic_key before saving

## 6. Report what was detected and saved.
