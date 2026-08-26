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
 * Fallback exacto sin preview. `tool` es literal read/glob/grep, `actual` el
 * tamaño real medido y `threshold` el umbral aplicable (por tool o acumulado).
 */
export declare function buildFallback(tool: BudgetTool, actual: number, threshold: number): string;
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
