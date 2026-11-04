import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL_REL_PATH = ".flowtask/skills/agent-loop-progress/SKILL.md";

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

function readSkill() {
  return fs.readFileSync(path.join(ROOT, SKILL_REL_PATH), "utf8");
}

function extractSchema(content) {
  const sectionStart = content.indexOf("## Schema ProgressRecord v1");
  assert.ok(sectionStart !== -1, "SKILL.md must contain the schema section");
  const afterSection = content.slice(sectionStart);
  const match = afterSection.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, "SKILL.md must contain a json fenced block after the schema section");
  return JSON.parse(match[1]);
}

function extractSection(content, heading) {
  const start = content.indexOf(heading);
  assert.ok(start !== -1, `SKILL.md must contain the section ${heading}`);
  const next = content.indexOf("\n## ", start + heading.length);
  const section = content.slice(start, next === -1 ? content.length : next);
  const rest = content.slice(0, start) + (next === -1 ? "" : content.slice(next));
  return { section, rest };
}

describe("agent-loop-progress skill contract", () => {
  const content = readSkill();

  it("has the canonical frontmatter", () => {
    assert.match(content, /^---\nname: agent-loop-progress\n/);
    for (const field of [
      "description:",
      "license: MIT",
      "compatibility: opencode",
      "metadata:",
      "category: agent-loop",
      "scope: flowtask",
    ]) {
      assert.ok(content.includes(field), `missing ${field}`);
    }
  });

  it("keeps the required sections in contract order", () => {
    const headings = [
      "## Propósito",
      "## Alcance y fronteras",
      "## Modelo de ejecución y ronda",
      "## Schema ProgressRecord v1",
      "## Variables observables y derivación",
      "## Evidencia",
      "## Inicialización",
      "## Actualización por ronda",
      "## Clasificación de ronda",
      "## Persistencia",
      "## Consulta de solo lectura",
      "## Reanudación y fallos",
      "## Garantías del contrato",
      "## Matriz de aceptación",
      "## Ejemplos canónicos",
    ];

    const positions = headings.map((heading) => content.indexOf(heading));
    for (const [index, position] of positions.entries()) {
      assert.ok(position !== -1, `missing section ${headings[index]}`);
      if (index > 0) {
        assert.ok(
          position > positions[index - 1],
          `section ${headings[index]} must come after ${headings[index - 1]}`,
        );
      }
    }
  });

  it("exposes a parseable ProgressRecord v1 schema", () => {
    const record = extractSchema(content);

    assert.equal(record.schema, "agent-loop-progress/v1");
    assert.deepEqual(Object.keys(record).sort(), [
      "baseline",
      "baseline_history",
      "created_at",
      "evidence",
      "execution",
      "incidents",
      "integrity",
      "registries",
      "round",
      "schema",
      "snapshots",
      "test_runs",
      "updated_at",
      "variables",
    ]);

    for (const key of ["id", "work_kind", "work_id", "status"]) {
      assert.ok(Object.hasOwn(record.execution, key), `execution must contain ${key}`);
    }

    for (const key of [
      "version",
      "approved_at",
      "criteria_source",
      "tasks_source",
      "criteria_total",
      "tasks_total",
      "initial_evidence_origin",
    ]) {
      assert.ok(Object.hasOwn(record.baseline, key), `baseline must contain ${key}`);
    }

    for (const key of ["number", "state", "classification"]) {
      assert.ok(Object.hasOwn(record.round, key), `round must contain ${key}`);
    }

    assert.deepEqual(Object.keys(record.variables).sort(), [
      "blockers",
      "criteria",
      "rounds_without_verifiable_progress",
      "tasks",
      "tests",
    ]);

    for (const key of ["criteria", "tests", "blockers", "tasks"]) {
      assert.ok(Object.hasOwn(record.registries, key), `registries must contain ${key}`);
    }

    for (const key of [
      "snapshot_id",
      "kind",
      "round",
      "revision",
      "supersedes",
      "revision_reason",
      "recorded_at",
      "baseline_version",
      "variables",
      "evidence_ids",
      "evidence_state",
      "classification",
      "advanced",
      "regressed",
      "summary",
    ]) {
      assert.ok(Object.hasOwn(record.snapshots[0], key), `snapshots[0] must contain ${key}`);
    }

    for (const key of ["record_version", "last_snapshot_id"]) {
      assert.ok(Object.hasOwn(record.integrity, key), `integrity must contain ${key}`);
    }
  });

  it("defines the five families and their states", () => {
    for (const family of [
      "criteria",
      "tests",
      "blockers",
      "tasks",
      "rounds_without_verifiable_progress",
    ]) {
      assert.ok(content.includes(family), `missing family ${family}`);
    }

    for (const state of ["known", "not_applicable", "unknown"]) {
      assert.ok(content.includes(state), `missing state ${state}`);
    }

    for (const rule of [
      "criteria.total",
      "tasks.total",
      "tests.passed",
      "tests.executed",
      "blockers.resolved",
      "blockers.open",
      "tasks.completed",
    ]) {
      assert.ok(content.includes(rule), `missing derivation rule ${rule}`);
    }
  });

  it("defines initialization, round update, and classification rules", () => {
    const flatContent = flat(content);

    for (const phrase of [
      "ronda 0",
      "primera ronda funcional es la ronda 1",
      "antes de despachar la primera ronda",
      "no crea registro",
      "exactamente una instantánea",
      "antes de decidir o despachar la siguiente",
      "no se reinicia al reanudar",
      "supersedes",
      "no cuenta como progreso",
      "no incrementa",
      "with_verifiable_progress",
      "without_verifiable_progress",
      "not_evaluable",
      "no reinicia ni incrementa",
      "mismos hechos y mismo baseline",
    ]) {
      assert.ok(flatContent.includes(phrase), `missing contract phrase "${phrase}"`);
    }
  });

  it("defines the abstract persistence and read-only query contract", () => {
    for (const phrase of [
      "documento durable único",
      "historial completo",
      "lectura de verificación",
      "no se usan archivos locales",
      "fuentes paralelas",
      "sin registro",
      "no disponible",
      "contradictorio",
      "solo lectura",
      "no modifica",
    ]) {
      assert.ok(content.includes(phrase), `missing persistence phrase "${phrase}"`);
    }
  });

  it("covers the acceptance matrix and canonical examples", () => {
    for (let index = 1; index <= 24; index += 1) {
      const id = `AC-${String(index).padStart(2, "0")}`;
      assert.ok(content.includes(id), `missing ${id}`);
    }

    for (let index = 1; index <= 14; index += 1) {
      const id = `E-${String(index).padStart(2, "0")}`;
      assert.ok(content.includes(id), `missing ${id}`);
    }

    const { section: matrix } = extractSection(content, "## Matriz de aceptación");
    assert.ok(matrix.includes("regla"), "the acceptance matrix must state the applicable rule");
    assert.ok(matrix.includes("sección"), "the acceptance matrix must reference a contract section");
  });

  it("stays integration-agnostic and free of out-of-scope behavior", () => {
    for (const forbidden of [
      "CA-agent-loop-progress",
      "ca/CA-agent-loop-progress",
      "F0.",
      "F1.",
      "F2.",
      "AgentRun",
      "Runner",
      "Engram",
      "mem_save",
      "mem_search",
      "mem_get_observation",
      "topic_key",
      "flow-state/",
      "memory-contract",
      "topic-keys-convention",
      "checkpoint-mixin",
      ".opencode/",
      "node:test",
      "import ",
      "require(",
      "child_process",
      "#!/",
      "process.",
      "fetch(",
      "máximo de rondas:",
      "tope de",
      "detener la ejecución",
      "pausar la ejecución",
    ]) {
      assert.ok(!content.includes(forbidden), `SKILL.md must not contain "${forbidden}"`);
    }

    const fencedBlocks = [...content.matchAll(/```(\w*)\n([\s\S]*?)```/g)];
    assert.equal(fencedBlocks.length, 1, "SKILL.md must contain exactly one fenced block");
    assert.equal(fencedBlocks[0][1], "json", "the only fenced block must be labeled json");

    const excluded = ["terminación", "presupuesto", "invariantes", "idempotencia"];
    const { section: scope, rest } = extractSection(content, "## Alcance y fronteras");

    for (const word of excluded) {
      assert.ok(scope.includes(word), `the scope section must exclude ${word}`);
      assert.ok(!rest.includes(word), `only the scope section may mention ${word}`);
    }
  });
});
