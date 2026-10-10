import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

describe("investigacion skill contract", () => {
  const content = read(".flowtask/skills/investigacion/SKILL.md");

  it("has the standard frontmatter", () => {
    assert.match(content, /^---\nname: investigacion\n/);
    for (const field of ["description:", "license:", "compatibility:", "metadata:"]) {
      assert.ok(content.includes(field), `missing ${field}`);
    }
  });

  it("defines the Graphify chain and exact degradation", () => {
    // Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
    // el whitespace para asentar frases del contrato sin depender del wrap.
    const flat = (text) => text.replace(/\s+/g, " ");
    const flatContent = flat(content);

    assert.ok(content.includes("graphify_query_graph"));

    // Contrato vigente: chain de 3 pasos. Antes de delegar, se evalúa la
    // suficiencia de la evidencia ya investigada.
    assert.ok(flatContent.includes("2. evaluar la suficiencia de la evidencia ya investigada y disponible"));
    assert.ok(flatContent.includes("3. delegar al Inspector para completar el GAP concreto"));
    assert.ok(
      flatContent.includes("la ausencia de referencias Graphify no activa por sí sola al Inspector"),
      "SKILL.md should state that missing Graphify references alone do not trigger delegation",
    );
    assert.ok(
      flatContent.includes("se identifica el GAP material y se delega al Inspector para completar esa brecha"),
      "SKILL.md should delegate to the Inspector when a material element is missing",
    );

    // Guarda de regresión: la delegación es condicional, nunca automática.
    assert.doesNotMatch(
      content,
      /escalar automáticamente al Inspector/,
      "SKILL.md must not regress to automatic escalation to the Inspector",
    );

    assert.doesNotMatch(content, /node \.flowtask\/bin\/flowtask\.js graphify query/);
    assert.ok(
      flatContent.includes("La búsqueda normal del proyecto no reemplaza la evidencia Graphify"),
      "SKILL.md should state that normal project search does not replace Graphify evidence",
    );
    assert.ok(content.includes("como evidencia Graphify"));
  });

  it("defines certainty, escalation, no-write, and hotfix transition", () => {
    assert.ok(content.includes("[Inferencia]"));
    assert.ok(content.includes("[No verificado]"));
    assert.ok(content.includes("Graphify y Engram no bastan"));
    assert.ok(content.includes("Inspector"));
    assert.ok(content.includes("Runner nunca escribe archivos"));
    assert.ok(content.includes("hotfix/{id}/artifact/investigacion"));
    assert.ok(content.includes("hotfix/{id}/artifact/plan"));
    assert.ok(content.includes("`ejecutar`"));
  });
});

describe("Runner hotfix integration contract", () => {
  const runner = read(".flowtask/agents/runner.md");

  it("loads investigacion always and preserves runner write prohibition", () => {
    assert.ok(runner.includes('skill({ name: "investigacion" })'));
    assert.ok(runner.includes("Al iniciar cada conversación"));
    assert.ok(runner.includes("NUNCA escribas código, archivos de producto ni configuración"));
  });

  it("documents direct research, execution transition, and all hotfix artifacts", () => {
    assert.ok(runner.includes("Investigación directa"));
    assert.ok(runner.includes("evento literal `ejecutar`"));
    for (const artifact of ["hotfix/{id}/artifact/investigacion", "hotfix/{id}/artifact/plan", "hotfix/{id}/artifact/validacion"]) {
      assert.ok(runner.includes(artifact), `missing ${artifact}`);
    }
    assert.ok(runner.includes("execution_id=hotfix/{id}"));
    assert.ok(runner.includes("artifact_namespace=hotfix/{id}"));
    assert.ok(runner.includes("worktree/hotfix/{id}"));
  });

  it("documents descriptive HF naming, collision handling, and propagation", () => {
    for (const content of [runner, read(".flowtask/skills/investigacion/SKILL.md")]) {
      assert.match(content, /HF-\{(?:slug|nombre-descriptivo)\}/);
      assert.match(content, /[Cc]onsulta Engram/);
      assert.ok(content.includes("HF-{slug}-2"));
      assert.ok(content.includes("-3"));
      assert.match(content, /no sobrescribas ni\s+mezcles/);
      assert.ok(content.includes("Los IDs temporales históricos no se renombran"));
      assert.ok(!content.includes("hotfix-YYYYMMDD-HHMMSS-<nonce>"));
    }
  });

  it("keeps the hotfix namespace while Validator distinguishes legacy IDs", () => {
    const validator = read(".flowtask/agents/validator.md");
    assert.ok(validator.includes("HF-{nombre-descriptivo}"));
    assert.ok(validator.includes("Los hotfixes anteriores se buscan bajo el ID original"));
    assert.ok(validator.includes("execution_id=hotfix/{id}"));
    assert.ok(validator.includes("artifact_namespace=hotfix/{id}"));
  });

  it("does not modify the Inspector contract", () => {
    const inspector = path.join(ROOT, ".flowtask", "agents", "inspector.md");
    assert.ok(fs.existsSync(inspector));
    assert.equal(fs.statSync(inspector).isFile(), true);
  });
});
