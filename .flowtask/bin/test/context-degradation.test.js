/**
 * Contract test of the `context-degradation` skill.
 *
 * The skill is a declarative contract: the test reads it and asserts the
 * clauses that the runtime and the agents rely on — the three degradation
 * levels, the six work moments, the recovery declaration, the acceptance
 * matrix and the canonical examples.
 *
 * The test is read-only: no network, no writes and no import of production
 * code. It only reads the skill document.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL_REL_PATH = ".flowtask/skills/context-degradation/SKILL.md";

// El contrato vive en Markdown con saltos de línea arbitrarios: se aplana el
// whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");
const flatLower = (text) => flat(text).toLowerCase();

function readSkill() {
  return fs.readFileSync(path.join(ROOT, SKILL_REL_PATH), "utf8");
}

const SECTION_HEADINGS = [
  "## Propósito",
  "## Alcance y fronteras",
  "## Términos",
  "## Degradación por niveles",
  "## Inyección de reglas por momento",
  "## Recuperación verificable",
  "## Herencia de evidencia y discrepancia",
  "## Avisos observables",
  "## Fallos y datos no verificables",
  "## Garantías del contrato",
  "## Matriz de aceptación",
  "## Ejemplos canónicos",
];

describe("context-degradation skill contract", () => {
  const content = readSkill();
  const flatContent = flat(content);
  const flatContentLower = flatContent.toLowerCase();

  it("has the canonical frontmatter", () => {
    assert.match(content, /^---\nname: context-degradation\n/);
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
    let previous = -1;
    for (const heading of SECTION_HEADINGS) {
      const index = content.indexOf(`\n${heading}\n`);
      assert.ok(index !== -1, `missing section ${heading}`);
      assert.ok(index > previous, `section out of order: ${heading}`);
      previous = index;
    }
  });

  it("defines the three degradation levels without exposing thresholds", () => {
    for (const level of ["Nivel 1", "Nivel 2", "Nivel 3"]) {
      assert.ok(flatContent.includes(level), `missing ${level}`);
    }
    assert.ok(flatContent.includes("sin preview"), "missing the no-preview rule");
    assert.ok(flatContent.includes("Inspector"), "missing the delegation target");
    assert.ok(flatContent.includes("no se exponen"), "missing the threshold opacity rule");
  });

  it("declares the six work moments and the pack discipline", () => {
    for (const moment of ["intake", "define", "plan", "build", "validate", "close"]) {
      assert.ok(flatContent.includes(`\`${moment}\``), `missing moment ${moment}`);
    }
    assert.ok(flatContent.includes("solo el pack del momento"), "missing the single-pack rule");
    assert.ok(flatContent.includes("se hereda"), "missing the inheritance rule");
    assert.ok(flatContent.includes("no se re-verifica"), "missing the no-re-verification rule");
  });

  it("declares the verifiable recovery with source, observation time and pause reasons", () => {
    for (const phrase of [
      "decisiones vigentes",
      "progreso confirmado",
      "gasto acumulado",
      "última ronda confirmada",
      "fuente",
      "momento de observación",
      "progress_unavailable",
      "record_unavailable",
      "[No verificado]",
    ]) {
      assert.ok(flatContentLower.includes(phrase.toLowerCase()), `missing ${phrase}`);
    }
  });

  it("keeps the acceptance matrix and the canonical examples complete", () => {
    for (let index = 1; index <= 14; index += 1) {
      const id = `AC-${String(index).padStart(2, "0")}`;
      assert.ok(flatContent.includes(id), `missing ${id}`);
    }
    for (let index = 1; index <= 10; index += 1) {
      const id = `E-${String(index).padStart(2, "0")}`;
      assert.ok(flatContent.includes(id), `missing ${id}`);
    }
  });

  it("carries no coordination identifiers", () => {
    const forbidden = [
      "CA-context-degradation",
      "F2.8",
      "#9561",
      "Hermes",
      "orquestación paralela",
      "bump",
      "archivos locales",
      "fuentes paralelas",
      "Engram",
    ];
    for (const token of forbidden) {
      assert.ok(
        !flatContent.includes(token),
        `the skill must not carry the coordination identifier "${token}"`,
      );
    }
  });
});
