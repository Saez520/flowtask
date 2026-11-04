import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readComposedRunner } from "./helpers/runner-document.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS_DIR = path.join(ROOT, ".flowtask", "agents");

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

// La documentación de arquitectura puede no existir todavía: su presencia se
// verifica en el bloque documental, no al cargar el archivo de prueba.
const readOptional = (relative) => (
  fs.existsSync(path.join(ROOT, relative)) ? flat(read(relative)) : ""
);

const skill = flat(read(".flowtask/skills/validation-contract/SKILL.md"));
const validator = flat(read(".flowtask/agents/validator.md"));
const runner = flat(readComposedRunner({ root: ROOT }));
const validationDoc = readOptional("docs/architecture/validation.md");
const index = flat(read("docs/architecture/INDEX.md"));
const coreFlow = flat(read("docs/core-flowtask.md"));

const SKILL_SECTIONS = [
  "## Propósito",
  "## Alcance",
  "## Invocación por ronda",
  "## Alcance declarado",
  "## Comprobaciones",
  "## Evidencia",
  "## Reglas de veredicto",
  "## Referencias de coordinación",
  "## Verificación ejecutable",
  "## Límites duros",
  "## Reutilización por la ronda siguiente",
];

const CLI_COMMAND = "node .flowtask/skills/validation-contract/scripts/validation-contract.js";

function frontmatterOf(relative) {
  const head = read(relative).split(/\r?\n/).slice(0, 20).join("\n");
  const value = (key) => {
    const match = head.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
    return match ? match[1].trim() : null;
  };
  return { name: value("name"), license: value("license"), compatibility: value("compatibility") };
}

describe("skill validation-contract", () => {
  it("existe el archivo de la skill con su frontmatter", () => {
    assert.equal(fs.existsSync(path.join(ROOT, ".flowtask", "skills", "validation-contract", "SKILL.md")), true);
    const head = frontmatterOf(".flowtask/skills/validation-contract/SKILL.md");
    assert.equal(head.name, "validation-contract");
    assert.equal(head.license, "MIT");
    assert.equal(head.compatibility, "opencode");
    assert.match(read(".flowtask/skills/validation-contract/SKILL.md"), /category:\s*validation/);
    assert.match(read(".flowtask/skills/validation-contract/SKILL.md"), /scope:\s*flowtask/);
  });

  it("declara las secciones obligatorias del contrato", () => {
    for (const section of SKILL_SECTIONS) {
      assert.equal(skill.includes(section), true, `la skill debe tener la sección ${section}`);
    }
  });

  it("documenta el comando CLI ejecutable", () => {
    const matches = skill.match(new RegExp(CLI_COMMAND.replace(/[/.]/g, "\\$&"), "g")) ?? [];
    assert.equal(matches.length >= 2, true, "la skill debe documentar el comando CLI al menos dos veces");
  });

  it("documenta los cuatro códigos de salida", () => {
    assert.match(skill, /\| 0 \| Aprobado/);
    assert.match(skill, /\| 1 \| Rechazo funcional/);
    assert.match(skill, /\| 2 \| Fallo operativo/);
    assert.match(skill, /\| 3 \| Contrato inválido/);
  });

  it("declara la precedencia del veredicto", () => {
    assert.match(skill, /`rejected`/);
    assert.match(skill, /`operational_failure`/);
    assert.match(skill, /`approved`/);
    assert.match(skill, /precedencia/i);
    const rejected = skill.indexOf("`rejected`");
    const failure = skill.indexOf("`operational_failure`");
    const approved = skill.indexOf("`approved`");
    assert.equal(rejected < failure, true);
    assert.equal(failure < approved, true);
  });

  it("distingue la ronda de cierre de la ronda intermedia", () => {
    assert.match(skill, /closure/);
    assert.match(skill, /intermediate/);
    assert.match(skill, /final: true/);
    assert.match(skill, /final: false/);
  });

  it("documenta el escáner y la excepción de literales permitidos", () => {
    assert.match(skill, /allowed_literals/);
    assert.match(skill, /bloqueante/);
    assert.match(skill, /escáner/i);
  });

  it("no publica calificación numérica ni máximo de rondas", () => {
    assert.doesNotMatch(skill, /Score:/);
    assert.doesNotMatch(skill, /máximo 2/);
  });
});

describe("validator", () => {
  it("declara el contrato, las rondas y el alcance", () => {
    assert.match(validator, /validation-contract/);
    assert.match(validator, /round/);
    assert.match(validator, /scope/);
    assert.match(validator, /closure/);
    assert.match(validator, /intermediate/);
    assert.match(validator, /final/);
  });

  it("declara los tres estados del veredicto y la causa por alcance ausente", () => {
    assert.match(validator, /APPROVED/);
    assert.match(validator, /REJECTED/);
    assert.match(validator, /OPERATIONAL_FAILURE/);
    assert.match(validator, /invocation_scope_missing/);
  });

  it("persiste el artifact de validación y el flow state", () => {
    assert.match(validator, /artifact\/validacion/);
    assert.match(validator, /flow-state\/\{execution_id\}\/validate/);
  });

  it("no publica calificación numérica ni conserva un máximo histórico", () => {
    assert.doesNotMatch(validator, /Score:/);
    assert.doesNotMatch(validator, /máximo 2/);
  });

  it("consolida un único bloque de restricciones", () => {
    const matches = read(".flowtask/agents/validator.md").match(/^## Restricciones/gm) ?? [];
    assert.equal(matches.length, 1);
  });
});

describe("runner", () => {
  it("despacha el validator declarando la ronda", () => {
    assert.match(runner, /round=closure/);
    assert.match(runner, /round=intermediate/);
    assert.match(runner, /final=true/);
  });

  it("mantiene el tratamiento ligero con hilo fresco", () => {
    assert.match(runner, /hilo fresco/);
    assert.match(runner, /Escenario A/);
  });

  it("distingue el fallo operativo del rechazo funcional", () => {
    assert.match(runner, /OPERATIONAL_FAILURE/);
    assert.match(runner, /continue_round/);
    assert.match(runner, /needs_recovery_or_pause/);
  });

  it("conserva la evidencia de validación y su artifact", () => {
    assert.match(runner, /artifact\/validacion/);
  });

  it("declara que solo el cierre aprobado cierra la ejecución", () => {
    assert.match(runner, /Solo un APPROVED de ronda closure con final=true cierra/);
  });

  it("no conserva un máximo histórico de intentos", () => {
    assert.doesNotMatch(runner, /máximo 2 intentos/);
    assert.doesNotMatch(runner, /máximo 2/);
  });
});

describe("documentación", () => {
  it("existe el documento de arquitectura de la validación", () => {
    assert.equal(fs.existsSync(path.join(ROOT, "docs", "architecture", "validation.md")), true);
  });

  it("enlaza el documento nuevo desde el índice", () => {
    assert.match(index, /validation\.md/);
  });

  it("alinea el bloque del flujo principal con las rondas y la evidencia", () => {
    assert.match(coreFlow, /closure/);
    assert.match(coreFlow, /intermediate/);
    assert.match(coreFlow, /evidence/i);
    assert.match(coreFlow, /APPROVED/);
    assert.match(coreFlow, /REJECTED/);
    assert.match(coreFlow, /OPERATIONAL_FAILURE/);
    assert.doesNotMatch(coreFlow, /máximo 2/);
  });

  it("documenta la precedencia, la excepción de literales y los códigos de salida", () => {
    assert.match(validationDoc, /precedence/i);
    assert.match(validationDoc, /allowed_literals/);
    assert.match(validationDoc, /\| 0 \|/);
    assert.match(validationDoc, /\| 1 \|/);
    assert.match(validationDoc, /\| 2 \|/);
    assert.match(validationDoc, /\| 3 \|/);
    assert.ok(validationDoc.includes(CLI_COMMAND));
  });

  it("no publica identificadores concretos ni historia de implementación", () => {
    for (const document of [validationDoc, coreFlow]) {
      assert.doesNotMatch(document, /CA-[a-z0-9]/);
      assert.doesNotMatch(document, /HF-[a-z0-9]/);
      assert.doesNotMatch(document, /Score:/);
      assert.doesNotMatch(document, /máximo 2/);
    }
  });
});
