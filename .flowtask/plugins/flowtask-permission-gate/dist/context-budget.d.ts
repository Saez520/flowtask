/** Umbral por llamada — read (chars de `output.output`). */
export declare const DEFAULT_READ_THRESHOLD = 16000;
/** Umbral por llamada — grep (chars de `output.output`). */
export declare const DEFAULT_GREP_THRESHOLD = 8000;
/** Umbral por llamada — glob (chars de `output.output`). */
export declare const DEFAULT_GLOB_THRESHOLD = 8000;
/** Suma máxima de chars entregados por turno del runner (reset por chat.message). */
export declare const DEFAULT_TURN_ACCUMULATED = 32000;
/** `stat.size` (bytes) que sin `limit`/`offset` dispara el pre-gate de read. */
export declare const PREVENTIVE_READ_STAT_LIMIT: number;
/** Patterns glob que sin path acotado disparan el pre-gate (lista cerrada). */
export declare const PREVENTIVE_GLOB_PATTERNS: string[];
/** grep sin `include` sobre la raíz dispara el pre-gate. */
export declare const PREVENTIVE_GREP_NO_INCLUDE_ROOT = true;
/** Attachment imagen/PDF bloqueado al runner (delegación al Inspector). */
export declare const IMAGE_PDF_BLOCKED = true;
export type BudgetTool = "read" | "glob" | "grep";
/** Ámbito del presupuesto aplicado: por llamada o acumulado del turno. */
export type BudgetScope = "call" | "turn";
/** Nivel de degradación observable de una entrega. */
export type DegradationLevel = "notice" | "reduced" | "turn_omitted" | "attachment_delegated" | "measurement_unavailable";
/** Quién puede tratar lo omitido por contexto. */
export declare const DELEGATION_TARGET = "Inspector";
/** Qué se omite en cada herramienta, nombrado en el mensaje de entrega reducida. */
export declare const CONTENT_LABEL: Record<BudgetTool, string>;
/** Cómo acotar un pedido amplio, nombrado en el aviso previo. */
export declare const NARROWING: Record<BudgetTool, string>;
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
/**
 * Carga la config con defaults; si existe un override file legible en workdir
 * (primero) o sessionDir (fallback), lo aplica. Fail-open: nunca lanza.
 */
export declare function loadContextBudgetConfig(workdir: string, sessionDir?: string): ContextBudgetConfig;
/**
 * Aviso de acotación previo: el primer pedido amplio del turno se anuncia con
 * la forma de acotar y no se ejecuta. No expone cifras ni contenido.
 */
export declare function buildNarrowingNotice(tool: BudgetTool, args: Record<string, unknown>): string;
/**
 * Entrega reducida: nombra qué se omitió, cuánto pesaba y a quién delegar, sin
 * preview del contenido omitido. El presupuesto se nombra por su ámbito, nunca
 * por su cifra.
 */
export declare function buildReducedDelivery(tool: BudgetTool, actual: number, scope?: BudgetScope): string;
/**
 * Entrega de un adjunto imagen/PDF: el texto medido no refleja el costo real
 * del adjunto, así que el adjunto se delega y no se entrega.
 */
export declare function buildAttachmentDelivery(tool: BudgetTool, actual: number): string;
/**
 * Fallback exacto sin preview. `tool` es literal read/glob/grep, `actual` el
 * tamaño real medido y `threshold` el umbral aplicable; la cifra no se
 * publica: el mensaje nombra el ámbito del presupuesto por llamada.
 */
export declare function buildFallback(tool: BudgetTool, actual: number, _threshold: number): string;
/** Marca de degradación observable sobre la metadata de la entrega. */
export declare function buildDegradationMetadata(level: DegradationLevel, options?: {
    budget?: BudgetScope;
    omittedChars?: number;
}): Record<string, unknown>;
/**
 * Identidad del pedido amplio. El prefijo de herramienta evita colisiones
 * entre los conjuntos de campos de cada una.
 */
export declare function noticeKey(tool: BudgetTool, args: Record<string, unknown>): string;
/** Avisos de acotación ya emitidos, por sesión y por pedido amplio. */
export declare const PRE_GATE_NOTICES: Map<string, Set<string>>;
/**
 * Registra el aviso de un pedido amplio. Devuelve `true` la primera vez (el
 * aviso se emite y el pedido no se ejecuta) y `false` si ya se emitió en este
 * turno (el pedido se permite y la entrega se reduce después).
 */
export declare function registerNarrowingNotice(sessionID: string, tool: BudgetTool, args: Record<string, unknown>): boolean;
/** Reinicia los avisos de acotación de una sesión o de todas. */
export declare function resetNarrowingNotices(sessionID?: string): void;
/**
 * Pre-gate barato de read: archivo sin `limit`/`offset` cuyo `stat.size` supera
 * el límite preventivo. `statSize` puede venir de un `statSync` previo del
 * llamador; si es `undefined` (stat falló) NO se bloquea: el post-gate decide.
 */
export declare function shouldPreventiveBlockRead(args: Record<string, unknown>, statSize?: number): boolean;
/** Pre-gate de glob: pattern amplio de la lista cerrada sin path acotado o con node_modules. */
export declare function shouldPreventiveBlockGlob(args: Record<string, unknown>): boolean;
/** Pre-gate de grep: sin `include` cuando el path es la raíz / no está acotado. */
export declare function shouldPreventiveBlockGrep(args: Record<string, unknown>): boolean;
type ToolOutput = {
    output?: unknown;
    metadata?: Record<string, unknown>;
};
/**
 * Detecta entrega de attachment imagen/PDF: la tool devuelve un texto corto
 * (`Image read successfully`) más un attachment base64 que no se refleja en
 * `string.length` pero sí satura contexto multimodal/memoria.
 */
export declare function isImageOrPdfOutput(output: ToolOutput | undefined): boolean;
export {};
