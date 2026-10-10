## 6. Handshake Protocol: Gestión de Identidad y Continuidad

```mermaid
flowchart TD
    INPUT["[ INPUT: CA-018 ]"]
    RUNNER["RUNNER (MANAGER)<br/>1. ¿Existe handshake para este?"]
    ENGRAM["ENGRAM STORAGE<br/>(Topic: flow-state/...)"]
    NO["1. Toma BaseName de lista:<br/>(Aitana, Kael, Lyra...)<br/>2. Crea Mapa de Instancias"]
    SI["1. Recupera BaseName<br/>2. Recupera 'task_id' del sub-agente"]
    PROMPT["CONSTRUCCIÓN DEL PROMPT<br/>- Name: {BaseName}-{AgentType} (Ej: #quot;Aitana-Planner#quot;)<br/>- Context: Snapshot de Engram<br/>- TaskID: {task_id_existente}"]
    INVOKE["INVOCACIÓN DE AGENTE<br/>(Task Tool / Claude)"]
    SUBAGENT["SUB-AGENTE (P)<br/>(Ejecuta Tarea)"]
    MAPA["ACTUALIZACIÓN MAPA<br/>1. Captura nuevo ID<br/>2. Timestamp"]
    ENGRAM2["ENGRAM STORAGE<br/>(flow-state/CA-018/inst)"]

    INPUT --> RUNNER
    RUNNER --> ENGRAM
    RUNNER -->|"[ NO (Nuevo CA) ]"| NO
    RUNNER -->|"[ SÍ (Continuación) ]"| SI
    NO -->|"3. Guarda en Engram"| ENGRAM
    SI -->|"3. Lee último Checkpoint"| ENGRAM
    NO --> PROMPT
    SI --> PROMPT
    PROMPT --> INVOKE
    INVOKE --> SUBAGENT
    SUBAGENT -->|"[ RESPUESTA ]"| MAPA
    INVOKE --> MAPA
    MAPA --> ENGRAM2
```

Desglose de los Componentes del Handshake:

### 1. El Mapa de Instancias (En Engram)

Es el archivo de estado que el Runner consulta. Evita la duplicidad de hilos.

```json
{
  "base_name": "Aitana",
  "agents": {
    "ca-writer": { 
      "task_id": "T123...", 
      "instance_name": "Aitana-ca-writer",
      "last_resume": "2026-05-14T..." 
    },
    "planner": { 
      "task_id": "T456...", 
      "instance_name": "Aitana-planner"
    }
  }
}
```

### 2. Naming Pool (Identidad Visual)

El Runner asigna nombres de una lista predefinida (Aitana, Kael, Lyra, Zev, Thalía, Iago, Elowen, Mael).

*   ¿Por qué? Porque es más fácil para el desarrollador identificar que "Aitana-Planner" está hablando de lo mismo que "Aitana-Constructor", en lugar de manejar IDs de sistema aburridos.

### 3. Context Injection (La Memoria de Trabajo)

Antes de que el agente empiece a trabajar, el Runner inyecta:

1.  Hallazgos de memoria: Lo que se aprendió en sesiones anteriores.
2.  Snapshot de estado: El "en qué nos quedamos" recuperado de Engram.

### 4. Self-Healing (Recuperación Automática)

Si el task_id ha expirado (por tiempo de inactividad de la API del LLM):

1.  El Runner detecta el fallo.
2.  Limpia el ID fallido de Engram.
3.  Relanza al agente en un hilo nuevo inyectando el último Checkpoint, por lo que el agente "no siente" que perdió la memoria, solo que es un nuevo día.
