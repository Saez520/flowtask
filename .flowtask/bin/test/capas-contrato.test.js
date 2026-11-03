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
  const page = read("docs/architecture/persona-autonomy-permissions-layers.md");
  const flatPage = flat(page);

  it("publishes the page with its nine sections", () => {
    assert.ok(exists("docs/architecture/persona-autonomy-permissions-layers.md"), "missing the layers page");
    for (const section of [
      "## Purpose",
      "## Layers",
      "## Values and schema",
      "## Per-layer resolution",
      "## Precedence",
      "## Per-layer failure",
      "## Enforcement points",
      "## Migration",
      "## Boundary with the domain policy",
      "## Verification",
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
      flatPage.includes("`permissions > autonomy > persona`"),
      "missing the structural precedence",
    );
    assert.ok(
      flatPage.includes("never expands the permissions envelope"),
      "the autonomy layer must not widen the permission envelope",
    );
    assert.ok(
      flatPage.includes("does not authorize or restrict"),
      "the persona layer must not authorize nor restrict",
    );
  });

  it("publishes the per-layer failure table", () => {
    assert.ok(flatPage.includes("| Missing or invalid layer | Behavior | Result |"), "missing the failure table header");
    assert.ok(flatPage.includes("| Permissions | Operational failure with message |"), "missing the permissions failure row");
    assert.ok(flatPage.includes("| Autonomy | Operational failure with message |"), "missing the autonomy failure row");
    assert.ok(flatPage.includes("| Persona | Visible warning and continuation |"), "missing the persona failure row");
    assert.ok(
      flatPage.includes("has no default value"),
      "the operational failure must not fall back to a default value",
    );
  });

  it("publishes the migration defaults and their boundary", () => {
    assert.ok(flatPage.includes('"profile": "autonomous-dev"'), "missing the autonomy migration default");
    assert.ok(flatPage.includes('"envelope": "standard"'), "missing the permissions migration default");
    assert.ok(
      flatPage.includes("They are a migration, **not** a runtime fallback"),
      "the migration default must be declared as not a runtime fallback",
    );
    assert.ok(
      flatPage.includes("An invalid layer is never repaired with a default"),
      "an invalid layer must never be repaired with a default",
    );
  });

  it("declares the boundary with the domain policy", () => {
    assert.ok(
      flatPage.includes("Hermes domain permissions belong to the domain permissions phase"),
      "missing the domain policy boundary",
    );
    assert.ok(
      flatPage.includes("without the capability policy and without domain permissions it does not expand the technical envelope"),
      "the hermes profile must not widen the envelope without the domain policy",
    );
  });

  it("does not reintroduce the retired per-flow switch rule", () => {
    assertNoRetiredPhrase(page, "persona-autonomy-permissions-layers.md");
  });

  it("rejects a regressed copy of the page", () => {
    const regressed = page.replace(
      "Precedence between layers is",
      RETIRED_PHRASE,
    );
    assert.notEqual(regressed, page, "the regression copy must differ from the contract");
    assert.throws(() => assertNoRetiredPhrase(regressed, "fixture"), /No hay interruptores por flujo/);
  });
});

describe("reconciliacion del contrato de autonomia", () => {
  it("replaces the retired rule in the autonomy page", () => {
    const page = read("docs/architecture/operational-autonomy.md");
    assertNoRetiredPhrase(page, "operational-autonomy.md");
    assert.ok(
      flat(page).includes("The autonomy layer declares initiative"),
      "the autonomy page must declare the initiative layer",
    );
    assert.ok(
      flat(page).includes("The execution policy remains `gate-then-auto`"),
      "the autonomy page must preserve the execution policy",
    );
    assert.ok(
      page.includes("persona-autonomy-permissions-layers.md"),
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
    assert.ok(index.includes("persona-autonomy-permissions-layers.md"), "the index must link the layers page");

    const core = read("docs/core-flowtask.md");
    assert.ok(core.includes("persona-autonomy-permissions-layers.md"), "the core flow must link the layers page");
    assert.ok(
      flat(core).includes("Personality only defines tone and depth; it does not authorize or restrict actions"),
      "the core flow must declare that the persona does not authorize",
    );
    assert.ok(
      flat(core).includes("Technical authorization lives in the permissions layer and initiative in the autonomy layer"),
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
    const installation = flat(read("docs/installation.md"));
    assert.ok(installation.includes("autonomy.json"), "docs/installation.md must document autonomy.json");
    assert.ok(installation.includes("permissions.json"), "docs/installation.md must document permissions.json");
    assert.ok(installation.includes("autonomous-dev"), "docs/installation.md must document the autonomy migration default");
    assert.ok(installation.includes("standard"), "docs/installation.md must document the permissions migration default");
    assert.match(installation, /not a runtime fallback/, "docs/installation.md must state that the default is not a runtime fallback");
    assert.match(installation, /An invalid layer is never repaired with a default/, "docs/installation.md must forbid repairing an invalid layer");

    const configReadme = flat(read(".flowtask/config/README.md"));
    assert.ok(configReadme.includes("autonomy.json"), ".flowtask/config/README.md must document autonomy.json");
    assert.ok(configReadme.includes("permissions.json"), ".flowtask/config/README.md must document permissions.json");
    assert.ok(configReadme.includes("autonomous-dev"), ".flowtask/config/README.md must document the autonomy migration default");
    assert.ok(configReadme.includes("standard"), ".flowtask/config/README.md must document the permissions migration default");
    assert.match(configReadme, /not a runtime fallback/, ".flowtask/config/README.md must state that the default is not a runtime fallback");
    assert.match(configReadme, /An invalid layer is never repaired with a default/, ".flowtask/config/README.md must forbid repairing an invalid layer");
  });
});
