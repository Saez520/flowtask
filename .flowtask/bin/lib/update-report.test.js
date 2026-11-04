import assert from "node:assert/strict";
import { test } from "node:test";
import { logWarn } from "./logger.js";
import { createUpdateReport } from "./update-report.js";

/*
 * gap_ref: V8
 * criterio: el marco mide exactamente 68 columnas con cualquier contenido,
 *   incluidos caracteres de ancho 2.
 * defecto: un mensaje de aviso o error con caracteres de ancho 2 (por ejemplo
 *   un identificador con CJK) desplaza la grilla y el borde derecho deja de
 *   alinear.
 * why_not_detected: el layout trunca y rellena por code units, no por ancho de
 *   display; las comprobaciones con `awk length` cuentan bytes o code units y
 *   no detectan el desalineamiento visual. No existía prueba del renderer.
 * comportamiento observable: cada línea del tablero ocupa 68 columnas de
 *   terminal; un aviso y un error con un identificador CJK conservan el borde
 *   derecho en la columna 68.
 */
test("V8: the frame keeps 68 display columns when a notice contains wide characters", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  let report;
  try {
    report = createUpdateReport({ version: "1.27.2", color: false });
    report.begin();
    report.phase("detect", "opencode", { durationMs: 120 });
    logWarn("personality profile 漢字 not found; run flowtask update --verbose for details");
    report.fail("target 漢字 failed to synchronize; run flowtask update --verbose");
    report.finish();
  } finally {
    report?.dispose();
    console.log = originalLog;
  }

  assert.ok(lines.length > 0, "the report must emit lines");

  const bad = lines
    .map((line, index) => ({ line: index + 1, width: displayWidth(line), text: line }))
    .filter(({ width }) => width !== 68);

  assert.deepEqual(
    bad.map(({ line, width }) => `line ${line}: ${width} columns`),
    [],
    `every dashboard line must occupy 68 display columns:\n${lines.join("\n")}`,
  );
});

// Test-local width table: only the East Asian Wide/Fullwidth ranges needed to
// measure the fixture. It is not a production dependency; zero-width
// variation selectors and joiners are ignored.
function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

function isWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
