import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Parser of the stored layers that the gate validates before applying the
 * runner's technical allowlist. It does not authorize tools: it only checks
 * that the autonomy and permissions layers exist and are valid in the target.
 */

export const AUTONOMY_PROFILES = ["assistant", "autonomous-dev", "hermes"];

export const PERMISSION_ENVELOPES = ["standard"];

/** Candidate configuration directories, tried in order within each root. */
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
 * Validates the content of the autonomy layer.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parseAutonomyLayer(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.version !== 1) {
    return { ok: false, value: null, reason: `invalid autonomy version: ${describe(value.version)}` };
  }
  if (!AUTONOMY_PROFILES.includes(value.profile)) {
    return { ok: false, value: null, reason: `unknown autonomy profile: ${describe(value.profile)}` };
  }
  return { ok: true, value: { version: 1, profile: value.profile }, reason: null };
}

/**
 * Validates the content of the permissions layer.
 *
 * @param {string} raw
 * @returns {LayerParseResult}
 */
export function parsePermissionsLayer(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.version !== 1) {
    return { ok: false, value: null, reason: `invalid permissions version: ${describe(value.version)}` };
  }
  if (!PERMISSION_ENVELOPES.includes(value.envelope)) {
    return { ok: false, value: null, reason: `unknown envelope: ${describe(value.envelope)}` };
  }
  return { ok: true, value: { version: 1, envelope: value.envelope }, reason: null };
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value;
}

function parseJsonObject(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, value: null, reason: "invalid JSON: the file is not parseable" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, value: null, reason: "the file does not contain a JSON object" };
  }
  return { ok: true, value, reason: null };
}

function readLayerFile(filePath, parse) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: false, value: null, reason: "missing layer: the layer file was not found" };
    }
    return { ok: false, value: null, reason: "the layer file could not be read" };
  }
  return parse(raw);
}

/**
 * Resolves the operational layers of a target.
 *
 * The first candidate directory that contains `autonomy.json` or
 * `permissions.json` is the source: both files must exist and be valid there.
 * When no candidate contains a layer, the target declares no layer
 * configuration and the check does not apply.
 *
 * @param {string[]} directories
 * @returns {OperationalLayersOk | OperationalLayersError}
 */
export function readOperationalLayers(directories) {
  const roots = Array.isArray(directories) ? directories : [directories];

  for (const root of roots) {
    if (!root) continue;
    for (const candidate of LAYER_DIR_CANDIDATES) {
      const configDir = resolve(root, candidate);
      const autonomyPath = join(configDir, AUTONOMY_FILE);
      const permissionsPath = join(configDir, PERMISSIONS_FILE);
      if (!existsSync(autonomyPath) && !existsSync(permissionsPath)) continue;

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
    reason: "missing permissions layer: the target declares no layer configuration",
    path: join(resolve(firstRoot, LAYER_DIR_CANDIDATES[0]), PERMISSIONS_FILE),
    configDir: null,
  };
}

/**
 * Operational message for a missing or invalid layer.
 *
 * @param {{ layer?: string, reason?: string, path?: string | null }} error
 * @returns {string}
 */
export function buildLayerBlockMessage(error) {
  const layerLabel = error && error.layer === "autonomy" ? "autonomy" : "permissions";
  return [
    `[FlowTask Permission Gate] Missing or invalid ${layerLabel} layer.`,
    `File: ${error && error.path ? error.path : "unidentified"}`,
    `Cause: ${error && error.reason ? error.reason : "invalid layer"}`,
    "Action: fix the layer or run flowtask update; the Runner does not execute tools with expanded limits.",
  ].join("\n");
}
