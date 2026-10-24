import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL_REL = ".flowtask/skills/ficha-proyecto/SKILL.md";

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

const flat = (text) => text.replace(/\s+/g, " ");

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "SKILL.md debe tener frontmatter delimitado por ---");
  return match[1];
}

const NINE_SECTIONS = [
  "Qué es (1-2 líneas)",
  "Problema que resuelve",
  "Estado",
  "Alcance y decisiones clave de diseño",
  "Resultados o evidencia de funcionamiento",
  "Stack técnico",
  "Rol del autor",
  "Relevancia potencial",
  "Nivel de confianza de esta ficha",
];

const SKILL_SECTIONS = [
  "## Material faltante",
  "## Persistencia y frontera",
  "## Rechazos",
  "## Resolución del proyecto",
  "## Evidencia del repositorio",
  "## Evidencia de Engram",
  "## Marcas de evidencia",
  "## Plantilla de la ficha",
  "## Reglas por sección",
  "## Criterios de aceptación",
  "## QA",
  "## Limitaciones",
  "## Verificación",
  "## Exclusiones",
];

describe("ficha-proyecto skill: archivos y frontmatter", () => {
  it("existe el archivo SKILL.md", () => {
    const target = path.join(ROOT, SKILL_REL);
    assert.ok(fs.existsSync(target), `falta ${SKILL_REL}`);
    assert.ok(fs.statSync(target).isFile(), `${SKILL_REL} debe ser un archivo`);
  });

  it("declara el frontmatter canonico", () => {
    const content = read(SKILL_REL);
    const fm = parseFrontmatter(content);
    assert.match(content, /^---\nname: ficha-proyecto\n/);
    for (const field of [
      "license: MIT",
      "compatibility: opencode",
      "metadata:",
      "category: content-preparation",
      "scope: project",
    ]) {
      assert.ok(fm.includes(field), `SKILL.md debe declarar ${field}`);
    }
  });

  it("el nombre del directorio coincide con el name declarado", () => {
    const content = read(SKILL_REL);
    const declared = content.match(/^name:\s*(\S+)$/m);
    assert.ok(declared, "SKILL.md debe declarar name");
    assert.equal(path.basename(path.dirname(path.join(ROOT, SKILL_REL))), declared[1]);
  });

  it("la description contiene las frases disparadoras y una prohibicion de redaccion/publicacion", () => {
    const content = read(SKILL_REL);
    const fm = parseFrontmatter(content);
    const flatFm = flat(fm);
    assert.ok(flatFm.includes("generemos contenido de"), 'description debe contener "generemos contenido de"');
    assert.ok(flatFm.toLowerCase().includes("ficha"), 'description debe contener "ficha"');
    const lower = flatFm.toLowerCase();
    assert.ok(
      lower.includes("no redacta") || lower.includes("no publica") || lower.includes("no escribe"),
      "description debe contener una prohibicion de redaccion/publicacion",
    );
  });
});

describe("ficha-proyecto skill: estructura", () => {
  const content = read(SKILL_REL);

  it("las 9 secciones de la ficha aparecen en orden", () => {
    let lastIndex = -1;
    for (const section of NINE_SECTIONS) {
      const idx = content.indexOf(section);
      assert.ok(idx !== -1, `SKILL.md debe contener la seccion de ficha "${section}"`);
      assert.ok(idx > lastIndex, `la seccion "${section}" debe aparecer despues de la anterior`);
      lastIndex = idx;
    }
  });

  it("contiene las secciones normativas de la skill", () => {
    for (const section of SKILL_SECTIONS) {
      assert.ok(content.includes(section), `SKILL.md debe contener ${section}`);
    }
  });

  it("contiene las tres marcas de evidencia", () => {
    for (const mark of ["[Verificado —", "[Inferencia —", "[No verificado —"]) {
      assert.ok(content.includes(mark), `SKILL.md debe contener la marca ${mark}`);
    }
  });

  it("declara la ruta de guardado manual", () => {
    assert.ok(content.includes("/Users/saez/Proyects/fichas/"), "SKILL.md debe declarar la ruta de guardado");
  });

  it("menciona .worktrees/ como prohibicion", () => {
    assert.ok(content.includes(".worktrees/"), "SKILL.md debe mencionar .worktrees/");
  });
});

describe("ficha-proyecto skill: frontera", () => {
  const content = read(SKILL_REL);
  const lower = content.toLowerCase();

  it("declara que no modifica el runner", () => {
    assert.ok(
      content.includes(".flowtask/agents/runner.md"),
      "SKILL.md debe mencionar .flowtask/agents/runner.md",
    );
    assert.ok(
      lower.includes("no se modifica") || lower.includes("no modifica"),
      "SKILL.md debe declarar que no modifica el runner",
    );
  });

  it("declara que no invoca subagentes", () => {
    assert.ok(lower.includes("no invoca subagentes") || lower.includes("no se invocan subagentes") || lower.includes("subagentes"), "SKILL.md debe mencionar subagentes");
    assert.ok(lower.includes("no invoca") || lower.includes("no se invoca"), "SKILL.md debe declarar que no invoca");
  });

  it("declara que no publica", () => {
    assert.ok(lower.includes("no publica"), "SKILL.md debe declarar que no publica");
  });

  it("declara que no escribe archivos", () => {
    assert.ok(lower.includes("no escribe") || lower.includes("no se escribe"), "SKILL.md debe declarar que no escribe");
  });

  it("declara que una ficha previa no es fuente", () => {
    const flatContent = flat(content).toLowerCase();
    assert.ok(
      flatContent.includes("ficha previa") && (flatContent.includes("no es fuente") || flatContent.includes("no se usa como fuente")),
      "SKILL.md debe declarar que la ficha previa no es fuente",
    );
  });

  it("declara que los documentos historicos/legacy/deprecados no se usan para claims vigentes", () => {
    const flatContent = flat(content).toLowerCase();
    assert.ok(
      flatContent.includes("historico") || flatContent.includes("legacy") || flatContent.includes("deprecado"),
      "SKILL.md debe mencionar documentos historicos/legacy/deprecados",
    );
    assert.ok(
      flatContent.includes("no se usan") || flatContent.includes("no se usa") || flatContent.includes("no se utilizan"),
      "SKILL.md debe declarar que no se usan para claims vigentes",
    );
  });
});

describe("ficha-proyecto skill: genericidad", () => {
  const content = read(SKILL_REL);

  it("no contiene FlowTask ni x-post como casos especiales", () => {
    assert.ok(!content.includes("FlowTask"), "SKILL.md no debe contener FlowTask");
    assert.ok(!content.includes("x-post"), "SKILL.md no debe contener x-post");
  });
});
