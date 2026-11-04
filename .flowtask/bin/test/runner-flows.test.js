/**
 * Cobertura de los huecos de paridad y entrega del canon del runner.
 *
 * El corte del runner exige cuatro coberturas nuevas: índice de Claude por
 * flujo bajo el límite del hook, cuerpo adaptado sin llamadas de skill, guarda
 * de flujo ausente y guarda de tamaño del núcleo. Se agrupan en tres casos para
 * no superar el techo de pruebas por entrega.
 *
 * El hotfix HF-parity-allowlist-default agrega la invocación CLI de paridad con
 * la allowlist por defecto y con un override explícito.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const CLI = path.join(FLOWTASK_DIR, "bin", "flowtask.js");
const PARITY_BASELINE = "2c23176";

const FLOW_INDEX_LINE = /^- `skill\(\{ name: "(runner-flow-[a-z0-9-]+)" \}\)`/;

const baselineProbe = spawnSync(
  "git",
  ["-C", ROOT, "cat-file", "-e", `${PARITY_BASELINE}^{commit}`],
  { encoding: "utf8" },
);
const baselineSkip =
  baselineProbe.status === 0
    ? false
    : `la baseline ${PARITY_BASELINE} no existe en este clon; la paridad no es verificable sin historia`;

function runFlowsVerify(args) {
  return spawnSync(process.execPath, [CLI, "flows", "verify", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
}

function parseFlowsReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(
      `la salida JSON no se pudo parsear (${error.message})\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

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

describe("runner parity CLI invocation", () => {
  /**
   * gap_ref: C4 (T4, HF-parity-allowlist-default)
   * criterio: `flows verify --baseline 2c23176` sin flags de allowlist sale 0,
   *   con verdict pass, missing_outside_allowlist 0 y missing_headings [].
   * defecto: el comando de aceptación vuelve a fallar en un checkout limpio
   *   porque la allowlist por defecto no se aplica, y ninguna prueba lo nota.
   * why_not_detected: `runner-flows.test.js` cubre runner-content y
   *   assertRunnerCanon; no ejercita el camino CLI de paridad.
   * comportamiento observable: la invocación por defecto desde la raíz del
   *   worktree devuelve exit 0 y un reporte de paridad sin faltantes.
   */
  it("passes parity with the default allowlist and no flags", { skip: baselineSkip }, () => {
    const result = runFlowsVerify(["--baseline", PARITY_BASELINE, "--json"]);
    const report = parseFlowsReport(result);

    assert.equal(result.status, 0, `la invocación por defecto debe salir 0\nstderr: ${result.stderr}`);
    assert.equal(report.verdict, "pass");
    assert.equal(report.parity.baseline_ref, PARITY_BASELINE);
    assert.equal(
      report.parity.missing_outside_allowlist,
      0,
      "la allowlist por defecto debe cubrir todos los deltas",
    );
    assert.deepEqual(
      report.parity.missing_headings,
      [],
      "no debe quedar un heading fuera de la allowlist",
    );
  });

  /**
   * gap_ref: C4 (T4, HF-parity-allowlist-default)
   * criterio: `--allow-deltas` explícito reemplaza al default; con un array
   *   vacío el comando sale 1 y reporta runner_parity_missing_lines.
   * defecto: el override deja de reemplazar al default y la paridad vuelve a
   *   pasar por la allowlist persistida aunque el archivo explícito esté vacío.
   * why_not_detected: no había prueba de la semántica del flag por CLI.
   * comportamiento observable: con un allowlist temporal vacío el reporte
   *   declara allowed_deltas 0, missing_outside_allowlist > 0 y el failure
   *   runner_parity_missing_lines; exit 1.
   */
  it("lets an explicit empty allowlist replace the default", { skip: baselineSkip }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-parity-explicit-"));
    try {
      const allowlistPath = path.join(dir, "allowlist.json");
      fs.writeFileSync(allowlistPath, "[]\n", "utf8");

      const result = runFlowsVerify([
        "--baseline",
        PARITY_BASELINE,
        "--allow-deltas",
        allowlistPath,
        "--json",
      ]);
      const report = parseFlowsReport(result);
      const codes = report.failures.map((failure) => failure.code);

      assert.equal(result.status, 1, "un allowlist explícito vacío debe fallar");
      assert.equal(report.verdict, "fail");
      assert.equal(
        report.parity.allowed_deltas,
        0,
        "el explícito reemplaza al default; no se fusionan",
      );
      assert.ok(report.parity.missing_outside_allowlist > 0);
      assert.ok(
        codes.includes("runner_parity_missing_lines"),
        `failures reportados: ${codes.join(", ")}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
