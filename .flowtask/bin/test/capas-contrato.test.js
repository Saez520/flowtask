import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const RETIRED_PHRASE = "No hay interruptores por flujo ni configuración estática";

/**
 * Falla si el texto reintroduce la regla retirada de interruptores por flujo.
 * La guarda es reutilizable sobre un fixture: una copia regresada debe fallar
 * con un mensaje que nombre la frase prohibida.
 */
export function assertNoRetiredPhrase(content, label = "documento") {
  assert.doesNotMatch(
    flat(content),
    new RegExp(RETIRED_PHRASE),
    `${label}: la frase prohibida no puede volver: "${RETIRED_PHRASE}"`,
  );
}

describe("capas de persona, autonomia y permisos — contrato", () => {
  const page = read("docs/architecture/capas-persona-autonomia-permisos.md");
  const flatPage = flat(page);

  it("publishes the page with its nine sections", () => {
    assert.ok(exists("docs/architecture/capas-persona-autonomia-permisos.md"), "missing the layers page");
    for (const section of [
      "## Propósito",
      "## Capas",
      "## Valores y esquema",
      "## Resolución por capa",
      "## Precedencia",
      "## Fallo por capa",
      "## Puntos de enforcement",
      "## Migración",
      "## Frontera con la policy de dominio",
      "## Verificación",
    ]) {
      assert.ok(page.includes(section), `missing section ${section}`);
    }
  });

  it("declares the three autonomy profiles and the permission envelope", () => {
    for (const profile of ["assistant", "autonomous-dev", "hermes"]) {
      assert.ok(flatPage.includes(`\`${profile}\``), `missing autonomy profile ${profile}`);
    }
    assert.ok(flatPage.includes("`standard`"), "missing the permission envelope");
    assert.ok(flatPage.includes('"version": 1'), "missing the schema version of the new layers");
    assert.ok(
      flatPage.includes("`profile.json`") && flatPage.includes("`autonomy.json`") && flatPage.includes("`permissions.json`"),
      "missing one of the three layer files",
    );
  });

  it("declares the structural precedence between layers", () => {
    assert.ok(
      flatPage.includes("`permisos > autonomía > persona`"),
      "missing the structural precedence",
    );
    assert.ok(
      flatPage.includes("nunca amplía el sobre de permisos"),
      "the autonomy layer must not widen the permission envelope",
    );
    assert.ok(
      flatPage.includes("no autoriza ni restringe"),
      "the persona layer must not authorize nor restrict",
    );
  });

  it("publishes the per-layer failure table", () => {
    assert.ok(flatPage.includes("| Capa ausente o inválida | Comportamiento | Resultado |"), "missing the failure table header");
    assert.ok(flatPage.includes("| Permisos | Fallo operativo con mensaje |"), "missing the permissions failure row");
    assert.ok(flatPage.includes("| Autonomía | Fallo operativo con mensaje |"), "missing the autonomy failure row");
    assert.ok(flatPage.includes("| Persona | Aviso visible y continuación |"), "missing the persona failure row");
    assert.ok(
      flatPage.includes("no tiene valor por defecto"),
      "the operational failure must not fall back to a default value",
    );
  });

  it("publishes the migration defaults and their boundary", () => {
    assert.ok(flatPage.includes('"profile": "autonomous-dev"'), "missing the autonomy migration default");
    assert.ok(flatPage.includes('"envelope": "standard"'), "missing the permissions migration default");
    assert.ok(
      flatPage.includes("no** un fallback de runtime") || flatPage.includes("no** un fallback de runtime:") || flatPage.includes("Son una migración, **no** un fallback de runtime"),
      "the migration default must be declared as not a runtime fallback",
    );
    assert.ok(
      flatPage.includes("Una capa inválida nunca se repara con un default"),
      "an invalid layer must never be repaired with a default",
    );
  });

  it("declares the boundary with the domain policy", () => {
    assert.ok(
      flatPage.includes("los permisos de dominio de Hermes pertenecen a la fase de permisos de dominio"),
      "missing the domain policy boundary",
    );
    assert.ok(
      flatPage.includes("sin la policy de capacidades y sin los permisos de dominio no amplía el sobre técnico"),
      "the hermes profile must not widen the envelope without the domain policy",
    );
  });

  it("does not reintroduce the retired per-flow switch rule", () => {
    assertNoRetiredPhrase(page, "capas-persona-autonomia-permisos.md");
  });

  it("rejects a regressed copy of the page", () => {
    const regressed = page.replace(
      "La precedencia entre capas es",
      RETIRED_PHRASE,
    );
    assert.notEqual(regressed, page, "the regression copy must differ from the contract");
    assert.throws(() => assertNoRetiredPhrase(regressed, "fixture"), /No hay interruptores por flujo/);
  });
});

describe("reconciliacion del contrato de autonomia", () => {
  it("replaces the retired rule in the autonomy page", () => {
    const page = read("docs/architecture/autonomia-operativa.md");
    assertNoRetiredPhrase(page, "autonomia-operativa.md");
    assert.ok(
      flat(page).includes("La capa de autonomía declara la iniciativa"),
      "the autonomy page must declare the initiative layer",
    );
    assert.ok(
      flat(page).includes("La política de ejecución sigue siendo `gate-then-auto`"),
      "the autonomy page must preserve the execution policy",
    );
    assert.ok(
      page.includes("capas-persona-autonomia-permisos.md"),
      "the autonomy page must link the layers page",
    );
  });

  it("replaces the retired rule in the loop contract", () => {
    const skill = read(".flowtask/skills/agent-loop-run/SKILL.md");
    assertNoRetiredPhrase(skill, "agent-loop-run/SKILL.md");
    assert.ok(
      flat(skill).includes("La capa de autonomía declara la iniciativa"),
      "the loop contract must declare the initiative layer",
    );
    assert.ok(
      flat(skill).includes("`permisos > autonomía > persona`"),
      "the loop contract must declare the precedence between layers",
    );
    assert.ok(flat(skill).includes("`autonomy.profile`"), "missing autonomy.profile in the loop contract");
    assert.ok(flat(skill).includes("`autonomy.source`"), "missing autonomy.source in the loop contract");
  });

  it("links the layers page from the index and the core flow", () => {
    const index = read("docs/architecture/INDEX.md");
    assert.ok(index.includes("capas-persona-autonomia-permisos.md"), "the index must link the layers page");

    const core = read("docs/core-flowtask.md");
    assert.ok(core.includes("capas-persona-autonomia-permisos.md"), "the core flow must link the layers page");
    assert.ok(
      flat(core).includes("La personalidad solo define tono y profundidad; no autoriza ni restringe acciones"),
      "the core flow must declare that the persona does not authorize",
    );
    assert.ok(
      flat(core).includes("La autorización técnica vive en la capa de permisos y la iniciativa en la capa de autonomía"),
      "the core flow must locate authorization and initiative in their own layers",
    );
  });
});

describe("configuracion local y documentacion de migracion", () => {
  it("ignores the new layer files in the four configuration locations", () => {
    const gitignore = read(".gitignore");

    for (const pattern of [
      "**/flowtask/config/autonomy.json",
      ".flowtask/config/autonomy.json",
      "**/flowtask/config/permissions.json",
      ".flowtask/config/permissions.json",
    ]) {
      assert.ok(gitignore.includes(pattern), `missing gitignore pattern ${pattern}`);
    }
  });

  it("documents the migration defaults and the non-fallback boundary", () => {
    for (const relative of ["docs/installation.md", ".flowtask/config/README.md"]) {
      const content = flat(read(relative));
      assert.ok(content.includes("autonomy.json"), `${relative} must document autonomy.json`);
      assert.ok(content.includes("permissions.json"), `${relative} must document permissions.json`);
      assert.ok(content.includes("autonomous-dev"), `${relative} must document the autonomy migration default`);
      assert.ok(content.includes("standard"), `${relative} must document the permissions migration default`);
      assert.match(content, /no un fallback de runtime/, `${relative} must state that the default is not a runtime fallback`);
      assert.match(content, /Una capa inválida nunca se repara con un default/, `${relative} must forbid repairing an invalid layer`);
    }
  });
});
