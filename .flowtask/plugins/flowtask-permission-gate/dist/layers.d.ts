/**
 * @typedef {{ ok: true, value: { version: number, profile: string } }} AutonomyParse
 * @typedef {{ ok: true, value: { version: number, envelope: string } }} PermissionsParse
 * @typedef {{ ok: false, value: null, reason: string }} LayerParseFailure
 * @typedef {AutonomyParse | PermissionsParse | LayerParseFailure} LayerParseResult
 * @typedef {{ ok: true, layers: { autonomy: { version: number, profile: string }, permissions: { version: number, envelope: string } } }} OperationalLayersOk
 * @typedef {{ ok: false, layer: string, reason: string, path: string | null, configDir: string | null }} OperationalLayersError
 */
/**
 * Validates the content of the autonomy layer.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parseAutonomyLayer(raw: string): LayerParseResult;
/**
 * Validates the content of the permissions layer.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parsePermissionsLayer(raw: string): LayerParseResult;
/**
 * Resolves the operational layers of a target.
 *
 * The first candidate directory that contains `autonomy.json` or
 * `permissions.json` is the source: both files must exist and be valid there.
 * When no candidate contains a layer, the target declares no layer
 * configuration: the result is a failure with `configDir: null` and the gate
 * denies with the permissions-layer message.
 *
 * @param {string[]} directories
 * @returns {OperationalLayersOk | OperationalLayersError}
 */
export function readOperationalLayers(directories: string[]): OperationalLayersOk | OperationalLayersError;
/**
 * Operational message for a missing or invalid layer.
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
 * Parser of the stored layers that the gate validates before applying the
 * runner's technical allowlist. It does not authorize tools: it only checks
 * that the autonomy and permissions layers exist and are valid in the target.
 */
export const AUTONOMY_PROFILES: string[];
export const PERMISSION_ENVELOPES: string[];
/** Candidate configuration directories, tried in order within each root. */
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
