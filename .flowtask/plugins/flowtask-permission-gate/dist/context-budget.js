/**
 * Presupuesto de contexto para las herramientas de lectura del runner.
 *
 * Gate transparente en herramienta vía `tool.execute.after` (OpenCode 1.18.15,
 * output mutable). Mide `output.output.length` (proxy chars/4 tokens) y omite la
 * entrega al modelo cuando excede el umbral por llamada o el acumulado por turno.
 *
 * Los límites viven EXCLUSIVAMENTE en esta herramienta; el runner no conoce los
 * umbrales ni se le exponen en el prompt. Override opcional por archivo en
 * `.flowtask/config/context-budget.json` (fail-open a defaults).
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
const CONFIG_CANDIDATES = [
    ".flowtask/config/context-budget.json",
    ".opencode/flowtask/config/context-budget.json",
];
function defaultConfig() {
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
function isPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
/**
 * Parsea el override file. Fail-open observable: JSON inválido o campos no
 * numéricos/≤0 → `console.warn` + defaults. Nunca lanza.
 */
function parseContextBudgetConfig(raw, filePath) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        console.warn(`[FlowTask Context Budget] JSON inválido en ${filePath}; se usan defaults.`);
        return defaultConfig();
    }
    if (!value || typeof value !== "object") {
        console.warn(`[FlowTask Context Budget] Configuración inválida en ${filePath}; se usan defaults.`);
        return defaultConfig();
    }
    const record = value;
    const config = defaultConfig();
    const numeric = [
        "readThreshold",
        "grepThreshold",
        "globThreshold",
        "turnAccumulated",
        "preventiveReadStatLimit",
    ];
    const array = ["preventiveGlobPatterns", "blockedPaths"];
    let invalid = false;
    for (const key of numeric) {
        if (record[key] === undefined)
            continue;
        if (isPositiveNumber(record[key])) {
            config[key] = record[key];
        }
        else {
            invalid = true;
            console.warn(`[FlowTask Context Budget] Campo "${key}" no es un número positivo en ${filePath}; se usan defaults.`);
        }
    }
    for (const key of array) {
        if (record[key] === undefined)
            continue;
        if (isStringArray(record[key])) {
            config[key] = [...record[key]];
        }
        else {
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
export function loadContextBudgetConfig(workdir, sessionDir) {
    const directories = [workdir, sessionDir].filter((directory, index, values) => Boolean(directory) && values.indexOf(directory) === index);
    for (const directory of directories) {
        for (const candidate of CONFIG_CANDIDATES) {
            const filePath = resolve(directory, candidate);
            let raw;
            try {
                raw = readFileSync(filePath, "utf8");
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue;
                console.warn(`[FlowTask Context Budget] No se pudo leer ${filePath}; se usan defaults.`);
                continue;
            }
            return parseContextBudgetConfig(raw, filePath);
        }
    }
    return defaultConfig();
}
/**
 * Fallback exacto sin preview. `tool` es literal read/glob/grep, `actual` el
 * tamaño real medido y `threshold` el umbral aplicable (por tool o acumulado).
 */
export function buildFallback(tool, actual, threshold) {
    return (`Resultado de \`${tool}\` omitido: \`${actual}\` chars exceden el presupuesto \`${threshold}\`. ` +
        `Acotá path/pattern/limit/include o delegá al Inspector.`);
}
/**
 * Pre-gate barato de read: archivo sin `limit`/`offset` cuyo `stat.size` supera
 * el límite preventivo. `statSize` puede venir de un `statSync` previo del
 * llamador; si es `undefined` (stat falló) NO se bloquea: el post-gate decide.
 */
export function shouldPreventiveBlockRead(args, statSize) {
    const file = args?.file;
    if (typeof file !== "string" || !file)
        return false;
    const hasWindow = args.limit !== undefined || args.offset !== undefined;
    if (hasWindow)
        return false;
    if (statSize !== undefined && statSize > PREVENTIVE_READ_STAT_LIMIT)
        return true;
    return false;
}
/** Pre-gate de glob: pattern amplio de la lista cerrada sin path acotado o con node_modules. */
export function shouldPreventiveBlockGlob(args) {
    const pattern = String(args?.pattern ?? "");
    if (!PREVENTIVE_GLOB_PATTERNS.includes(pattern))
        return false;
    const pathValue = args?.path;
    const unboundedPath = pathValue === undefined || pathValue === null || pathValue === "" || pathValue === "." || pathValue === "/";
    const pathSegments = typeof pathValue === "string" ? pathValue.split(/[\\/]/) : [];
    const hitsNodeModules = pathSegments.some((segment) => segment === "node_modules");
    return unboundedPath || hitsNodeModules;
}
/** Pre-gate de grep: sin `include` cuando el path es la raíz / no está acotado. */
export function shouldPreventiveBlockGrep(args) {
    if (!PREVENTIVE_GREP_NO_INCLUDE_ROOT)
        return false;
    const include = args?.include;
    if (include !== undefined && include !== null && include !== "")
        return false;
    const pathValue = args?.path;
    return (pathValue === undefined || pathValue === null || pathValue === "" || pathValue === "." || pathValue === "/");
}
/**
 * Detecta entrega de attachment imagen/PDF: la tool devuelve un texto corto
 * (`Image read successfully`) más un attachment base64 que no se refleja en
 * `string.length` pero sí satura contexto multimodal/memoria.
 */
export function isImageOrPdfOutput(output) {
    if (!output)
        return false;
    if (typeof output.output === "string" && output.output === "Image read successfully")
        return true;
    const attachment = output.metadata?.attachment;
    if (attachment === undefined || attachment === null || attachment === false)
        return false;
    return true;
}
