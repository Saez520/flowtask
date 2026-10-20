import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SKILL_DIR = path.join(ROOT, ".flowtask", "skills", "repo-cleanup");
const SKILL_REL = ".flowtask/skills/repo-cleanup/SKILL.md";
const QA_REL = ".flowtask/skills/repo-cleanup/QA.md";

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const SECTIONS = [
  "## Propósito",
  "## Alcance y no-objetivos",
  "## Entradas y configuración",
  "## Contrato de solo lectura",
  "## Taxonomía de severidad",
  "## Familias de análisis",
  "## Reglas de higiene",
  "## Protocolo de ejecución con aprobación",
  "## Contrato de salida",
  "## Agnosticismo del repositorio",
  "## Degradación y límites",
  "## Instalación y descubrimiento",
  "## Verificación",
  "## Exclusiones",
];

const FAMILIES = [
  ["F1", "Declaración y estado de submódulos"],
  ["F2", "Artefactos sin consumidor operativo"],
  ["F3", "Referencias muertas"],
  ["F4", "Contradicciones entre documentación y comportamiento"],
  ["F5", "Identificadores fijados a mano y entradas huérfanas"],
  ["F6", "Cadena de identidad de submódulos"],
  ["F7", "Duplicación documental entre consumidor y componente"],
];

const RULES = [
  ["R1", "Purga con fallo cerrado."],
  ["R2", "Sin reescritura de historial ni republicación de etiquetas."],
  ["R3", "Identificadores derivados del índice."],
  ["R4", "Revalidación del consumidor."],
  ["R5", "Sin guardado temporal en árboles con submódulos."],
  ["R6", "Destino sucio por puntero de submódulo."],
  ["R7", "Tolerancia de estado y fallo cerrado."],
  ["R8", "Orden componente antes que consumidor."],
  ["R9", "Manifiestos e índices por parche exacto."],
  ["R10", "Una sola fuente por tema."],
];

const STAGES = [
  ["P1", "Pre-verificación."],
  ["P2", "Copia aislada."],
  ["P3", "Aprobación explícita."],
  ["P4", "Orden de aplicación."],
  ["P5", "Post-verificación."],
  ["P6", "Reporte de fallo."],
];

const OUTPUT_BLOCKS = [
  "### Inventario de hallazgos",
  "### Plan de limpieza",
  "### Registro de aplicación",
  "### Estado final",
];

const SEVERITIES = ["bloqueante", "riesgo silencioso", "ruido"];

const CONFIG_KEYS = [
  "`repositorio_objetivo`",
  "`categorias_activas`",
  "`severidad_minima`",
  "`modo`",
  "`idioma`",
];

// Denylist de literales que no pueden aparecer en la skill: la hacen agnóstica.
// Los límites de palabra evitan falsos positivos con prefijos y sufijos.
const DENY_COMMON = [
  ["nombre del componente de origen", /worktree-manager/i],
  ["nombre del proyecto de origen", /flowtask/i],
  ["ruta de usuario de la maquina", /\/Users\//],
  ["ruta de inicio de usuario", /\/home\//],
  ["directorio de copias de trabajo", /\.worktrees/],
  ["directorio interno del proyecto", /\.flowtask/],
  ["directorio de ejecucion del agente", /\.opencode/],
  ["nombre de rama por defecto", /\bmain\b/],
  ["nombre de rama historico", /\bmaster\b/],
  ["identificador de revision literal", /\b[0-9a-f]{40}\b/i],
  ["nombre de etapa del origen", /phase-\d+/i],
  ["opcion especifica del origen", /preserve-dirty/i],
];

const DENY_LANGUAGES = [
  ["extensión de lenguaje de implementación", /\b(jsx|tsx|js|ts|py|rb|go|java|cs|rs|php)\b/],
];

function headings(content, level) {
  return [...content.matchAll(new RegExp(`^${level} (.+)$`, "gm"))].map((m) => m[1]);
}

function familyBody(content, id) {
  // El límite de sección es el siguiente encabezado de nivel dos o tres, o el
  // final del documento: `(?![\\s\\S])` marca el final real del texto.
  const re = new RegExp(
    `^### ${id} — [^\\n]*\\n([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`,
    "m",
  );
  const match = content.match(re);
  assert.ok(match, `SKILL.md debe contener la familia ${id}`);
  return match[1];
}

describe("repo-cleanup skill: archivos y frontmatter", () => {
  it("tiene SKILL.md y QA.md como archivos", () => {
    for (const rel of [SKILL_REL, QA_REL]) {
      const target = path.join(ROOT, rel);
      assert.ok(fs.existsSync(target), `falta ${rel}`);
      assert.ok(fs.statSync(target).isFile(), `${rel} debe ser un archivo`);
    }
  });

  it("declara el frontmatter canonico", () => {
    const content = read(SKILL_REL);
    assert.match(content, /^---\nname: repo-cleanup\n/);
    for (const field of [
      "description: >-",
      "license: MIT",
      "compatibility: opencode",
      "metadata:",
      "category: maintenance",
      "scope: repository",
    ]) {
      assert.ok(content.includes(field), `SKILL.md debe declarar ${field}`);
    }
  });

  it("el nombre del directorio coincide con el name declarado", () => {
    const content = read(SKILL_REL);
    const declared = content.match(/^name:\s*(\S+)$/m);
    assert.ok(declared, "SKILL.md debe declarar name");
    assert.equal(path.basename(SKILL_DIR), declared[1]);
  });
});

describe("repo-cleanup skill: estructura normativa", () => {
  const content = read(SKILL_REL);

  it("mantiene las catorce secciones en orden exacto", () => {
    const found = headings(content, "##");
    assert.deepEqual(found, SECTIONS.map((s) => s.replace(/^## /, "")));
  });

  it("declara las siete familias en orden y cada una prescribe una comprobacion de solo lectura", () => {
    const found = headings(content, "###").filter((h) => /^F[1-7] — /.test(h));
    assert.deepEqual(
      found,
      FAMILIES.map(([id, title]) => `${id} — ${title}`),
    );
    for (const [id] of FAMILIES) {
      const body = familyBody(content, id);
      assert.match(
        body,
        /\bgit\s+(?:-[A-Za-z]\s+)*[a-z][a-z-]*/,
        `la familia ${id} debe prescribir al menos un comando git de solo lectura`,
      );
    }
  });

  it("declara las diez reglas con sus titulos exactos", () => {
    const found = [...content.matchAll(/^- \*\*(R(?:10|[1-9])) — (.+?)\*\*/gm)];
    assert.equal(found.length, RULES.length, "debe haber exactamente diez reglas");
    RULES.forEach(([id, title], index) => {
      assert.equal(found[index][1], id);
      assert.equal(found[index][2], title);
    });
  });

  it("declara las seis etapas del protocolo con sus titulos exactos", () => {
    const found = [...content.matchAll(/^- \*\*(P[1-6]) — (.+?)\*\*/gm)];
    assert.equal(found.length, STAGES.length, "debe haber exactamente seis etapas");
    STAGES.forEach(([id, title], index) => {
      assert.equal(found[index][1], id);
      assert.equal(found[index][2], title);
    });
  });

  it("declara los cuatro bloques del contrato de salida", () => {
    for (const block of OUTPUT_BLOCKS) {
      assert.ok(content.includes(block), `SKILL.md debe contener ${block}`);
    }
  });

  it("declara las tres severidades y las cinco claves de configuracion", () => {
    const flatContent = flat(content);
    for (const severity of SEVERITIES) {
      assert.ok(flatContent.includes(severity), `SKILL.md debe definir la severidad ${severity}`);
    }
    for (const key of CONFIG_KEYS) {
      assert.ok(flatContent.includes(key), `SKILL.md debe declarar la clave ${key}`);
    }
  });

  it("declara la degradacion y la frase de agnosticismo como literales", () => {
    const flatContent = flat(content);
    assert.ok(
      flatContent.includes(
        "La skill no contiene rutas, ramas, identificadores de revisión, lenguajes de implementación, nombres de proyectos ni de hospedaje.",
      ),
      "SKILL.md debe declarar la frase de agnosticismo",
    );
    assert.ok(
      flatContent.includes(
        "Si el repositorio no declara submódulos, F1 y F6 se informan como no aplicables, no como fallo.",
      ),
      "SKILL.md debe declarar la degradacion para repositorios sin submodulos",
    );
  });
});

describe("repo-cleanup skill: agnosticismo", () => {
  it("SKILL.md no contiene literales del repositorio de origen", () => {
    const content = read(SKILL_REL);
    for (const [label, re] of DENY_COMMON) {
      assert.doesNotMatch(content, re, `SKILL.md no debe contener ${label}`);
    }
    for (const [label, re] of DENY_LANGUAGES) {
      assert.doesNotMatch(content, re, `SKILL.md no debe contener ${label}`);
    }
  });

  it("QA.md no contiene literales del repositorio de origen", () => {
    const content = read(QA_REL);
    for (const [label, re] of DENY_COMMON) {
      assert.doesNotMatch(content, re, `QA.md no debe contener ${label}`);
    }
  });

  it("QA.md usa un temporal y declara los cuatro bloques estaticos y los siete escenarios", () => {
    const content = read(QA_REL);
    assert.ok(content.includes("mktemp"), "QA.md debe trabajar en un directorio temporal");

    const estaticos = [...content.matchAll(/^### (A-0[1-4]) — /gm)];
    assert.equal(estaticos.length, 4, "QA.md debe declarar cuatro comprobaciones estaticas");
    estaticos.forEach((m, index) => assert.equal(m[1], `A-0${index + 1}`));

    const escenarios = [...content.matchAll(/^### (B-0[1-7]) — /gm)];
    assert.equal(escenarios.length, 7, "QA.md debe declarar siete escenarios de fixture");
    escenarios.forEach((m, index) => assert.equal(m[1], `B-0${index + 1}`));
  });

  it("QA.md no usa el guardado temporal del arbol como paso", () => {
    const content = read(QA_REL);
    const usos = content.split("git stash").length - 1;
    assert.equal(usos, 1, "git stash solo puede aparecer como prohibicion");
  });
});

describe("repo-cleanup skill: descubrimiento por directorio", () => {
  const installer = read(".flowtask/bin/lib/installer.js");

  it("el instalador copia el directorio de skills completo a varios destinos", () => {
    const matches = installer.match(/src:\s*"skills"/g) || [];
    assert.ok(
      matches.length >= 3,
      `ASSETS debe copiar el directorio de skills a al menos tres destinos; encontrados ${matches.length}`,
    );
  });

  it("el instalador replica las skills en el directorio del agente", () => {
    assert.ok(
      installer.includes('path.join(projectDir, ".opencode", "skills")'),
      "el instalador debe resolver el directorio de skills del agente",
    );
    assert.ok(
      installer.includes('copyDirectoryDelta(srcSkills, path.join(projectDir, ".opencode", "skills")'),
      "el instalador debe replicar el directorio de skills al actualizar",
    );
  });

  it("el instalador no requiere un registro por skill", () => {
    assert.ok(
      !installer.includes("repo-cleanup"),
      "el descubrimiento es por directorio: el instalador no debe enumerar skills",
    );
  });

  it("la documentacion declara la ausencia de registro editorial", () => {
    const doc = flat(read("docs/architecture/integracion-skills.md"));
    assert.ok(
      doc.includes("no existe un skill registry editorial"),
      "la documentacion debe declarar que no hay registro editorial de skills",
    );
  });
});
