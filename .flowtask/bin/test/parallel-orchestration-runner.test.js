/**
 * Contract test of the runner wiring for the safe parallel orchestration.
 *
 * The runner is the surface that turns the orchestration policy into an
 * observable behavior: it loads the skill, it decides the batch before the
 * first dispatch, it keeps the queue visible, it serializes the integration
 * and it contains a conflict with the codes already in force.
 *
 * The test is read-only: it reads the agent document and asserts the clauses
 * the flow depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RUNNER_REL = ".flowtask/agents/runner.md";
const AGENT_REL = ".flowtask/agents/parallel-orchestration.md";

const PARALLEL_HEADING = "## Orquestación paralela segura";
const LOOP_HEADING = "## Control del Agent Loop";
const CONTEXT_HEADING = "## Contexto: reglas por momento y recuperación";
const CANONICAL_HEADING = "### Formato canónico de `subagent()` (fuente única de verdad)";

/** The seven subsections of the orchestration section, in contract order. */
const SUBSECTIONS = [
  "### Cuándo se evalúa",
  "### Decisión de lote",
  "### Despacho y join",
  "### Cola y capacidad",
  "### Contención de conflictos",
  "### Integración serializada",
  "### Herencia de superficies",
];

/** The clauses the orchestration section must declare. */
const SECTION_TOKENS = [
  "archivos previstos",
  "topic_key",
  "worktree",
  "rama",
  "dependencia",
  "superficies compartidas",
  "independencia no verificable",
  "maxParallel",
  "cola FIFO",
  "background: true",
  "sessionID",
  "no reutiliza",
  "resource_locked",
  "concurrent_write_suspected",
  "no sobrescribe",
  "no reintenta a ciegas",
  "no inventa identificadores",
  "condición de reanudación",
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

/** The clauses the runner document must declare wherever they belong. */
const DOCUMENT_TOKENS = [
  ...SECTION_TOKENS,
  "dos integraciones",
  "lote como completado",
];

/** The coordination identifiers that never reach a functional artifact. */
const COORDINATION_IDENTIFIERS = [
  "CA-parallel-orchestration",
  "F2.9",
  "#9562",
  "1.26.0",
];

/** The reserved dev-only core layer name, pre-existing in the identity block. */
const RESERVED_LAYER_NAME = "Hermes";

const flat = (text) => text.replace(/\s+/g, " ");

function readRunner() {
  return fs.readFileSync(path.join(ROOT, RUNNER_REL), "utf8");
}

/** The orchestration section, from its heading up to the context section. */
function extractParallelSection(content) {
  const start = content.indexOf(PARALLEL_HEADING);
  assert.ok(start !== -1, `runner.md must contain the section ${PARALLEL_HEADING}`);
  const end = content.indexOf(CONTEXT_HEADING, start);
  assert.ok(end !== -1, `runner.md must contain the section ${CONTEXT_HEADING}`);
  return content.slice(start, end);
}

/** The canonical dispatch block, from its heading up to the next section. */
function extractCanonicalBlock(content) {
  const start = content.indexOf(CANONICAL_HEADING);
  assert.ok(start !== -1, `runner.md must contain the section ${CANONICAL_HEADING}`);
  const end = content.indexOf("## Paso 0", start);
  assert.ok(end !== -1, "runner.md must contain the Paso 0 section");
  return content.slice(start, end);
}

function assertSkillIsLoaded(content) {
  assert.ok(
    content.includes('skill({ name: "parallel-orchestration" })'),
    "the runner must load the orchestration skill",
  );
}

function assertSectionExists(content) {
  assert.ok(content.includes(PARALLEL_HEADING), "missing the orchestration section");
}

function assertSubsectionsInOrder(content) {
  let previous = -1;
  for (const subsection of SUBSECTIONS) {
    const index = content.indexOf(subsection);
    assert.ok(index !== -1, `missing the subsection ${subsection}`);
    assert.ok(index > previous, `the subsection ${subsection} must be in contract order`);
    previous = index;
  }
}

function assertSectionPlacement(content) {
  const loop = content.indexOf(LOOP_HEADING);
  const parallel = content.indexOf(PARALLEL_HEADING);
  const context = content.indexOf(CONTEXT_HEADING);
  assert.ok(loop !== -1 && parallel !== -1 && context !== -1);
  assert.ok(loop < parallel, "the orchestration section must follow the loop control");
  assert.ok(parallel < context, "the orchestration section must precede the context section");
}

function assertSectionTokens(content) {
  const section = flat(extractParallelSection(content));
  for (const token of SECTION_TOKENS) {
    assert.ok(section.includes(token), `the orchestration section must declare ${token}`);
  }
}

function assertDocumentTokens(content) {
  const document = flat(content);
  for (const token of DOCUMENT_TOKENS) {
    assert.ok(document.includes(token), `runner.md must declare ${token}`);
  }
}

function assertBackgroundDispatch(content) {
  const block = extractCanonicalBlock(content);
  assert.ok(
    block.includes("background: true"),
    "the canonical block must declare the background dispatch with background: true",
  );
  assert.ok(
    block.includes("El `background` no cambia la identidad, el handshake, el checkpoint"),
    "the canonical block must declare that the background changes only the wait",
  );
}

function assertNoAgentCreated() {
  assert.equal(
    fs.existsSync(path.join(ROOT, AGENT_REL)),
    false,
    "the orchestration policy does not create a role agent",
  );
}

function assertNoCoordinationIdentifiers(content) {
  for (const identifier of COORDINATION_IDENTIFIERS) {
    assert.equal(
      content.includes(identifier),
      false,
      `runner.md must not publish ${identifier}`,
    );
  }
  assert.equal(
    flat(extractParallelSection(content)).includes(RESERVED_LAYER_NAME),
    false,
    `the orchestration section must not publish ${RESERVED_LAYER_NAME}`,
  );
}

/** The complete wiring of the orchestration policy, applied to any copy. */
function assertRunnerContract(content) {
  assertSkillIsLoaded(content);
  assertSectionExists(content);
  assertSubsectionsInOrder(content);
  assertSectionPlacement(content);
  assertSectionTokens(content);
  assertDocumentTokens(content);
  assertBackgroundDispatch(content);
  assertNoCoordinationIdentifiers(content);
}

describe("runner parallel orchestration wiring", () => {
  const content = readRunner();

  it("loads the orchestration skill", () => {
    assertSkillIsLoaded(content);
  });

  it("declares the orchestration section with its seven subsections in order", () => {
    assertSectionExists(content);
    assertSubsectionsInOrder(content);
  });

  it("places the orchestration section between the loop control and the context section", () => {
    assertSectionPlacement(content);
  });

  it("declares the decision, the queue, the dispatch and the containment clauses", () => {
    assertSectionTokens(content);
  });

  it("declares the canonical background dispatch", () => {
    assertBackgroundDispatch(content);
  });

  it("does not create a role agent for the orchestration policy", () => {
    assertNoAgentCreated();
  });

  it("publishes no coordination identifier", () => {
    assertNoCoordinationIdentifiers(content);
  });
});

describe("runner parallel orchestration mutations", () => {
  const original = readRunner();

  it("rejects a copy that drops the background dispatch", () => {
    const mutated = original.replace("background: true", "background: false");
    assert.notEqual(mutated, original, "the mutated copy must differ from the contract");
    assert.throws(() => assertRunnerContract(mutated), /background: true/);
  });

  it("rejects a copy that moves the section after the context section", () => {
    const start = original.indexOf(PARALLEL_HEADING);
    const end = original.indexOf(CONTEXT_HEADING, start);
    assert.ok(start !== -1 && end !== -1);
    const section = original.slice(start, end);
    const mutated = original.slice(0, start) + original.slice(end) + "\n" + section;
    assert.notEqual(mutated, original, "the mutated copy must differ from the contract");
    assert.throws(() => assertRunnerContract(mutated), /must precede the context section/);
  });
});
