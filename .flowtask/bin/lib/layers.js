import fs from "fs";
import path from "path";

/**
 * Logical contract for the three stored layers: persona (tone), autonomy
 * (initiative), and permissions (technical envelope). Each layer is validated
 * and resolved separately; precedence between them is `permissions > autonomy > persona`.
 */

export const PERSONA_LEVELS = Object.freeze(["training", "mid", "senior", "custom"]);

/** Legacy read alias. It is normalized to `training`; it is never emitted on write. */
export const LEGACY_PERSONA_LEVELS = Object.freeze(["junior"]);

export const AUTONOMY_PROFILES = Object.freeze(["assistant", "autonomous-dev"]);

export const PERMISSION_ENVELOPES = Object.freeze(["standard"]);

/** Structural precedence order between layers. */
export const LAYER_ORDER = Object.freeze(["permissions", "autonomy", "persona"]);

export const LAYER_FILES = Object.freeze({
  persona: "profile.json",
  autonomy: "autonomy.json",
  permissions: "permissions.json",
});

/**
 * Migration defaults. They are written only when the layer does not exist: they are a
 * migration, not a runtime fallback. An invalid layer is never repaired with
 * a default.
 */
export const MIGRATION_DEFAULTS = Object.freeze({
  autonomy: Object.freeze({ version: 1, profile: "autonomous-dev" }),
  permissions: Object.freeze({ version: 1, envelope: "standard" }),
});

/** Logical resolution sources. */
export const LAYER_SOURCES = Object.freeze(["team", "project"]);

const VALIDATORS = Object.freeze({
  persona: validatePersonaLayer,
  autonomy: validateAutonomyLayer,
  permissions: validatePermissionsLayer,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describeValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return typeof value;
}

/**
 * Normalizes the persona level. `junior` is a legacy read alias and is
 * resolved to `training`; any other unknown value is not normalized.
 */
export function normalizePersonaLevel(level) {
  if (typeof level !== "string") return null;
  const trimmed = level.trim();
  if (PERSONA_LEVELS.includes(trimmed)) return trimmed;
  if (LEGACY_PERSONA_LEVELS.includes(trimmed)) return "training";
  return null;
}

export function validatePersonaLayer(raw) {
  if (raw === null || raw === undefined) return { status: "missing", value: null, reason: null };
  if (!isPlainObject(raw)) {
    return { status: "invalid", value: null, reason: "the persona layer is not a JSON object" };
  }
  const level = normalizePersonaLevel(raw.level);
  if (!level) {
    return { status: "invalid", value: null, reason: `unknown persona level: ${describeValue(raw.level)}` };
  }
  if (typeof raw.persona !== "string" || !raw.persona.trim()) {
    return { status: "invalid", value: null, reason: "the persona layer does not declare a \"persona\" value" };
  }
  return {
    status: "valid",
    value: { level, persona: raw.persona, onboarded: raw.onboarded === true },
    reason: null,
  };
}

export function validateAutonomyLayer(raw) {
  if (raw === null || raw === undefined) return { status: "missing", value: null, reason: null };
  if (!isPlainObject(raw)) {
    return { status: "invalid", value: null, reason: "the autonomy layer is not a JSON object" };
  }
  if (raw.version !== 1) {
    return { status: "invalid", value: null, reason: `invalid autonomy version: ${describeValue(raw.version)}` };
  }
  if (!AUTONOMY_PROFILES.includes(raw.profile)) {
    return { status: "invalid", value: null, reason: `unknown autonomy profile: ${describeValue(raw.profile)}` };
  }
  return { status: "valid", value: { version: 1, profile: raw.profile }, reason: null };
}

export function validatePermissionsLayer(raw) {
  if (raw === null || raw === undefined) return { status: "missing", value: null, reason: null };
  if (!isPlainObject(raw)) {
    return { status: "invalid", value: null, reason: "the permissions layer is not a JSON object" };
  }
  if (raw.version !== 1) {
    return { status: "invalid", value: null, reason: `invalid permissions version: ${describeValue(raw.version)}` };
  }
  if (!PERMISSION_ENVELOPES.includes(raw.envelope)) {
    return { status: "invalid", value: null, reason: `unknown envelope: ${describeValue(raw.envelope)}` };
  }
  return { status: "valid", value: { version: 1, envelope: raw.envelope }, reason: null };
}

function validateLayer(name, raw) {
  const validator = VALIDATORS[name];
  if (!validator) throw new Error(`unknown layer: ${name}`);
  return validator(raw);
}

/**
 * Reads a layer file. State is file-level: `present` when the
 * JSON parses, `missing` when the file does not exist, and `invalid` when the
 * file exists but cannot be read or parsed.
 */
export function readLayerFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { status: "missing", value: null, reason: null, path: filePath };
    }
    return {
      status: "invalid",
      value: null,
      reason: `could not read the file: ${error && error.message ? error.message : "read error"}`,
      path: filePath,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "invalid",
      value: null,
      reason: `invalid JSON: ${error && error.message ? error.message : "unparseable content"}`,
      path: filePath,
    };
  }

  if (!isPlainObject(parsed)) {
    return { status: "invalid", value: null, reason: "the file does not contain a JSON object", path: filePath };
  }
  return { status: "present", value: parsed, reason: null, path: filePath };
}

/**
 * Reads the three layers from a configuration directory. Reading lives here:
 * the resolver never opens files.
 */
export function readLayerSources(configDir) {
  return {
    persona: readLayerFile(path.join(configDir, LAYER_FILES.persona)),
    autonomy: readLayerFile(path.join(configDir, LAYER_FILES.autonomy)),
    permissions: readLayerFile(path.join(configDir, LAYER_FILES.permissions)),
  };
}

/**
 * A source entry is a raw layer value or a file record
 * `{ status, value, reason, path }`. No layer schema declares a `status`
 * field, so the record shape is unambiguous.
 */
function isLayerRecord(entry) {
  return isPlainObject(entry) && Object.hasOwn(entry, "status");
}

function evaluateLayer(name, entry) {
  if (entry === null || entry === undefined) {
    return { status: "missing", value: null, reason: null, path: null };
  }

  if (isLayerRecord(entry)) {
    if (entry.status === "missing") {
      return { status: "missing", value: null, reason: entry.reason ?? null, path: entry.path ?? null };
    }
    if (entry.status === "invalid") {
      return { status: "invalid", value: null, reason: entry.reason ?? "invalid layer", path: entry.path ?? null };
    }
    const validated = validateLayer(name, entry.value);
    return {
      status: validated.status,
      value: validated.value,
      reason: validated.reason,
      path: entry.path ?? null,
    };
  }

  const validated = validateLayer(name, entry);
  return { status: validated.status, value: validated.value, reason: validated.reason, path: null };
}

/**
 * Resolves a layer: the project governs entirely when it defines it (valid or
 * invalid); if it does not define it, the team base applies; if neither defines it,
 * the layer is absent. Fields are never mixed between sources.
 */
function resolveLayer(name, projectEntry, teamEntry) {
  const project = evaluateLayer(name, projectEntry);
  if (project.status !== "missing") {
    return {
      status: project.status,
      value: project.value,
      source: "project",
      reason: project.reason,
      path: project.path,
    };
  }

  const team = evaluateLayer(name, teamEntry);
  if (team.status !== "missing") {
    return {
      status: team.status,
      value: team.value,
      source: "team",
      reason: team.reason,
      path: team.path,
    };
  }

  return { status: "missing", value: null, source: null, reason: null, path: project.path ?? team.path ?? null };
}

function buildOperationalError(code, layer, state) {
  const reason = state.reason
    ?? (state.status === "missing"
      ? "layer missing: the layer file was not found"
      : "invalid layer");
  const error = { code, layer, path: state.path ?? null, reason };
  error.message = describeOperationalFailure(error);
  return error;
}

function buildOperationalStatus(layers) {
  const errors = [];
  const autonomy = layers.autonomy;
  const permissions = layers.permissions;

  if (autonomy.status === "missing") errors.push(buildOperationalError("autonomy_missing", "autonomy", autonomy));
  else if (autonomy.status === "invalid") errors.push(buildOperationalError("autonomy_invalid", "autonomy", autonomy));

  if (permissions.status === "missing") errors.push(buildOperationalError("permissions_missing", "permissions", permissions));
  else if (permissions.status === "invalid") errors.push(buildOperationalError("permissions_invalid", "permissions", permissions));

  return { ok: errors.length === 0, errors };
}

function buildWarnings(layers) {
  const warnings = [];
  const persona = layers.persona;
  if (persona.status === "missing") {
    warnings.push("Persona layer missing: continuing without persona injection.");
  } else if (persona.status === "invalid") {
    warnings.push(`Invalid persona layer: ${persona.reason}. Continuing without persona injection.`);
  }
  return warnings;
}

/**
 * Resolves the three layers from two already-read logical sources.
 * Returns `{ layers, precedence, operational, warnings }`.
 */
export function resolveLayers({ team = null, project = null } = {}) {
  const layers = {};
  for (const name of LAYER_ORDER) {
    layers[name] = resolveLayer(name, project ? project[name] : null, team ? team[name] : null);
  }
  return {
    layers,
    precedence: [...LAYER_ORDER],
    operational: buildOperationalStatus(layers),
    warnings: buildWarnings(layers),
  };
}

/** Operational message for a missing or invalid layer. */
export function describeOperationalFailure(error) {
  const isPermissions = error && error.layer === "permissions";
  const layerLabel = isPermissions ? "permissions" : "autonomy";
  const action = isPermissions
    ? 'Action: define "envelope": "standard" and retry; no action with expanded limits is executed.'
    : 'Action: define "profile" as assistant or autonomous-dev and retry; no execution starts.';
  return [
    `[FlowTask Layers] ${layerLabel} layer missing or invalid.`,
    `File: ${error && error.path ? error.path : "unidentified"}`,
    `Cause: ${error && error.reason ? error.reason : "invalid layer"}`,
    action,
  ].join("\n");
}

/**
 * Fails if the resolution is not operable. Persona never fails: it only leaves a
 * warning in `warnings`.
 */
export function assertOperationalLayers(resolution) {
  const errors = (resolution && resolution.operational && resolution.operational.errors) || [];
  if (errors.length === 0) return resolution;

  const first = errors[0];
  const failure = new Error(describeOperationalFailure(first));
  failure.code = first.code;
  failure.layer = first.layer;
  failure.path = first.path ?? null;
  failure.reason = first.reason;
  throw failure;
}
