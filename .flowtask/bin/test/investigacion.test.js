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
    assert.ok(content.includes("integración de consulta configurada para el CLI actual"));
    assert.ok(content.includes("node .flowtask/bin/flowtask.js graphify query --query <query-string>"));
    assert.ok(content.includes("búsqueda normal del proyecto"));
    assert.ok(content.includes("no pude consultar el grafo, estoy usando búsqueda normal"));
    assert.ok(content.includes("La búsqueda normal no se presenta como evidencia Graphify"));
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

  it("does not modify the Inspector contract", () => {
    const inspector = path.join(ROOT, ".flowtask", "agents", "inspector.md");
    assert.ok(fs.existsSync(inspector));
    assert.equal(fs.statSync(inspector).isFile(), true);
  });
});
