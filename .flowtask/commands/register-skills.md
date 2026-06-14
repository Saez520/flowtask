---
description: Register all FlowTask skills from .flowtask/skills/ into Engram registry. Scans SKILL.md frontmatter and saves metadata + path. Run after adding/modifying skills.
agent: flowtask-runner
subtask: true
---

# /register-skills — Poblar registro de skills en Engram

## Propósito

Escanea `.flowtask/skills/*/SKILL.md`, extrae frontmatter (name, description, triggers, etc.) y guarda cada entry en Engram con topic_key `skill-registry/{name}`.

**IMPORTANTE**: Solo guarda metadatos y rutas. NUNCA guardes el contenido completo del SKILL.md.

---

## Instrucciones

### 1. Listar skills

Usa `ls` o glob para listar directorios en `.flowtask/skills/*/`:

```
ls .flowtask/skills/
```

### 2. Para cada skill, leer frontmatter

Lee SOLO el frontmatter YAML de `SKILL.md` (primeras ~12 líneas hasta `---`):

```
head -12 .flowtask/skills/{name}/SKILL.md
```

Extrae estos campos:
- `name` (obligatorio)
- `description` (obligatorio)
- `license` (opcional)
- `compatibility` (opcional)
- `metadata` (opcional)
- `triggers` (opcional — si existe en el frontmatter)

### 3. Construir entry

Para cada skill, construye:

- **name**: del frontmatter
- **path**: ruta absoluta al SKILL.md (resuelve con `realpath` o desde `pwd`)
- **scope**: `"project"`
- **triggers**: `[]` (o lo que diga el frontmatter)
- **description**: del frontmatter

### 4. Guardar en Engram

```
mem_save(
  topic_key: "skill-registry/{name}",
  type: "config",
  scope: "project",
  title: "Skill registry: {name}",
  content:
    **Skill**: {name}
    **Path**: {absolute_path_to_SKILL.md}
    **Scope**: project
    **Triggers**: []
    **Description**: {description from frontmatter}
)
```

**NUNCA incluyas el cuerpo del SKILL.md en el content.** Solo metadatos + ruta.

### 5. Reportar resumen

Al finalizar, reporta:

```
✅ Skills registradas: {count}
❌ Fallaron: {count_failed} (si alguna)
📋 Skills:
  - {name} → {short_path}
```

---

## Formato esperado del content en Engram

Cada entry en Engram debe verse así (ejemplo):

```
**Skill**: memory-protocol
**Path**: /Users/user/FlowTask/.flowtask/skills/memory-protocol/SKILL.md
**Scope**: project
**Triggers**: []
**Description**: Guía práctica de uso de memoria Engram para agentes FlowTask.
```

Sin contenido adicional del SKILL.md.

---

## Verificación

Después de registrar, verifica:

```
mem_search(query: "skill-registry", scope: "project")
```

Debe devolver 8+ resultados (uno por cada skill en `.flowtask/skills/`).

Cada resultado debe contener `**Path**:` y `**Description**:` pero NO el cuerpo del skill.
