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
export function parseAutonomyLayer(raw: string): LayerParseResult;
/**
 * Valida el contenido de la capa de permisos.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parsePermissionsLayer(raw: string): LayerParseResult;
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
export function readOperationalLayers(directories: string[]): OperationalLayersOk | OperationalLayersError;
/**
 * Mensaje operativo de una capa ausente o inválida.
 *
 * @param {{ layer?: string, reason?: string, path?: string | null }} error
 * @returns {string}
 */
export function buildLayerBlockMessage(error: {
    layer?: string;
    reason?: string;
    path?: string | null;
}): string;
/**
 * Parser de las capas almacenadas que el gate valida antes de aplicar la
 * allowlist técnica del runner. No autoriza herramientas: solo comprueba que
 * la capa de autonomía y la de permisos existan y sean válidas en el target.
 */
export const AUTONOMY_PROFILES: string[];
export const PERMISSION_ENVELOPES: string[];
/** Directorios candidatos de configuración, probados en orden dentro de cada raíz. */
export const LAYER_DIR_CANDIDATES: string[];
export type AutonomyParse = {
    ok: true;
    value: {
        version: number;
        profile: string;
    };
};
export type PermissionsParse = {
    ok: true;
    value: {
        version: number;
        envelope: string;
    };
};
export type LayerParseFailure = {
    ok: false;
    value: null;
    reason: string;
};
export type LayerParseResult = AutonomyParse | PermissionsParse | LayerParseFailure;
export type OperationalLayersOk = {
    ok: true;
    layers: {
        autonomy: {
            version: number;
            profile: string;
        };
        permissions: {
            version: number;
            envelope: string;
        };
    };
};
export type OperationalLayersError = {
    ok: false;
    layer: string;
    reason: string;
    path: string | null;
    configDir: string | null;
};
