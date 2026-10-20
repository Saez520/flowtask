/**
 * Contrato ejecutable de identidad por capas.
 *
 * El módulo es puro: lee definiciones de agentes cuando se le pide y nada más.
 * No escribe archivos, no consulta un almacén de memoria y no usa la red.
 * Los fallos operativos se devuelven como resultados estructurados en lugar
 * de lanzarse como excepciones.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Las tres capas de identidad y su etiqueta visible. */
export const LAYERS = Object.freeze({
  hermes: Object.freeze({ label: "núcleo Hermes", devOnly: true }),
  orchestrator: Object.freeze({ label: "orquestador", devOnly: false }),
  subagent: Object.freeze({ label: "subagente", devOnly: false }),
});

/** Nombre reservado de la capa Hermes: no puede ser nombre base ni nombre de subagente. */
export const HERMES_RESERVED_NAME = "Hermes";

/** Nombre del agente de la capa orquestador. */
export const ORCHESTRATOR_AGENT_NAME = "runner";

/** Nombres de ejemplo: sustituyen a la lista real cuando el operador no provee una. */
export const EXAMPLE_BASE_NAMES = Object.freeze(["Aitana", "Kael"]);

const FRONTMATTER_LINES = 20;

const normalizeName = (value) => (typeof value === "string" ? value.trim() : "");
const normalizeKey = (value) => normalizeName(value).toLowerCase();
const isClosedStatus = (status) => normalizeKey(status) === "closed";

function makeIdentity(layer, baseName, agentType, instanceName, definition) {
  const display = definition.devOnly
    ? `[capa: ${definition.label}] ${instanceName} (dev-only)`
    : `[capa: ${definition.label}] ${instanceName}`;
  return Object.freeze({
    layer,
    layer_label: definition.label,
    base_name: baseName,
    agent_type: agentType,
    instance_name: instanceName,
    display,
    dev_only: definition.devOnly,
  });
}

/** Construye la identidad de una capa contra su regla de nombre. */
export function buildIdentity({ layer, baseName = null, agentType = null } = {}) {
  if (!Object.hasOwn(LAYERS, layer)) {
    return {
      ok: false,
      reason: "layer_unknown",
      expected: Object.keys(LAYERS).join(", "),
      found: layer ?? null,
    };
  }
  const definition = LAYERS[layer];

  if (layer === "hermes") {
    if (normalizeName(baseName)) {
      return {
        ok: false,
        reason: "base_name_not_allowed",
        expected: "sin nombre base para la capa Hermes",
        found: baseName,
      };
    }
    return {
      ok: true,
      identity: makeIdentity("hermes", null, null, HERMES_RESERVED_NAME, definition),
    };
  }

  const base = normalizeName(baseName);
  if (!base) {
    return {
      ok: false,
      reason: "base_name_missing",
      expected: "nombre base no vacío",
      found: baseName ?? null,
    };
  }
  if (normalizeKey(base) === normalizeKey(HERMES_RESERVED_NAME)) {
    return {
      ok: false,
      reason: "base_name_reserved",
      expected: `nombre base distinto del nombre reservado "${HERMES_RESERVED_NAME}"`,
      found: base,
    };
  }

  if (layer === "orchestrator") {
    if (normalizeName(agentType)) {
      return {
        ok: false,
        reason: "agent_type_not_allowed",
        expected: "sin tipo de agente para la capa orquestador",
        found: agentType,
      };
    }
    return { ok: true, identity: makeIdentity("orchestrator", base, null, base, definition) };
  }

  const type = normalizeName(agentType);
  if (!type) {
    return {
      ok: false,
      reason: "agent_type_missing",
      expected: "tipo de agente no vacío",
      found: agentType ?? null,
    };
  }
  return {
    ok: true,
    identity: makeIdentity("subagent", base, type, `${base}-${type}`, definition),
  };
}

/**
 * Asigna el nombre base de un trabajo: primer nombre libre de la lista.
 * Un trabajo ocupa su nombre mientras no esté cerrado.
 */
export function allocateBaseName({ baseNames, activeWorks = [], requestedBaseName = null } = {}) {
  if (!Array.isArray(baseNames) || baseNames.length === 0) {
    return {
      ok: false,
      reason: "base_names_invalid",
      expected: "lista no vacía de nombres base",
      found: Array.isArray(baseNames) ? baseNames : null,
    };
  }
  const candidates = [];
  for (const candidate of baseNames) {
    const value = normalizeName(candidate);
    if (!value) {
      return {
        ok: false,
        reason: "base_names_invalid",
        expected: "nombres base no vacíos",
        found: candidate ?? null,
      };
    }
    candidates.push(value);
  }

  const seen = new Set();
  for (const value of candidates) {
    const key = normalizeKey(value);
    if (seen.has(key)) {
      return {
        ok: false,
        reason: "duplicate_active_base_name",
        expected: "nombres base únicos",
        found: `nombres base duplicados: ${value}`,
      };
    }
    seen.add(key);
  }

  const occupied = new Map();
  for (const work of Array.isArray(activeWorks) ? activeWorks : []) {
    if (!work || typeof work !== "object") continue;
    const name = normalizeName(work.base_name);
    if (!name || isClosedStatus(work.status)) continue;
    const key = normalizeKey(name);
    if (occupied.has(key)) {
      return {
        ok: false,
        reason: "duplicate_active_base_name",
        expected: "un trabajo activo por nombre base",
        found: `nombres base duplicados entre trabajos activos: ${name}`,
      };
    }
    occupied.set(key, name);
  }

  const requested = normalizeName(requestedBaseName);
  if (requested) {
    const key = normalizeKey(requested);
    if (occupied.has(key)) {
      return {
        ok: false,
        reason: "base_name_conflict",
        expected: "nombre base libre",
        found: `nombre base ocupado por un trabajo activo: ${occupied.get(key)}`,
      };
    }
    const match = candidates.find((value) => normalizeKey(value) === key);
    if (!match) {
      return {
        ok: false,
        reason: "base_name_conflict",
        expected: "nombre base de la lista disponible",
        found: requested,
      };
    }
    return { ok: true, baseName: match };
  }

  for (const value of candidates) {
    if (!occupied.has(normalizeKey(value))) return { ok: true, baseName: value };
  }
  return {
    ok: false,
    reason: "base_name_unavailable",
    expected: "nombre base libre",
    found: "lista de nombres base agotada",
  };
}

/** Renderiza una identidad para el mensaje de detención. */
export function displayIdentity(identity) {
  if (!identity || typeof identity !== "object") return "sin identidad";
  if (typeof identity.display === "string" && identity.display) return identity.display;
  const layer = identity.layer;
  const known = Object.hasOwn(LAYERS, layer) ? LAYERS[layer] : null;
  const label = identity.layer_label ?? known?.label ?? layer ?? "desconocida";
  const name = identity.instance_name ?? "";
  const devOnly = identity.dev_only ?? known?.devOnly ?? false;
  return `[capa: ${label}] ${name}${devOnly ? " (dev-only)" : ""}`;
}

function sameIdentity(registered, presented) {
  return (
    registered.layer === presented.layer &&
    normalizeKey(registered.base_name) === normalizeKey(presented.base_name) &&
    normalizeKey(registered.agent_type) === normalizeKey(presented.agent_type) &&
    normalizeName(registered.instance_name) === normalizeName(presented.instance_name)
  );
}

/**
 * Verifica que la identidad presentada sea la registrada.
 * Ante cualquier falla conserva el registro previo y exige detenerse.
 */
export function verifyInvocationIdentity({ registered, presented } = {}) {
  if (!registered || typeof registered !== "object") {
    return {
      ok: false,
      reason: "identity_missing",
      action: "stop",
      expected: "identidad registrada",
      found: "sin identidad registrada",
      preserved: registered ?? null,
    };
  }
  if (!presented || typeof presented !== "object") {
    return {
      ok: false,
      reason: "identity_missing",
      action: "stop",
      expected: displayIdentity(registered),
      found: "sin identidad presentada",
      preserved: registered,
    };
  }
  if (!sameIdentity(registered, presented)) {
    return {
      ok: false,
      reason: "identity_mismatch",
      action: "stop",
      expected: displayIdentity(registered),
      found: displayIdentity(presented),
      preserved: registered,
    };
  }
  return { ok: true, identity: registered, resumedLiterally: true };
}

/**
 * Verificación de continuidad del Constructor: identidad coincidente y
 * checkpoint restaurable. Sin checkpoint restaurable no hay continuidad.
 */
export function verifyConstructorContinuity({ registered, presented, checkpointRestorable } = {}) {
  const verification = verifyInvocationIdentity({ registered, presented });
  if (!verification.ok) return verification;
  if (checkpointRestorable !== true) {
    return {
      ok: false,
      reason: "constructor_continuity_unavailable",
      action: "stop",
      expected: "checkpoint restaurable",
      found: "checkpoint no restaurable",
      preserved: registered,
    };
  }
  return verification;
}

/** Clasifica la capa de una definición de agente por su frontmatter. */
export function classifyAgentDefinition({ name, mode } = {}) {
  const agentName = normalizeName(name);
  const agentMode = normalizeName(mode);
  if (agentMode === "primary" && agentName === ORCHESTRATOR_AGENT_NAME) {
    return { ok: true, layer: "orchestrator" };
  }
  if (agentMode === "subagent") {
    return { ok: true, layer: "subagent" };
  }
  return {
    ok: false,
    reason: "agent_layer_unknown",
    expected: "mode: primary con name runner, o mode: subagent",
    found: { name: name ?? null, mode: mode ?? null },
  };
}

function frontmatterValue(head, key) {
  const match = head.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

/** Lee las definiciones de agentes leyendo solo el frontmatter inicial. */
export function loadAgentDefinitions(agentsDir) {
  if (!agentsDir || typeof agentsDir !== "string") {
    return {
      ok: false,
      reason: "agents_dir_missing",
      expected: "directorio de definiciones de agentes",
      found: null,
    };
  }
  let entries;
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: "agents_dir_missing", expected: agentsDir, found: null };
  }
  const definitions = [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of files) {
    const file = path.join(agentsDir, entry.name);
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const head = content.split(/\r?\n/).slice(0, FRONTMATTER_LINES).join("\n");
    definitions.push({
      file: entry.name,
      path: file,
      name: frontmatterValue(head, "name"),
      mode: frontmatterValue(head, "mode"),
    });
  }
  if (definitions.length === 0) {
    return {
      ok: false,
      reason: "agents_dir_empty",
      expected: "definiciones de agentes",
      found: agentsDir,
    };
  }
  return { ok: true, definitions };
}

/** Primer directorio existente entre el explícito y las rutas activas del proyecto. */
export function resolveAgentsDir({ explicitDir = null, cwd = process.cwd() } = {}) {
  const candidates = [];
  if (explicitDir) candidates.push(explicitDir);
  candidates.push(path.join(cwd, ".opencode/flowtask/agents"));
  candidates.push(path.join(cwd, ".claude/flowtask/agents"));
  candidates.push(path.join(cwd, ".flowtask/agents"));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Ejecuta el check completo: clasifica las definiciones de agentes, construye
 * las identidades de las tres capas y comprueba la unicidad en paralelo y las
 * detenciones fail-closed.
 */
export function runIdentityCheck({ agentsDir = null, baseNames = EXAMPLE_BASE_NAMES, cwd = process.cwd() } = {}) {
  const lines = [];
  const names = Array.isArray(baseNames) ? baseNames.map(normalizeName).filter(Boolean) : [];
  if (names.length === 0) {
    return {
      ok: false,
      reason: "base_names_invalid",
      lines,
      expected: "lista no vacía de nombres base",
      found: baseNames ?? null,
    };
  }

  const resolved = agentsDir ? agentsDir : resolveAgentsDir({ cwd });
  if (!resolved) {
    return {
      ok: false,
      reason: "agents_dir_missing",
      lines,
      expected: "directorio de definiciones de agentes",
      found: null,
    };
  }

  const loaded = loadAgentDefinitions(resolved);
  if (!loaded.ok) {
    return { ok: false, reason: loaded.reason, lines, expected: loaded.expected, found: loaded.found };
  }

  const classified = [];
  for (const definition of loaded.definitions) {
    const result = classifyAgentDefinition(definition);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        lines,
        expected: result.expected,
        found: { file: definition.file, ...result.found },
      };
    }
    classified.push({ ...definition, layer: result.layer });
  }

  const orchestrators = classified.filter((definition) => definition.layer === "orchestrator");
  if (orchestrators.length !== 1) {
    return {
      ok: false,
      reason: "orchestrator_definition_invalid",
      lines,
      expected: `un único mode: primary llamado ${ORCHESTRATOR_AGENT_NAME}`,
      found: orchestrators.map((definition) => definition.name),
    };
  }

  const subagents = classified.filter((definition) => definition.layer === "subagent");
  const agentNames = new Set();
  for (const subagent of subagents) {
    const key = normalizeKey(subagent.name);
    if (agentNames.has(key)) {
      return {
        ok: false,
        reason: "duplicate_agent_name",
        lines,
        expected: "nombres de agente únicos",
        found: subagent.name,
      };
    }
    agentNames.add(key);
  }

  const hermes = buildIdentity({ layer: "hermes" });
  if (!hermes.ok) {
    return { ok: false, reason: hermes.reason, lines, expected: hermes.expected, found: hermes.found };
  }
  const orchestrator = buildIdentity({ layer: "orchestrator", baseName: names[0] });
  if (!orchestrator.ok) {
    return {
      ok: false,
      reason: orchestrator.reason,
      lines,
      expected: orchestrator.expected,
      found: orchestrator.found,
    };
  }
  const subagentIdentities = [];
  for (const subagent of subagents) {
    const identity = buildIdentity({ layer: "subagent", baseName: names[0], agentType: subagent.name });
    if (!identity.ok) {
      return {
        ok: false,
        reason: identity.reason,
        lines,
        expected: identity.expected,
        found: identity.found,
      };
    }
    subagentIdentities.push(identity.identity);
  }

  lines.push(hermes.identity.display);
  lines.push(orchestrator.identity.display);
  for (const identity of subagentIdentities) lines.push(identity.display);

  const first = allocateBaseName({ baseNames: names });
  if (!first.ok) {
    return { ok: false, reason: first.reason, lines, expected: first.expected, found: first.found };
  }
  const parallel = [first.baseName];
  if (names.length > 1) {
    const second = allocateBaseName({
      baseNames: names,
      activeWorks: [{ base_name: first.baseName, status: "active", work_ref: "check" }],
      requestedBaseName: names[1],
    });
    if (!second.ok) {
      return { ok: false, reason: second.reason, lines, expected: second.expected, found: second.found };
    }
    parallel.push(second.baseName);
  }
  const parallelKeys = new Set(parallel.map(normalizeKey));
  if (parallelKeys.size !== parallel.length) {
    return {
      ok: false,
      reason: "duplicate_active_base_name",
      lines,
      expected: "nombres base únicos",
      found: `nombres base duplicados: ${parallel.join(", ")}`,
    };
  }

  const missing = verifyInvocationIdentity({ registered: orchestrator.identity, presented: null });
  const mismatched = verifyInvocationIdentity({
    registered: subagentIdentities[0],
    presented: orchestrator.identity,
  });
  if (missing.ok || missing.action !== "stop" || mismatched.ok || mismatched.reason !== "identity_mismatch") {
    return {
      ok: false,
      reason: "fail_closed_not_enforced",
      lines,
      expected: "detención ante identidad faltante o distinta",
      found: "el módulo no detiene",
    };
  }

  const summary = [
    `✔ Orquestador: ${orchestrator.identity.display}`,
    `✔ Núcleo Hermes: ${hermes.identity.display}`,
    `✔ Subagentes: ${subagentIdentities.length} identidades únicas`,
    `✔ nombres paralelos únicos: ${parallel.join(", ")}`,
    "✔ fail-closed: identidad faltante o distinta detiene y conserva el registro previo",
  ];

  return { ok: true, lines, summary, identities: { hermes: hermes.identity, orchestrator: orchestrator.identity, subagents: subagentIdentities } };
}

/** Línea humana de detención ante identidad faltante o distinta. */
export function formatIdentityFailure(result) {
  const expected = result?.expected ?? "identidad verificable";
  const found = result?.found ?? "sin identidad";
  return `⛔ Identidad detenida: esperaba ${expected}; encontré ${found}. Registro previo conservado.`;
}

/** Parseo de argumentos del CLI. */
export function parseCliArgs(argv) {
  const options = { command: null, names: null, agentsDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--names") {
      options.names = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--names=")) {
      options.names = arg.slice("--names=".length);
      continue;
    }
    if (arg === "--agents-dir") {
      options.agentsDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--agents-dir=")) {
      options.agentsDir = arg.slice("--agents-dir=".length);
      continue;
    }
    if (!arg.startsWith("-") && !options.command) {
      options.command = arg;
    }
  }
  return options;
}

/** Divide la lista de nombres base del CLI. */
export function parseBaseNames(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const HELP = `agent-identity — contrato ejecutable de identidad por capas

Uso:
  node agent-identity.js roles --names Aitana,Kael [--agents-dir PATH]
  node agent-identity.js check --names Aitana,Kael [--agents-dir PATH]
  node agent-identity.js --help

Subcomandos:
  roles   Imprime las identidades de las tres capas: núcleo Hermes, orquestador
          y una por subagente.
  check   Imprime las identidades y ejecuta el resumen de comprobaciones:
          unicidad de nombres entre trabajos en paralelo y detención
          fail-closed ante identidad faltante o distinta.

Opciones:
  --names LISTA       Nombres base separados por coma. Sin este valor se usan
                      nombres de ejemplo y la salida lo declara.
  --agents-dir PATH   Directorio de definiciones de agentes. Sin este valor se
                      busca en las rutas activas del proyecto.
  --help              Muestra esta ayuda.

Códigos de salida: 0 si todas las comprobaciones pasan, 1 ante cualquier
violación de identidad.`;

function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!options.command) {
    process.stderr.write(`${HELP}\n`);
    return 1;
  }
  if (options.command !== "roles" && options.command !== "check") {
    process.stderr.write(`⛔ Comando desconocido: ${options.command}\n`);
    return 1;
  }

  const usingExamples = options.names === null;
  const names = usingExamples ? [...EXAMPLE_BASE_NAMES] : parseBaseNames(options.names);
  const result = runIdentityCheck({ agentsDir: options.agentsDir, baseNames: names });
  if (!result.ok) {
    process.stdout.write(`${formatIdentityFailure(result)}\n`);
    return 1;
  }
  if (usingExamples) {
    process.stdout.write(`ℹ️ nombres de ejemplo: ${names.join(", ")}\n`);
  }
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (options.command === "check") {
    for (const line of result.summary) process.stdout.write(`${line}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
