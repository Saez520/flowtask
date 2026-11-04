import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readComposedRunner } from "./helpers/runner-document.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8");

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const PLANNER = ".flowtask/agents/planner.md";
const RUNNER = ".flowtask/agents/runner.md";

/**
 * Contrato del Planner: continuidad firmada, verificación con herencia, consulta
 * del grafo por la integración, comunicación mediada y huecos de negocio.
 */
function assertPlannerContract(planner) {
  const plannerFlat = flat(planner);

  for (const token of [
    "## Comunicación mediada",
    "R1 — Canal único",
    "R2 — Pedido con referencias citables",
    "R3 — Huecos de negocio",
    "R4 — Herencia de evidencia",
    "R5 — Límites y espera",
    "derivations",
    "business_gaps",
    "waiting_for_derivation",
    "datum_id",
    "pause_reason",
    "topic_signature",
    "resume_ref",
    'treatment_class: "complete"',
    'state: "completed"',
    "graphify_query_graph",
    "no pude consultar el grafo, estoy usando búsqueda normal",
    "Herencia de evidencia",
    "missing_source",
    "una ronda",
    "sin agentes nuevos",
    "sin skills nuevas",
    "sin espacios de nombres nuevos",
    "sin cambios de permisos",
  ]) {
    assert.ok(plannerFlat.includes(token), `planner.md debe declarar ${token}`);
  }

  for (const forbidden of ["What: Plan generado", "snapshot", "CLI actual", "Verificar con ferris-search"]) {
    assert.ok(
      !plannerFlat.includes(forbidden),
      `planner.md no debe conservar ${forbidden}`,
    );
  }

  // Canal único: el Planner no invoca directamente a quien explora.
  assert.doesNotMatch(
    planner,
    /invoca directamente al Inspector|invoca al Inspector|flowtask-inspector/i,
    "el canal directo al Inspector no está disponible para el Planner",
  );
}

/**
 * Contrato del Runner: rama de derivaciones y huecos del Planner, y guarda
 * del Gate.
 */
function assertRunnerContract(runner) {
  const runnerFlat = flat(runner);
  const runnerBare = runnerFlat.replace(/`/g, "");

  for (const token of [
    "Paso 2.5 — Derivaciones y huecos del Planner",
    "datum_id",
    "business_gaps",
    "waiting_for_derivation",
    "persistencia_fallida",
    "pause_reason",
    "No avanzar al Gate",
  ]) {
    assert.ok(runnerFlat.includes(token), `runner.md debe declarar ${token}`);
  }

  for (const token of ["mismo task_id", "misma instance_name"]) {
    assert.ok(runnerBare.includes(token), `runner.md debe declarar ${token}`);
  }

  assert.ok(
    /una ronda por dato/i.test(runnerFlat),
    "runner.md debe declarar una ronda por dato",
  );
}

describe("planner mediated references contract", () => {
  it("declara la continuidad firmada y la respuesta completa del Planner", () => {
    assertPlannerContract(read(PLANNER));
  });

  it("declara la rama de derivaciones y huecos del Runner", () => {
    assertRunnerContract(readComposedRunner({ root: ROOT }));
  });

  it("rechaza una copia que pierde la espera por derivación", () => {
    const original = read(PLANNER);
    const mutated = original.replaceAll("waiting_for_derivation", "espera_del_dato");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerContract(mutated),
      /waiting_for_derivation/,
      "la ausencia de la espera debe fallar el contrato",
    );
  });

  it("rechaza una copia que pierde la firma del tema", () => {
    const original = read(PLANNER);
    const mutated = original.replaceAll("topic_signature", "firma_del_tema");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerContract(mutated),
      /topic_signature/,
      "la ausencia de la firma debe fallar el contrato",
    );
  });

  it("rechaza una copia que invoca directamente al Inspector", () => {
    const original = read(PLANNER);
    const mutated = `${original}\n\nInvoca directamente al Inspector con la pregunta pendiente.\n`;
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerContract(mutated),
      /canal directo al Inspector/,
      "la invocación directa debe fallar el contrato",
    );
  });
});

describe("hygiene of the functional surfaces", () => {
  it("no publica identificadores de coordinación en la prosa funcional", () => {
    // Los bloques de código y las citas en línea no son prosa: los ejemplos
    // canónicos viven ahí y no constituyen una referencia de coordinación.
    // El recorte en línea se hace por línea para que un backtick impar no
    // consuma prosa de líneas siguientes al leer el documento compuesto.
    const stripCode = (text) =>
      text
        .replace(/```[\s\S]*?```/g, " ")
        .split("\n")
        .map((line) => line.replace(/`[^`]*`/g, " "))
        .join("\n");

    for (const [relPath, content] of [
      [PLANNER, read(PLANNER)],
      [RUNNER, readComposedRunner({ root: ROOT })],
    ]) {
      const prose = stripCode(content);
      assert.doesNotMatch(
        prose,
        /CA-[a-z0-9]/,
        `${relPath} no debe publicar un identificador de requisito`,
      );
      assert.doesNotMatch(
        prose,
        /F\d\.\d/,
        `${relPath} no debe publicar un identificador de fase`,
      );
    }

    const testFile = read(".flowtask/bin/test/planner-mediated-references.test.js");
    assert.doesNotMatch(
      testFile,
      /CA-[a-z0-9]/,
      "la prueba no debe incluir el identificador del requisito",
    );
    assert.doesNotMatch(
      testFile,
      /F\d\.\d/,
      "la prueba no debe incluir el identificador de fase",
    );
  });

  it("no altera la versión vigente del proyecto", () => {
    assert.ok(read(".flowtask/package.json").includes('"version": "1.26.0"'));
  });
});
