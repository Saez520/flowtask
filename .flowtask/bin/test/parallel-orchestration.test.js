/**
 * Contract test of the safe parallel orchestration skill.
 *
 * The skill is the surface that turns the orchestration policy into an
 * observable behavior: it decides which works advance together, it keeps the
 * batch bounded with a visible queue, it keeps identity and traces separate
 * and it contains a conflict with the codes already in force.
 *
 * The test is read-only: it reads the skill and asserts the clauses the flow
 * depends on. Every guarantee has a mutation that proves the assertion bites.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL_REL = ".flowtask/skills/parallel-orchestration/SKILL.md";
const CONFIG_EXAMPLE_REL = ".flowtask/config/parallel.json.example";
const CONFIG_README_REL = ".flowtask/config/README.md";
const ARCH_DOC_REL = "docs/architecture/parallel-orchestration.md";
const ARCH_INDEX_REL = "docs/architecture/INDEX.md";
const AUTONOMY_DOC_REL = "docs/architecture/operational-autonomy.md";

/** The sections of the architecture page. */
const ARCH_SECTIONS = [
  "## Purpose",
  "## Current support and boundary",
  "## Verifiable independence",
  "## Batch decision and queue",
  "## Bounded dispatch and join",
  "## Identity and traces",
  "## Conflict containment",
  "## Serialized integration",
  "## Inherited surfaces",
  "## References",
];

/** The contracts live in Markdown with arbitrary line breaks. */
const flat = (text) => text.replace(/\s+/g, " ");

function readSkill() {
  return fs.readFileSync(path.join(ROOT, SKILL_REL), "utf8");
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/** The thirteen sections of the contract, in contract order. */
const SECTION_ORDER = [
  "## Propósito",
  "## Alcance y fronteras",
  "## Términos",
  "## Independencia verificable",
  "## Decisión de lote y cola",
  "## Despacho paralelo acotado",
  "## Identidad y trazas separadas",
  "## Contención de conflictos",
  "## Superficies heredadas",
  "## Fallos, avisos y datos no verificables",
  "## Garantías del contrato",
  "## Matriz de aceptación",
  "## Ejemplos canónicos",
];

/** The four dimensions that make a batch parallel. */
const INDEPENDENCE_TOKENS = [
  "archivos previstos",
  "topic_key",
  "worktree",
  "rama",
  "dependencia",
  "superficies compartidas",
  "independencia no verificable",
];

/** The decision of the batch and the visible queue. */
const DECISION_TOKENS = [
  "maxParallel",
  "cola FIFO",
  "queue_position",
  "capacity",
  "parallel",
  "sequential_independence_unverifiable",
  "sequential_shared_surface",
  "sequential_dependency",
  "sequential_capacity_unset",
];

/** The bounded background dispatch. */
const DISPATCH_TOKENS = [
  "background: true",
  "sessionID",
  "no reutiliza",
  "join",
  "progress_unavailable",
];

/** The containment of a conflict with the codes already in force. */
const CONTENTION_TOKENS = [
  "resource_locked",
  "concurrent_write_suspected",
  "no sobrescribe",
  "no reintenta a ciegas",
  "no inventa identificadores",
  "condición de reanudación",
];

/** The inherited surfaces that the batch consults and never redefines. */
const INHERITANCE_TOKENS = [
  "agent-loop-progress",
  "agent-loop-termination",
  "agent-loop-idempotency",
  "agent-loop-budget",
  "agent-loop-run",
  "checkpoint-mixin",
  "context-degradation",
  "pruebas condicionales",
  "no se redefine",
];

/** The coordination identifiers that never reach a functional artifact. */
const COORDINATION_IDENTIFIERS = [
  "CA-parallel-orchestration",
  "F2.9",
  "#9562",
  "Hermes",
  "1.26.0",
];

/** The guarantees of the contract. */
const GUARANTEE_IDS = Array.from({ length: 12 }, (_, index) =>
  `G-${String(index + 1).padStart(2, "0")}`,
);
const ACCEPTANCE_IDS = Array.from({ length: 10 }, (_, index) =>
  `AC-${String(index + 1).padStart(2, "0")}`,
);
const EXAMPLE_IDS = Array.from({ length: 8 }, (_, index) =>
  `E-${String(index + 1).padStart(2, "0")}`,
);

function assertFrontmatter(content) {
  const head = content.split(/\r?\n/).slice(0, 20).join("\n");
  assert.match(head, /^name:\s*parallel-orchestration$/m, "falta el nombre de la skill");
  assert.match(head, /^license:\s*MIT$/m, "falta la licencia");
  assert.match(head, /^compatibility:\s*opencode$/m, "falta la compatibilidad");
  assert.match(head, /category:\s*agent-loop/, "falta la categoría");
  assert.match(head, /scope:\s*flowtask/, "falta el scope");
  assert.ok(
    head.includes("Contrato de orquestación paralela segura"),
    "falta la descripción de la skill",
  );
}

function assertSectionOrder(content) {
  let previous = -1;
  for (const section of SECTION_ORDER) {
    const index = content.indexOf(section);
    assert.ok(index !== -1, `falta la sección ${section}`);
    assert.ok(index > previous, `la sección ${section} debe ir en orden de contrato`);
    previous = index;
  }
  const headings = content.split(/\r?\n/).filter((line) => line.startsWith("## "));
  assert.equal(headings.length, SECTION_ORDER.length, "la cantidad de secciones H2 se mantiene");
}

function assertTokens(content, tokens, label) {
  const flatContent = flat(content);
  for (const token of tokens) {
    assert.ok(flatContent.includes(token), `falta ${token} en ${label}`);
  }
}

function assertAcceptanceMatrix(content) {
  const flatContent = flat(content);
  for (const id of [...GUARANTEE_IDS, ...ACCEPTANCE_IDS, ...EXAMPLE_IDS]) {
    assert.ok(flatContent.includes(id), `falta ${id}`);
  }
}

function assertNoCoordinationIdentifiers(content) {
  for (const identifier of COORDINATION_IDENTIFIERS) {
    assert.equal(
      content.includes(identifier),
      false,
      `la skill no debe publicar ${identifier}`,
    );
  }
}

/** The complete contract of the skill, applied to any copy. */
function assertSkillContract(content) {
  assertFrontmatter(content);
  assertSectionOrder(content);
  assertTokens(content, INDEPENDENCE_TOKENS, "la independencia verificable");
  assertTokens(content, DECISION_TOKENS, "la decisión de lote y la cola");
  assertTokens(content, DISPATCH_TOKENS, "el despacho paralelo acotado");
  assertTokens(content, CONTENTION_TOKENS, "la contención de conflictos");
  assertTokens(content, INHERITANCE_TOKENS, "las superficies heredadas");
  assertAcceptanceMatrix(content);
  assertNoCoordinationIdentifiers(content);
}

describe("parallel orchestration skill contract", () => {
  const content = readSkill();

  it("publishes the skill with its frontmatter", () => {
    assert.equal(fs.existsSync(path.join(ROOT, SKILL_REL)), true);
    assertFrontmatter(content);
  });

  it("declares the thirteen sections in contract order", () => {
    assertSectionOrder(content);
  });

  it("declares the four dimensions of verifiable independence", () => {
    assertTokens(content, INDEPENDENCE_TOKENS, "la independencia verificable");
  });

  it("declares the batch decision and the visible queue", () => {
    assertTokens(content, DECISION_TOKENS, "la decisión de lote y la cola");
  });

  it("declares the bounded background dispatch and the join", () => {
    assertTokens(content, DISPATCH_TOKENS, "el despacho paralelo acotado");
  });

  it("contains the conflicts with the codes already in force", () => {
    assertTokens(content, CONTENTION_TOKENS, "la contención de conflictos");
  });

  it("consults the inherited surfaces without redefining them", () => {
    assertTokens(content, INHERITANCE_TOKENS, "las superficies heredadas");
  });

  it("publishes the guarantees, the acceptance matrix and the canonical examples", () => {
    assertAcceptanceMatrix(content);
  });

  it("publishes no coordination identifier", () => {
    assertNoCoordinationIdentifiers(content);
  });
});

describe("parallel orchestration configuration contract", () => {
  it("publishes the example without an active capacity", () => {
    assert.equal(fs.existsSync(path.join(ROOT, CONFIG_EXAMPLE_REL)), true);
    const example = JSON.parse(read(CONFIG_EXAMPLE_REL));
    assert.equal(example.maxParallel, null, "el ejemplo no declara una capacidad activa");
    assert.deepEqual(Object.keys(example), ["maxParallel"], "el ejemplo declara solo maxParallel");
  });

  it("does not ship an active capacity file", () => {
    assert.equal(
      fs.existsSync(path.join(ROOT, ".flowtask/config/parallel.json")),
      false,
      "el proyecto no declara una capacidad activa por defecto",
    );
  });

  it("documents the capacity, the conservative degradation and the visible queue", () => {
    const readme = flat(read(CONFIG_README_REL));
    assert.ok(readme.includes("Parallel orchestration"), "falta la sección de la configuración");
    for (const token of [
      "maxParallel",
      "without a declared default value",
      "sequential",
      "FIFO queue",
      "Serialized integration",
    ]) {
      assert.ok(readme.includes(token), `el README de configuración debe declarar ${token}`);
    }
  });
});

describe("parallel orchestration documentation contract", () => {
  it("publishes the architecture page with its sections", () => {
    assert.equal(fs.existsSync(path.join(ROOT, ARCH_DOC_REL)), true);
    const doc = read(ARCH_DOC_REL);
    assert.ok(doc.startsWith("# Safe parallel orchestration"), "falta el título de la página");
    for (const section of ARCH_SECTIONS) {
      assert.ok(doc.includes(section), `falta la sección ${section}`);
    }
  });

  it("describes the current support, the boundary and the inherited surfaces", () => {
    const doc = flat(read(ARCH_DOC_REL));
    for (const token of [
      "Background dispatch exists",
      "There is no parallel engine",
      "lifecycle authority",
      "Planned files",
      "topic_key",
      "worktree",
      "maxParallel",
      "FIFO queue",
      "background: true",
      "sessionID",
      "resource_locked",
      "concurrent_write_suspected",
      "do not overwrite",
      "do not blindly retry",
      "do not invent identifiers",
      "agent-loop-progress",
      "checkpoint-mixin",
      "context-degradation",
      "conditional test gate",
    ]) {
      assert.ok(doc.includes(token), `la página de arquitectura debe declarar ${token}`);
    }
  });

  it("links the page from the architecture index", () => {
    const index = read(ARCH_INDEX_REL);
    assert.ok(index.includes("parallel-orchestration.md"), "falta el enlace del índice");
  });

  it("declares in the autonomy page that the bounded parallelism relaxes no control", () => {
    const autonomy = flat(read(AUTONOMY_DOC_REL));
    assert.ok(
      autonomy.includes("Bounded parallelism does not relax"),
      "la página de autonomía debe declarar que el paralelismo no relaja los controles",
    );
    assert.ok(
      autonomy.includes("integration is serialized"),
      "la página de autonomía debe declarar la integración serializada",
    );
  });

  it("publishes no coordination identifier in the new documentation", () => {
    const doc = read(ARCH_DOC_REL);
    for (const identifier of COORDINATION_IDENTIFIERS) {
      assert.equal(
        doc.includes(identifier),
        false,
        `la página de arquitectura no debe publicar ${identifier}`,
      );
    }
  });
});

describe("parallel orchestration skill mutations", () => {
  const original = readSkill();

  it("rejects a copy that drops the declared capacity", () => {
    const mutated = original.replaceAll("maxParallel", "capacityLimit");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSkillContract(mutated), /maxParallel/);
  });

  it("rejects a copy that drops the occupied lock code", () => {
    const mutated = original.replaceAll("resource_locked", "lock_contended");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSkillContract(mutated), /resource_locked/);
  });

  it("rejects a copy that drops the no-overwrite rule", () => {
    const mutated = original.replaceAll("no sobrescribe", "sobrescribe");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSkillContract(mutated), /no sobrescribe/);
  });

  it("rejects a copy that publishes the execution identifier", () => {
    const mutated = `${original}\n\nCA-parallel-orchestration\n`;
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSkillContract(mutated), /CA-parallel-orchestration/);
  });
});
