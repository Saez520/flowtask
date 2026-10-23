import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
/**
 * Parser de las capas almacenadas que el gate valida antes de aplicar la
 * allowlist técnica del runner. No autoriza herramientas: solo comprueba que
 * la capa de autonomía y la de permisos existan y sean válidas en el target.
 */
export const AUTONOMY_PROFILES = ["assistant", "autonomous-dev", "hermes"];
export const PERMISSION_ENVELOPES = ["standard"];
/** Directorios candidatos de configuración, probados en orden dentro de cada raíz. */
export const LAYER_DIR_CANDIDATES = [
    ".opencode/flowtask/config",
    ".claude/flowtask/config",
    ".vscode/flowtask/config",
    ".flowtask/config",
];
const AUTONOMY_FILE = "autonomy.json";
const PERMISSIONS_FILE = "permissions.json";
/**
 * @typedef {{ ok: true, value: { version: number, profile: string } }} AutonomyParse
 * @typedef {{ ok: true, value: { version: number, envelope: string } }} PermissionsParse
 * @typedef {{ ok: false, value: null, reason: string }} LayerParseFailure
 * @typedef {AutonomyParse | PermissionsParse | LayerParseFailure} LayerParseResult
 * @typedef {{ ok: true, layers: { autonomy: { version: number, profile: string }, permissions: { version: number, envelope: string } } }} OperationalLayersOk
 * @typedef {{ ok: false, layer: string, reason: string, path: string | null, configDir: string | null }} OperationalLayersError
 */
/**
 * Valida el contenido de la capa de autonomía.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parseAutonomyLayer(raw) {
    const parsed = parseJsonObject(raw);
    if (!parsed.ok)
        return parsed;
    const value = parsed.value;
    if (value.version !== 1) {
        return { ok: false, value: null, reason: `versión de autonomía inválida: ${describe(value.version)}` };
    }
    if (!AUTONOMY_PROFILES.includes(value.profile)) {
        return { ok: false, value: null, reason: `perfil de autonomía desconocido: ${describe(value.profile)}` };
    }
    return { ok: true, value: { version: 1, profile: value.profile }, reason: null };
}
/**
 * Valida el contenido de la capa de permisos.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parsePermissionsLayer(raw) {
    const parsed = parseJsonObject(raw);
    if (!parsed.ok)
        return parsed;
    const value = parsed.value;
    if (value.version !== 1) {
        return { ok: false, value: null, reason: `versión de permisos inválida: ${describe(value.version)}` };
    }
    if (!PERMISSION_ENVELOPES.includes(value.envelope)) {
        return { ok: false, value: null, reason: `envelope desconocido: ${describe(value.envelope)}` };
    }
    return { ok: true, value: { version: 1, envelope: value.envelope }, reason: null };
}
function describe(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (value === null)
        return "null";
    if (value === undefined)
        return "undefined";
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return typeof value;
}
function parseJsonObject(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return { ok: false, value: null, reason: "JSON inválido: el archivo no es parseable" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, value: null, reason: "el archivo no contiene un objeto JSON" };
    }
    return { ok: true, value, reason: null };
}
function readLayerFile(filePath, parse) {
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch (error) {
        if (error && error.code === "ENOENT") {
            return { ok: false, value: null, reason: "capa ausente: no se encontró el archivo de la capa" };
        }
        return { ok: false, value: null, reason: "no se pudo leer el archivo de la capa" };
    }
    return parse(raw);
}
/**
 * Resuelve las capas operativas de un target.
 *
 * El primer directorio candidato que contiene `autonomy.json` o
 * `permissions.json` es la fuente: ahí ambos archivos deben existir y ser
 * válidos. Cuando ningún candidato contiene una capa, el target no declara
 * configuración de capas y la comprobación no aplica.
 *
 * @param {string[]} directories
 * @returns {OperationalLayersOk | OperationalLayersError}
 */
export function readOperationalLayers(directories) {
    const roots = Array.isArray(directories) ? directories : [directories];
    for (const root of roots) {
        if (!root)
            continue;
        for (const candidate of LAYER_DIR_CANDIDATES) {
            const configDir = resolve(root, candidate);
            const autonomyPath = join(configDir, AUTONOMY_FILE);
            const permissionsPath = join(configDir, PERMISSIONS_FILE);
            if (!existsSync(autonomyPath) && !existsSync(permissionsPath))
                continue;
            const autonomy = readLayerFile(autonomyPath, parseAutonomyLayer);
            if (!autonomy.ok) {
                return { ok: false, layer: "autonomy", reason: autonomy.reason, path: autonomyPath, configDir };
            }
            const permissions = readLayerFile(permissionsPath, parsePermissionsLayer);
            if (!permissions.ok) {
                return { ok: false, layer: "permissions", reason: permissions.reason, path: permissionsPath, configDir };
            }
            return {
                ok: true,
                layers: { autonomy: autonomy.value, permissions: permissions.value },
                configDir,
            };
        }
    }
    const firstRoot = roots.find(Boolean) || process.cwd();
    return {
        ok: false,
        layer: "permissions",
        reason: "capa de permisos ausente: el target no declara ninguna configuración de capas",
        path: join(resolve(firstRoot, LAYER_DIR_CANDIDATES[0]), PERMISSIONS_FILE),
        configDir: null,
    };
}
/**
 * Mensaje operativo de una capa ausente o inválida.
 *
 * @param {{ layer?: string, reason?: string, path?: string | null }} error
 * @returns {string}
 */
export function buildLayerBlockMessage(error) {
    const layerLabel = error && error.layer === "autonomy" ? "autonomía" : "permisos";
    return [
        `[FlowTask Permission Gate] Capa de ${layerLabel} ausente o inválida.`,
        `Archivo: ${error && error.path ? error.path : "no identificado"}`,
        `Causa: ${error && error.reason ? error.reason : "capa inválida"}`,
        "Acción: corregí la capa o ejecutá flowtask update; el Runner no ejecuta herramientas con límites ampliados.",
    ].join("\n");
}
