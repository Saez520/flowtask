import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

// La remisión válida nombra la norma y su sección: "`memory-contract`
// (Confirmación de escritura)" o "norma de `memory-contract`, Confirmación de
// escritura". Nombrar la skill sin la sección no identifica la regla aplicada.
const NORM_REFERENCE = /`memory-contract`[^.\n]{0,60}?Confirmación de escritura/;

const AGENTES_OBLIGADOS = [
  ".flowtask/agents/review-orchestrator.md",
  ".flowtask/agents/logger.md",
  ".flowtask/agents/graphify-docs-media.md",
];

const REGLAS_PROPIAS = [
  ".flowtask/skills/checkpoint-mixin/SKILL.md",
  ".flowtask/skills/agent-loop-idempotency/SKILL.md",
  ".flowtask/skills/parallel-orchestration/SKILL.md",
];

// Criterios de coincidencia que solo puede enunciar la norma. Una regla propia
// que los repita crea un segundo criterio que puede divergir del primero.
const CRITERIOS_DE_LA_NORMA = /mismo tamaño|fragmento marcador/;

function tableBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    if (i > 0 && lines[i - 1].trim().startsWith("|")) continue;
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      rows.push(lines[i]);
      i += 1;
    }
    blocks.push(rows);
  }
  return blocks;
}

function cellsOf(row) {
  return row.split("|").slice(1, -1).map((cell) => cell.trim());
}

function isSeparator(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

describe("C7 — agentes obligados por la norma de confirmación", () => {
  // gap: G1 — C7: un agente obligado sin referencia a la norma de confirmación o sin el campo persistencia en su respuesta
  it("los tres agentes sin regla propia remiten a la norma y declaran persistencia", () => {
    for (const file of AGENTES_OBLIGADOS) {
      const document = flat(read(file));
      assert.match(
        document,
        NORM_REFERENCE,
        `${file} debe remitir a memory-contract (Confirmación de escritura)`,
      );
      assert.match(
        document,
        /persistencia: confirmed \| failed/,
        `${file} debe declarar persistencia en su respuesta al runner`,
      );
      assert.match(
        document,
        /persistencia_reintentos: 0 \| 1/,
        `${file} debe declarar persistencia_reintentos`,
      );
      assert.match(
        document,
        /persistencia_fallida: NONE \| \{topic_key\}/,
        `${file} debe declarar persistencia_fallida con el topic_key afectado`,
      );
    }
  });
});

describe("C9 — reglas propias que remiten sin duplicar la norma", () => {
  // gap: G2 — C9: una regla propia que contradiga la norma o pierda su detalle
  it("las reglas propias remiten a la norma y conservan su detalle", () => {
    for (const file of REGLAS_PROPIAS) {
      const document = flat(read(file));
      assert.match(
        document,
        NORM_REFERENCE,
        `${file} debe remitir a memory-contract (Confirmación de escritura)`,
      );
      assert.doesNotMatch(
        document,
        CRITERIOS_DE_LA_NORMA,
        `${file} no puede enunciar un criterio de coincidencia paralelo al de la norma`,
      );
    }

    const checkpoint = read(".flowtask/skills/checkpoint-mixin/SKILL.md");
    assert.match(
      checkpoint,
      /persistence: "artifact_confirmed"/,
      "checkpoint-mixin conserva su marcador de persistencia del artifact",
    );
    const checkpointSentences = flat(checkpoint)
      .split(/(?<=\.)\s+/)
      .filter((sentence) => sentence.includes("Confirmación de escritura"));
    assert.ok(
      checkpointSentences.some(
        (sentence) => sentence.includes("sequence") && sentence.includes('state: "completed"'),
      ),
      "el cierre del checkpoint conserva la confirmación por clave, sequence y state: completed",
    );
    assert.ok(
      checkpointSentences.some((sentence) => sentence.includes("sequence + 1")),
      "cada actualización del checkpoint conserva la confirmación por sequence + 1",
    );

    const persistenceParagraph = read(".flowtask/skills/agent-loop-idempotency/SKILL.md")
      .split(/\n\s*\n/)
      .map(flat)
      .find((block) => block.includes("Confirmación de persistencia."));
    assert.ok(persistenceParagraph, "agent-loop-idempotency conserva el párrafo Confirmación de persistencia");
    for (const field of [
      "`schema`",
      "`execution.id`",
      "`integrity.record_version`",
      "`integrity.last_operation_id`",
      "`last_confirmed_operation_id`",
    ]) {
      assert.ok(
        persistenceParagraph.includes(field),
        `la confirmación del ledger conserva el campo propio ${field}`,
      );
    }
    assert.match(
      persistenceParagraph,
      NORM_REFERENCE,
      "la confirmación del ledger remite a la norma y conserva un único reintento",
    );

    const batchTables = tableBlocks(read(".flowtask/skills/parallel-orchestration/SKILL.md"))
      .map((rows) => rows.map(cellsOf))
      .filter((rows) => rows.some((cells) => cells.includes("`persistence_unconfirmed`")));
    assert.equal(batchTables.length, 1, "parallel-orchestration declara una sola fila de escritura sin confirmar");
    const batchRows = batchTables[0].filter((cells) => !isSeparator(cells) && cells[1] !== "Código vigente");
    const vigentes = new Set([
      "—",
      "`resource_locked`",
      "`concurrent_write_suspected`",
      "`progress_unavailable`",
      "`persistence_unconfirmed`",
    ]);
    for (const cells of batchRows) {
      assert.equal(cells.length, 5, `la fila del lote conserva sus cinco columnas: ${cells.join(" | ")}`);
      assert.ok(
        vigentes.has(cells[1]),
        `la fila del lote usa un código vigente, sin crear un motivo nuevo: ${cells[1]}`,
      );
    }
    const unconfirmedRow = batchRows.find((cells) => cells[1] === "`persistence_unconfirmed`");
    assert.match(unconfirmedRow[2], /Un único reintento/, "el lote conserva el reintento único de la norma");
    assert.match(unconfirmedRow[2], /se pausa/, "el lote conserva la pausa ante la escritura no confirmada");
    assert.ok(
      unconfirmedRow[3].length > 0 && unconfirmedRow[4].length > 0,
      "el lote conserva el estado retenido y la condición de reanudación",
    );
  });
});
