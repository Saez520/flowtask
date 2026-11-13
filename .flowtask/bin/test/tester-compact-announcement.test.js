import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8");

const TESTER = ".flowtask/agents/tester.md";
const REQUIREMENTS = "## Requisitos de cada prueba";
const REPORT = "## Reporte de pruebas";

// El contrato vive en Markdown: se recorta la sección exacta para que las
// aserciones no dependan de otras secciones del mismo archivo.
function section(text, heading, closing) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `tester.md debe declarar ${heading}`);
  const end = text.indexOf(closing, start + heading.length);
  assert.notEqual(end, -1, `tester.md debe cerrar ${heading} con ${closing}`);
  return text.slice(start, end);
}

function assertSingleLineAnnouncement(tester) {
  const requirements = section(tester, REQUIREMENTS, "## Generación por huecos");

  assert.match(
    requirements,
    /gap: G\d+ — <defecto/,
    "tester.md debe anunciar cada prueba con una sola línea `gap: G<n> — <defecto>`",
  );
  assert.match(
    requirements,
    /una sola línea/,
    "tester.md debe declarar que el anuncio ocupa una sola línea",
  );
  assert.match(
    requirements,
    /no agregues metadatos por prueba/i,
    "tester.md no debe admitir metadatos por prueba en el cuerpo del cambio",
  );
  assert.doesNotMatch(
    requirements,
    /^\s*\|/m,
    "## Requisitos de cada prueba no debe reintroducir una tabla de metadatos por prueba",
  );
  assert.match(
    requirements,
    /Los otros cuatro datos viven en el reporte/,
    "tester.md debe remitir el detalle por prueba al reporte",
  );
}

function assertReportCarriesFourData(tester) {
  const report = section(tester, REPORT, "### Persistencia");
  const generatedRow = report
    .split("\n")
    .find((line) => /^\|\s*`generated`\s*\|/.test(line));

  assert.ok(generatedRow, "## Reporte de pruebas debe declarar la fila `generated`");

  for (const field of [
    "criterio",
    "defecto",
    "why_not_detected",
    "comportamiento observable",
  ]) {
    assert.ok(
      generatedRow.includes(field),
      `la fila generated debe declarar ${field} por prueba`,
    );
  }
}

describe("contrato compacto del Tester", () => {
  // gap: G1 — un bloque de cinco campos o la ausencia del anuncio pasa la guarda
  it("G1: un bloque de metadatos por prueba o la ausencia del anuncio rompe la guarda del Tester", () => {
    const tester = read(TESTER);
    assertSingleLineAnnouncement(tester);

    const withoutAnnouncement = tester.replace(
      /Cada prueba se anuncia en el cuerpo del cambio con una sola línea:[^\n]*\n/,
      "",
    );
    assert.notEqual(withoutAnnouncement, tester, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSingleLineAnnouncement(withoutAnnouncement), /gap: G/);

    const withFieldBlock = tester.replace(
      "No agregues metadatos por prueba en el cuerpo del cambio.",
      "No agregues metadatos por prueba en el cuerpo del cambio.\n\n" +
        "| Campo | Contenido |\n" +
        "|-------|-----------|\n" +
        "| `gap_ref` | G1 |\n" +
        "| `criterio` | C6 |\n" +
        "| `defecto` | bloque de metadatos |\n" +
        "| `why_not_detected` | la guarda no mira el formato |\n" +
        "| `comportamiento observable` | el anuncio desaparece |\n",
    );
    assert.notEqual(withFieldBlock, tester, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertSingleLineAnnouncement(withFieldBlock), /tabla de metadatos/);
  });

  // gap: G2 — compactar el anuncio pierde criterio, defecto, motivo o comportamiento observable
  it("G2: perder criterio, defecto, motivo o comportamiento observable en la fila generated rompe la guarda del reporte", () => {
    const tester = read(TESTER);
    assertReportCarriesFourData(tester);

    for (const field of [
      "criterio",
      "defecto",
      "why_not_detected",
      "comportamiento observable",
    ]) {
      const withoutField = tester.replace(
        /(^\|\s*`generated`\s*\|.*$)/m,
        (row) => row.replace(field, ""),
      );
      assert.notEqual(
        withoutField,
        tester,
        `la copia mutada sin ${field} debe diferir del contrato`,
      );
      assert.throws(() => assertReportCarriesFourData(withoutField), new RegExp(field));
    }
  });
});
