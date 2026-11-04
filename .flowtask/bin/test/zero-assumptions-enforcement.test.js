import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readComposedRunner } from "./helpers/runner-document.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8");
const exists = (relPath) => fs.existsSync(path.join(ROOT, relPath));

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const ZERO_ASSUMPTIONS = ".flowtask/skills/zero-assumptions/SKILL.md";
const zeroAssumptions = read(ZERO_ASSUMPTIONS);
const zeroFlat = flat(zeroAssumptions);

const ZERO_ASSUMPTIONS_SECTIONS = [
  "## Propósito",
  "## Nada se da por supuesto",
  "## Material y periférico",
  "## Orden de verificación",
  "## Registro de evidencia",
  "## Incertidumbre y discrepancia",
  "## Pausa por dato material no confirmado",
  "## Alcance por rol",
  "## Herencia de evidencia",
  "## Consecuencia de violación",
  "## Verificación",
];

const VERIFICATION_RECORD_FIELDS = [
  "schema",
  "id",
  "datum",
  "materiality",
  "source_kind",
  "source_ref",
  "status",
  "observed_at",
  "order_exception",
  "missing_source",
  "note",
];

/** Extrae y parsea el primer bloque JSON fenced del contenido. */
function jsonBlock(content) {
  const match = content.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, "el contenido debe declarar un bloque json");
  return JSON.parse(match[1]);
}

/** Motivos de pausa vigentes; ningún enum nuevo puede agregarse. */
const VIGENT_PAUSE_REASONS = new Set([
  "authority_block",
  "explicit_limit",
  "invariant_violation",
  "no_verifiable_progress",
  "progress_unavailable",
  "soft_limit_exceeded",
  "explicit_pause_decision",
  "record_unavailable",
  "data_unverified",
  "hard_limit",
]);

/** Tokens que no son motivos de pausa aunque aparezcan en su contexto. */
const NON_REASON_TOKENS = new Set([
  "new_limit",
  "authority_decision",
  "new_hypothesis",
  "new_baseline",
  "progress_readable",
  "record_readable",
  "data_complete",
  "resolution_record",
  "signal_lifted",
  "hard_limit_invalid",
  "rollback_and_pause",
]);

/**
 * Motivos de pausa declarados explícitamente en el contenido: las celdas de
 * motivo de las tablas y las menciones en prosa que nombran un motivo.
 */
function declaredPauseReasons(content) {
  const reasons = new Set();
  const lines = content.split("\n");
  let inMotiveTable = false;

  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      const cells = line.split("|").map((cell) => cell.trim());
      if (cells.some((cell) => /motivo/i.test(cell))) {
        inMotiveTable = true;
        continue;
      }
      if (inMotiveTable) {
        for (const match of line.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
          reasons.add(match[1]);
        }
        continue;
      }
    } else {
      inMotiveTable = false;
    }

    for (const match of line.matchAll(/motivo(?: de pausa)?\s*(?:vigente)?\s*:?\s*`([a-z][a-z0-9_]*)`/gi)) {
      reasons.add(match[1]);
    }
  }
  return reasons;
}

/**
 * Falla si el contenido introduce un enum de motivo de pausa nuevo.
 * El conjunto de motivos vigentes es cerrado.
 */
function assertNoNewPauseReason(content) {
  assert.doesNotMatch(
    content,
    /pause_reason_/,
    "no puede introducirse un enum nuevo de motivo de pausa",
  );
  for (const reason of declaredPauseReasons(content)) {
    if (NON_REASON_TOKENS.has(reason)) continue;
    assert.ok(
      VIGENT_PAUSE_REASONS.has(reason),
      `motivo de pausa fuera del conjunto vigente: ${reason}`,
    );
  }
}

describe("zero-assumptions skill contract", () => {
  it("publica la skill con su frontmatter", () => {
    assert.equal(exists(ZERO_ASSUMPTIONS), true);
    const head = read(ZERO_ASSUMPTIONS).split(/\r?\n/).slice(0, 20).join("\n");
    assert.match(head, /^name:\s*zero-assumptions$/m);
    assert.match(head, /^license:\s*MIT$/m);
    assert.match(head, /^compatibility:\s*opencode$/m);
    assert.match(head, /category:\s*protocol/);
    assert.match(head, /scope:\s*flowtask/);
  });

  it("declara las secciones del protocolo", () => {
    for (const section of ZERO_ASSUMPTIONS_SECTIONS) {
      assert.ok(zeroAssumptions.includes(section), `falta la sección ${section}`);
    }
  });

  it("fija el orden de verificación de las fuentes", () => {
    const memory = zeroFlat.indexOf("1. **Memoria del proyecto**");
    const repository = zeroFlat.indexOf("2. **Documentación, código y estado del repositorio**");
    const person = zeroFlat.indexOf("3. **La persona**");
    assert.ok(memory >= 0, "falta el primer paso del orden de verificación");
    assert.ok(repository > memory, "el repositorio va después de la memoria");
    assert.ok(person > repository, "la persona va después del repositorio");
    assert.ok(
      zeroFlat.includes("El grafo de conocimiento y la lectura directa instrumentan este paso"),
      "falta la instrumentación del paso de documentación y código",
    );
    assert.ok(zeroFlat.includes("order_exception"), "falta la excepción de orden declarada");
    assert.ok(zeroFlat.includes("missing_source"), "falta la fuente ausente declarada");
    assert.ok(
      zeroFlat.includes("la ausencia de fuente no confirma nada"),
      "la ausencia de fuente no puede confirmar el dato",
    );
  });

  it("elimina la cadena de validación indefinida", () => {
    assert.doesNotMatch(
      zeroAssumptions,
      /Sigue tu cadena de validación/,
      "el protocolo ya prescribe el orden de consulta",
    );
  });

  it("declara el schema VerificationRecord v1 parseable y completo", () => {
    const record = jsonBlock(zeroAssumptions);
    assert.equal(record.schema, "verification-record/v1");
    for (const field of VERIFICATION_RECORD_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(record, field),
        `el registro no declara el campo ${field}`,
      );
    }
  });

  it("declara los enums del registro y sus reglas", () => {
    assert.ok(zeroFlat.includes("`material` o `peripheral`"), "falta el enum de materialidad");
    assert.ok(
      zeroFlat.includes("`memory`, `document_or_code`, `repository_state` o `person`"),
      "falta el enum de origen de la fuente",
    );
    assert.ok(
      zeroFlat.includes("`verified`, `unverified` o `discrepant`"),
      "falta el enum de estado",
    );
    assert.ok(
      zeroFlat.includes("`verified` exige un `source_ref` resoluble"),
      "verified exige fuente resoluble",
    );
    assert.ok(
      zeroFlat.includes("`unverified` exige `missing_source` o `note`, y solo es admisible para un dato periférico"),
      "unverified exige causa y solo admite datos periféricos",
    );
    assert.ok(
      zeroFlat.includes("`discrepant` exige `note` con las dos fuentes en conflicto"),
      "discrepant exige las dos fuentes",
    );
    assert.ok(
      zeroFlat.includes("No hay puntaje de confianza"),
      "el protocolo descarta el puntaje de confianza",
    );
  });

  it("aplica la materialidad conservadora", () => {
    assert.ok(
      zeroFlat.includes("cambia una decisión, el alcance, un criterio, un permiso, la seguridad o un entregable"),
      "falta la definición de dato material",
    );
    assert.ok(
      zeroFlat.includes("Ante la duda, el dato es material"),
      "la duda se resuelve como material",
    );
    assert.ok(zeroFlat.includes("[No verificado]"), "falta el estado del dato periférico");
    assert.ok(
      zeroFlat.includes("no se presenta como hecho"),
      "un dato material no confirmado no se presenta como hecho",
    );
  });

  it("mapea la pausa por dato material a los motivos vigentes", () => {
    for (const reason of ["authority_block", "progress_unavailable", "no_verifiable_progress"]) {
      assert.ok(zeroFlat.includes(reason), `falta el motivo de pausa ${reason}`);
    }
    assert.ok(zeroFlat.includes("⏸ Pausa por excepción: {motivo}"), "falta la línea de pausa");
    assert.ok(zeroFlat.includes("Estado conservado:"), "falta la línea de estado conservado");
    assert.ok(zeroFlat.includes("Para reanudar:"), "falta la línea de reanudación");
    assert.ok(zeroFlat.includes("policy.profile"), "falta el perfil de política");
    assert.ok(
      zeroFlat.includes("La verificación mínima para reanudar es la misma en ambos perfiles"),
      "la verificación mínima es igual en ambos perfiles",
    );
    assertNoNewPauseReason(zeroAssumptions);
  });

  it("distingue el alcance por rol", () => {
    assert.ok(zeroFlat.includes("Redacta, planifica y explora"), "falta el rol de análisis");
    assert.ok(zeroFlat.includes("Construye y valida"), "falta el rol de ejecución");
    assert.ok(zeroFlat.includes("Orquesta"), "falta el rol de orquestación");
    assert.ok(
      /verifica solo el dato nuevo material/i.test(zeroFlat),
      "falta el alcance acotado",
    );
  });

  it("establece la herencia de evidencia y la contradicción", () => {
    assert.ok(
      zeroFlat.includes("se hereda con su `source_ref` y su `observed_at`; no se re-verifica por rutina"),
      "falta la herencia con fuente y momento",
    );
    assert.ok(
      zeroFlat.includes("Un estado mutable se re-observa solo cuando la decisión depende de su valor actual"),
      "falta la regla del estado mutable",
    );
    assert.ok(
      zeroFlat.includes("se registra como `discrepant` y pausa antes de imponer un cambio de alcance"),
      "la contradicción pausa antes de imponer alcance",
    );
  });

  it("no introduce bloqueo automático ni referencias de coordinación", () => {
    assert.ok(
      zeroFlat.includes("No hay bloqueo automático"),
      "no hay bloqueo automático",
    );
    assert.doesNotMatch(zeroAssumptions, /CA-[a-z0-9]/, "sin identificadores de ejecución");
    assert.doesNotMatch(zeroAssumptions, /F2\.7/, "sin identificadores de fase");
    assert.doesNotMatch(zeroAssumptions, /flow-state\//, "sin namespaces de coordinación");
  });
});

const PLAN_TEMPLATE = ".flowtask/skills/plan-template/SKILL.md";
const PLAN_AUDITOR = ".flowtask/agents/plan-auditor.md";
const planTemplate = read(PLAN_TEMPLATE);
const planTemplateFlat = flat(planTemplate);
const planAuditor = read(PLAN_AUDITOR);
const planAuditorFlat = flat(planAuditor);

describe("plan evidence contract", () => {
  it("declara la sección de evidencia verificada en la plantilla", () => {
    assert.ok(planTemplate.includes("## Evidencia verificada"), "falta la sección de evidencia");
    const evidence = planTemplate.indexOf("## Evidencia verificada");
    const decisions = planTemplate.indexOf("## Decisiones de diseño");
    const scope = planTemplate.indexOf("## Scope");
    assert.ok(decisions >= 0 && evidence > decisions, "la evidencia va después de las decisiones");
    assert.ok(scope > evidence, "la evidencia va antes del alcance");
  });

  it("declara la tabla de evidencia con fuente y estado", () => {
    for (const column of ["| ID |", "Materialidad", "Fuente", "Estado", "Nota"]) {
      assert.ok(planTemplate.includes(column), `falta la columna ${column}`);
    }
    assert.ok(planTemplate.includes("VR-01"), "falta el identificador del registro");
    assert.ok(planTemplate.includes("verified"), "falta el estado verificado");
    assert.ok(planTemplate.includes("unverified"), "falta el estado no verificado");
    assert.ok(planTemplate.includes("discrepant"), "falta el estado discrepante");
  });

  it("exige que todo dato material cite su registro", () => {
    assert.ok(
      planTemplateFlat.includes("Every material datum cited by a decision cites its record (VR-NN)."),
      "falta la regla de cita del registro",
    );
    assert.ok(
      planTemplateFlat.includes("never stays inside a decision or a task"),
      "un dato material sin verificar no puede quedar en una decisión o tarea",
    );
    assert.ok(planTemplateFlat.includes("pending_decision"), "falta la decisión pendiente");
    assert.ok(planTemplateFlat.includes("blocker"), "falta el blocker");
    assert.ok(
      planTemplateFlat.includes("No hay datos materiales adicionales"),
      "falta la declaración de ausencia de datos materiales",
    );
    assert.ok(
      planTemplateFlat.includes("No unverified material datum in a decision"),
      "falta la regla de key rules",
    );
  });

  it("hace que el auditor verifique la evidencia material del plan", () => {
    assert.ok(planAuditor.includes("### 6. Evidencia material del plan"), "falta la verificación 6");
    assert.ok(planAuditor.includes("zero-assumptions"), "falta la carga del protocolo");
    assert.ok(
      planAuditorFlat.includes("FALLA si"),
      "la verificación declara su condición de falla",
    );
    assert.ok(
      planAuditorFlat.includes("unverified"),
      "la verificación contempla el estado no verificado",
    );
    assert.ok(
      planAuditorFlat.includes("discrepant"),
      "la verificación contempla el estado discrepante",
    );
    assert.ok(
      planAuditorFlat.includes("como decisión pendiente ni como blocker"),
      "la falla exige decisión pendiente o blocker",
    );
  });

  it("agrega el blocker y el anti-patrón de la evidencia material", () => {
    const blockers = planAuditor.slice(planAuditor.indexOf("### SÍ son Blockers"));
    assert.ok(
      blockers.includes("dato material"),
      "el blocker de evidencia material debe estar en los blockers",
    );
    const antiPatterns = planAuditor.slice(planAuditor.indexOf("### NO son Blockers"));
    assert.ok(
      antiPatterns.includes("dato periférico"),
      "el anti-patrón debe eximir al dato periférico",
    );
  });

  it("incorpora el paso de evidencia material al proceso de review", () => {
    const process = planAuditor.slice(
      planAuditor.indexOf("## Proceso de Review"),
      planAuditor.indexOf("## Framework de Decisión"),
    );
    assert.ok(
      process.includes("Verificar evidencia material"),
      "el proceso debe verificar la evidencia material",
    );
  });

  it("conserva la aprilación por default y el máximo de issues", () => {
    assert.ok(planAuditorFlat.includes("APROBAR por default"), "falta la aprobación por default");
    assert.ok(planAuditorFlat.includes("Máximo 3 issues"), "falta el máximo de issues");
  });
});

const CA_WRITER = ".flowtask/agents/ca-writer.md";
const caWriter = read(CA_WRITER);
const caWriterFlat = flat(caWriter);

describe("ca-writer evidence contract", () => {
  it("carga el protocolo antes de la consulta de grafo", () => {
    const protocol = caWriter.indexOf('skill({ name: "zero-assumptions" })');
    const graphify = caWriter.indexOf('skill({ name: "graphify-protocol" })');
    assert.ok(protocol >= 0, "falta la carga del protocolo");
    assert.ok(graphify > protocol, "el protocolo se carga antes del grafo");
  });

  it("agrega la verificación material antes de la clarificación", () => {
    const verification = caWriter.indexOf("### Paso 2.6 — Verificación material");
    const clarification = caWriter.indexOf("### Paso 3 — Clarificación");
    assert.ok(verification >= 0, "falta el paso de verificación material");
    assert.ok(clarification > verification, "la verificación va antes de la clarificación");
    for (const token of ["VR-*", "missing_source", "[No verificado]", "draft"]) {
      assert.ok(caWriterFlat.includes(token), `falta ${token}`);
    }
    assert.ok(
      caWriterFlat.includes("Una decisión de negocio se registra como autoridad"),
      "falta la distinción entre decisión de negocio y afirmación factual",
    );
  });

  it("incluye la sección de evidencia verificada en el formato del CA", () => {
    const evidence = caWriter.indexOf("## Evidencia verificada");
    const criteria = caWriter.indexOf("## Criterios de aceptación");
    const tradeoffs = caWriter.indexOf("## Tradeoffs y GAPs");
    assert.ok(evidence >= 0, "falta la sección de evidencia");
    assert.ok(evidence > criteria, "la evidencia va después de los criterios");
    assert.ok(tradeoffs > evidence, "la evidencia va antes de los tradeoffs");
    for (const column of ["| ID |", "Materialidad", "Fuente", "Estado"]) {
      assert.ok(caWriter.includes(column), `falta la columna ${column}`);
    }
  });

  it("conserva el resto del formato del CA", () => {
    for (const section of [
      "## Clasificación",
      "## Contexto",
      "## Requisito funcional",
      "## Qué debe ser configurable",
      "## Criterios de aceptación",
      "## Tradeoffs y GAPs",
      "## AI-Slop Prevention",
    ]) {
      assert.ok(caWriter.includes(section), `falta la sección ${section}`);
    }
  });

  it("mantiene el CA en draft cuando un dato material no está confirmado", () => {
    assert.ok(
      caWriterFlat.includes("mantiene el CA en `draft`"),
      "falta la regla de draft ante dato material sin confirmar",
    );
    assert.ok(
      caWriterFlat.includes("waiting_for_user"),
      "falta la respuesta waiting_for_user",
    );
  });

  it("declara la regla de evidencia en las reglas de escritura y en las restricciones", () => {
    assert.ok(
      caWriterFlat.includes("Un dato material no verificado no se presenta como hecho"),
      "falta la regla del dato material no verificado",
    );
    assert.ok(
      caWriterFlat.includes("cita su registro `VR-*`"),
      "falta la regla de citar el registro",
    );
  });
});

const PLANNER = ".flowtask/agents/planner.md";
const planner = read(PLANNER);
const plannerFlat = flat(planner);

describe("planner evidence contract", () => {
  it("carga el protocolo en la tabla de skills", () => {
    assert.ok(planner.includes("| `zero-assumptions` |"), "falta la carga del protocolo");
  });

  it("agrega el paso 3.6 entre el grafo y la generación del plan", () => {
    const graphify = planner.indexOf("### Paso 3.5 — Consulta Graphify");
    const verification = planner.indexOf("### Paso 3.6 — Verificación material");
    const generation = planner.indexOf("### Paso 4 — Generar plan estructurado");
    assert.ok(graphify >= 0, "falta el paso del grafo");
    assert.ok(verification > graphify, "la verificación va después del grafo");
    assert.ok(generation > verification, "la verificación va antes de la generación");
  });

  it("verifica los hechos del repositorio y registra los registros", () => {
    for (const token of [
      "VR-*",
      "convenciones que el plan declara",
      "existencia y el contenido de cada archivo referenciado",
      "versión vigente del proyecto",
      "artifacts de Engram",
    ]) {
      assert.ok(plannerFlat.includes(token), `falta ${token}`);
    }
    assert.ok(
      plannerFlat.includes("Registra un registro `VR-*` por dato material en la sección `## Evidencia verificada`"),
      "falta el registro de la evidencia en el plan",
    );
    assert.ok(
      plannerFlat.includes("Toda decisión material cita el registro que la sostiene"),
      "falta la cita del registro en las decisiones",
    );
  });

  it("manda el dato material sin verificar a decisiones pendientes o blockers", () => {
    assert.ok(
      plannerFlat.includes("Un dato material en estado `unverified` o `discrepant` va a `pending_decisions` o a `blockers`"),
      "falta la regla de pending_decisions",
    );
    assert.ok(
      plannerFlat.includes("nunca sostiene una decisión ni una tarea"),
      "el dato sin verificar no sostiene decisiones ni tareas",
    );
    assert.ok(plannerFlat.includes("[No verificado]"), "falta el estado del dato periférico");
    assert.ok(
      plannerFlat.includes("queda `discrepant` con ambas fuentes"),
      "la discrepancia conserva ambas fuentes",
    );
  });

  it("condiciona pending_decisions a la ausencia de material sin verificar", () => {
    assert.ok(
      plannerFlat.includes("`pending_decisions: []` solo es correcto cuando no queda ningún dato material en estado `unverified` o `discrepant`"),
      "falta la regla de pending_decisions vacías",
    );
  });

  it("conserva la evidencia verificable del grafo", () => {
    assert.ok(planner.includes("## Evidencia verificable del grafo"), "falta la sección del grafo");
    assert.ok(planner.includes("G-001"), "falta el identificador del grafo");
    assert.ok(planner.includes("Vía"), "falta la vía de la evidencia");
  });
});

const INSPECTOR = ".flowtask/agents/inspector.md";
const inspector = read(INSPECTOR);
const inspectorFlat = flat(inspector);

describe("inspector evidence contract", () => {
  it("carga el protocolo en las skills requeridas", () => {
    assert.ok(inspector.includes('skill({ name: "zero-assumptions" })'), "falta la carga del protocolo");
  });

  it("agrega la verificación material entre la búsqueda y la lectura de archivos", () => {
    const search = inspector.indexOf("### Paso 2 — búsqueda proactiva en Engram primero");
    const verification = inspector.indexOf("### Paso 2.5 — Verificación material");
    const files = inspector.indexOf("### Paso 3 — Leer archivos relevantes");
    assert.ok(search >= 0, "falta el paso de búsqueda");
    assert.ok(verification > search, "la verificación va después de la búsqueda");
    assert.ok(files > verification, "la verificación va antes de la lectura de archivos");
  });

  it("no re-verifica la investigación previa y verifica los datos nuevos", () => {
    assert.ok(
      inspectorFlat.includes("no se re-verifica por rutina"),
      "la investigación previa no se re-verifica",
    );
    assert.ok(
      inspectorFlat.includes("Los datos nuevos que agregues al análisis sí se verifican"),
      "los datos nuevos se verifican",
    );
    assert.ok(inspectorFlat.includes("source_ref"), "falta la cita de la fuente");
    assert.ok(inspectorFlat.includes("[No verificado]"), "falta el estado del dato periférico");
    assert.ok(
      inspectorFlat.includes("se informa como GAP material y se recomienda la pausa"),
      "falta el GAP material con pausa recomendada",
    );
    assert.ok(
      inspectorFlat.includes("informa la discrepancia con ambas fuentes"),
      "falta la discrepancia informada",
    );
  });

  it("exige el bloque de fuentes cuando usa datos materiales", () => {
    const sources = inspector.indexOf("#### Fuentes");
    assert.ok(sources >= 0, "falta el bloque de fuentes");
    const block = inspector.slice(sources, sources + 700);
    assert.ok(block.includes("| Dato | Fuente | Estado |"), "falta la tabla de fuentes");
    assert.ok(block.includes("verified"), "falta el estado verificado");
    assert.ok(
      inspectorFlat.includes("El bloque se agrega solo cuando hay datos materiales que citar: no se crean secciones vacías"),
      "no se crean secciones vacías",
    );
  });

  it("conserva los modos de operación y la prohibición de escribir", () => {
    assert.ok(inspector.includes("**Normal**"), "falta el modo normal");
    assert.ok(inspector.includes("**Evolution Mode**"), "falta el modo de evolución");
    assert.ok(
      inspectorFlat.includes("Nunca modifiques ningún archivo en ningún modo"),
      "falta la prohibición de escribir",
    );
  });

  it("declara las restricciones de evidencia en la respuesta", () => {
    assert.ok(
      inspectorFlat.includes("NUNCA presentes un dato material no verificado como hecho"),
      "falta la restricción del dato no verificado",
    );
    assert.ok(
      inspectorFlat.includes("La evidencia heredada no se re-verifica por rutina"),
      "falta la restricción de no re-verificar",
    );
  });
});

const CONSTRUCTOR = ".flowtask/agents/constructor.md";
const constructor = read(CONSTRUCTOR);
const constructorFlat = flat(constructor);

describe("constructor evidence contract", () => {
  it("agrega la verificación y herencia de evidencia entre la búsqueda y la lectura", () => {
    const search = constructor.indexOf("### Paso 2 — búsqueda proactiva de contexto");
    const evidence = constructor.indexOf("## Verificación y herencia de evidencia");
    const files = constructor.indexOf("### Paso 3 — Leer archivos del plan");
    assert.ok(search >= 0, "falta el paso de búsqueda");
    assert.ok(evidence > search, "la evidencia va después de la búsqueda");
    assert.ok(files > evidence, "la evidencia va antes de leer los archivos del plan");
  });

  it("hereda la evidencia publicada y no re-verifica por rutina", () => {
    assert.ok(constructorFlat.includes("hereda"), "falta la herencia");
    assert.ok(
      constructorFlat.includes("no re-verifica por rutina lo que ya está verificado"),
      "falta la no re-verificación rutinaria",
    );
    assert.ok(constructorFlat.includes("VR-*"), "falta la cita de los registros");
  });

  it("verifica solo el dato nuevo material", () => {
    for (const token of [
      "el alcance real del trabajo en el destino",
      "un requisito del CA que el plan no cubrió",
      "el estado actual del destino donde se implementa",
      "la lista vigente de archivos protegidos",
      "una convención que el plan dejó sin resolver",
    ]) {
      assert.ok(constructorFlat.includes(token), `falta ${token}`);
    }
    assert.ok(
      constructorFlat.includes("Verifica solo el dato nuevo material"),
      "falta el alcance acotado de la verificación",
    );
  });

  it("pausa ante contradicción y ante dato material no confirmado", () => {
    assert.ok(constructorFlat.includes("discrepant"), "falta el estado discrepante");
    assert.ok(
      constructorFlat.includes("no se impone el cambio de alcance y se pausa"),
      "la contradicción no impone alcance",
    );
    assert.ok(
      constructorFlat.includes("Un dato material que no se puede confirmar **pausa**: no se implementa sobre él"),
      "el dato material no confirmado pausa",
    );
  });

  it("mapea la pausa por dato material a los motivos vigentes", () => {
    const pause = constructor.slice(constructor.indexOf("### Pausa por excepción"));
    for (const reason of ["authority_block", "progress_unavailable", "no_verifiable_progress"]) {
      assert.ok(pause.includes(reason), `falta el motivo ${reason}`);
    }
    assert.ok(pause.includes("| Motivo |"), "falta la tabla de motivos");
    assert.ok(pause.includes("dato material no confirmado"), "falta la causa del dato no confirmado");
    assertNoNewPauseReason(constructor);
  });

  it("conserva la prohibición de decidir diseño y el manejo de conflicto", () => {
    assert.ok(
      constructorFlat.includes("NUNCA tomes decisiones de diseño"),
      "falta la prohibición de decidir diseño",
    );
    assert.ok(
      constructorFlat.includes("no pierdas el worktree"),
      "falta la conservación del worktree en conflicto",
    );
  });

  it("declara las reglas de verificación y herencia en las restricciones", () => {
    assert.ok(
      constructorFlat.includes("NUNCA re-verifiques por rutina"),
      "falta la restricción de no re-verificar",
    );
    assert.ok(
      constructorFlat.includes("NUNCA implementes** sobre un dato material no confirmado"),
      "falta la restricción de no implementar sobre dato no confirmado",
    );
  });
});

const VALIDATOR = ".flowtask/agents/validator.md";
const VALIDATION_CONTRACT = ".flowtask/skills/validation-contract/SKILL.md";
const validator = read(VALIDATOR);
const validatorFlat = flat(validator);
const validationContract = read(VALIDATION_CONTRACT);
const validationContractFlat = flat(validationContract);

describe("validation evidence contract", () => {
  it("agrega la verificación y herencia de evidencia en el validator", () => {
    const invocation = validator.indexOf("## Invocación por ronda y alcance declarado");
    const evidence = validator.indexOf("## Verificación y herencia de evidencia");
    const search = validator.indexOf("### Paso 2 — búsqueda proactiva de contexto");
    assert.ok(invocation >= 0, "falta la invocación por ronda");
    assert.ok(evidence > invocation, "la evidencia va después de la invocación");
    assert.ok(search > evidence, "la evidencia va antes de la búsqueda");
  });

  it("hereda la evidencia y no repite comprobaciones veredictadas", () => {
    assert.ok(validatorFlat.includes("no repite comprobaciones ya veredictadas"), "falta la no repetición");
    assert.ok(/no se re-verifica por rutina/i.test(validatorFlat), "falta la no re-verificación rutinaria");
    assert.ok(validatorFlat.includes("VR-*"), "falta la cita de los registros");
  });

  it("verifica solo el dato nuevo material", () => {
    for (const token of [
      "el alcance real de la implementación validada",
      "el worktree o destino donde vive la implementación",
      "el estado actual de la implementación",
      "un criterio de aceptación que las rondas anteriores no cubrieron",
    ]) {
      assert.ok(validatorFlat.includes(token), `falta ${token}`);
    }
  });

  it("distingue la contradicción del fallo operativo", () => {
    assert.ok(
      validatorFlat.includes("bloquea el veredicto favorable y no impone un cambio de alcance"),
      "la contradicción bloquea el veredicto favorable",
    );
    assert.ok(
      validatorFlat.includes("produce `OPERATIONAL_FAILURE`: no es un rechazo funcional"),
      "el dato no confirmable es fallo operativo",
    );
  });

  it("documenta la herencia y la contradicción en el contrato ejecutable", () => {
    assert.ok(
      validationContract.includes("## Herencia de evidencia y contradicción"),
      "falta la sección de herencia del contrato",
    );
    const reuse = validationContract.indexOf("## Reutilización por la ronda siguiente");
    const inheritance = validationContract.indexOf("## Herencia de evidencia y contradicción");
    assert.ok(inheritance > reuse, "la herencia va después de la reutilización");
    assert.ok(
      validationContractFlat.includes("con su fuente y su momento de observación"),
      "la herencia conserva fuente y momento",
    );
    assert.ok(
      validationContractFlat.includes("se re-observa solo cuando la decisión depende de su valor actual"),
      "falta la regla del estado mutable",
    );
    assert.ok(
      validationContractFlat.includes("`operational_failure`, nunca `rejected`"),
      "el dato no confirmable no es rechazo",
    );
    assert.ok(
      /el esquema de evidencia, la precedencia del veredicto y los códigos/i.test(validationContractFlat),
      "el contrato declara que no cambia su esquema",
    );
  });

  it("conserva los cuatro códigos y la precedencia del veredicto", () => {
    for (const code of ["| 0 | Aprobado", "| 1 | Rechazo funcional", "| 2 | Fallo operativo", "| 3 | Contrato inválido"]) {
      assert.ok(validationContract.includes(code), `falta el código ${code}`);
    }
    const rejected = validationContractFlat.indexOf("`rejected`");
    const failure = validationContractFlat.indexOf("`operational_failure`");
    const approved = validationContractFlat.indexOf("`approved`");
    assert.ok(rejected < failure && failure < approved, "la precedencia del veredicto se conserva");
  });
});

const runner = readComposedRunner({ root: ROOT });
const runnerFlat = flat(runner);

describe("runner evidence contract", () => {
  it("carga el protocolo en las skills disponibles", () => {
    assert.ok(runner.includes('skill({ name: "zero-assumptions" })'), "falta la carga del protocolo");
    const investigation = runner.indexOf('skill({ name: "investigacion" })');
    const protocol = runner.indexOf('skill({ name: "zero-assumptions" })');
    assert.ok(protocol > investigation, "el protocolo se carga después de la investigación");
  });

  it("agrega la verificación material entre la inferencia y las restricciones", () => {
    const inference = runner.indexOf("## Inferencia adaptativa");
    const verification = runner.indexOf("## Verificación material");
    const restrictions = runner.indexOf("## Restricciones absolutas");
    assert.ok(inference >= 0, "falta la inferencia adaptativa");
    assert.ok(verification > inference, "la verificación va después de la inferencia");
    assert.ok(restrictions > verification, "la verificación va antes de las restricciones");
  });

  it("verifica en el orden vigente y cita fuente y estado", () => {
    assert.ok(
      runnerFlat.includes("memoria del proyecto → documentación, código y estado del repositorio → persona"),
      "falta el orden de verificación",
    );
    assert.ok(runnerFlat.includes("El grafo y la búsqueda normal instrumentan el segundo paso"), "falta la instrumentación");
    assert.ok(runnerFlat.includes("memoria del proyecto se consulta primero"), "falta la prioridad de la memoria");
    assert.ok(runnerFlat.includes("`verified`, `unverified` o `discrepant`"), "falta el enum de estado");
    assert.ok(
      runnerFlat.includes("informa la discrepancia con ambas fuentes"),
      "la discrepancia se informa con ambas fuentes",
    );
    assert.ok(
      runnerFlat.includes("no es una espera rutinaria ni una segunda confirmación"),
      "la verificación no es una espera rutinaria",
    );
  });

  it("pasa y reutiliza las referencias de evidencia", () => {
    assert.ok(
      runnerFlat.includes("Al delegar, pasa las referencias de evidencia ya resueltas"),
      "la delegación pasa la evidencia",
    );
    assert.ok(
      runnerFlat.includes("Al reanudar, reutiliza esa evidencia en lugar de repetir la verificación"),
      "la reanudación reutiliza la evidencia",
    );
  });

  it("prohíbe presentar un dato material no verificado como hecho", () => {
    assert.ok(
      runnerFlat.includes("NUNCA presentes un dato material no verificado como hecho ni avances sobre una suposición material"),
      "falta la restricción absoluta",
    );
  });

  it("agrega el criterio de evidencia material al Gate", () => {
    const gateStart = runner.indexOf("## Gate de Ejecución");
    assert.ok(gateStart >= 0, "falta la sección del Gate");
    const gateEnd = runner.indexOf("\n## ", gateStart + 1);
    const gate = runner.slice(gateStart, gateEnd === -1 ? undefined : gateEnd);
    assert.ok(gate.includes("4. **Evidencia material del plan**"), "falta el criterio 4 del Gate");
    assert.ok(gate.includes("sección de evidencia verificada"), "falta la sección exigida");
    assert.ok(gate.includes("`unverified` o `discrepant` queda fuera de `pending_decisions` o de `blockers`"), "falta la condición de estado");
    assert.ok(
      gate.includes("Verificar la evidencia material del plan"),
      "falta el paso del procedimiento",
    );
    assert.ok(
      gate.includes("evidencia material ausente o incompleta"),
      "falta la condición del FAIL",
    );
    assert.ok(
      gate.includes("Los registros de evidencia material verificados (`VR-*`) del plan se incluyen en `evidence_refs`"),
      "falta el registro de la evidencia en la PolicyDecision",
    );
  });

  it("conserva la transición automática y el FAIL de una sola línea", () => {
    assert.ok(runnerFlat.includes("sin espera intermedia"), "falta la transición sin espera");
    assert.ok(
      runnerFlat.includes("No se crea worktree, no se abre ejecución y no se invoca el Constructor ni el Validator"),
      "falta la condición del FAIL",
    );
  });

  it("amplía el contrato de delegación con las referencias de evidencia", () => {
    assert.ok(
      runnerFlat.includes("incluidas las referencias de evidencia ya resueltas (`VR-*` o la sección de evidencia verificada)"),
      "falta la categoría 2 ampliada",
    );
  });
});

const AGENT_LOOP_RUN = ".flowtask/skills/agent-loop-run/SKILL.md";
const AGENT_LOOP_INVARIANTS = ".flowtask/skills/agent-loop-invariants/SKILL.md";
const agentLoopRun = read(AGENT_LOOP_RUN);
const agentLoopRunFlat = flat(agentLoopRun);
const agentLoopInvariants = read(AGENT_LOOP_INVARIANTS);
const agentLoopInvariantsFlat = flat(agentLoopInvariants);

describe("control loop evidence contract", () => {
  it("distingue la evidencia material en la autonomía por política", () => {
    assert.ok(
      agentLoopRunFlat.includes("La evidencia material distingue lo verificado de lo no verificado"),
      "falta la distinción de evidencia material",
    );
    assert.ok(
      agentLoopRunFlat.includes("`verified: false` no respalda un avance material ni un cierre"),
      "el dato no verificado no habilita avance ni cierre",
    );
    assert.ok(
      agentLoopRunFlat.includes("como máximo habilita una pausa"),
      "el dato no verificado habilita como máximo una pausa",
    );
    assert.ok(
      agentLoopRunFlat.includes("cita la fuente concreta y no presenta un dato no verificado como hecho"),
      "la decisión material cita la fuente",
    );
  });

  it("reutiliza la evidencia material en la reanudación", () => {
    assert.ok(
      agentLoopRunFlat.includes("La reanudación reutiliza la evidencia material verificada"),
      "falta la herencia en la reanudación",
    );
    assert.ok(
      agentLoopRunFlat.includes("Si un dato material sigue sin confirmarse, la pausa se mantiene y la ronda siguiente no se despacha"),
      "el dato sin confirmar mantiene la pausa",
    );
  });

  it("no altera el conteo de garantías ni de criterios de aceptación", () => {
    assert.ok(agentLoopRun.includes("28. **La autonomía no concede permisos.**"), "falta la garantía 28");
    assert.doesNotMatch(agentLoopRun, /AC-34/, "no se agrega la fila AC-34");
    assert.doesNotMatch(agentLoopRun, /29\. \*\*.*\*/, "no se agrega la garantía 29");
  });

  it("agrega la evidencia material y herencia como subsección de INV-4", () => {
    assert.ok(
      agentLoopInvariants.includes("### Evidencia material y herencia"),
      "falta la subsección de evidencia material",
    );
    const evidence = agentLoopInvariants.indexOf("## Evidencia requerida por invariante");
    const inheritance = agentLoopInvariants.indexOf("### Evidencia material y herencia");
    const next = agentLoopInvariants.indexOf("## Lista de lo protegido");
    assert.ok(inheritance > evidence && next > inheritance, "la subsección va dentro de la evidencia por invariante");
  });

  it("declara el estado de la referencia y su efecto sobre la ronda", () => {
    for (const token of ["verified", "unverified", "discrepant"]) {
      assert.ok(agentLoopInvariantsFlat.includes(`\`${token}\``), `falta el estado ${token}`);
    }
    assert.ok(
      agentLoopInvariantsFlat.includes("No respalda un avance material y la ronda no se confirma"),
      "el estado no verificado no confirma la ronda",
    );
    assert.ok(
      agentLoopInvariantsFlat.includes("Exige las dos fuentes en conflicto y no confirma la ronda"),
      "el estado discrepante exige ambas fuentes",
    );
  });

  it("establece la herencia y el estado mutable en los invariantes", () => {
    assert.ok(
      agentLoopInvariantsFlat.includes("no se re-verifica por rutina"),
      "falta la no re-verificación rutinaria",
    );
    assert.ok(
      agentLoopInvariantsFlat.includes("se re-observa solo cuando la decisión depende de su valor actual"),
      "falta la regla del estado mutable",
    );
    assert.ok(
      agentLoopInvariantsFlat.includes("Una contradicción no confirma la ronda hasta que la autoridad la resuelve"),
      "la contradicción no confirma la ronda",
    );
  });

  it("conserva el catálogo, su versión y los cinco invariantes", () => {
    assert.ok(agentLoopInvariants.includes("`catalog_version: 1`"), "falta la versión del catálogo");
    for (const code of ["INV-1", "INV-2", "INV-3", "INV-4", "INV-5"]) {
      assert.ok(agentLoopInvariants.includes(code), `falta ${code}`);
    }
    const h2 = agentLoopInvariants.split("\n").filter((line) => line.startsWith("## "));
    assert.equal(h2.length, 16, "la cantidad de secciones H2 se mantiene");
    assert.ok(
      agentLoopInvariantsFlat.includes("Esta aclaración no redefine INV-4"),
      "la aclaración no redefine el invariante",
    );
  });
});

const VERIFICATION_DOC = "docs/architecture/material-verification.md";
const verificationDoc = read(VERIFICATION_DOC);
const verificationDocFlat = flat(verificationDoc);
const autonomyDoc = read("docs/architecture/operational-autonomy.md");

describe("verification material documentation", () => {
  it("publica la página de verificación material", () => {
    assert.ok(exists(VERIFICATION_DOC), "falta la página de verificación material");
    assert.ok(
      verificationDoc.startsWith("# Material verification and citable evidence"),
      "falta el título de la página",
    );
  });

  it("declara las secciones de la página", () => {
    for (const section of [
      "## Purpose",
      "## Verification order",
      "## Evidence record",
      "## Uncertainty and discrepancy",
      "## Scope by role",
      "## Evidence inheritance",
      "## Pause and resumption",
      "## Limits",
      "## Verification",
    ]) {
      assert.ok(verificationDoc.includes(section), `falta la sección ${section}`);
    }
  });

  it("describe los tres pasos, el registro y los estados", () => {
    assert.ok(verificationDocFlat.includes("Project memory"), "falta el primer paso");
    assert.ok(
      verificationDocFlat.includes("Documentation, code, and repository state"),
      "falta el segundo paso",
    );
    assert.ok(verificationDocFlat.includes("The person"), "falta el tercer paso");
    assert.ok(
      verificationDocFlat.includes("the absence of a source confirms nothing"),
      "falta la consecuencia de la fuente ausente",
    );
    for (const field of ["schema", "id", "datum", "materiality", "source_kind", "source_ref", "status", "observed_at"]) {
      assert.ok(verificationDoc.includes(`\`${field}\``), `falta el campo ${field}`);
    }
    for (const state of ["verified", "unverified", "discrepant"]) {
      assert.ok(verificationDocFlat.includes(`\`${state}\``), `falta el estado ${state}`);
    }
  });

  it("documenta el alcance por rol, la herencia y la pausa", () => {
    assert.ok(verificationDocFlat.includes("Writes, plans, and explores"), "falta el rol de análisis");
    assert.ok(verificationDocFlat.includes("Builds and validates"), "falta el rol de ejecución");
    assert.ok(verificationDocFlat.includes("Orchestrates"), "falta el rol de orquestación");
    assert.ok(
      verificationDocFlat.includes("is not re-verified by routine"),
      "falta la herencia sin re-verificación",
    );
    assert.ok(verificationDocFlat.includes("⏸ Pause by exception: {reason}"), "falta el mensaje de pausa");
    assert.ok(verificationDocFlat.includes("Preserved state:"), "falta el estado conservado");
    assert.ok(verificationDocFlat.includes("To resume:"), "falta la condición de reanudación");
  });

  it("declara los límites sin bloqueo automático ni namespace nuevo", () => {
    assert.ok(verificationDocFlat.includes("There is no automatic blocking"), "falta el límite de bloqueo");
    assert.ok(verificationDocFlat.includes("There is no confidence score"), "falta el límite de puntaje");
    assert.ok(verificationDocFlat.includes("There are no per-role switches"), "falta el límite de interruptores");
    assert.ok(
      verificationDocFlat.includes("There are no new namespaces"),
      "falta el límite de namespace",
    );
  });

  it("enlaza la página desde el índice y desde la página de validación", () => {
    assert.ok(flat(read("docs/architecture/INDEX.md")).includes("material-verification.md"), "falta el enlace del índice");
    assert.ok(
      flat(read("docs/architecture/validation.md")).includes("material-verification.md"),
      "falta el enlace de la página de validación",
    );
  });

  it("alinea el flujo principal con la evidencia verificada y el gate", () => {
    const coreFlow = flat(read("docs/core-flowtask.md"));
    assert.ok(coreFlow.includes("verified evidence"), "falta la evidencia verificada en el flujo");
    assert.ok(
      coreFlow.includes("no unverified material data"),
      "falta el criterio de evidencia material en el gate",
    );
  });

  it("corrige la afirmación sobre el contrato de validación", () => {
    assert.doesNotMatch(
      autonomyDoc,
      /The live validation contract is not modified/,
      "la página ya no afirma que el contrato de validación no se modifica",
    );
    assert.ok(
      flat(autonomyDoc).includes("The live validation contract keeps its schema and its verdict"),
      "falta la frase corregida",
    );
  });

  it("no publica identificadores concretos ni historia de implementación", () => {
    for (const document of [verificationDoc, flat(read("docs/architecture/validation.md"))]) {
      assert.doesNotMatch(document, /CA-[a-z0-9]/);
      assert.doesNotMatch(document, /HF-[a-z0-9]/);
      assert.doesNotMatch(document, /F2\.7/);
    }
  });
});

/**
 * Falla si un dato material sin verificar se presenta como hecho o no queda
 * convertido en decisión pendiente, blocker, pausa o exención periférica.
 */
function assertNoUnverifiedAsFact(content) {
  const sentences = flat(content)
    .split(/(?<=[.;:])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const UNVERIFIED = /unverified|no\s+verificad|no\s+confirmad|sin\s+confirmar/i;
  const SUBJECT = /dato|material|record|evidencia|referencia|datum/i;
  const DISPOSITIONS = [
    "pending_decision",
    "blocker",
    "decisión pendiente",
    "decisiones pendientes",
    "pausa",
    "pause",
    "no se presenta como hecho",
    "nunca",
    "ningún",
    "ninguno",
    "periféric",
    "peripheral",
    "[no verificado]",
    "no implementa",
    "no bloquea",
    "impide",
    "no habilita",
    "no se avanza",
    "no queda",
    "no figura",
    "never stays inside",
    "never used as the basis",
    "pregunta",
    "draft",
    "waiting_for_user",
    "sin bloquear",
  ];

  /** Unasentence que enuncia una prohibición ya dispone del dato. */
  const isProhibition = (sentence) =>
    /^(no|nunca|ning[uú]n|never|sin)\b/i.test(
      sentence.replace(/^[\s\-*#>•¿¡]+/, "").replace(/\*\*/g, "").trim(),
    );

  for (const sentence of sentences) {
    if (!UNVERIFIED.test(sentence)) continue;
    if (!SUBJECT.test(sentence)) continue;
    // Un encabezado con dos puntos introduce una lista: la disposición vive
    // en sus elementos, no en el encabezado.
    if (sentence.endsWith(":")) continue;
    const disposition =
      isProhibition(sentence) ||
      DISPOSITIONS.some((marker) => sentence.toLowerCase().includes(marker));
    assert.ok(
      disposition,
      `un dato material no verificado no queda en decisión pendiente: ${sentence}`,
    );
  }
}

const ROLE_SURFACES = [
  { file: ".flowtask/agents/ca-writer.md", section: "Verificación material" },
  { file: ".flowtask/agents/planner.md", section: "Verificación material" },
  { file: ".flowtask/agents/inspector.md", section: "Verificación material" },
  { file: ".flowtask/agents/constructor.md", section: "Verificación y herencia de evidencia" },
  { file: ".flowtask/agents/validator.md", section: "Verificación y herencia de evidencia" },
  { file: ".flowtask/agents/runner.md", section: "Verificación material" },
];

const EVIDENCE_TARGETS = [
  ".flowtask/skills/zero-assumptions/SKILL.md",
  ".flowtask/skills/plan-template/SKILL.md",
  ".flowtask/agents/planner.md",
  ".flowtask/agents/constructor.md",
  ".flowtask/agents/runner.md",
];

describe("cross-surface and regression guards", () => {
  it("no presenta un dato material no verificado como hecho en las superficies clave", () => {
    for (const target of EVIDENCE_TARGETS) {
      assertNoUnverifiedAsFact(read(target));
    }
    // El documento compuesto cubre las secciones movidas a los flujos.
    assertNoUnverifiedAsFact(runner);
  });

  it("no introduce un enum de motivo de pausa nuevo en las superficies clave", () => {
    for (const target of EVIDENCE_TARGETS) {
      assertNoNewPauseReason(read(target));
    }
    assertNoNewPauseReason(runner);
  });

  it("carga el protocolo y declara su sección en los seis contratos de rol", () => {
    for (const surface of ROLE_SURFACES) {
      const content = read(surface.file);
      assert.ok(
        content.includes("zero-assumptions"),
        `${surface.file} debe cargar el protocolo de verificación`,
      );
      assert.ok(
        content.includes(surface.section),
        `${surface.file} debe declarar la sección ${surface.section}`,
      );
    }
  });

  it("rechaza una copia que presenta un dato material no verificado como hecho", () => {
    const original = flat(zeroAssumptions);
    const mutated = original.replace(
      "no se presenta como hecho: se convierte en decisión pendiente o en pausa",
      "es un hecho verificado del proyecto",
    );
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertNoUnverifiedAsFact(mutated), /no verificado/i);
  });

  it("rechaza una copia que introduce un motivo de pausa nuevo", () => {
    const original = zeroAssumptions;
    const mutated = original.replace(
      "| Falta la decisión o la confirmación de la persona. | `authority_block` |",
      "| Falta la decisión o la confirmación de la persona. | `pause_reason_material` |",
    );
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertNoNewPauseReason(mutated), /motivo de pausa/);
  });

  it("rechaza una copia que quita la herencia de evidencia", () => {
    const original = zeroAssumptions;
    const mutated = original.replace("## Herencia de evidencia", "## Otra sección");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.equal(mutated.includes("## Herencia de evidencia"), false);
  });
});
