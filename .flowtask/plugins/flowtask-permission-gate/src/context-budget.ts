/**
 * Context budget for the runner's read tools.
 *
 * Transparent tool gate on the V2 tool result (mutable `output`/`content` and
 * `metadata`). Measures the delivered text length (proxy chars/4 tokens) and
 * degrades the delivery by levels before omitting it:
 *
 * 1. `notice` — the first broad request of the turn is announced with the way
 *    to narrow it and is not executed.
 * 2. `reduced` — a delivery that exceeds the per-call budget is reduced:
 *    it declares what was omitted, how much it weighed, and who to delegate to,
 *    without a preview.
 * 3. `turn_omitted` — the turn total reaches the accumulated budget: the next
 *    delivery is omitted even if each piece fits on its own.
 *
 * Image/PDF attachments are delegated (`attachment_delegated`) and output that
 * cannot be measured is delivered intact with a trace (`measurement_unavailable`).
 *
 * The limits live EXCLUSIVELY in this tool; the runner does not know the
 * thresholds and they are not exposed in the prompt: messages name the scope of
 * the applied budget and the real omitted size, never the figure. Optional
 * per-file override in `.flowtask/config/context-budget.json` (fail-open to
 * defaults).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Per-call threshold — read (chars of `output.output`). */
export const DEFAULT_READ_THRESHOLD = 16000;
/** Per-call threshold — grep (chars of `output.output`). */
export const DEFAULT_GREP_THRESHOLD = 8000;
/** Per-call threshold — glob (chars of `output.output`). */
export const DEFAULT_GLOB_THRESHOLD = 8000;
/** Maximum chars delivered per runner turn (reset by the prompt hook). */
export const DEFAULT_TURN_ACCUMULATED = 32000;
/** `stat.size` (bytes) that without `limit`/`offset` triggers the read pre-gate. */
export const PREVENTIVE_READ_STAT_LIMIT = 50 * 1024;
/** Glob patterns that without a bounded path trigger the pre-gate (closed list). */
export const PREVENTIVE_GLOB_PATTERNS = ["**/*", "**"];
/** grep without `include` on the root triggers the pre-gate. */
export const PREVENTIVE_GREP_NO_INCLUDE_ROOT = true;
/** Image/PDF attachment blocked for the runner (delegation to the Inspector). */
export const IMAGE_PDF_BLOCKED = true;

export type BudgetTool = "read" | "glob" | "grep";

/** Scope of the applied budget: per call or accumulated per turn. */
export type BudgetScope = "call" | "turn";

/** Observable degradation level of a delivery. */
export type DegradationLevel =
  | "notice"
  | "reduced"
  | "turn_omitted"
  | "attachment_delegated"
  | "measurement_unavailable";

/** Who can handle what was omitted for context. */
export const DELEGATION_TARGET = "Inspector";

/** What is omitted in each tool, named in the reduced-delivery message. */
export const CONTENT_LABEL: Record<BudgetTool, string> = {
  read: "file content",
  grep: "matches",
  glob: "paths",
};

/** How to narrow a broad request, named in the prior notice. */
export const NARROWING: Record<BudgetTool, string> = {
  read: "use `limit`/`offset` or delegate the full file to the Inspector",
  grep: "narrow with `include` and `path`, or delegate the search to the Inspector",
  glob: "narrow `path` or use a more specific pattern, or delegate the listing to the Inspector",
};

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
 * Parses the override file. Observable fail-open: invalid JSON or
 * non-numeric/≤0 fields → `console.warn` + defaults. Never throws.
 */
function parseContextBudgetConfig(raw: string, filePath: string): ContextBudgetConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn(`[FlowTask Context Budget] invalid JSON in ${filePath}; using defaults.`);
    return defaultConfig();
  }

  if (!value || typeof value !== "object") {
    console.warn(`[FlowTask Context Budget] invalid configuration in ${filePath}; using defaults.`);
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
      console.warn(`[FlowTask Context Budget] field "${key}" is not a positive number in ${filePath}; using defaults.`);
    }
  }
  for (const key of array) {
    if (record[key] === undefined) continue;
    if (isStringArray(record[key])) {
      config[key] = [...record[key]];
    } else {
      invalid = true;
      console.warn(`[FlowTask Context Budget] field "${key}" is not a string array in ${filePath}; using defaults.`);
    }
  }

  if (invalid) {
    console.warn(`[FlowTask Context Budget] invalid configuration in ${filePath}; using defaults.`);
    return defaultConfig();
  }
  return config;
}

/**
 * Loads the config with defaults; if a readable override file exists in workdir
 * (first) or sessionDir (fallback), applies it. Fail-open: never throws.
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
        console.warn(`[FlowTask Context Budget] could not read ${filePath}; using defaults.`);
        continue;
      }
      return parseContextBudgetConfig(raw, filePath);
    }
  }
  return defaultConfig();
}

/**
 * Prior narrowing notice: the first broad request of the turn is announced with
 * the way to narrow it and is not executed. It exposes no figures or content.
 */
export function buildNarrowingNotice(tool: BudgetTool, args: Record<string, unknown>): string {
  return `Broad \`${tool}\` request (\`${narrowingTarget(tool, args)}\`): \`${NARROWING[tool]}\`.`;
}

/**
 * Reduced delivery: names what was omitted, how much it weighed, and who to
 * delegate to, without a preview of the omitted content. The budget is named by
 * its scope, never by its figure.
 */
export function buildReducedDelivery(tool: BudgetTool, actual: number, scope: BudgetScope = "call"): string {
  const budget = scope === "turn" ? "the accumulated turn budget" : "the per-call budget";
  return (
    `\`${tool}\` result reduced: \`${actual}\` chars of \`${CONTENT_LABEL[tool]}\` were omitted due to \`${budget}\`. ` +
    `Delegate the omitted content to the Inspector or narrow path/pattern/limit/include.`
  );
}

/**
 * Delivery of an image/PDF attachment: the measured text does not reflect the
 * real cost of the attachment, so the attachment is delegated and not delivered.
 */
export function buildAttachmentDelivery(tool: BudgetTool, actual: number): string {
  return (
    `\`${tool}\` attachment omitted: \`${actual}\` chars of measured text plus an image/PDF attachment. ` +
    `Delegate the attachment to the Inspector; the runner receives no attachments.`
  );
}

/**
 * Exact fallback without preview. `tool` is a literal read/glob/grep, `actual`
 * the real measured size, and `threshold` the applicable threshold; the figure
 * is not published: the message names the scope of the per-call budget.
 */
export function buildFallback(tool: BudgetTool, actual: number, _threshold: number): string {
  return buildReducedDelivery(tool, actual, "call");
}

/** Observable degradation mark on the delivery metadata. */
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

/** Target of the broad request: the file or the pattern, or the absence of a window. */
function narrowingTarget(tool: BudgetTool, args: Record<string, unknown>): string {
  const candidate = tool === "read" ? args?.file : args?.pattern;
  return typeof candidate === "string" && candidate ? candidate : "no bounded window";
}

/**
 * Identity of the broad request. The tool prefix prevents collisions between
 * each tool's field sets.
 */
export function noticeKey(tool: BudgetTool, args: Record<string, unknown>): string {
  const field = (value: unknown): string => (typeof value === "string" ? value : "");
  if (tool === "read") return `read|${field(args?.file)}`;
  if (tool === "glob") return `glob|${field(args?.pattern)}|${field(args?.path)}`;
  return `grep|${field(args?.pattern)}|${field(args?.path)}|${field(args?.include)}`;
}

/** Narrowing notices already issued, per session and per broad request. */
export const PRE_GATE_NOTICES = new Map<string, Set<string>>();

/**
 * Registers the notice for a broad request. Returns `true` the first time (the
 * notice is emitted and the request is not executed) and `false` if it was
 * already emitted in this turn (the request is allowed and the delivery is
 * reduced afterward).
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

/** Resets the narrowing notices of one session or all of them. */
export function resetNarrowingNotices(sessionID?: string): void {
  if (sessionID === undefined) {
    PRE_GATE_NOTICES.clear();
    return;
  }
  PRE_GATE_NOTICES.delete(sessionID);
}

/**
 * Cheap read pre-gate: file without `limit`/`offset` whose `stat.size` exceeds
 * the preventive limit. `statSize` may come from the caller's prior `statSync`;
 * if it is `undefined` (stat failed), it does NOT block: the post-gate decides.
 */
export function shouldPreventiveBlockRead(args: Record<string, unknown>, statSize?: number): boolean {
  const file = args?.file;
  if (typeof file !== "string" || !file) return false;
  const hasWindow = args.limit !== undefined || args.offset !== undefined;
  if (hasWindow) return false;
  if (statSize !== undefined && statSize > PREVENTIVE_READ_STAT_LIMIT) return true;
  return false;
}

/** Glob pre-gate: broad pattern from the closed list without a bounded path or with node_modules. */
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

/** grep pre-gate: no `include` when the path is the root / unbounded. */
export function shouldPreventiveBlockGrep(args: Record<string, unknown>): boolean {
  if (!PREVENTIVE_GREP_NO_INCLUDE_ROOT) return false;
  const include = args?.include;
  if (include !== undefined && include !== null && include !== "") return false;
  const pathValue = args?.path;
  return (
    pathValue === undefined || pathValue === null || pathValue === "" || pathValue === "." || pathValue === "/"
  );
}

type ToolOutput = { output?: unknown; content?: unknown; metadata?: Record<string, unknown> };

/**
 * Text delivered by a V2 tool result: `output` first, then `content` when it is
 * a string. Returns undefined when the delivery cannot be measured.
 */
export function readDeliveredText(result: ToolOutput | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.output === "string") return result.output;
  if (typeof result.content === "string") return result.content;
  return undefined;
}

/**
 * Applies a reduced delivery to a mutable V2 tool result: replaces the string
 * delivery fields and merges the observable degradation metadata. Never throws.
 */
export function applyReducedDelivery(
  result: ToolOutput | undefined,
  reduced: string,
  level: DegradationLevel,
  options: { budget?: BudgetScope; omittedChars?: number } = {},
): ToolOutput | undefined {
  if (!result) return result;
  if (typeof result.output === "string") result.output = reduced;
  if (typeof result.content === "string") result.content = reduced;
  result.metadata = {
    ...(result.metadata ?? {}),
    truncated: true,
    ...buildDegradationMetadata(level, options),
  };
  return result;
}

/**
 * Detects image/PDF attachment delivery: the tool returns a short text
 * (`Image read successfully`) plus a base64 attachment that is not reflected in
 * `string.length` but does saturate multimodal context/memory. V2 may also
 * deliver the payload as file parts in `content` or mark it in `metadata`.
 */
export function isImageOrPdfOutput(output: ToolOutput | undefined): boolean {
  if (!output) return false;
  if (typeof output.output === "string" && output.output === "Image read successfully") return true;
  const attachment = output.metadata?.attachment;
  if (attachment !== undefined && attachment !== null && attachment !== false) return true;
  if (Array.isArray(output.content)) {
    return output.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const record = part as Record<string, unknown>;
      return (
        record.type === "file" &&
        typeof record.mime === "string" &&
        (record.mime.startsWith("image/") || record.mime === "application/pdf")
      );
    });
  }
  return false;
}
