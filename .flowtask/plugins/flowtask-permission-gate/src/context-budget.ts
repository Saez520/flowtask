/**
 * Presupuesto de contexto para las herramientas de lectura del runner.
 *
 * Gate transparente en herramienta vía `tool.execute.after` (OpenCode 1.18.15,
 * output mutable). Mide `output.output.length` (proxy chars/4 tokens) y degrada
 * la entrega por niveles antes de omitirla:
 *
 * 1. `notice` — el primer pedido amplio del turno se anuncia con la forma de
 *    acotar y no se ejecuta.
 * 2. `reduced` — la entrega que excede el presupuesto por llamada se reduce:
 *    declara qué se omitió, cuánto pesaba y a quién delegar, sin preview.
 * 3. `turn_omitted` — la suma del turno alcanza el presupuesto acumulado: lo
 *    siguiente se omite aunque cada pieza por separado quepa.
 *
 * Los adjuntos imagen/PDF se delegan (`attachment_delegated`) y una salida que
 * no se puede medir se entrega intacta con traza (`measurement_unavailable`).
 *
 * Los límites viven EXCLUSIVAMENTE en esta herramienta; el runner no conoce los
 * umbrales ni se le exponen en el prompt: los mensajes nombran el ámbito del
 * presupuesto aplicado y el tamaño real omitido, nunca la cifra. Override
 * opcional por archivo en `.flowtask/config/context-budget.json` (fail-open a
 * defaults).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Umbral por llamada — read (chars de `output.output`). */
export const DEFAULT_READ_THRESHOLD = 16000;
/** Umbral por llamada — grep (chars de `output.output`). */
export const DEFAULT_GREP_THRESHOLD = 8000;
/** Umbral por llamada — glob (chars de `output.output`). */
export const DEFAULT_GLOB_THRESHOLD = 8000;
/** Suma máxima de chars entregados por turno del runner (reset por chat.message). */
export const DEFAULT_TURN_ACCUMULATED = 32000;
/** `stat.size` (bytes) que sin `limit`/`offset` dispara el pre-gate de read. */
export const PREVENTIVE_READ_STAT_LIMIT = 50 * 1024;
/** Patterns glob que sin path acotado disparan el pre-gate (lista cerrada). */
export const PREVENTIVE_GLOB_PATTERNS = ["**/*", "**"];
/** grep sin `include` sobre la raíz dispara el pre-gate. */
export const PREVENTIVE_GREP_NO_INCLUDE_ROOT = true;
/** Attachment imagen/PDF bloqueado al runner (delegación al Inspector). */
export const IMAGE_PDF_BLOCKED = true;

export type BudgetTool = "read" | "glob" | "grep";

/** Ámbito del presupuesto aplicado: por llamada o acumulado del turno. */
export type BudgetScope = "call" | "turn";

/** Nivel de degradación observable de una entrega. */
export type DegradationLevel =
  | "notice"
  | "reduced"
  | "turn_omitted"
  | "attachment_delegated"
  | "measurement_unavailable";

/** Quién puede tratar lo omitido por contexto. */
export const DELEGATION_TARGET = "Inspector";

/** Qué se omite en cada herramienta, nombrado en el mensaje de entrega reducida. */
export const CONTENT_LABEL: Record<BudgetTool, string> = {
  read: "contenido del archivo",
  grep: "coincidencias",
  glob: "rutas",
};

/** Cómo acotar un pedido amplio, nombrado en el aviso previo. */
export const NARROWING: Record<BudgetTool, string> = {
  read: "usá `limit`/`offset` o delegá el archivo completo al Inspector",
  grep: "acotá con `include` y `path`, o delegá la búsqueda al Inspector",
  glob: "acotá `path` o usá un patrón más específico, o delegá el listado al Inspector",
};

export type ContextBudgetConfig = {
  /** Umbral por llamada read (chars). */
  readThreshold: number;
  /** Umbral por llamada grep (chars). */
  grepThreshold: number;
  /** Umbral por llamada glob (chars). */
  globThreshold: number;
  /** Suma máxima de chars entregados por turno. */
  turnAccumulated: number;
  /** `stat.size` (bytes) que sin limit/offset dispara el pre-gate de read. */
  preventiveReadStatLimit: number;
  /** Patterns glob amplios de la lista cerrada del pre-gate. */
  preventiveGlobPatterns: string[];
  /** Segmentos de path considerados no acotados (p.ej. node_modules). */
  blockedPaths: string[];
};

const CONFIG_CANDIDATES = [
  ".flowtask/config/context-budget.json",
  ".opencode/flowtask/config/context-budget.json",
] as const;

function defaultConfig(): ContextBudgetConfig {
  return {
    readThreshold: DEFAULT_READ_THRESHOLD,
    grepThreshold: DEFAULT_GREP_THRESHOLD,
    globThreshold: DEFAULT_GLOB_THRESHOLD,
    turnAccumulated: DEFAULT_TURN_ACCUMULATED,
    preventiveReadStatLimit: PREVENTIVE_READ_STAT_LIMIT,
    preventiveGlobPatterns: [...PREVENTIVE_GLOB_PATTERNS],
    blockedPaths: ["node_modules"],
  };
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Parsea el override file. Fail-open observable: JSON inválido o campos no
 * numéricos/≤0 → `console.warn` + defaults. Nunca lanza.
 */
function parseContextBudgetConfig(raw: string, filePath: string): ContextBudgetConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn(`[FlowTask Context Budget] JSON inválido en ${filePath}; se usan defaults.`);
    return defaultConfig();
  }

  if (!value || typeof value !== "object") {
    console.warn(`[FlowTask Context Budget] Configuración inválida en ${filePath}; se usan defaults.`);
    return defaultConfig();
  }

  const record = value as Record<string, unknown>;
  const config = defaultConfig();
  const numeric = [
    "readThreshold",
    "grepThreshold",
    "globThreshold",
    "turnAccumulated",
    "preventiveReadStatLimit",
  ] as const;
  const array = ["preventiveGlobPatterns", "blockedPaths"] as const;

  let invalid = false;
  for (const key of numeric) {
    if (record[key] === undefined) continue;
    if (isPositiveNumber(record[key])) {
      (config as Record<string, unknown>)[key] = record[key];
    } else {
      invalid = true;
      console.warn(`[FlowTask Context Budget] Campo "${key}" no es un número positivo en ${filePath}; se usan defaults.`);
    }
  }
  for (const key of array) {
    if (record[key] === undefined) continue;
    if (isStringArray(record[key])) {
      config[key] = [...record[key]];
    } else {
      invalid = true;
      console.warn(`[FlowTask Context Budget] Campo "${key}" no es un array de strings en ${filePath}; se usan defaults.`);
    }
  }

  if (invalid) {
    console.warn(`[FlowTask Context Budget] Configuración inválida en ${filePath}; se usan defaults.`);
    return defaultConfig();
  }
  return config;
}

/**
 * Carga la config con defaults; si existe un override file legible en workdir
 * (primero) o sessionDir (fallback), lo aplica. Fail-open: nunca lanza.
 */
export function loadContextBudgetConfig(workdir: string, sessionDir?: string): ContextBudgetConfig {
  const directories = [workdir, sessionDir].filter(
    (directory, index, values): directory is string => Boolean(directory) && values.indexOf(directory) === index,
  );
  for (const directory of directories) {
    for (const candidate of CONFIG_CANDIDATES) {
      const filePath = resolve(directory, candidate);
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        console.warn(`[FlowTask Context Budget] No se pudo leer ${filePath}; se usan defaults.`);
        continue;
      }
      return parseContextBudgetConfig(raw, filePath);
    }
  }
  return defaultConfig();
}

/**
 * Aviso de acotación previo: el primer pedido amplio del turno se anuncia con
 * la forma de acotar y no se ejecuta. No expone cifras ni contenido.
 */
export function buildNarrowingNotice(tool: BudgetTool, args: Record<string, unknown>): string {
  return `Pedido amplio de \`${tool}\` (\`${narrowingTarget(tool, args)}\`): \`${NARROWING[tool]}\`.`;
}

/**
 * Entrega reducida: nombra qué se omitió, cuánto pesaba y a quién delegar, sin
 * preview del contenido omitido. El presupuesto se nombra por su ámbito, nunca
 * por su cifra.
 */
export function buildReducedDelivery(tool: BudgetTool, actual: number, scope: BudgetScope = "call"): string {
  const budget = scope === "turn" ? "el presupuesto acumulado del turno" : "el presupuesto por llamada";
  return (
    `Resultado de \`${tool}\` reducido: se omitieron \`${actual}\` chars de \`${CONTENT_LABEL[tool]}\` por \`${budget}\`. ` +
    `Delegá lo omitido al Inspector o acotá path/pattern/limit/include.`
  );
}

/**
 * Entrega de un adjunto imagen/PDF: el texto medido no refleja el costo real
 * del adjunto, así que el adjunto se delega y no se entrega.
 */
export function buildAttachmentDelivery(tool: BudgetTool, actual: number): string {
  return (
    `Adjunto de \`${tool}\` omitido: \`${actual}\` chars de texto medidos más un adjunto imagen/PDF. ` +
    `Delegá el adjunto al Inspector; el runner no recibe adjuntos.`
  );
}

/**
 * Fallback exacto sin preview. `tool` es literal read/glob/grep, `actual` el
 * tamaño real medido y `threshold` el umbral aplicable; la cifra no se
 * publica: el mensaje nombra el ámbito del presupuesto por llamada.
 */
export function buildFallback(tool: BudgetTool, actual: number, _threshold: number): string {
  return buildReducedDelivery(tool, actual, "call");
}

/** Marca de degradación observable sobre la metadata de la entrega. */
export function buildDegradationMetadata(
  level: DegradationLevel,
  options: { budget?: BudgetScope; omittedChars?: number } = {},
): Record<string, unknown> {
  const degradation: Record<string, unknown> = { level };
  if (options.budget !== undefined) degradation.budget = options.budget;
  if (options.omittedChars !== undefined) degradation.omitted_chars = options.omittedChars;
  if (level !== "measurement_unavailable") degradation.delegated_to = DELEGATION_TARGET;
  return { degradation };
}

/** Objetivo del pedido amplio: el archivo o el patrón, o la ausencia de ventana. */
function narrowingTarget(tool: BudgetTool, args: Record<string, unknown>): string {
  const candidate = tool === "read" ? args?.file : args?.pattern;
  return typeof candidate === "string" && candidate ? candidate : "sin ventana acotada";
}

/**
 * Identidad del pedido amplio. El prefijo de herramienta evita colisiones
 * entre los conjuntos de campos de cada una.
 */
export function noticeKey(tool: BudgetTool, args: Record<string, unknown>): string {
  const field = (value: unknown): string => (typeof value === "string" ? value : "");
  if (tool === "read") return `read|${field(args?.file)}`;
  if (tool === "glob") return `glob|${field(args?.pattern)}|${field(args?.path)}`;
  return `grep|${field(args?.pattern)}|${field(args?.path)}|${field(args?.include)}`;
}

/** Avisos de acotación ya emitidos, por sesión y por pedido amplio. */
export const PRE_GATE_NOTICES = new Map<string, Set<string>>();

/**
 * Registra el aviso de un pedido amplio. Devuelve `true` la primera vez (el
 * aviso se emite y el pedido no se ejecuta) y `false` si ya se emitió en este
 * turno (el pedido se permite y la entrega se reduce después).
 */
export function registerNarrowingNotice(sessionID: string, tool: BudgetTool, args: Record<string, unknown>): boolean {
  const key = noticeKey(tool, args);
  let issued = PRE_GATE_NOTICES.get(sessionID);
  if (!issued) {
    issued = new Set<string>();
    PRE_GATE_NOTICES.set(sessionID, issued);
  }
  if (issued.has(key)) return false;
  issued.add(key);
  return true;
}

/** Reinicia los avisos de acotación de una sesión o de todas. */
export function resetNarrowingNotices(sessionID?: string): void {
  if (sessionID === undefined) {
    PRE_GATE_NOTICES.clear();
    return;
  }
  PRE_GATE_NOTICES.delete(sessionID);
}

/**
 * Pre-gate barato de read: archivo sin `limit`/`offset` cuyo `stat.size` supera
 * el límite preventivo. `statSize` puede venir de un `statSync` previo del
 * llamador; si es `undefined` (stat falló) NO se bloquea: el post-gate decide.
 */
export function shouldPreventiveBlockRead(args: Record<string, unknown>, statSize?: number): boolean {
  const file = args?.file;
  if (typeof file !== "string" || !file) return false;
  const hasWindow = args.limit !== undefined || args.offset !== undefined;
  if (hasWindow) return false;
  if (statSize !== undefined && statSize > PREVENTIVE_READ_STAT_LIMIT) return true;
  return false;
}

/** Pre-gate de glob: pattern amplio de la lista cerrada sin path acotado o con node_modules. */
export function shouldPreventiveBlockGlob(args: Record<string, unknown>): boolean {
  const pattern = String(args?.pattern ?? "");
  if (!PREVENTIVE_GLOB_PATTERNS.includes(pattern)) return false;
  const pathValue = args?.path;
  const unboundedPath =
    pathValue === undefined || pathValue === null || pathValue === "" || pathValue === "." || pathValue === "/";
  const pathSegments = typeof pathValue === "string" ? pathValue.split(/[\\/]/) : [];
  const hitsNodeModules = pathSegments.some((segment) => segment === "node_modules");
  return unboundedPath || hitsNodeModules;
}

/** Pre-gate de grep: sin `include` cuando el path es la raíz / no está acotado. */
export function shouldPreventiveBlockGrep(args: Record<string, unknown>): boolean {
  if (!PREVENTIVE_GREP_NO_INCLUDE_ROOT) return false;
  const include = args?.include;
  if (include !== undefined && include !== null && include !== "") return false;
  const pathValue = args?.path;
  return (
    pathValue === undefined || pathValue === null || pathValue === "" || pathValue === "." || pathValue === "/"
  );
}

type ToolOutput = { output?: unknown; metadata?: Record<string, unknown> };

/**
 * Detecta entrega de attachment imagen/PDF: la tool devuelve un texto corto
 * (`Image read successfully`) más un attachment base64 que no se refleja en
 * `string.length` pero sí satura contexto multimodal/memoria.
 */
export function isImageOrPdfOutput(output: ToolOutput | undefined): boolean {
  if (!output) return false;
  if (typeof output.output === "string" && output.output === "Image read successfully") return true;
  const attachment = output.metadata?.attachment;
  if (attachment === undefined || attachment === null || attachment === false) return false;
  return true;
}
