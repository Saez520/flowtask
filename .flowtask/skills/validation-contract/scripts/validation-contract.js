/**
 * Contrato ejecutable de validación en caliente.
 *
 * El módulo ejecuta las comprobaciones declaradas por una invocación, registra
 * comando y resultado, distingue lo verificado de lo no verificado y agrega un
 * veredicto único de tres estados. Es de solo lectura: lee archivos, ejecuta
 * comandos declarados y no escribe, no instala, no corrige y no usa la red.
 * Los fallos operativos se devuelven como resultados estructurados en lugar de
 * lanzarse como excepciones.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Versión del contrato de invocación. */
export const CONTRACT_VERSION = "1";

/** Veredictos agregados. */
export const VERDICTS = Object.freeze({
  approved: "approved",
  rejected: "rejected",
  operational_failure: "operational_failure",
});

/** Rondas de validación. */
export const ROUNDS = Object.freeze({
  closure: "closure",
  intermediate: "intermediate",
});

/** Estados posibles de una comprobación. */
export const CHECK_STATUS = Object.freeze({
  passed: "passed",
  failed: "failed",
  unverified: "unverified",
});

/** Severidades de hallazgo. */
export const FINDING_SEVERITY = Object.freeze({
  blocker: "blocker",
  minor: "minor",
});

/** Entornos declarados: se registran y no alteran el veredicto. */
export const ENVIRONMENTS = Object.freeze({
  development: "development",
  production: "production",
});

export const DEFAULT_TIMEOUT_MS = 120000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 600000;
export const MAX_OUTPUT_CHARS = 2000;
export const MAX_EVIDENCE_CHARS = 240;
export const MAX_BUFFER_BYTES = 1024 * 1024;

/** Patrones de referencias de coordinación detectadas en archivos funcionales. */
export const COORDINATION_PATTERNS = Object.freeze([
  Object.freeze({ id: "execution_id", pattern: /\b(?:CA|HF)-[A-Za-z0-9][A-Za-z0-9._-]*\b/ }),
  Object.freeze({ id: "artifact_namespace", pattern: /\b(?:ca|hotfix)\/[A-Za-z0-9][A-Za-z0-9._/-]*\/artifact\b/ }),
  Object.freeze({ id: "flow_state_path", pattern: /\bflow-state\/[A-Za-z0-9][A-Za-z0-9._/-]*/ }),
  Object.freeze({ id: "topic_key_literal", pattern: /\btopic_key\s*[:=]\s*["'][A-Za-z0-9][^"']*["']/ }),
]);

const TOP_LEVEL_KEYS = new Set([
  "schema_version", "execution_id", "round", "environment", "project_root", "plan_ref",
  "scope", "checks", "findings", "manual_verified", "manual_unverified", "design_decisions", "scan",
]);
const SCOPE_KEYS = new Set(["goal", "files", "criteria"]);
const CRITERION_KEYS = new Set(["id", "material", "statement"]);
const CHECK_KEYS = new Set(["id", "command", "args", "shell", "timeout_ms", "cwd", "criteria", "description"]);
const FINDING_KEYS = new Set(["severity", "criterion", "path", "line", "evidence", "check_id", "source"]);
const MANUAL_VERIFIED_KEYS = new Set(["criterion", "evidence", "source"]);
const MANUAL_UNVERIFIED_KEYS = new Set(["criterion", "cause", "check_id"]);
const DECISION_KEYS = new Set(["id", "decision", "implemented", "documented", "evidence"]);
const SCAN_KEYS = new Set(["files", "exclude", "allowed_literals"]);

/** Directorios que nunca se recorren al escanear. */
const SCAN_EXCLUDED_DIRECTORIES = new Set([".git", ".worktrees", "node_modules", ".flowtask"]);

/** Rutas que nunca se escanean, ni siquiera de forma explícita. */
const SCAN_EXCLUDED_PATHS = ["docs/project-history.md", "docs/roadmap/"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const hasLineBreak = (value) => typeof value === "string" && /[\r\n]/.test(value);
const hasNul = (value) => typeof value === "string" && value.includes("\0");

const invalid = (reason, expected, found) => ({ ok: false, reason, expected, found: found ?? null });

/** Recorta un texto al máximo indicado sin exceder el límite. */
export function excerpt(text, max = MAX_OUTPUT_CHARS) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

/** Ruta relativa al proyecto, sin escape ni separadores absolutos. */
function isRepoRelative(value) {
  if (!isNonEmptyString(value)) return false;
  if (path.isAbsolute(value)) return false;
  if (value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  const normalized = path.posix.normalize(value.trim());
  if (normalized === "." || normalized === "..") return false;
  if (normalized.startsWith("../")) return false;
  if (normalized.includes("/../")) return false;
  return true;
}

/** Resuelve una ruta relativa dentro de la raíz del proyecto. */
function resolveInside(root, relative, { allowRoot = false } = {}) {
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (relation === "") return allowRoot ? absolute : null;
  if (relation.startsWith("..") || path.isAbsolute(relation)) return null;
  return absolute;
}

/**
 * Valida el descriptor de una invocación de validación.
 * Devuelve `{ok: true, descriptor}` o un error estructurado con la razón.
 */
export function validateInvocationDescriptor(input, { projectRoot = process.cwd() } = {}) {
  if (!isPlainObject(input)) {
    return invalid("descriptor_not_object", "descriptor de invocación", input);
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return invalid("unknown_key", `claves permitidas: ${[...TOP_LEVEL_KEYS].join(", ")}`, key);
    }
  }
  if (input.round !== undefined && !Object.hasOwn(ROUNDS, input.round)) {
    return invalid("round_invalid", Object.keys(ROUNDS).join(", "), input.round);
  }
  if (input.schema_version !== CONTRACT_VERSION) {
    return invalid("schema_version_invalid", CONTRACT_VERSION, input.schema_version);
  }
  if (!isNonEmptyString(input.execution_id)) {
    return invalid("execution_id_missing", "identificador de ejecución no vacío", input.execution_id);
  }
  if (!Object.hasOwn(ROUNDS, input.round)) {
    return invalid("round_invalid", Object.keys(ROUNDS).join(", "), input.round);
  }
  const environment = input.environment === undefined ? ENVIRONMENTS.development : input.environment;
  if (!Object.hasOwn(ENVIRONMENTS, environment)) {
    return invalid("environment_invalid", Object.keys(ENVIRONMENTS).join(", "), input.environment);
  }

  let root = input.project_root === undefined ? projectRoot : input.project_root;
  if (!isNonEmptyString(root) || !path.isAbsolute(root)) {
    return invalid("project_root_invalid", "ruta absoluta existente", input.project_root);
  }
  root = path.resolve(root);
  try {
    if (!fs.statSync(root).isDirectory()) {
      return invalid("project_root_invalid", "ruta absoluta existente", input.project_root);
    }
  } catch {
    return invalid("project_root_invalid", "ruta absoluta existente", input.project_root);
  }

  if (input.round === ROUNDS.closure && !isNonEmptyString(input.plan_ref)) {
    return invalid("plan_ref_missing", "referencia al plan en ronda de cierre", input.plan_ref);
  }
  if (input.plan_ref !== undefined && !isNonEmptyString(input.plan_ref)) {
    return invalid("plan_ref_invalid", "referencia al plan no vacía", input.plan_ref);
  }

  if (!isPlainObject(input.scope)) {
    return invalid("scope_missing", "alcance declarado", input.scope);
  }
  for (const key of Object.keys(input.scope)) {
    if (!SCOPE_KEYS.has(key)) {
      return invalid("unknown_key", `claves permitidas en scope: ${[...SCOPE_KEYS].join(", ")}`, key);
    }
  }
  if (!isNonEmptyString(input.scope.goal)) {
    return invalid("scope_goal_missing", "objetivo del alcance no vacío", input.scope.goal);
  }

  const scopeFiles = input.scope.files === undefined ? [] : input.scope.files;
  if (!Array.isArray(scopeFiles)) {
    return invalid("scope_files_invalid", "lista de rutas relativas al proyecto", scopeFiles);
  }
  for (const file of scopeFiles) {
    if (!isRepoRelative(file)) {
      return invalid("scope_files_invalid", "ruta relativa al proyecto sin escape", file);
    }
  }

  const rawCriteria = input.scope.criteria;
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    return invalid("scope_criteria_missing", "al menos un criterio declarado", rawCriteria);
  }
  const criteria = [];
  const criterionIds = new Set();
  for (const raw of rawCriteria) {
    if (!isPlainObject(raw)) {
      return invalid("criterion_invalid", "criterio con id, material y statement", raw);
    }
    for (const key of Object.keys(raw)) {
      if (!CRITERION_KEYS.has(key)) {
        return invalid("unknown_key", `claves permitidas en criterio: ${[...CRITERION_KEYS].join(", ")}`, key);
      }
    }
    if (!isNonEmptyString(raw.id)) {
      return invalid("criterion_invalid", "identificador de criterio no vacío", raw.id);
    }
    if (criterionIds.has(raw.id)) {
      return invalid("criterion_id_duplicate", "identificadores de criterio únicos", raw.id);
    }
    criterionIds.add(raw.id);
    if (raw.material !== undefined && typeof raw.material !== "boolean") {
      return invalid("criterion_invalid", "material booleano", raw.material);
    }
    if (!isNonEmptyString(raw.statement)) {
      return invalid("criterion_invalid", "enunciado del criterio no vacío", raw.statement);
    }
    criteria.push({
      id: raw.id.trim(),
      material: raw.material === undefined ? true : raw.material,
      statement: raw.statement.trim(),
    });
  }

  const checkIds = new Set();
  let checks = null;
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) {
      return invalid("checks_invalid", "lista de comprobaciones", input.checks);
    }
    checks = [];
    for (const raw of input.checks) {
      if (!isPlainObject(raw)) {
        return invalid("check_invalid", "comprobación con id y command", raw);
      }
      for (const key of Object.keys(raw)) {
        if (!CHECK_KEYS.has(key)) {
          return invalid("unknown_key", `claves permitidas en check: ${[...CHECK_KEYS].join(", ")}`, key);
        }
      }
      if (!isNonEmptyString(raw.id)) {
        return invalid("check_invalid", "identificador de comprobación no vacío", raw.id);
      }
      if (checkIds.has(raw.id)) {
        return invalid("check_id_duplicate", "identificadores de comprobación únicos", raw.id);
      }
      checkIds.add(raw.id);
      if (!isNonEmptyString(raw.command) || hasLineBreak(raw.command)) {
        return invalid("check_invalid", "comando no vacío sin saltos de línea", raw.command);
      }
      const args = raw.args === undefined ? [] : raw.args;
      if (!Array.isArray(args)) {
        return invalid("check_invalid", "lista de argumentos", raw.args);
      }
      for (const arg of args) {
        if (typeof arg !== "string" || hasNul(arg) || hasLineBreak(arg)) {
          return invalid("check_invalid", "argumentos de texto sin NUL ni saltos de línea", arg);
        }
      }
      const shell = raw.shell === undefined ? false : raw.shell;
      if (typeof shell !== "boolean") {
        return invalid("check_invalid", "shell booleano", raw.shell);
      }
      if (shell === true && args.length > 0) {
        return invalid("shell_requires_empty_args", "args vacío cuando shell es true", args);
      }
      let timeout = null;
      if (raw.timeout_ms !== undefined) {
        if (
          typeof raw.timeout_ms !== "number"
          || !Number.isInteger(raw.timeout_ms)
          || raw.timeout_ms < MIN_TIMEOUT_MS
          || raw.timeout_ms > MAX_TIMEOUT_MS
        ) {
          return invalid("timeout_out_of_range", `${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}`, raw.timeout_ms);
        }
        timeout = raw.timeout_ms;
      }
      let cwd = null;
      if (raw.cwd !== undefined) {
        if (!isNonEmptyString(raw.cwd) || path.isAbsolute(raw.cwd)) {
          return invalid("cwd_outside_project_root", "ruta relativa dentro del proyecto", raw.cwd);
        }
        const resolved = resolveInside(root, raw.cwd, { allowRoot: true });
        if (!resolved) {
          return invalid("cwd_outside_project_root", "ruta relativa dentro del proyecto", raw.cwd);
        }
        cwd = resolved;
      }
      const checkCriteria = raw.criteria === undefined ? [] : raw.criteria;
      if (!Array.isArray(checkCriteria)) {
        return invalid("check_invalid", "lista de criterios de la comprobación", raw.criteria);
      }
      for (const criterionId of checkCriteria) {
        if (!isNonEmptyString(criterionId)) {
          return invalid("check_invalid", "identificadores de criterio no vacíos", criterionId);
        }
        if (!criterionIds.has(criterionId)) {
          return invalid("criterion_not_found", "criterio declarado en el alcance", criterionId);
        }
      }
      if (raw.description !== undefined && !isNonEmptyString(raw.description)) {
        return invalid("check_invalid", "descripción no vacía", raw.description);
      }
      checks.push({
        id: raw.id.trim(),
        command: raw.command,
        args: [...args],
        shell,
        timeout_ms: timeout,
        cwd,
        criteria: [...checkCriteria],
        description: raw.description === undefined ? null : raw.description.trim(),
      });
    }
  }

  const findings = [];
  if (input.findings !== undefined) {
    if (!Array.isArray(input.findings)) {
      return invalid("findings_invalid", "lista de hallazgos", input.findings);
    }
    for (const raw of input.findings) {
      if (!isPlainObject(raw)) {
        return invalid("finding_invalid", "hallazgo con severidad y evidencia", raw);
      }
      for (const key of Object.keys(raw)) {
        if (!FINDING_KEYS.has(key)) {
          return invalid("unknown_key", `claves permitidas en finding: ${[...FINDING_KEYS].join(", ")}`, key);
        }
      }
      if (!Object.hasOwn(FINDING_SEVERITY, raw.severity)) {
        return invalid("finding_invalid", `severidad: ${Object.keys(FINDING_SEVERITY).join(", ")}`, raw.severity);
      }
      if (!isNonEmptyString(raw.evidence)) {
        return invalid("finding_invalid", "evidencia no vacía", raw.evidence);
      }
      if (raw.path !== undefined && !isRepoRelative(raw.path)) {
        return invalid("finding_invalid", "ruta relativa al proyecto", raw.path);
      }
      if (raw.line !== undefined && (!Number.isInteger(raw.line) || raw.line < 1)) {
        return invalid("finding_invalid", "número de línea positivo", raw.line);
      }
      if (raw.criterion !== undefined) {
        if (!isNonEmptyString(raw.criterion)) {
          return invalid("finding_invalid", "criterio asociado no vacío", raw.criterion);
        }
        if (!criterionIds.has(raw.criterion)) {
          return invalid("criterion_not_found", "criterio declarado en el alcance", raw.criterion);
        }
      }
      if (raw.severity === FINDING_SEVERITY.blocker && raw.criterion === undefined) {
        return invalid("finding_invalid", "criterio obligatorio en hallazgo bloqueante", raw.evidence);
      }
      if (raw.check_id !== undefined) {
        if (!isNonEmptyString(raw.check_id)) {
          return invalid("finding_invalid", "identificador de comprobación no vacío", raw.check_id);
        }
        if (!checkIds.has(raw.check_id)) {
          return invalid("check_id_not_found", "comprobación declarada en el descriptor", raw.check_id);
        }
      }
      findings.push({
        severity: raw.severity,
        criterion: raw.criterion === undefined ? null : raw.criterion,
        path: raw.path === undefined ? null : raw.path,
        line: raw.line === undefined ? null : raw.line,
        evidence: raw.evidence.trim(),
        check_id: raw.check_id === undefined ? null : raw.check_id,
        source: raw.source === undefined ? "manual" : raw.source,
      });
    }
  }

  const manualVerified = [];
  if (input.manual_verified !== undefined) {
    if (!Array.isArray(input.manual_verified)) {
      return invalid("manual_verified_invalid", "lista de verificaciones manuales", input.manual_verified);
    }
    for (const raw of input.manual_verified) {
      if (!isPlainObject(raw)) {
        return invalid("manual_verified_invalid", "verificación manual con criterio y evidencia", raw);
      }
      for (const key of Object.keys(raw)) {
        if (!MANUAL_VERIFIED_KEYS.has(key)) {
          return invalid("unknown_key", `claves permitidas en manual_verified: ${[...MANUAL_VERIFIED_KEYS].join(", ")}`, key);
        }
      }
      if (!isNonEmptyString(raw.criterion)) {
        return invalid("manual_verified_invalid", "criterio asociado no vacío", raw.criterion);
      }
      if (!criterionIds.has(raw.criterion)) {
        return invalid("criterion_not_found", "criterio declarado en el alcance", raw.criterion);
      }
      if (!isNonEmptyString(raw.evidence)) {
        return invalid("manual_verified_invalid", "evidencia no vacía", raw.evidence);
      }
      manualVerified.push({
        criterion: raw.criterion,
        evidence: raw.evidence.trim(),
        source: raw.source === undefined ? "manual" : raw.source,
      });
    }
  }

  const manualUnverified = [];
  if (input.manual_unverified !== undefined) {
    if (!Array.isArray(input.manual_unverified)) {
      return invalid("manual_unverified_invalid", "lista de no verificados", input.manual_unverified);
    }
    for (const raw of input.manual_unverified) {
      if (!isPlainObject(raw)) {
        return invalid("manual_unverified_invalid", "no verificado con criterio y causa", raw);
      }
      for (const key of Object.keys(raw)) {
        if (!MANUAL_UNVERIFIED_KEYS.has(key)) {
          return invalid("unknown_key", `claves permitidas en manual_unverified: ${[...MANUAL_UNVERIFIED_KEYS].join(", ")}`, key);
        }
      }
      if (!isNonEmptyString(raw.criterion)) {
        return invalid("manual_unverified_invalid", "criterio asociado no vacío", raw.criterion);
      }
      if (!criterionIds.has(raw.criterion)) {
        return invalid("criterion_not_found", "criterio declarado en el alcance", raw.criterion);
      }
      if (!isNonEmptyString(raw.cause)) {
        return invalid("manual_unverified_invalid", "causa conocida no vacía", raw.cause);
      }
      if (raw.check_id !== undefined) {
        if (!isNonEmptyString(raw.check_id)) {
          return invalid("manual_unverified_invalid", "identificador de comprobación no vacío", raw.check_id);
        }
        if (!checkIds.has(raw.check_id)) {
          return invalid("check_id_not_found", "comprobación declarada en el descriptor", raw.check_id);
        }
      }
      manualUnverified.push({
        criterion: raw.criterion,
        cause: raw.cause.trim(),
        check_id: raw.check_id === undefined ? null : raw.check_id,
      });
    }
  }

  const designDecisions = [];
  if (input.design_decisions !== undefined) {
    if (!Array.isArray(input.design_decisions)) {
      return invalid("design_decisions_invalid", "lista de decisiones de diseño", input.design_decisions);
    }
    for (const raw of input.design_decisions) {
      if (!isPlainObject(raw)) {
        return invalid("design_decision_invalid", "decisión con id, decisión y evidencia", raw);
      }
      for (const key of Object.keys(raw)) {
        if (!DECISION_KEYS.has(key)) {
          return invalid("unknown_key", `claves permitidas en design_decisions: ${[...DECISION_KEYS].join(", ")}`, key);
        }
      }
      if (!isNonEmptyString(raw.id)) {
        return invalid("design_decision_invalid", "identificador de decisión no vacío", raw.id);
      }
      if (!isNonEmptyString(raw.decision)) {
        return invalid("design_decision_invalid", "decisión no vacía", raw.decision);
      }
      if (raw.implemented !== undefined && typeof raw.implemented !== "boolean") {
        return invalid("design_decision_invalid", "implemented booleano", raw.implemented);
      }
      if (raw.documented !== undefined && typeof raw.documented !== "boolean") {
        return invalid("design_decision_invalid", "documented booleano", raw.documented);
      }
      if (!isNonEmptyString(raw.evidence)) {
        return invalid("design_decision_invalid", "evidencia no vacía", raw.evidence);
      }
      designDecisions.push({
        id: raw.id.trim(),
        decision: raw.decision.trim(),
        implemented: raw.implemented === undefined ? null : raw.implemented,
        documented: raw.documented === undefined ? null : raw.documented,
        evidence: raw.evidence.trim(),
      });
    }
  }

  const scanFiles = [];
  const scanExclude = [];
  const allowedLiterals = [];
  if (input.scan !== undefined) {
    if (!isPlainObject(input.scan)) {
      return invalid("scan_invalid", "configuración de escaneo", input.scan);
    }
    for (const key of Object.keys(input.scan)) {
      if (!SCAN_KEYS.has(key)) {
        return invalid("unknown_key", `claves permitidas en scan: ${[...SCAN_KEYS].join(", ")}`, key);
      }
    }
    if (input.scan.files !== undefined) {
      if (!Array.isArray(input.scan.files)) {
        return invalid("scan_invalid", "lista de rutas para escanear", input.scan.files);
      }
      for (const file of input.scan.files) {
        if (!isRepoRelative(file)) {
          return invalid("scan_invalid", "ruta relativa al proyecto sin escape", file);
        }
        scanFiles.push(file.trim());
      }
    }
    if (input.scan.exclude !== undefined) {
      if (!Array.isArray(input.scan.exclude)) {
        return invalid("scan_invalid", "lista de rutas excluidas", input.scan.exclude);
      }
      for (const file of input.scan.exclude) {
        if (!isNonEmptyString(file)) {
          return invalid("scan_invalid", "ruta excluida no vacía", file);
        }
        scanExclude.push(file.trim());
      }
    }
    if (input.scan.allowed_literals !== undefined) {
      if (!Array.isArray(input.scan.allowed_literals)) {
        return invalid("scan_invalid", "lista de literales permitidos", input.scan.allowed_literals);
      }
      for (const literal of input.scan.allowed_literals) {
        if (!isNonEmptyString(literal)) {
          return invalid("scan_invalid", "literal permitido no vacío", literal);
        }
        allowedLiterals.push(literal);
      }
    }
  }

  return {
    ok: true,
    descriptor: {
      schema_version: CONTRACT_VERSION,
      execution_id: input.execution_id.trim(),
      round: input.round,
      environment,
      project_root: root,
      plan_ref: input.plan_ref === undefined ? null : input.plan_ref.trim(),
      scope: { goal: input.scope.goal.trim(), files: scopeFiles.map((file) => file.trim()), criteria },
      checks,
      findings,
      manual_verified: manualVerified,
      manual_unverified: manualUnverified,
      design_decisions: designDecisions,
      scan: { files: scanFiles, exclude: scanExclude, allowed_literals: allowedLiterals },
    },
  };
}

/** Clasifica el desenlace de una comprobación ejecutada. */
export function classifyCheckOutcome({ exitCode = null, signal = null, errorCode = null, timedOut = false } = {}) {
  if (exitCode === 0 && !errorCode) {
    return { status: CHECK_STATUS.passed, cause: null };
  }
  if (timedOut === true || errorCode === "ETIMEDOUT") {
    return { status: CHECK_STATUS.unverified, cause: "timeout" };
  }
  if (
    errorCode === "ENOENT"
    || errorCode === "EACCES"
    || errorCode === "EPERM"
    || exitCode === 126
    || exitCode === 127
  ) {
    return { status: CHECK_STATUS.unverified, cause: "tool_unavailable" };
  }
  if (errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { status: CHECK_STATUS.unverified, cause: "output_limit" };
  }
  if (signal) {
    return { status: CHECK_STATUS.unverified, cause: "signal" };
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return { status: CHECK_STATUS.failed, cause: "nonzero_exit" };
  }
  return { status: CHECK_STATUS.unverified, cause: "spawn_error" };
}

/** Primera línea no vacía de la salida de la comprobación. */
function summarize(stdout, stderr) {
  for (const source of [stdout, stderr]) {
    const lines = String(source).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0) return excerpt(lines[0], MAX_OUTPUT_CHARS);
  }
  return "(sin salida)";
}

/** Resuelve el directorio de trabajo de una comprobación. */
function resolveCheckCwd(check, root) {
  if (!check.cwd) return root;
  if (path.isAbsolute(check.cwd)) return resolveInside(root, path.relative(root, check.cwd), { allowRoot: true });
  return resolveInside(root, check.cwd, { allowRoot: true });
}

/**
 * Ejecuta las comprobaciones declaradas y registra comando y resultado.
 * Nunca lanza por un error de ejecución: clasifica el desenlace.
 */
export function runChecks({
  checks = [],
  projectRoot = process.cwd(),
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  executor = null,
} = {}) {
  const root = path.resolve(projectRoot);
  const results = [];
  for (const check of Array.isArray(checks) ? checks : []) {
    const timeout = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, Number.isInteger(check.timeout_ms) ? check.timeout_ms : defaultTimeoutMs),
    );
    const cwd = resolveCheckCwd(check, root) ?? root;
    const started = Date.now();
    let outcome;
    try {
      if (typeof executor === "function") {
        outcome = executor({
          command: check.command,
          args: Array.isArray(check.args) ? check.args : [],
          shell: check.shell === true,
          cwd,
          timeout,
        });
      } else {
        outcome = spawnSync(check.command, Array.isArray(check.args) ? check.args : [], {
          cwd,
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: "utf8",
          shell: check.shell === true,
        });
      }
    } catch (error) {
      outcome = { status: null, stdout: "", stderr: "", signal: null, error };
    }
    const duration = Date.now() - started;
    const exitCode = typeof outcome?.status === "number" ? outcome.status : null;
    const signal = typeof outcome?.signal === "string" ? outcome.signal : null;
    const errorCode = typeof outcome?.error?.code === "string" ? outcome.error.code : null;
    const timedOut = errorCode === "ETIMEDOUT";
    const classification = classifyCheckOutcome({ exitCode, signal, errorCode, timedOut });
    const stdout = typeof outcome?.stdout === "string" ? outcome.stdout : "";
    const stderr = typeof outcome?.stderr === "string" ? outcome.stderr : "";
    results.push({
      id: check.id,
      command: check.command,
      args: Array.isArray(check.args) ? [...check.args] : [],
      cwd: path.relative(root, cwd) || ".",
      description: check.description ?? null,
      exit_code: exitCode,
      signal,
      error_code: errorCode,
      duration_ms: duration,
      timeout_ms: timeout,
      result_summary: summarize(stdout, stderr),
      stdout_excerpt: excerpt(stdout, MAX_OUTPUT_CHARS),
      stderr_excerpt: excerpt(stderr, MAX_OUTPUT_CHARS),
      status: classification.status,
      cause: classification.cause,
      criteria: Array.isArray(check.criteria) ? [...check.criteria] : [],
    });
  }
  return results;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listTestFiles(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Descubre las comprobaciones disponibles por manifiestos del proyecto.
 * No ejecuta nada: devuelve la lista ordenada y sin duplicados.
 */
export function discoverChecks({ projectRoot = process.cwd() } = {}) {
  const root = path.resolve(projectRoot);
  const candidates = [];

  const packageJson = readJsonFile(path.join(root, "package.json"));
  const scripts = packageJson && isPlainObject(packageJson.scripts) ? packageJson.scripts : null;
  if (scripts) {
    if (isNonEmptyString(scripts.test)) candidates.push({ id: "npm-test", command: "npm", args: ["test"] });
    if (isNonEmptyString(scripts.lint)) candidates.push({ id: "npm-lint", command: "npm", args: ["run", "lint"] });
    if (isNonEmptyString(scripts.typecheck)) {
      candidates.push({ id: "npm-typecheck", command: "npm", args: ["run", "typecheck"] });
    }
  }

  const testFiles = listTestFiles(path.join(root, ".flowtask", "bin", "test"));
  if (testFiles.length > 0) {
    candidates.push({
      id: "flowtask-tests",
      command: "node",
      args: ["--test", ...testFiles.map((name) => path.join(".flowtask", "bin", "test", name))],
    });
  }

  const pythonMarkers = ["pyproject.toml", "pytest.ini", "setup.cfg"];
  for (const marker of pythonMarkers) {
    let content = null;
    try {
      content = fs.readFileSync(path.join(root, marker), "utf8");
    } catch {
      content = null;
    }
    if (content && /pytest/i.test(content)) {
      candidates.push({ id: "pytest", command: "pytest", args: ["-q"] });
      break;
    }
  }

  if (fs.existsSync(path.join(root, "go.mod"))) {
    candidates.push({ id: "go-test", command: "go", args: ["test", "./..."] });
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    candidates.push({ id: "cargo-test", command: "cargo", args: ["test"] });
  }
  const composerJson = readJsonFile(path.join(root, "composer.json"));
  if (composerJson && isPlainObject(composerJson.scripts) && isNonEmptyString(composerJson.scripts.test)) {
    candidates.push({ id: "composer-test", command: "composer", args: ["test"] });
  }
  try {
    const makefile = fs.readFileSync(path.join(root, "Makefile"), "utf8");
    if (/^test\s*:/m.test(makefile)) {
      candidates.push({ id: "make-test", command: "make", args: ["test"] });
    }
  } catch {
    // sin Makefile no hay comprobación de make
  }

  const unique = new Map();
  for (const candidate of candidates) {
    if (!unique.has(candidate.id)) {
      unique.set(candidate.id, { ...candidate, criteria: [], description: null });
    }
  }
  return { ok: true, checks: [...unique.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

/** El escáner recorre directorios y respeta las exclusiones declaradas. */
function walkDirectory(absolute, root) {
  const collected = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const relative = path.relative(root, child).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        stack.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedPath(relative, { allowFlowtask: false })) continue;
      collected.push(relative);
    }
  }
  return collected.sort((left, right) => left.localeCompare(right));
}

/** Decide si una ruta está entre las exclusiones permanentes del escáner. */
function isExcludedPath(relative, { allowFlowtask }) {
  for (const excluded of SCAN_EXCLUDED_PATHS) {
    if (relative === excluded) return true;
    if (excluded.endsWith("/") && relative.startsWith(excluded)) return true;
  }
  const parts = relative.split("/");
  for (const part of parts.slice(0, -1)) {
    if (SCAN_EXCLUDED_DIRECTORIES.has(part) && !(allowFlowtask && part === ".flowtask")) return true;
  }
  return false;
}

/** Aplica las exclusiones declaradas por la invocación. */
function isExcludedByDeclaration(relative, exclude) {
  for (const entry of exclude) {
    if (relative === entry) return true;
    if (relative.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Escanea referencias de coordinación concretas en los archivos del alcance.
 * Un hallazgo es bloqueante. Un archivo ilegible o binario queda como no
 * verificado, nunca como hallazgo.
 */
export function scanCoordinationReferences({
  files = [],
  projectRoot = process.cwd(),
  allowedLiterals = [],
  exclude = [],
} = {}) {
  const root = path.resolve(projectRoot);
  const allowed = (Array.isArray(allowedLiterals) ? allowedLiterals : []).filter(isNonEmptyString);
  const declared = (Array.isArray(exclude) ? exclude : []).filter(isNonEmptyString);
  const findings = [];
  const unverified = [];
  const targets = Array.isArray(files) ? files : [];

  for (const target of targets) {
    const requested = typeof target === "string" ? target.trim() : "";
    const isRoot = requested === ".";
    if (!isRoot && !isRepoRelative(requested)) {
      unverified.push({ path: String(target), status: CHECK_STATUS.unverified, cause: "path_invalid", source: "scanner" });
      continue;
    }
    const relative = isRoot ? "." : requested;
    if (!isRoot && (isExcludedPath(relative, { allowFlowtask: true }) || isExcludedByDeclaration(relative, declared))) continue;
    const absolute = isRoot ? root : resolveInside(root, relative);
    if (!absolute) {
      unverified.push({ path: relative, status: CHECK_STATUS.unverified, cause: "path_outside_project", source: "scanner" });
      continue;
    }
    let stat = null;
    try {
      stat = fs.statSync(absolute);
    } catch {
      unverified.push({ path: relative, status: CHECK_STATUS.unverified, cause: "file_unreadable", source: "scanner" });
      continue;
    }
    if (stat.isDirectory()) {
      for (const file of walkDirectory(absolute, root)) {
        if (isExcludedByDeclaration(file, declared)) continue;
        scanFile(file, path.join(root, file), { allowed, findings, unverified });
      }
      continue;
    }
    scanFile(relative, absolute, { allowed, findings, unverified });
  }

  return { findings, unverified };
}

/** Escanea un archivo línea por línea. */
function scanFile(relative, absolute, { allowed, findings, unverified }) {
  let content = null;
  try {
    content = fs.readFileSync(absolute, "utf8");
  } catch {
    unverified.push({ path: relative, status: CHECK_STATUS.unverified, cause: "file_unreadable", source: "scanner" });
    return;
  }
  if (content.includes("\0")) {
    unverified.push({ path: relative, status: CHECK_STATUS.unverified, cause: "binary", source: "scanner" });
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (allowed.some((literal) => line.includes(literal))) continue;
    const seen = new Set();
    for (const { id, pattern } of COORDINATION_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let match = regex.exec(line);
      while (match !== null) {
        const text = match[0];
        const after = line[match.index + text.length];
        if (after !== "{" && !seen.has(text)) {
          seen.add(text);
          findings.push({
            severity: FINDING_SEVERITY.blocker,
            criterion: "coordination_reference",
            path: relative,
            line: index + 1,
            evidence: excerpt(line, MAX_EVIDENCE_CHARS),
            pattern: id,
            matched: text,
            source: "scanner",
          });
        }
        match = regex.exec(line);
      }
    }
  }
}

/** Evidencia declarada para el estado de un criterio. */
function criterionEvidence(criterionId, { passedChecks, unverifiedChecks, manualVerified, manualUnverified, blockers, criteriaFor }) {
  const blocker = blockers.find((finding) => finding.criterion === criterionId);
  if (blocker) return excerpt(blocker.evidence, MAX_EVIDENCE_CHARS);
  const manual = manualVerified.find((entry) => entry.criterion === criterionId);
  if (manual) return excerpt(manual.evidence, MAX_EVIDENCE_CHARS);
  const passed = passedChecks.find((result) => criteriaFor(result).includes(criterionId));
  if (passed) return `comprobación ${passed.id}: ${passed.result_summary}`;
  const pending = unverifiedChecks.find((result) => criteriaFor(result).includes(criterionId));
  if (pending) return `comprobación ${pending.id}: ${pending.cause ?? "no verificada"}`;
  const manualPending = manualUnverified.find((entry) => entry.criterion === criterionId);
  if (manualPending) return `no verificado: ${manualPending.cause}`;
  return "sin cobertura";
}

/**
 * Agrega el veredicto con precedencia única.
 * Un bloqueante rechaza; sin bloqueantes, un estado no verificado o un
 * criterio material sin cubrir produce fallo operativo; solo el caso limpio
 * aprueba.
 */
export function aggregateVerdict({
  descriptor,
  checkResults = [],
  findings = [],
  scanUnverified = [],
} = {}) {
  const scope = descriptor?.scope ?? { criteria: [] };
  const declaredChecks = Array.isArray(descriptor?.checks) ? descriptor.checks : [];
  const checkById = new Map(declaredChecks.map((check) => [check.id, check]));
  const criteriaFor = (result) => {
    const declared = checkById.get(result?.id);
    if (declared && Array.isArray(declared.criteria) && declared.criteria.length > 0) return declared.criteria;
    return Array.isArray(result?.criteria) ? result.criteria : [];
  };

  const results = Array.isArray(checkResults) ? checkResults : [];
  const allFindings = Array.isArray(findings) ? findings : [];
  const blockers = allFindings.filter((finding) => finding.severity === FINDING_SEVERITY.blocker);
  const minors = allFindings.filter((finding) => finding.severity === FINDING_SEVERITY.minor);
  const passedChecks = results.filter((result) => result.status === CHECK_STATUS.passed);
  const failedChecks = results.filter((result) => result.status === CHECK_STATUS.failed);
  const unverifiedChecks = results.filter((result) => result.status === CHECK_STATUS.unverified);
  const manualVerified = Array.isArray(descriptor?.manual_verified) ? descriptor.manual_verified : [];
  const manualUnverified = Array.isArray(descriptor?.manual_unverified) ? descriptor.manual_unverified : [];
  const scanPending = Array.isArray(scanUnverified) ? scanUnverified : [];

  const criteria = scope.criteria.map((criterion) => {
    const id = criterion.id;
    let state = "uncovered";
    if (blockers.some((finding) => finding.criterion === id)) {
      state = "failed";
    } else if (
      passedChecks.some((result) => criteriaFor(result).includes(id))
      || manualVerified.some((entry) => entry.criterion === id)
    ) {
      state = "verified";
    } else if (
      unverifiedChecks.some((result) => criteriaFor(result).includes(id))
      || manualUnverified.some((entry) => entry.criterion === id)
    ) {
      state = "unverified";
    }
    return {
      id,
      material: criterion.material,
      statement: criterion.statement,
      state,
      evidence: criterionEvidence(id, {
        passedChecks,
        unverifiedChecks,
        manualVerified,
        manualUnverified,
        blockers,
        criteriaFor,
      }),
    };
  });

  const materialCriteria = criteria.filter((criterion) => criterion.material);
  const uncoveredMaterial = materialCriteria.filter((criterion) => criterion.state === "uncovered");
  const failedWithoutDisposition = failedChecks.filter((result) => (
    !blockers.some((finding) => finding.check_id === result.id)
    && !manualUnverified.some((entry) => entry.check_id === result.id)
  ));

  const reasons = [];
  if (unverifiedChecks.length > 0) reasons.push(`${unverifiedChecks.length} comprobación(es) no verificada(s)`);
  if (scanPending.length > 0) reasons.push(`${scanPending.length} archivo(s) sin escaneo verificable`);
  if (uncoveredMaterial.length > 0) {
    reasons.push(`criterio(s) material(es) sin cubrir: ${uncoveredMaterial.map((item) => item.id).join(", ")}`);
  }
  if (failedWithoutDisposition.length > 0) {
    reasons.push(`comprobación(es) fallida(s) sin disposición: ${failedWithoutDisposition.map((item) => item.id).join(", ")}`);
  }
  if (manualUnverified.length > 0) reasons.push(`${manualUnverified.length} verificación(es) manual(es) declarada(s) como no verificada(s)`);
  if (passedChecks.length === 0) reasons.push("ninguna comprobación exitosa");
  if (materialCriteria.length === 0) reasons.push("ningún criterio material declarado");

  let verdict = VERDICTS.approved;
  if (blockers.length > 0) {
    verdict = VERDICTS.rejected;
  } else if (reasons.length > 0) {
    verdict = VERDICTS.operational_failure;
  }

  const counts = {
    checks: {
      total: results.length,
      passed: passedChecks.length,
      failed: failedChecks.length,
      unverified: unverifiedChecks.length,
    },
    criteria: {
      total: criteria.length,
      material: materialCriteria.length,
      verified: criteria.filter((item) => item.state === "verified").length,
      unverified: criteria.filter((item) => item.state === "unverified").length,
      uncovered: criteria.filter((item) => item.state === "uncovered").length,
      failed: criteria.filter((item) => item.state === "failed").length,
    },
    findings: { total: allFindings.length, blocker: blockers.length, minor: minors.length },
  };

  return {
    verdict,
    final: descriptor?.round === ROUNDS.closure && verdict === VERDICTS.approved,
    reasons,
    criteria,
    counts,
  };
}

/** Texto seguro para una celda de tabla Markdown. */
function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Renderiza el reporte de validación y la evidencia estructurada.
 * El reporte no calcula un score: publica conteos de comprobaciones, criterios
 * y hallazgos.
 */
export function renderValidationReport({
  descriptor,
  checkResults = [],
  findings = [],
  verdict = null,
  criteria = [],
  designDecisions = [],
  generatedAt = null,
} = {}) {
  const stamp = generatedAt === null
    ? new Date().toISOString()
    : (generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt));
  const scope = descriptor?.scope ?? { goal: "", files: [], criteria: [] };
  const results = Array.isArray(checkResults) ? checkResults : [];
  const allFindings = Array.isArray(findings) ? findings : [];
  const blockers = allFindings.filter((finding) => finding.severity === FINDING_SEVERITY.blocker);
  const minors = allFindings.filter((finding) => finding.severity === FINDING_SEVERITY.minor);
  const unverifiedChecks = results.filter((result) => result.status === CHECK_STATUS.unverified);
  const manualUnverified = Array.isArray(descriptor?.manual_unverified) ? descriptor.manual_unverified : [];
  const decisions = Array.isArray(designDecisions) ? designDecisions : [];
  const resolvedVerdict = typeof verdict === "string" ? verdict : verdict?.verdict ?? null;
  const isFinal = typeof verdict === "object" && verdict !== null ? verdict.final === true : false;
  const reasons = typeof verdict === "object" && verdict !== null && Array.isArray(verdict.reasons)
    ? verdict.reasons
    : [];

  const counts = {
    checks: {
      total: results.length,
      passed: results.filter((result) => result.status === CHECK_STATUS.passed).length,
      failed: results.filter((result) => result.status === CHECK_STATUS.failed).length,
      unverified: unverifiedChecks.length,
    },
    criteria: {
      total: criteria.length,
      material: criteria.filter((item) => item.material).length,
      verified: criteria.filter((item) => item.state === "verified").length,
      unverified: criteria.filter((item) => item.state === "unverified").length,
      uncovered: criteria.filter((item) => item.state === "uncovered").length,
      failed: criteria.filter((item) => item.state === "failed").length,
    },
    findings: { total: allFindings.length, blocker: blockers.length, minor: minors.length },
  };

  const evidence = {
    schema_version: CONTRACT_VERSION,
    generated_at: stamp,
    execution: {
      id: descriptor?.execution_id ?? null,
      round: descriptor?.round ?? null,
      environment: descriptor?.environment ?? null,
      plan_ref: descriptor?.plan_ref ?? null,
    },
    scope: {
      goal: scope.goal,
      files: Array.isArray(scope.files) ? [...scope.files] : [],
      criteria: (Array.isArray(scope.criteria) ? scope.criteria : []).map((criterion) => ({
        id: criterion.id,
        material: criterion.material,
        statement: criterion.statement,
      })),
    },
    checks: results.map((result) => ({
      id: result.id,
      command: result.command,
      args: result.args ?? [],
      cwd: result.cwd ?? null,
      description: result.description ?? null,
      status: result.status,
      cause: result.cause ?? null,
      exit_code: result.exit_code ?? null,
      signal: result.signal ?? null,
      duration_ms: result.duration_ms ?? null,
      result_summary: result.result_summary ?? null,
      stdout_excerpt: result.stdout_excerpt ?? "",
      stderr_excerpt: result.stderr_excerpt ?? "",
      criteria: result.criteria ?? [],
    })),
    findings: allFindings.map((finding) => ({
      severity: finding.severity,
      criterion: finding.criterion ?? null,
      path: finding.path ?? null,
      line: finding.line ?? null,
      evidence: finding.evidence ?? null,
      check_id: finding.check_id ?? null,
      pattern: finding.pattern ?? null,
      source: finding.source ?? "manual",
    })),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      material: criterion.material,
      statement: criterion.statement,
      state: criterion.state,
      evidence: criterion.evidence ?? null,
    })),
    unverified: [
      ...unverifiedChecks.map((result) => ({
        kind: "check",
        id: result.id,
        cause: result.cause ?? null,
        command: result.command,
        result_summary: result.result_summary ?? null,
      })),
      ...manualUnverified.map((entry) => ({
        kind: "manual",
        id: entry.criterion,
        cause: entry.cause,
        command: null,
        result_summary: null,
      })),
    ],
    design_decisions: decisions.map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      implemented: decision.implemented ?? null,
      documented: decision.documented ?? null,
      evidence: decision.evidence ?? null,
    })),
    counts,
    verdict: resolvedVerdict,
    final: isFinal,
    reasons,
  };

  const lines = [];
  lines.push("# Reporte de validación en caliente");
  lines.push("");
  lines.push(`- **Ronda:** ${descriptor?.round ?? "sin ronda"}`);
  lines.push(`- **Entorno:** ${descriptor?.environment ?? "sin entorno"}`);
  lines.push(`- **Veredicto:** ${String(resolvedVerdict ?? "sin veredicto").toUpperCase()}`);
  lines.push(`- **Final:** ${isFinal ? "sí" : "no"}`);
  lines.push(`- **Ejecución:** ${descriptor?.execution_id ?? "sin ejecución"}`);
  lines.push(`- **Plan:** ${descriptor?.plan_ref ?? "sin plan"}`);
  lines.push(`- **Generado:** ${stamp}`);
  lines.push("");
  lines.push("## Alcance");
  lines.push("");
  lines.push(`**Objetivo:** ${scope.goal ?? ""}`);
  lines.push("");
  lines.push(`**Archivos:** ${(scope.files ?? []).length > 0 ? scope.files.join(", ") : "ninguno"}`);
  lines.push("");
  lines.push("## Comprobaciones");
  lines.push("");
  if (results.length === 0) {
    lines.push("Sin comprobaciones ejecutadas.");
  } else {
    lines.push("| # | Comprobación | Comando | Estado | Resultado | Criterios |");
    lines.push("|---|--------------|---------|--------|-----------|-----------|");
    results.forEach((result, index) => {
      const command = [result.command, ...(result.args ?? [])].join(" ");
      lines.push(
        `| ${index + 1} | ${cell(result.id)} | ${cell(command)} | ${cell(result.status)} | ${cell(result.result_summary)} | ${cell((result.criteria ?? []).join(", ") || "-")} |`,
      );
    });
  }
  lines.push("");
  lines.push("## Criterios");
  lines.push("");
  if (criteria.length === 0) {
    lines.push("Sin criterios declarados.");
  } else {
    lines.push("| # | Criterio | Material | Estado | Evidencia |");
    lines.push("|---|----------|----------|--------|----------|");
    criteria.forEach((criterion, index) => {
      lines.push(
        `| ${index + 1} | ${cell(criterion.id)} | ${criterion.material ? "sí" : "no"} | ${cell(criterion.state)} | ${cell(criterion.evidence)} |`,
      );
    });
  }
  lines.push("");
  lines.push("## Bloqueantes");
  lines.push("");
  if (blockers.length === 0) {
    lines.push("Ninguno.");
  } else {
    for (const blocker of blockers) {
      const location = blocker.path ? `${blocker.path}${blocker.line ? `:${blocker.line}` : ""}` : "sin ruta";
      lines.push(`- ${cell(blocker.evidence)} (${cell(location)})`);
    }
  }
  lines.push("");
  lines.push("## Menores");
  lines.push("");
  if (minors.length === 0) {
    lines.push("Ninguno.");
  } else {
    for (const minor of minors) {
      lines.push(`- ${cell(minor.evidence)}`);
    }
  }
  lines.push("");
  lines.push("## No verificado");
  lines.push("");
  if (evidence.unverified.length === 0) {
    lines.push("Nada quedó sin verificar.");
  } else {
    for (const entry of evidence.unverified) {
      lines.push(`- ${cell(entry.id)}: ${cell(entry.cause)}`);
    }
  }
  lines.push("");
  lines.push("## Decisiones de diseño");
  lines.push("");
  if (decisions.length === 0) {
    lines.push("Sin decisiones declaradas.");
  } else {
    lines.push("| # | Decisión | Implementada | Documentada | Evidencia |");
    lines.push("|---|----------|--------------|------------|----------|");
    decisions.forEach((decision, index) => {
      lines.push(
        `| ${index + 1} | ${cell(decision.id)} | ${decision.implemented === null ? "-" : decision.implemented ? "sí" : "no"} | ${decision.documented === null ? "-" : decision.documented ? "sí" : "no"} | ${cell(decision.evidence)} |`,
      );
    });
  }
  lines.push("");
  lines.push("## Conteos");
  lines.push("");
  lines.push(`- Comprobaciones: ${counts.checks.total} (exitosas ${counts.checks.passed}, fallidas ${counts.checks.failed}, no verificadas ${counts.checks.unverified})`);
  lines.push(`- Criterios: ${counts.criteria.total} (materiales ${counts.criteria.material}, verificados ${counts.criteria.verified}, no verificados ${counts.criteria.unverified}, sin cubrir ${counts.criteria.uncovered}, incumplidos ${counts.criteria.failed})`);
  lines.push(`- Hallazgos: ${counts.findings.total} (bloqueantes ${counts.findings.blocker}, menores ${counts.findings.minor})`);
  lines.push("");
  if (reasons.length > 0) {
    lines.push("## Motivos");
    lines.push("");
    for (const reason of reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  lines.push("## Evidencia");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(evidence, null, 2));
  lines.push("```");

  return { markdown: lines.join("\n"), evidence };
}

/**
 * Ejecuta una validación completa: valida el descriptor, resuelve las
 * comprobaciones, las ejecuta, escanea el alcance, agrega y renderiza.
 */
export function runValidation({
  descriptor,
  projectRoot = process.cwd(),
  executor = null,
  now = null,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const candidate = isPlainObject(descriptor) && descriptor.project_root === undefined
    ? { ...descriptor, project_root: projectRoot }
    : descriptor;
  const validated = validateInvocationDescriptor(candidate, { projectRoot });
  if (!validated.ok) return validated;
  const resolved = validated.descriptor;

  let checks = resolved.checks;
  let checksSource = "declared";
  if (checks === null) {
    const discovery = discoverChecks({ projectRoot: resolved.project_root });
    if (!discovery.ok) return discovery;
    checks = discovery.checks;
    checksSource = "discovered";
  }

  const checkResults = runChecks({
    checks,
    projectRoot: resolved.project_root,
    defaultTimeoutMs,
    executor,
  });

  const scanTargets = [...resolved.scope.files, ...resolved.scan.files];
  const scan = scanCoordinationReferences({
    files: scanTargets,
    projectRoot: resolved.project_root,
    allowedLiterals: resolved.scan.allowed_literals,
    exclude: resolved.scan.exclude,
  });

  const findings = [...resolved.findings, ...scan.findings];
  const aggregate = aggregateVerdict({
    descriptor: resolved,
    checkResults,
    findings,
    scanUnverified: scan.unverified,
  });

  const stamp = now === null
    ? new Date()
    : (typeof now === "function" ? now() : now);
  const { markdown, evidence } = renderValidationReport({
    descriptor: resolved,
    checkResults,
    findings,
    verdict: aggregate,
    criteria: aggregate.criteria,
    designDecisions: resolved.design_decisions,
    generatedAt: stamp,
  });
  evidence.checks_source = checksSource;
  evidence.scan = {
    files: scanTargets,
    excluded: resolved.scan.exclude,
    allowed_literals: resolved.scan.allowed_literals,
    unverified: scan.unverified,
  };

  return { ok: true, result: evidence, markdown };
}

/** Parseo de argumentos del CLI. */
export function parseCliArgs(argv) {
  const options = {
    command: null,
    input: null,
    projectRoot: null,
    json: false,
    timeoutMs: null,
    help: false,
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--input") {
      options.input = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--input=")) {
      options.input = arg.slice("--input=".length);
      continue;
    }
    if (arg === "--project-root") {
      options.projectRoot = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      options.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      const raw = args[index + 1];
      options.timeoutMs = raw === undefined ? null : Number(raw);
      index += 1;
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
      continue;
    }
    if (!arg.startsWith("-") && !options.command) {
      options.command = arg;
    }
  }
  return options;
}

const HELP = `validation-contract — contrato ejecutable de validación en caliente

Uso:
  node validation-contract.js run --input <archivo|-> [--project-root RUTA] [--json] [--timeout-ms N]
  node validation-contract.js discover [--project-root RUTA] [--json]
  node validation-contract.js --help

Subcomandos:
  run        Ejecuta la validación declarada por el descriptor de invocación y
             publica el veredicto con la evidencia ejecutada.
  discover   Lista las comprobaciones disponibles por manifiestos del proyecto.

Opciones:
  --input RUTA     Descriptor de invocación. "-" lee de la entrada estándar.
  --project-root   Raíz del proyecto. Sin este valor se usa el directorio actual.
  --json           Salida en JSON completo.
  --timeout-ms     Límite por defecto de cada comprobación, en milisegundos.
  --help           Muestra esta ayuda.

Códigos de salida: 0 aprobado, 1 rechazo funcional, 2 fallo operativo,
3 contrato inválido o error de uso.`;

const EXIT_BY_VERDICT = {
  [VERDICTS.approved]: 0,
  [VERDICTS.rejected]: 1,
  [VERDICTS.operational_failure]: 2,
};

function readDescriptorSource(input) {
  if (input === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path.resolve(input), "utf8");
}

function runDiscoverCommand(options) {
  const root = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const discovery = discoverChecks({ projectRoot: root });
  if (!discovery.ok) {
    process.stderr.write(`⛔ ${discovery.reason}: ${discovery.expected ?? ""}\n`);
    return 3;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checks: discovery.checks }, null, 2)}\n`);
    return 0;
  }
  if (discovery.checks.length === 0) {
    process.stdout.write("Sin comprobaciones disponibles.\n");
    return 0;
  }
  for (const check of discovery.checks) {
    process.stdout.write(`${check.id}: ${[check.command, ...check.args].join(" ")}\n`);
  }
  return 0;
}

function runValidationCommand(options) {
  if (!options.input) {
    process.stderr.write("⛔ Falta --input con el descriptor de invocación\n");
    return 3;
  }
  let raw = null;
  try {
    raw = readDescriptorSource(options.input);
  } catch (error) {
    process.stderr.write(`⛔ No se pudo leer el descriptor: ${error.message}\n`);
    return 3;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`⛔ Descriptor inválido: ${error.message}\n`);
    return 3;
  }
  const root = options.projectRoot ? path.resolve(options.projectRoot) : process.cwd();
  const outcome = runValidation({
    descriptor: parsed,
    projectRoot: root,
    defaultTimeoutMs: options.timeoutMs && Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS,
  });
  if (!outcome.ok) {
    const found = outcome.found === undefined || outcome.found === null
      ? ""
      : ` (${JSON.stringify(outcome.found)})`;
    process.stderr.write(`⛔ ${outcome.reason}: ${outcome.expected ?? ""}${found}\n`);
    return 3;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  } else {
    process.stdout.write(`${outcome.markdown}\n`);
  }
  return EXIT_BY_VERDICT[outcome.result.verdict] ?? 2;
}

/** Punto de entrada del CLI. */
export function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!options.command) {
    process.stderr.write(`${HELP}\n`);
    return 3;
  }
  if (options.command === "discover") return runDiscoverCommand(options);
  if (options.command === "run") return runValidationCommand(options);
  process.stderr.write(`⛔ Comando desconocido: ${options.command}\n`);
  return 3;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
