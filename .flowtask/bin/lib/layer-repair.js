import fs from "fs";
import path from "path";
import {
  LAYER_FILES,
  MIGRATION_DEFAULTS,
  readLayerSources,
  resolveLayers,
} from "./layers.js";
import { AUTHORITY_MESSAGES } from "./authority-messages.js";

/**
 * Installed targets, in the same order the permission gate probes them.
 * `dir` is project-relative: repair runs from the project root.
 */
export const AUTHORITY_TARGETS = Object.freeze([
  Object.freeze({ id: "opencode", dir: ".opencode/flowtask/config" }),
  Object.freeze({ id: "claude", dir: ".claude/flowtask/config" }),
  Object.freeze({ id: "vscode", dir: ".vscode/flowtask/config" }),
  Object.freeze({ id: "standalone", dir: ".flowtask/config" }),
]);

const OPERATIONAL_LAYERS = Object.freeze(["autonomy", "permissions"]);

const STATUS_SCHEMA = "flowtask-authority-status/v1";
const REPAIR_SCHEMA = "flowtask-authority-repair/v1";

/**
 * Returns the first installed target from `rootDir`, in gate order, or `null`.
 * A target is installed when its configuration directory exists; the layer
 * files may be missing or invalid, which is exactly the state repair handles.
 */
export function detectAuthorityTarget(rootDir = process.cwd()) {
  for (const target of AUTHORITY_TARGETS) {
    const configDir = path.resolve(rootDir, target.dir);
    let stat;
    try {
      stat = fs.statSync(configDir);
    } catch {
      continue;
    }
    if (stat.isDirectory()) return { id: target.id, dir: target.dir, configDir };
  }
  return null;
}

/**
 * Read-only diagnosis of the authority layers.
 *
 * The structured `errors[]` is the technical channel: each entry is limited to
 * `code`, `layer`, `path`, and `reason`. The top-level `message` is the
 * operator channel and never includes those details.
 */
export function diagnoseAuthority({ rootDir = process.cwd() } = {}) {
  const target = detectAuthorityTarget(rootDir);
  if (!target) {
    return {
      schema: STATUS_SCHEMA,
      target: null,
      classification: "not_installed",
      profile: null,
      source: null,
      errors: [],
      message: AUTHORITY_MESSAGES.not_installed,
    };
  }

  const resolution = resolveLayers({ team: null, project: readLayerSources(target.configDir) });
  if (resolution.operational.ok) {
    const autonomy = resolution.layers.autonomy;
    return {
      schema: STATUS_SCHEMA,
      target: target.id,
      classification: "ok",
      profile: autonomy.value ? autonomy.value.profile : null,
      source: autonomy.source ?? null,
      errors: [],
      message: AUTHORITY_MESSAGES.healthy,
    };
  }

  return {
    schema: STATUS_SCHEMA,
    target: target.id,
    classification: "authority_block",
    profile: null,
    source: null,
    errors: resolution.operational.errors.map((error) => ({
      code: error.code,
      layer: error.layer,
      path: error.path ?? null,
      reason: error.reason,
    })),
    message: AUTHORITY_MESSAGES.authority_block,
  };
}

function repairResult(target, status, { restored = [], preserved = [], backups = [] } = {}) {
  const message = status === "repaired"
    ? AUTHORITY_MESSAGES.repaired
    : status === "healthy"
      ? AUTHORITY_MESSAGES.healthy
      : status === "not_installed"
        ? AUTHORITY_MESSAGES.not_installed
        : AUTHORITY_MESSAGES.repair_failed;
  return {
    schema: REPAIR_SCHEMA,
    target: target ? target.id : null,
    status,
    restored,
    preserved,
    backups,
    message,
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return JSON.stringify(written) === JSON.stringify(value);
  } catch {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve original */ }
    return false;
  }
}

function restoreOriginal(filePath, original) {
  if (original === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const tempPath = `${filePath}.${process.pid}.restore`;
  fs.writeFileSync(tempPath, original);
  fs.renameSync(tempPath, filePath);
}

function verifyRepair(configDir, planned, preservedSnapshots) {
  const resolution = resolveLayers({ team: null, project: readLayerSources(configDir) });
  if (!resolution.operational.ok) return false;

  for (const [name, value] of planned) {
    const layer = resolution.layers[name];
    if (layer.status !== "valid" || JSON.stringify(layer.value) !== JSON.stringify(value)) return false;
  }
  for (const [name, value] of preservedSnapshots) {
    const layer = resolution.layers[name];
    if (layer.status !== "valid" || JSON.stringify(layer.value) !== JSON.stringify(value)) return false;
  }
  return true;
}

/**
 * Repairs only the missing or invalid autonomy and permissions layers of the
 * first installed target.
 *
 * A valid layer is preserved untouched. An existing invalid file is copied to
 * `<file>.bak-<stamp>` before the safe default is written. The planned values
 * are verified after the write; on any failure every original file is restored
 * and the result is `failed`.
 */
export function repairAuthority({ rootDir = process.cwd() } = {}) {
  const target = detectAuthorityTarget(rootDir);
  if (!target) return repairResult(null, "not_installed");

  const resolution = resolveLayers({ team: null, project: readLayerSources(target.configDir) });
  const preserved = [];
  const preservedSnapshots = [];
  for (const name of OPERATIONAL_LAYERS) {
    const layer = resolution.layers[name];
    if (layer.status === "valid") {
      preserved.push(name);
      preservedSnapshots.push([name, layer.value]);
    }
  }

  if (resolution.operational.ok) return repairResult(target, "healthy", { preserved });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const planned = [];
  const writes = [];
  const backups = [];

  try {
    for (const name of OPERATIONAL_LAYERS) {
      const layer = resolution.layers[name];
      if (layer.status === "valid") continue;

      const filePath = path.join(target.configDir, LAYER_FILES[name]);
      const exists = fs.existsSync(filePath);
      let original = null;
      if (exists) {
        original = fs.readFileSync(filePath);
        const backupPath = `${filePath}.bak-${stamp}`;
        fs.copyFileSync(filePath, backupPath);
        backups.push(backupPath);
      }
      planned.push([name, MIGRATION_DEFAULTS[name]]);
      writes.push({ filePath, original });
    }

    for (const [name, value] of planned) {
      const filePath = path.join(target.configDir, LAYER_FILES[name]);
      if (!writeJsonAtomic(filePath, value)) throw new Error("write verification failed");
    }

    if (!verifyRepair(target.configDir, planned, preservedSnapshots)) throw new Error("repair verification failed");
  } catch {
    for (const { filePath, original } of [...writes].reverse()) {
      try {
        restoreOriginal(filePath, original);
      } catch {
        // A failed restore is reported by the `failed` result; the backup stays intact.
      }
    }
    return repairResult(target, "failed", {
      preserved,
      backups,
    });
  }

  return repairResult(target, "repaired", {
    restored: planned.map(([name]) => name),
    preserved,
    backups,
  });
}
