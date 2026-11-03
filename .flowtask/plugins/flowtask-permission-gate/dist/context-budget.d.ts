/** Per-call threshold — read (chars of `output.output`). */
export declare const DEFAULT_READ_THRESHOLD = 16000;
/** Per-call threshold — grep (chars of `output.output`). */
export declare const DEFAULT_GREP_THRESHOLD = 8000;
/** Per-call threshold — glob (chars of `output.output`). */
export declare const DEFAULT_GLOB_THRESHOLD = 8000;
/** Maximum chars delivered per runner turn (reset by chat.message). */
export declare const DEFAULT_TURN_ACCUMULATED = 32000;
/** `stat.size` (bytes) that without `limit`/`offset` triggers the read pre-gate. */
export declare const PREVENTIVE_READ_STAT_LIMIT: number;
/** Glob patterns that without a bounded path trigger the pre-gate (closed list). */
export declare const PREVENTIVE_GLOB_PATTERNS: string[];
/** grep without `include` on the root triggers the pre-gate. */
export declare const PREVENTIVE_GREP_NO_INCLUDE_ROOT = true;
/** Image/PDF attachment blocked for the runner (delegation to the Inspector). */
export declare const IMAGE_PDF_BLOCKED = true;
export type BudgetTool = "read" | "glob" | "grep";
/** Scope of the applied budget: per call or accumulated per turn. */
export type BudgetScope = "call" | "turn";
/** Observable degradation level of a delivery. */
export type DegradationLevel = "notice" | "reduced" | "turn_omitted" | "attachment_delegated" | "measurement_unavailable";
/** Who can handle what was omitted for context. */
export declare const DELEGATION_TARGET = "Inspector";
/** What is omitted in each tool, named in the reduced-delivery message. */
export declare const CONTENT_LABEL: Record<BudgetTool, string>;
/** How to narrow a broad request, named in the prior notice. */
export declare const NARROWING: Record<BudgetTool, string>;
export type ContextBudgetConfig = {
    /** Per-call read threshold (chars). */
    readThreshold: number;
    /** Per-call grep threshold (chars). */
    grepThreshold: number;
    /** Per-call glob threshold (chars). */
    globThreshold: number;
    /** Maximum chars delivered per turn. */
    turnAccumulated: number;
    /** `stat.size` (bytes) that without limit/offset triggers the read pre-gate. */
    preventiveReadStatLimit: number;
    /** Broad glob patterns from the pre-gate closed list. */
    preventiveGlobPatterns: string[];
    /** Path segments considered unbounded (e.g. node_modules). */
    blockedPaths: string[];
};
/**
 * Loads the config with defaults; if a readable override file exists in workdir
 * (first) or sessionDir (fallback), applies it. Fail-open: never throws.
 */
export declare function loadContextBudgetConfig(workdir: string, sessionDir?: string): ContextBudgetConfig;
/**
 * Prior narrowing notice: the first broad request of the turn is announced with
 * the way to narrow it and is not executed. It exposes no figures or content.
 */
export declare function buildNarrowingNotice(tool: BudgetTool, args: Record<string, unknown>): string;
/**
 * Reduced delivery: names what was omitted, how much it weighed, and who to
 * delegate to, without a preview of the omitted content. The budget is named by
 * its scope, never by its figure.
 */
export declare function buildReducedDelivery(tool: BudgetTool, actual: number, scope?: BudgetScope): string;
/**
 * Delivery of an image/PDF attachment: the measured text does not reflect the
 * real cost of the attachment, so the attachment is delegated and not delivered.
 */
export declare function buildAttachmentDelivery(tool: BudgetTool, actual: number): string;
/**
 * Exact fallback without preview. `tool` is a literal read/glob/grep, `actual`
 * the real measured size, and `threshold` the applicable threshold; the figure
 * is not published: the message names the scope of the per-call budget.
 */
export declare function buildFallback(tool: BudgetTool, actual: number, _threshold: number): string;
/** Observable degradation mark on the delivery metadata. */
export declare function buildDegradationMetadata(level: DegradationLevel, options?: {
    budget?: BudgetScope;
    omittedChars?: number;
}): Record<string, unknown>;
/**
 * Identity of the broad request. The tool prefix prevents collisions between
 * each tool's field sets.
 */
export declare function noticeKey(tool: BudgetTool, args: Record<string, unknown>): string;
/** Narrowing notices already issued, per session and per broad request. */
export declare const PRE_GATE_NOTICES: Map<string, Set<string>>;
/**
 * Registers the notice for a broad request. Returns `true` the first time (the
 * notice is emitted and the request is not executed) and `false` if it was
 * already emitted in this turn (the request is allowed and the delivery is
 * reduced afterward).
 */
export declare function registerNarrowingNotice(sessionID: string, tool: BudgetTool, args: Record<string, unknown>): boolean;
/** Resets the narrowing notices of one session or all of them. */
export declare function resetNarrowingNotices(sessionID?: string): void;
/**
 * Cheap read pre-gate: file without `limit`/`offset` whose `stat.size` exceeds
 * the preventive limit. `statSize` may come from the caller's prior `statSync`;
 * if it is `undefined` (stat failed), it does NOT block: the post-gate decides.
 */
export declare function shouldPreventiveBlockRead(args: Record<string, unknown>, statSize?: number): boolean;
/** Glob pre-gate: broad pattern from the closed list without a bounded path or with node_modules. */
export declare function shouldPreventiveBlockGlob(args: Record<string, unknown>): boolean;
/** grep pre-gate: no `include` when the path is the root / unbounded. */
export declare function shouldPreventiveBlockGrep(args: Record<string, unknown>): boolean;
type ToolOutput = {
    output?: unknown;
    metadata?: Record<string, unknown>;
};
/**
 * Detects image/PDF attachment delivery: the tool returns a short text
 * (`Image read successfully`) plus a base64 attachment that is not reflected in
 * `string.length` but does saturate multimodal context/memory.
 */
export declare function isImageOrPdfOutput(output: ToolOutput | undefined): boolean;
export {};
