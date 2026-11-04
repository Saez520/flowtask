/**
 * Cobertura de los huecos declarados por T5 del plan del corte del runner.
 *
 * El plan exige cuatro coberturas nuevas: índice de Claude por flujo bajo el
 * límite del hook, cuerpo adaptado sin llamadas de skill, guarda de flujo
 * ausente y guarda de tamaño del núcleo. Se agrupan en tres casos para no
 * superar el techo de pruebas por entrega.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNNER_CORE_BASELINE_BYTES,
  SESSION_START_LIMIT_BYTES,
  adaptFlowBodyForClaude,
  assertRunnerCoreUnderLimit,
  buildSessionStartContent,
  parseFrontmatter,
} from "../lib/runner-content.js";
import { assertRunnerCanon } from "../lib/runner-flows.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FLOWTASK_DIR = path.join(ROOT, ".flowtask");
const SKILLS_DIR = path.join(FLOWTASK_DIR, "skills");
const RUNNER_PATH = path.join(FLOWTASK_DIR, "agents", "runner.md");

const FLOW_INDEX_LINE = /^- `skill\(\{ name: "(runner-flow-[a-z0-9-]+)" \}\)`/;

function readRunnerContent() {
  return fs.readFileSync(RUNNER_PATH, "utf8");
}

describe("runner flow delivery coverages", () => {
  /**
   * gap_ref: T5-6a (criterio C7)
   * criterio: el índice de Claude incluye una línea Read por flujo y queda bajo
   *   10 000 bytes.
   * defecto: un flujo declarado sin línea Read en el payload de Claude, o un
   *   índice que supera el límite del hook SessionStart y rompe el arranque.
   * why_not_detected: `claude-installer.test.js` solo cuenta las 13 skills
   *   declaradas; ninguna prueba verificaba las líneas de flujo ni el tamaño
   *   del índice generado con el canon real.
   * comportamiento observable: `buildSessionStartContent` sobre el canon real
   *   emite 8 líneas de flujo con ruta absoluta existente y menos de 10 000 bytes.
   */
  it("keeps one Claude Read line per flow inside the SessionStart limit", () => {
    const content = buildSessionStartContent({
      skillsDir: SKILLS_DIR,
      runnerPath: RUNNER_PATH,
      runnerContent: readRunnerContent(),
      verificationSkillsDir: SKILLS_DIR,
    });

    const flowLines = content
      .split("\n")
      .map((line) => line.match(FLOW_INDEX_LINE))
      .filter(Boolean)
      .map((match) => match[1]);

    assert.equal(flowLines.length, 8, "cada flujo declarado necesita una línea Read");
    assert.equal(new Set(flowLines).size, 8, "las líneas de flujo no se repiten");
    for (const flow of flowLines) {
      const flowPath = path.join(SKILLS_DIR, flow, "SKILL.md");
      assert.ok(
        content.includes(`**Read** \`${flowPath}\``),
        `${flow} debe resolver a una ruta absoluta del payload`,
      );
      assert.equal(fs.existsSync(flowPath), true, `${flowPath} debe existir`);
    }
    assert.ok(
      Buffer.byteLength(content, "utf8") < SESSION_START_LIMIT_BYTES,
      "el índice de arranque debe quedar bajo el límite del hook",
    );
  });

  /**
   * gap_ref: T5-6b (criterios C6/C2)
   * criterio: el cuerpo adaptado de un flujo no tiene `skill(` y todas sus
   *   rutas Read existen.
   * defecto: una llamada de skill queda sin traducir en el payload de Claude o
   *   una ruta Read apunta a un archivo inexistente; el subagente improvisa.
   * why_not_detected: la adaptación de flujos no tenía una prueba que la
   *   ejecutara sobre un flujo canónico real y resolviera sus rutas.
   * comportamiento observable: `adaptFlowBodyForClaude` sobre el flujo de
   *   delegación devuelve cero `skill(` y cada `**Read**` es absoluta y existe.
   */
  it("adapts a canonical flow body to reads that resolve inside the payload", () => {
    const flowPath = path.join(SKILLS_DIR, "runner-flow-delegacion", "SKILL.md");
    const { body } = parseFrontmatter(fs.readFileSync(flowPath, "utf8"));
    const adapted = adaptFlowBodyForClaude(body, {
      skillsDir: SKILLS_DIR,
      context: "runner-flow-delegacion",
    });

    assert.equal(adapted.includes("skill("), false, "no puede quedar una llamada skill() sin traducir");
    const reads = [...adapted.matchAll(/\*\*Read\*\* `([^`]+)`/g)].map((match) => match[1]);
    assert.ok(reads.length > 0, "el flujo adaptado debe declarar rutas de lectura");
    for (const readPath of reads) {
      assert.equal(path.isAbsolute(readPath), true, `${readPath} debe ser absoluta`);
      assert.equal(fs.existsSync(readPath), true, `${readPath} debe existir`);
    }
  });

  /**
   * gap_ref: T5-6c/T5-6d (criterios C3/C1)
   * criterio: `assertRunnerCanon` falla con `runner_flows_missing` si falta un
   *   flujo, y `assertRunnerCoreUnderLimit` falla en 97 054 bytes.
   * defecto: una instalación copia un canon incompleto o un núcleo que alcanzó
   *   el tamaño del monolito, y el respaldo fail-closed no se activa.
   * why_not_detected: las guardas existen pero ninguna prueba las ejercitaba
   *   con una copia sin flujo ni con el umbral exacto del CA.
   * comportamiento observable: el canon completo pasa; sin un flujo lanza
   *   `runner_flows_missing` con el nombre; el límite exacto lanza
   *   `runner_core_too_large` y un byte menos pasa.
   */
  it("fails closed when a flow is missing and when the core reaches the baseline size", () => {
    assert.equal(assertRunnerCanon({ flowtaskDir: FLOWTASK_DIR }).ok, true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-flows-guard-"));
    try {
      const flowtaskDir = path.join(root, ".flowtask");
      fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
      fs.copyFileSync(RUNNER_PATH, path.join(flowtaskDir, "agents", "runner.md"));
      fs.cpSync(SKILLS_DIR, path.join(flowtaskDir, "skills"), { recursive: true });
      fs.rmSync(path.join(flowtaskDir, "skills", "runner-flow-review"), { recursive: true, force: true });

      assert.throws(
        () => assertRunnerCanon({ flowtaskDir }),
        (error) => {
          assert.equal(error.code, "runner_flows_missing");
          assert.ok(Array.isArray(error.failures), "la guarda debe reportar todos los fallos");
          assert.ok(
            error.failures.some(
              (failure) =>
                failure.code === "runner_flows_missing" && failure.flow === "runner-flow-review",
            ),
            "el fallo debe nombrar el flujo ausente",
          );
          return true;
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    assert.throws(
      () => assertRunnerCoreUnderLimit("x".repeat(RUNNER_CORE_BASELINE_BYTES)),
      (error) =>
        error.code === "runner_core_too_large" &&
        error.bytes === RUNNER_CORE_BASELINE_BYTES &&
        error.limit === RUNNER_CORE_BASELINE_BYTES,
    );
    assert.equal(
      assertRunnerCoreUnderLimit("x".repeat(RUNNER_CORE_BASELINE_BYTES - 1)).length,
      RUNNER_CORE_BASELINE_BYTES - 1,
      "un byte menos que el baseline debe pasar",
    );
  });
});
