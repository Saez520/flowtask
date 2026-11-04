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

const handshake = flat(read(".flowtask/skills/handshake-protocol/SKILL.md"));
const checkpoint = flat(read(".flowtask/skills/checkpoint-mixin/SKILL.md"));
const memoryContract = flat(read(".flowtask/skills/memory-contract/SKILL.md"));
const docs = flat(read("docs/architecture/handshake.md"));

const agentFiles = fs
  .readdirSync(AGENTS_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

function frontmatter(file) {
  const head = fs.readFileSync(path.join(AGENTS_DIR, file), "utf8").split(/\r?\n/).slice(0, 20).join("\n");
  const value = (key) => {
    const match = head.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
    return match ? match[1].trim() : null;
  };
  return { file, name: value("name"), mode: value("mode"), content: flat(fs.readFileSync(path.join(AGENTS_DIR, file), "utf8")) };
}

const definitions = agentFiles.map(frontmatter);
const orchestrator = definitions.find((definition) => definition.mode === "primary");
const subagents = definitions.filter((definition) => definition.mode === "subagent");

const SUBAGENT_IDENTITY_SECTION = "## Identidad de capa";

describe("contrato de identidad por capas", () => {
  it("declara las dos capas sin reserva", () => {
    for (const document of [handshake, docs]) {
      assert.match(document, /orquestador/);
      assert.match(document, /subagente/);
    }
    assert.match(handshake, /dos capas separadas/);
    assert.match(docs, /two separate layers/);
    assert.doesNotMatch(handshake, /reserva nominal/i);
    assert.doesNotMatch(docs, /nominal reservation/i);
  });

  it("declara el rechazo de capa desconocida sin alias", () => {
    assert.match(handshake, /layer_unknown/);
    assert.match(handshake, /sin alias/);
    assert.match(docs, /rejected as unknown/);
    assert.match(docs, /without alias/);
  });

  it("expone el parámetro work_kind y el contrato de salida completo", () => {
    assert.match(handshake, /`work_kind`/);
    assert.match(handshake, /"new"/);
    assert.match(handshake, /"existing"/);
    assert.match(handshake, /`identity_display`/);
    assert.match(handshake, /`layer_label`/);
    assert.match(handshake, /exactamente 6 campos/);
    assert.match(docs, /`identity_display`/);
    assert.match(docs, /`layer_label`/);
  });

  it("detiene ante Engram no disponible y conserva el registro previo", () => {
    assert.match(handshake, /Si `mem_search` falla[\s\S]*detenerse/);
    assert.match(handshake, /Registro previo conservado|conserva lo previamente registrado/);
    assert.match(docs, /Engram unavailable stops/);
    assert.match(docs, /preserves the previous state/);
  });

  it("detiene ante identidad faltante o distinta sin escenario sustituto", () => {
    assert.match(handshake, /detención fail-closed/i);
    assert.match(handshake, /topic_unverifiable/);
    assert.match(handshake, /topic_mismatch/);
    assert.match(docs, /topic_unverifiable/);
    assert.match(docs, /topic_mismatch/);
    assert.match(docs, /does not assign a substitute name/);
  });

  it("no conserva las reglas fail-open retiradas", () => {
    for (const document of [handshake, docs]) {
      assert.doesNotMatch(document, /asignar por orden secuencial/);
      assert.doesNotMatch(document, /degrada a caso nuevo/);
      assert.doesNotMatch(document, /fuerza Escenario A/);
      assert.doesNotMatch(document, /se marca como `?abandoned`?/);
    }
  });

  it("impone la unicidad de nombres entre trabajos activos", () => {
    assert.match(handshake, /No se reutiliza el nombre de un trabajo activo/);
    assert.match(docs, /never reuses the name of an active job/);
  });

  it("registra la capa en checkpoints y en el payload normativo", () => {
    for (const document of [checkpoint, memoryContract]) {
      assert.match(document, /layer/);
      assert.match(document, /layer_label/);
      assert.match(document, /subagent/);
      assert.match(document, /subagente/);
    }
    assert.match(checkpoint, /topic_unverifiable/);
    assert.match(checkpoint, /topic_signature/);
    assert.match(memoryContract, /CheckpointPayload/);
  });

  it("documenta la verificación ejecutable", () => {
    for (const document of [handshake, docs]) {
      assert.match(document, /node \.flowtask\/skills\/handshake-protocol\/scripts\/agent-identity\.js check --names Aitana,Kael/);
    }
  });
});

describe("identidad visible en los agentes", () => {
  it("exige un único orquestador y subagentes únicos", () => {
    assert.equal(definitions.length, 13);
    assert.ok(orchestrator, "debe existir un agente primary");
    assert.equal(orchestrator.name, "runner");
    assert.equal(subagents.length, 12);

    const names = subagents.map((definition) => definition.name);
    assert.equal(new Set(names).size, names.length, "los subagentes deben tener nombres únicos");
  });

  it("da a cada subagente la sección canónica de identidad de capa", () => {
    for (const definition of subagents) {
      assert.ok(
        definition.content.includes(SUBAGENT_IDENTITY_SECTION),
        `${definition.file} debe tener la sección ${SUBAGENT_IDENTITY_SECTION}`,
      );
      assert.match(definition.content, /\[capa: subagente\]/);
      assert.match(definition.content, /layer: "subagent"/);
      assert.match(definition.content, /layer_label: "subagente"/);
    }
  });

  it("impide que un subagente se presente como orquestador", () => {
    for (const definition of subagents) {
      assert.doesNotMatch(
        definition.content,
        /\[capa: orquestador\]/,
        `${definition.file} no puede presentar otra capa`,
      );
    }
  });

  it("identifica al orquestador en el runner", () => {
    const runnerContent = flat(readComposedRunner({ root: ROOT }));
    assert.match(runnerContent, /\[capa: orquestador\]/);
    assert.match(runnerContent, /\{identity_display\}/);
    assert.match(runnerContent, /layer: "orchestrator"/);
    assert.match(runnerContent, /layer_label: "orquestador"/);
  });

  it("agrega la capa a los ejemplos de checkpoint inline", () => {
    for (const file of ["ca-writer.md", "planner.md", "inspector.md", "review-orchestrator.md"]) {
      const definition = definitions.find((entry) => entry.file === file);
      assert.ok(definition, `debe existir ${file}`);
      const instances = definition.content.match(/instance_name: "\{Name\}"/g) ?? [];
      assert.ok(instances.length > 0, `${file} debe traer ejemplos de checkpoint`);
      const withLayer = definition.content.match(/instance_name: "\{Name\}",? layer: "subagent",? layer_label: "subagente"/g) ?? [];
      assert.equal(
        withLayer.length,
        instances.length,
        `${file} debe traer layer y layer_label en cada ejemplo de checkpoint`,
      );
    }
  });
});
