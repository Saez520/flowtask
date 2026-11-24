# ADR-0001 — Forma del broker de delegación y lenguaje de implementación

## Estado

Aceptado por decisión delegada (modo autónomo) el 2026-11-23; pendiente de ratificación del desarrollador.

Origen: tarea F0.3 del roadmap Harness Sandbox (Engram #11503). Se apoya en el spike ACP de F0.2 (Engram #11696) y en la investigación de la ejecución (Engram `hotfix/hf-harness-broker-adr/artifact/investigacion`, #11697).

## Contexto

FlowTask necesita ejecutar subagentes en otro harness (Claude Code, OpenCode, Pi) bajo un contrato de autoridad común. Hoy un agente padre lanza `opencode run ...` directamente y el cumplimiento depende de que el hijo obedezca.

Evidencia del problema (roadmap #11503 §2):

- Con stdin que no es `/dev/null` (un socket en la herramienta Bash de Claude Code), `opencode run` v2.0.29 se queda mudo: 0 bytes y 0 % de CPU. Con `</dev/null` responde en 4–6 s. El spike confirmó que con `stdin` pipe abierto y sin cerrar, `opencode run` cuelga más de 40 s y que con `stdin.end()` o stdio ignorado responde en 5,5 s.
- Los intentos de la sesión 73d24de7 que delegaron al constructor quedaron colgados 35 y 5 minutos sin señal para el padre.
- El resultado dependía de que el padre interpretara la salida de texto del hijo.

Se necesita un componente determinista (broker) que lance, supervise y registre al hijo, y devuelva un resultado normalizado. Hay dos decisiones por fijar: la forma del broker y el lenguaje.

Decisiones ya tomadas por el desarrollador en el roadmap y que este ADR no reabre: core genérico hexagonal con un adaptador por harness (D2); ledger como estado transaccional de vida corta, Engram como memoria durable (D3); sin `result.json`, el padre lee el ledger (D4); ACP como transporte hacia el hijo (D6); estados alineados con A2A y campos OTel en el esquema (D8).

## Decisión

### 1. Forma del broker: opción C

Un CLI `delegate` que lanza un **supervisor desacoplado por run** y devuelve el `run_id` al instante. `status`, `result` y `cancel` leen y escriben el **ledger SQLite en modo WAL**. **MCP es un segundo frente** sobre el mismo core, con schema; no es el único.

Resumen de la mecánica:

1. `delegate` valida la `DelegationRequest`, registra el run en el ledger (`submitted`), lanza el supervisor en un proceso aparte (detached) y retorna `run_id`.
2. El supervisor abre el adaptador ACP del harness, conduce el turno, escribe eventos y latidos derivados en el ledger y fija el estado terminal.
3. `status`/`result` leen el ledger por cursor; `cancel` es idempotente.

### 2. Lenguaje: Node/TypeScript

Se elige **Node/TS**. Es un **desvío declarado** respecto de la inclinación del roadmap (#11503 §9: "Rust si el spike de ACP sale bien; si no, Node"). El spike salió bien en ACP, pero no mostró ventaja de Rust.

Razones, contrastadas con los criterios de #11503 §9:

| Criterio (§9) | Rust | Node/TS |
|---|---|---|
| SDK oficial de ACP | Crate `agent-client-protocol` 5.5.1 (VR-003) | `@agentclientprotocol/sdk` 2.9.1 (VR-003) |
| Adaptador de Claude Code | Proceso externo | `claude-agent-acp` 0.110.1 es Node (VR-003) |
| Convenciones de test de FlowTask | Nuevas | `node:test`, ya vigente |
| Encaje con instalador y distribución | Binarios por plataforma, firma en macOS arm64 [Inferencia] | Mismo runtime que el instalador |
| SQLite | Dependencia adicional | `node:sqlite` disponible en Node v26.12.1 (VR-003) |
| Verificación automática (compilador, enums exhaustivos) | Más fuerte | TypeScript con `strict` cubre uniones discriminadas exhaustivas |
| Supervisión en Windows | Job Objects | Sin Job Objects nativos; ver Riesgos |
| Costo de iteración de adaptadores | Mayor | Menor |

Rust sigue siendo reevaluable si se exige un supervisor sin runtime Node. El contrato (esquema SQLite, JSON schemas, superficie CLI, suite de conformidad) es independiente del lenguaje (#11503 §4.5), de modo que un cambio de lenguaje no invalida los consumidores.

### 3. Transporte: ACP

El broker habla ACP (NDJSON por stdio) con el hijo mediante `@agentclientprotocol/sdk`.

Adaptadores verificados en el spike (#11696):

- OpenCode: `opencode acp` (nativo).
- Claude Code: `claude-agent-acp`. Funciona con suscripción Claude Pro sin `ANTHROPIC_API_KEY` (`session/new` 4,4 s, prompt 3,7 s).

El `sessionId` de ACP coincide con el id nativo en ambos harnesses (OpenCode `ses_*`; Claude UUID igual al `.jsonl`). El ledger guarda ambos campos igualmente, nullable, según D7.

### 4. Reglas de supervisión (derivadas del spike)

1. **stdin controlado.** Nunca heredar un stdin ajeno. ACP no sufre el bug de stdin de `opencode run`, pero toda invocación de un CLI de un solo uso debe cerrar stdin o ignorarlo.
2. **Proceso detached y kill de grupo.** Lanzar con grupo de procesos propio y terminar con `kill(-pgid)`. En el spike no dejó restos; `kill -9` de `opencode acp` mata el árbol en menos de 5 s.
3. **Watchdog propio.** No hay heartbeat nativo en ACP. La liveness se deriva de updates (`agent_thought_chunk` a ~100 ms, `tool_call_update`), de EOF/exit del proceso y de tres timeouts: primer evento, inactividad y pared.
4. **Cancelación correlacionada.** `session/cancel` debe enviarse solo contra el turno vivo: un cancel tardío aborta el **siguiente** prompt. Con el turno vivo, `cancelled` llega en ~24 ms y limpia los procesos hijos (zsh + sleep en la prueba).
5. **Cierre de stdin no es cancelación.** Cerrar stdin hace salir al agente (exit 0, ~2 s) pero un prompt en vuelo nunca se resuelve; el supervisor debe fijar el estado terminal por su cuenta.
6. **Help por stdout.** `opencode acp` imprime su ayuda por stdout ante un flag inválido: el supervisor no debe interpretar stdout como NDJSON sin validar cada línea.
7. **Semántica de `reject_once`.** En OpenCode, rechazar un permiso con `reject_once` termina **todo** el turno con `stopReason: cancelled`. El broker lo mapea a un motivo explícito y no lo trata como un rechazo local de una sola tool.

### 5. Selección de agente

- **OpenCode:** `session/new` solo lista agentes `primary`/`all` en `configOptions.mode`; `flowtask-constructor` es `subagent` y falla con `-32602`. Se lanza `opencode acp` con `OPENCODE_CONFIG_CONTENT='{"agent":{"flowtask-constructor":{"mode":"primary"}}}'` (o `all`), por lanzamiento, y queda seleccionable. No se modifica la configuración persistente del usuario. [No verificado] que corra con su system prompt y permisos reales.
- **Claude Code:** la opción `agent` nativa lista los agentes de `~/.claude/agents`.

Nota de nomenclatura: el spike usó la clave `agent` en el override; el instalador ya migró a `agents` (HF-opencode-agent-config-conflict, f5b8d33). Qué clave respeta el override de `OPENCODE_CONFIG_CONTENT` en la versión vigente es [No verificado]; debe confirmarse en F1.

### 6. Estados

Alineados con A2A (mapeo [Inferencia]; #11503 §6): `submitted`, `working`, `input_required` (pausa `authority_block` o permiso pendiente), `auth_required` (saldo o autenticación), `completed`, `failed` (con motivo: `idle_timeout`, `no_first_event`, `exit_nonzero`, `wall_timeout`), `canceled` (idempotente) y `rejected` (gate). Terminales: `completed`, `failed`, `canceled`, `rejected`.

Correspondencia con ACP: `end_turn` -> `completed`; `cancelled` -> `canceled` (o `failed`/`input_required` si lo originó un `reject_once`, ver regla 7); `refusal`, `max_tokens` y `max_turn_requests` se mapean a `failed` con motivo propio, a definir en el contrato de F0.4.

## Alternativas consideradas

### A. CLI de un solo uso (bloqueante)

Un comando que lanza al hijo, espera y devuelve el resultado.

- A favor: la superficie más simple; sin proceso desacoplado.
- En contra: bloquea al padre; el Bash de Claude Code corta a los 10 minutos (#11503 §5), lo que no encaja con runs de ~21 minutos como el observado; un corte del padre mata o deja huérfano al hijo; sin consulta de estado desde otro proceso.

### B. Daemon + MCP

Un servicio residente expuesto por MCP.

- A favor: estado en memoria, múltiples clientes, streaming natural.
- En contra: ciclo de vida propio (arranque, reinicio, actualización), mayor superficie de seguridad, y un punto único cuya caída afecta a todos los runs; exige MCP en todos los padres.

### C. CLI delegate + supervisor desacoplado + ledger (elegida)

Combina la ausencia de servicio residente de A con la consulta asíncrona de B. El estado vive en el ledger, no en un proceso, así que un supervisor caído deja un run reconciliable en vez de un estado perdido. MCP se añade como frente sin ser requisito.

## Consecuencias

- El padre no bloquea: delega, recibe `run_id` y consulta `status`/`result`.
- Un supervisor por run aísla fallos entre runs.
- El ledger es la única fuente de verdad del run; el broker no escribe memoria del proyecto en Engram (como mucho un puntero al cierre; decisión abierta).
- El gate de permisos pasa a permitir solo el broker y a denegar `opencode run` y `claude -p` directos (F1.5).
- Se añade un runtime Node como dependencia del broker; coincide con el que ya requiere el instalador.
- El watchdog es código propio del broker y debe cubrirse con la suite de conformidad.

## Riesgos

- **Windows.** Node no ofrece Job Objects nativos; el kill de grupo de `kill(-pgid)` no existe allí. Opciones: `taskkill /T` o una dependencia mínima. [No verificado]. Hay usuarios Windows (HF-instalacion-windows-python #11051). `srt` en Windows es alfa según un espejo (#11503 §8).
- **ACP v2 en Preview.** La especificación sigue evolucionando y los métodos de session-modes "se retirarán en una versión futura". Mitigación: aislar ACP tras la interfaz de adaptador y fijar versiones del SDK y de los adaptadores.
- **Gate de permisos.** Los permisos ACP solo cubren lo que el agente pide aprobar [Inferencia]; en el spike, en el cwd de FlowTask los writes se ejecutaron sin permiso por defecto, y el comportamiento del gate bajo ACP es [No verificado]. Hace falta la capa de sandbox de SO (F2.2).
- **Broker como punto único.** Mitigación: suite de conformidad en F1.
- **Sesiones de prueba residuales.** El spike dejó ~7 sesiones `ses_df4f*` sin borrar en OpenCode.

## Gaps y verificaciones pendientes

Fuente: spike #11696 e investigación #11697.

- **G1.** El constructor solo es seleccionable en OpenCode con override de modo por lanzamiento (`OPENCODE_CONFIG_CONTENT`). [No verificado] que corra con su system prompt y permisos reales.
- **G2.** No hay heartbeat nativo; el watchdog es propio (primer evento, inactividad, pared). Los umbrales por defecto no están medidos.
- **G3.** `reject_once` aborta el turno completo en OpenCode; el diseño de `input_required` debe contemplarlo.
- **G4.** Claude Code sin probar: `request_permission`, selección de `agent` y kill con un prompt en vuelo. [No verificado].
- **G5.** Sesiones hijas y `additionalDirectories` sin explorar.
- Gate bajo ACP y denegación de invocación directa en ambos harnesses: [No verificado].
- Flags de salida estructurada de Claude Code: [No verificado].
- Supervisión en Windows: [No verificado].

## Decisiones abiertas

- Empaquetado npm del broker: dentro de F3.5 de #10175 o canal propio.
- Puntero en Engram al cierre de un run (el broker no escribe memoria del proyecto).
- Prioridad de la tarea de telemetría nativa de harnesses (#11649), fuera de este ADR.
- Ratificación del desarrollador de la opción C y del desvío a Node/TS.

## Referencias

- Roadmap Harness Sandbox: Engram #11503 (§4, §5, §6, §8, §9, §11, §12).
- Spike ACP (F0.2): Engram #11696.
- Investigación de esta ejecución: Engram #11697 (`hotfix/hf-harness-broker-adr/artifact/investigacion`).
- Plan de esta ejecución: Engram #11698.
- Diagnóstico del cuelgue de sesión 73d24de7: Engram #11583.
- Hotfix del conflicto `agent`/`agents` del instalador: commit f5b8d33 (HF-opencode-agent-config-conflict).
- Versiones observadas (2026-11-23): OpenCode 2.0.29, `claude-agent-acp` 0.110.1, `@agentclientprotocol/sdk` 2.9.1, Node v26.12.1.
