import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8");

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const CA_WRITER = ".flowtask/agents/ca-writer.md";
const CHECKPOINT_MIXIN = ".flowtask/skills/checkpoint-mixin/SKILL.md";
const MEMORY_CONTRACT = ".flowtask/skills/memory-contract/SKILL.md";
const RUNNER = ".flowtask/agents/runner.md";

const caWriter = read(CA_WRITER);
const caWriterFlat = flat(caWriter);
const checkpointMixin = flat(read(CHECKPOINT_MIXIN));
const memoryContract = flat(read(MEMORY_CONTRACT));
const runner = flat(read(RUNNER));

/**
 * Exige un único payload de continuidad firmado: la firma del tema y la
 * referencia de reanudación están presentes y la secuencia se incrementa.
 */
function assertSignedCheckpoint(content) {
  const flatContent = flat(content);
  assert.match(
    flatContent,
    /topic_signature\s*:/,
    "el payload de continuidad debe declarar la firma del tema",
  );
  assert.match(
    flatContent,
    /resume_ref\s*:/,
    "el payload de continuidad debe declarar la referencia de reanudación",
  );
  assert.ok(
    flatContent.includes("sequence: {anterior + 1}"),
    "la secuencia del checkpoint debe incrementarse sobre el previo",
  );
}

/**
 * Exige que el contrato no imponga una cuota mínima de tradeoffs.
 */
function assertNoTradeoffQuota(content) {
  assert.doesNotMatch(
    flat(content),
    /mínimo 2 tradeoffs|mínimo dos tradeoffs/i,
    "no puede existir una cuota mínima de tradeoffs",
  );
}

const RESPONSE_ENUMS = [
  "ca_created | ca_updated | blocked",
  "draft | complete",
  "NONE | artifact | checkpoint",
  "ready_for_planning | waiting_for_user | waiting_for_derivation",
];

const CRITERION_FIELDS = [
  "Condición",
  "Evento",
  "Resultado observable",
  "Cómo se observa",
  "Prohibido",
];

const AI_SLOP_PATTERNS = [
  "Alcance inflado",
  "Soporte de futuro especulativo",
  "Solución más elaborada",
  "Criterios vagos o circulares",
  "Adjetivos no verificables",
  "Requisitos inventados",
  "Blindaje de futuro",
  "Duplicación de requisitos",
  "Soluciones no pedidas",
];

describe("ca-writer checkpoint firmado y único", () => {
  it("declara la firma, la referencia de reanudación y la secuencia incremental", () => {
    assertSignedCheckpoint(caWriter);
    assertSignedCheckpoint(checkpointMixin);
  });

  it("no condiciona la carga del checkpoint a un porcentaje de contexto", () => {
    assert.doesNotMatch(
      caWriter,
      /contexto ≥ 70%/,
      "el checkpoint se carga al inicio, no por porcentaje de contexto",
    );
  });

  it("elimina el segundo payload narrativo bajo la clave de continuidad", () => {
    assert.doesNotMatch(
      caWriter,
      /What: CA creado/,
      "no puede existir un payload narrativo adicional bajo la clave de continuidad",
    );
    assert.ok(
      caWriterFlat.includes("Un `topic_key` admite un único payload"),
      "falta la regla de payload único",
    );
  });

  it("conserva la firma y la referencia en el payload de cierre", () => {
    const closing = caWriter.slice(caWriter.indexOf("Al completar la clarificación"));
    assertSignedCheckpoint(closing);
    assert.ok(
      closing.includes('state: "completed"'),
      "el cierre debe declarar el estado completed",
    );
    assert.ok(
      closing.includes('persistence: "artifact_confirmed"'),
      "el cierre debe declarar la persistencia confirmada del artifacto",
    );
  });

  it("declara el ciclo de vida del payload en el contrato de memoria", () => {
    assert.ok(
      memoryContract.includes("Un `topic_key` de continuidad admite un único payload"),
      "falta la unicidad del payload de continuidad",
    );
    assert.ok(
      memoryContract.includes("conserva `topic_signature` y `resume_ref`"),
      "falta la conservación de la firma y la referencia en el cierre",
    );
  });
});

describe("ca-writer máquina de estados y formato único", () => {
  it("no impone una cantidad mínima de tradeoffs", () => {
    assertNoTradeoffQuota(caWriter);
  });

  it("elimina la definición duplicada de los estados", () => {
    assert.doesNotMatch(
      caWriter,
      /sin la sección completa/,
      "no puede quedar la definición duplicada de los estados",
    );
    assert.ok(
      caWriterFlat.includes(
        "**draft**: el artifacto se guarda en Engram con todas las secciones presentes",
      ),
      "falta la regla única del estado draft",
    );
    assert.ok(
      caWriterFlat.includes(
        "**complete**: el artifacto se guarda en Engram con todas las secciones resueltas",
      ),
      "falta la regla única del estado complete",
    );
  });

  it("permite declarar la ausencia de tradeoffs materiales", () => {
    assert.ok(
      caWriterFlat.includes("No hay tradeoffs materiales en este alcance"),
      "falta la declaración de ausencia de tradeoffs materiales",
    );
  });

  it("marca lo pendiente en lugar de omitir secciones", () => {
    assert.ok(caWriterFlat.includes("[PENDIENTE:"), "falta el marcador de pendiente");
  });

  it("presenta las opciones con implicación, costo, descarte y recomendación", () => {
    assert.ok(caWriter.includes("## Opciones consideradas"), "falta la sección de opciones");
    for (const column of [
      "Implicación",
      "Costo asumido",
      "Dejaría de ser válida si",
      "Recomendación",
    ]) {
      assert.ok(caWriter.includes(column), `falta la columna ${column}`);
    }
    assert.ok(caWriterFlat.includes("O1"), "falta el identificador de opción");
  });

  it("separa los huecos fuera de alcance de las dudas que bloquean", () => {
    assert.ok(caWriter.includes("GAPs fuera de alcance (aceptados):"), "falta el grupo de huecos");
    assert.ok(caWriter.includes("Dudas que bloquean:"), "falta el grupo de dudas bloqueantes");
  });

  it("declara el valor por entorno solo cuando el comportamiento difiere", () => {
    assert.doesNotMatch(
      caWriter,
      /default desarrollo \/ default producción/,
      "no puede obligarse a declarar dos valores de entorno",
    );
    assert.ok(
      caWriterFlat.includes("único valor vigente"),
      "falta la regla del valor único vigente",
    );
  });

  it("incorpora la intención de investigación al catálogo", () => {
    assert.ok(caWriter.includes("**Investigación**"), "falta la intención Investigación");
  });
});

describe("ca-writer taxonomía anti-adorno y criterios observables", () => {
  it("cubre los nueve patrones de adorno", () => {
    for (const pattern of AI_SLOP_PATTERNS) {
      assert.ok(caWriter.includes(pattern), `falta el patrón ${pattern}`);
    }
  });

  it("registra lo rechazado con motivo y reemplazo", () => {
    assert.ok(caWriter.includes("| Patrón rechazado | Motivo | Decisión que lo reemplaza |"), "falta la tabla");
  });

  it("declara los cinco campos de cada criterio observable", () => {
    for (const field of CRITERION_FIELDS) {
      assert.ok(caWriter.includes(field), `falta el campo ${field}`);
    }
  });

  it("prohíbe los verbos vagos sin umbral observable", () => {
    const vagueness = caWriter.slice(caWriter.indexOf("**Verbos vagos**"));
    assert.ok(vagueness.includes("soportar"), "falta el ejemplo de verbo vago");
    assert.ok(vagueness.includes("condición y resultado medible"), "falta el umbral exigido");
  });

  it("prohíbe los criterios que solo se comprueban inspeccionando el interior", () => {
    assert.ok(
      caWriterFlat.includes("Criterios solo inspeccionables"),
      "falta la prohibición de criterios solo inspeccionables",
    );
  });
});

describe("ca-writer verificación, grafo y derivaciones", () => {
  it("consulta el grafo por la integración MCP y no por la CLI histórica", () => {
    assert.ok(caWriter.includes("graphify_query_graph"), "falta la vía MCP del grafo");
    assert.doesNotMatch(caWriter, /CLI actual/, "no puede describirse la CLI histórica");
  });

  it("conserva la frase literal de degradación", () => {
    assert.ok(
      caWriter.includes("no pude consultar el grafo, estoy usando búsqueda normal"),
      "falta la frase literal de degradación",
    );
  });

  it("mantiene los permisos sin ampliar", () => {
    assert.match(caWriter, /^ {3}bash: deny$/m);
    assert.match(caWriter, /^ {3}webfetch: deny$/m);
  });

  it("delega la verificación externa y la del estado del repositorio", () => {
    assert.doesNotMatch(
      caWriter,
      /Verificar con ferris-search/,
      "no puede instruirse la verificación externa desde el agente",
    );
    assert.ok(caWriterFlat.includes("derivations"), "falta el cauce de derivación");
    assert.ok(caWriterFlat.includes("waiting_for_derivation"), "falta el estado de espera por derivación");
  });

  it("declara el contrato de derivación con pregunta, alcance, referencias y huecos", () => {
    for (const token of [
      "kind: technical | external_verification | repository_state",
      "question:",
      "scope:",
      "evidence_refs:",
      "gaps:",
    ]) {
      assert.ok(caWriter.includes(token), `falta el token ${token}`);
    }
  });

  it("incorpora la respuesta derivada como registro de evidencia", () => {
    assert.ok(
      caWriterFlat.includes("se registra como un nuevo `VR-*` con su fuente y su estado"),
      "falta la incorporación de la respuesta derivada",
    );
  });

  it("prohíbe decidir diseño técnico", () => {
    assert.ok(
      caWriterFlat.includes("No se decide diseño técnico") ||
        caWriterFlat.includes("no decides diseño técnico") ||
        caWriterFlat.includes("Prohibido**: decidir arquitectura"),
      "falta la prohibición de decidir diseño técnico",
    );
  });

  it("expone la rama de derivaciones en el runner", () => {
    assert.ok(runner.includes("Paso 1.5 — Derivaciones del CA-Writer"), "falta la rama de derivaciones");
    assert.ok(runner.includes("evidence_refs"), "falta el pase de referencias al Inspector");
    assert.ok(
      runner.includes("El paso a planificación exige `derivations: []` y `ca_status: complete`"),
      "falta la condición de avance a planificación",
    );
  });
});

describe("ca-writer búsqueda de requisitos previos y vocabulario de respuesta", () => {
  it("consulta el contexto reciente antes de buscar requisitos previos", () => {
    const context = caWriter.indexOf("mem_context");
    const artifacts = caWriter.indexOf(
      'mem_search(query: "CA-{ID} {tipo}", type: "ca-artifact"',
    );
    assert.ok(context >= 0, "falta la consulta de contexto reciente");
    assert.ok(artifacts > context, "los requisitos previos se buscan después del contexto reciente");
  });

  it("busca los requisitos previos bajo demanda con propósito declarado", () => {
    assert.ok(caWriterFlat.includes("bajo demanda"), "falta la búsqueda bajo demanda");
    assert.ok(caWriterFlat.includes("propósito"), "falta el propósito declarado");
    assert.ok(caWriterFlat.includes("mem_get_observation"), "falta la recuperación del artifact relevante");
  });

  it("declara la fuente ausente y continúa cuando la vía no está disponible", () => {
    assert.ok(
      caWriterFlat.includes("la ausencia de fuente no confirma coherencia"),
      "falta la declaración de la fuente ausente",
    );
  });

  it("conserva los enums de respuesta que consume el runner", () => {
    for (const value of RESPONSE_ENUMS) {
      assert.ok(caWriter.includes(value), `falta el enum ${value}`);
    }
  });

  it("no usa el valor de estado del requisito en el campo de estado", () => {
    assert.doesNotMatch(caWriter, /state: complete/, "el campo de estado no toma el valor del requisito");
  });
});

describe("regresión de la guarda de contrato", () => {
  it("rechaza una copia sin firma de tema", () => {
    const mutated = caWriter.replace(/topic_signature:/g, "firma:");
    assert.notEqual(mutated, caWriter, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSignedCheckpoint(mutated), /firma del tema/);
  });

  it("rechaza una copia que reintroduce la cuota mínima de tradeoffs", () => {
    const mutated = `${caWriter}\n\nIdentifica mínimo 2 tradeoffs.\n`;
    assert.notEqual(mutated, caWriter, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertNoTradeoffQuota(mutated), /cuota mínima de tradeoffs/);
  });
});
