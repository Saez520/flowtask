import fs from "fs";
import path from "path";

/**
 * Contrato lógico de las tres capas almacenadas: persona (tono), autonomía
 * (iniciativa) y permisos (sobre técnico). Cada capa se valida y se resuelve
 * por separado; la precedencia entre ellas es `permisos > autonomía > persona`.
 */

export const PERSONA_LEVELS = Object.freeze(["training", "mid", "senior", "custom"]);

/** Alias heredado de lectura. Se normaliza a `training`; nunca se emite al escribir. */
export const LEGACY_PERSONA_LEVELS = Object.freeze(["junior"]);

export const AUTONOMY_PROFILES = Object.freeze(["assistant", "autonomous-dev", "hermes"]);

export const PERMISSION_ENVELOPES = Object.freeze(["standard"]);

/** Orden estructural de precedencia entre capas. */
export const LAYER_ORDER = Object.freeze(["permissions", "autonomy", "persona"]);

export const LAYER_FILES = Object.freeze({
  persona: "profile.json",
  autonomy: "autonomy.json",
  permissions: "permissions.json",
});

/**
 * Defaults de migración. Solo se escriben cuando la capa no existe: son una
 * migración, no un fallback de runtime. Una capa inválida nunca se repara con
 * un default.
 */
export const MIGRATION_DEFAULTS = Object.freeze({
  autonomy: Object.freeze({ version: 1, profile: "autonomous-dev" }),
  permissions: Object.freeze({ version: 1, envelope: "standard" }),
});

/** Fuentes lógicas de resolución. */
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
 * Normaliza el nivel de persona. `junior` es un alias heredado de lectura y se
 * resuelve a `training`; cualquier otro valor desconocido no se normaliza.
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
    return { status: "invalid", value: null, reason: "la capa de persona no es un objeto JSON" };
  }
  const level = normalizePersonaLevel(raw.level);
  if (!level) {
    return { status: "invalid", value: null, reason: `nivel de persona desconocido: ${describeValue(raw.level)}` };
  }
  if (typeof raw.persona !== "string" || !raw.persona.trim()) {
    return { status: "invalid", value: null, reason: "la capa de persona no declara un valor \"persona\"" };
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
    return { status: "invalid", value: null, reason: "la capa de autonomía no es un objeto JSON" };
  }
  if (raw.version !== 1) {
    return { status: "invalid", value: null, reason: `versión de autonomía inválida: ${describeValue(raw.version)}` };
  }
  if (!AUTONOMY_PROFILES.includes(raw.profile)) {
    return { status: "invalid", value: null, reason: `perfil de autonomía desconocido: ${describeValue(raw.profile)}` };
  }
  return { status: "valid", value: { version: 1, profile: raw.profile }, reason: null };
}

export function validatePermissionsLayer(raw) {
  if (raw === null || raw === undefined) return { status: "missing", value: null, reason: null };
  if (!isPlainObject(raw)) {
    return { status: "invalid", value: null, reason: "la capa de permisos no es un objeto JSON" };
  }
  if (raw.version !== 1) {
    return { status: "invalid", value: null, reason: `versión de permisos inválida: ${describeValue(raw.version)}` };
  }
  if (!PERMISSION_ENVELOPES.includes(raw.envelope)) {
    return { status: "invalid", value: null, reason: `envelope desconocido: ${describeValue(raw.envelope)}` };
  }
  return { status: "valid", value: { version: 1, envelope: raw.envelope }, reason: null };
}

function validateLayer(name, raw) {
  const validator = VALIDATORS[name];
  if (!validator) throw new Error(`capa desconocida: ${name}`);
  return validator(raw);
}

/**
 * Lee un archivo de capa. El estado es a nivel de archivo: `present` cuando el
 * JSON parsea, `missing` cuando el archivo no existe e `invalid` cuando el
 * archivo existe pero no se puede leer o parsear.
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
      reason: `no se pudo leer el archivo: ${error && error.message ? error.message : "error de lectura"}`,
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
      reason: `JSON inválido: ${error && error.message ? error.message : "contenido no parseable"}`,
      path: filePath,
    };
  }

  if (!isPlainObject(parsed)) {
    return { status: "invalid", value: null, reason: "el archivo no contiene un objeto JSON", path: filePath };
  }
  return { status: "present", value: parsed, reason: null, path: filePath };
}

/**
 * Lee las tres capas desde un directorio de configuración. La lectura vive acá:
 * el resolver nunca abre archivos.
 */
export function readLayerSources(configDir) {
  return {
    persona: readLayerFile(path.join(configDir, LAYER_FILES.persona)),
    autonomy: readLayerFile(path.join(configDir, LAYER_FILES.autonomy)),
    permissions: readLayerFile(path.join(configDir, LAYER_FILES.permissions)),
  };
}

/**
 * Una entrada de fuente es un valor crudo de capa o un registro de archivo
 * `{ status, value, reason, path }`. Ningún esquema de capa declara un campo
 * `status`, así que la forma del registro es inequívoca.
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
      return { status: "invalid", value: null, reason: entry.reason ?? "capa inválida", path: entry.path ?? null };
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
 * Resuelve una capa: el proyecto manda completo cuando la define (válida o
 * inválida); si no la define, rige la base de equipo; si ninguna la define, la
 * capa está ausente. Nunca se mezclan campos entre fuentes.
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
      ? "capa ausente: no se encontró el archivo de la capa"
      : "capa inválida");
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
    warnings.push("Capa de persona ausente: se continúa sin inyección de persona.");
  } else if (persona.status === "invalid") {
    warnings.push(`Capa de persona inválida: ${persona.reason}. Se continúa sin inyección de persona.`);
  }
  return warnings;
}

/**
 * Resuelve las tres capas desde dos fuentes lógicas ya leídas.
 * Devuelve `{ layers, precedence, operational, warnings }`.
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

/** Mensaje operativo de una capa ausente o inválida. */
export function describeOperationalFailure(error) {
  const isPermissions = error && error.layer === "permissions";
  const layerLabel = isPermissions ? "permisos" : "autonomía";
  const action = isPermissions
    ? 'Acción: definí "envelope": "standard" y reintentá; no se ejecuta ninguna acción con límites ampliados.'
    : 'Acción: definí "profile" como assistant, autonomous-dev o hermes y reintentá; no se inicia ninguna ejecución.';
  return [
    `[FlowTask Layers] Capa de ${layerLabel} ausente o inválida.`,
    `Archivo: ${error && error.path ? error.path : "no identificado"}`,
    `Causa: ${error && error.reason ? error.reason : "capa inválida"}`,
    action,
  ].join("\n");
}

/**
 * Falla si la resolución no es operable. La persona nunca falla: solo deja un
 * aviso en `warnings`.
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
