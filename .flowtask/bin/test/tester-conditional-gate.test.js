import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8");

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases del contrato sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const TESTER = ".flowtask/agents/tester.md";
const RUNNER = ".flowtask/agents/runner.md";
const VALIDATOR = ".flowtask/agents/validator.md";
const PLANNER = ".flowtask/agents/planner.md";
const PLAN_AUDITOR = ".flowtask/agents/plan-auditor.md";
const PLAN_TEMPLATE = ".flowtask/skills/plan-template/SKILL.md";

function assertDeclares(text, tokens, file) {
  for (const token of tokens) {
    assert.ok(text.includes(token), `${file} debe declarar ${token}`);
  }
}

function assertOmits(text, tokens, file) {
  for (const token of tokens) {
    assert.ok(!text.includes(token), `${file} no debe reintroducir ${token}`);
  }
}

/**
 * Contrato del Tester: invocación por huecos, presupuesto 1/3/0 y reporte sin
 * decisión previa. Las secciones y marcas son el contrato que consume el Runner.
 */
function assertTesterGapContract(tester) {
  const text = flat(tester);

  assertDeclares(
    text,
    [
      "## Invocación por huecos",
      "## Huecos de verificación",
      "## Presupuesto",
      "## Requisitos de cada prueba",
      "## Generación por huecos",
      "## Reporte de pruebas",
      "1 prueba por hueco",
      "techo 3",
      "default 0",
      "budget_limit",
      "missing_verification_path",
      "needs_decision",
      "no_gaps",
      "gaps_declared",
      "gaps_covered",
      "gaps_not_covered",
      "plan_ref",
      "`defecto`",
      "`why_not_detected`",
      "no incluye `decision_ref`",
    ],
    "tester.md",
  );

  assertOmits(
    text,
    [
      "mode: decide",
      "mode: generate",
      "test-gate",
      "tests_required",
      "test_decision_ref",
      "regression_risk",
      "business_logic",
      "ambiguous_criterion",
      "risk_not_discardable",
    ],
    "tester.md",
  );
}

/**
 * Contrato del flujo: registro, worktree y Constructor sin decisión previa; el
 * Paso 4.5 genera por huecos y el Validator exige el reporte cuando hay gaps.
 */
function assertRunnerValidatorFlow(runner, validator) {
  const runnerText = flat(runner);
  const validatorText = flat(validator);

  assertDeclares(
    runnerText,
    [
      "El orden de inicio es: `AgentRunRecord` → worktree → Constructor.",
      "### Paso 4.5 — Generación de pruebas por huecos",
      "tests_report_ref: NONE",
      "tests_gaps: NONE",
      "`needs_decision` → pausa con `authority_block`",
      "`state: blocked` o `persistencia_fallida` → pausa con `progress_unavailable`",
      "`tests_generated` → conservá `tests_report_ref` y `tests_gaps`",
      "Pasá al Validator `plan_ref`, `tests_report_ref` y `tests_gaps`",
      "no re-evalúa una decisión",
    ],
    "runner.md",
  );

  assertOmits(
    runnerText,
    ["#### Decisión de pruebas", "test_decision_ref", "tests_required", "mode: decide", "mode: generate"],
    "runner.md",
  );

  const order = [
    "El orden de inicio es: `AgentRunRecord` → worktree → Constructor.",
    "### Política de worktrees",
    "invoca constructor usando el formato canónico",
    "### Paso 4.5 — Generación de pruebas por huecos",
    "### Paso 5 — Validator",
  ];

  let previous = -1;
  for (const marker of order) {
    const index = runner.indexOf(marker);
    assert.ok(index > previous, `runner.md debe declarar ${marker} en orden`);
    previous = index;
  }

  assertDeclares(
    validatorText,
    [
      "### Herencia del reporte de pruebas",
      "`plan_ref`, `tests_report_ref` y `tests_gaps`",
      "No hay artifact de decisión.",
      "Sin gaps y con `tests_report_ref: NONE`, no se espera reporte",
      "`OPERATIONAL_FAILURE` con causa `tests_report_missing`",
      "Un reporte incompleto es el que no declara todos los gaps del plan.",
      "el Validator no re-ejecuta las pruebas ya comprobadas",
      "Un test `failed` es un rechazo funcional",
      "Un test `unverified` por herramienta ausente no se convierte en incumplimiento del trabajo",
    ],
    "validator.md",
  );

  assertOmits(
    validatorText,
    ["test_decision_ref", "test_decision_missing", "tests_required", "test-gate"],
    "validator.md",
  );
}

/**
 * Contrato de gobernanza: el plan declara una vía por criterio, la plantilla
 * prohíbe tareas de test y relleno, y la auditoría rechaza gaps inválidos.
 */
function assertPlannerAuditorGovernance(planner, planAuditor, planTemplate) {
  const plannerText = flat(planner);
  const auditorText = flat(planAuditor);
  const templateText = flat(planTemplate);

  assertDeclares(
    plannerText,
    [
      "## Verificación por criterio y gobierno de pruebas",
      "`existing_test`, `command`, `manual` o `gap`",
      "`gap` exige un defecto nombrado y `why_not_detected`.",
      "El plan no escribe código de prueba",
      "Solo el Tester escribe pruebas",
      "No se usan plantillas genéricas.",
      "No se duplica cobertura ya existente.",
      "No se comprueba dos veces el mismo comportamiento.",
      "formato consumido por otro componente",
    ],
    "planner.md",
  );

  assertDeclares(
    templateText,
    [
      "## Verificación por criterio",
      "`gap` requires a defect and `why_not_detected`.",
      "The plan does not write test code",
      "No generic templates",
      "no duplicate coverage",
      "Implementation + verification = ONE task",
    ],
    "plan-template/SKILL.md",
  );

  assertOmits(
    templateText,
    ["Tests after implementation", "Implementation + Test = ONE task"],
    "plan-template/SKILL.md",
  );

  assertDeclares(
    auditorText,
    [
      "### 7. Verificación por criterio y gobierno de pruebas",
      "¿Cada `gap` declara un defecto y `why_not_detected`?",
      "Un gap sin defecto o sin motivo",
      "Un gap con cobertura existente (gap de relleno)",
      "Una tarea que crea o edita tests",
      "Cobertura duplicada",
      "Un plan donde no hay tareas de prueba",
      "prosa literal no consumida",
    ],
    "plan-auditor.md",
  );
}

describe("guarda del contrato gap-driven", () => {
  /**
   * gap_ref: G-1
   * criterio: el Tester conserva la invocación por huecos y el presupuesto 1/3/0.
   * defecto: reintroducir `mode: decide`, `test-gate` o las condiciones por riesgo,
   *   o quitar el presupuesto, deja de ser visible.
   * why_not_detected: la guarda heredada afirma el contrato risk-driven; si se
   *   reintroduce, sus aserciones pasan. Ninguna otra prueba lee tester.md.
   * comportamiento observable: el contrato vigente pasa; una copia con
   *   `mode: decide` o sin `techo 3` hace fallar la guarda.
   */
  it("G-1: reintroducir la decisión por riesgo o quitar el presupuesto 1/3/0 rompe la guarda del Tester", () => {
    const tester = read(TESTER);
    assertTesterGapContract(tester);

    const withDecision = `${tester}\n\n## Modo de invocación\n\nmode: decide | generate\n`;
    assert.notEqual(withDecision, tester, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterGapContract(withDecision), /mode: decide/);

    const withoutCeiling = tester.replaceAll("techo 3", "techo ilimitado");
    assert.notEqual(withoutCeiling, tester, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterGapContract(withoutCeiling), /techo 3/);
  });

  /**
   * gap_ref: G-2
   * criterio: el flujo va del registro al worktree y al Constructor, y el
   *   Validator falla con `tests_report_missing` cuando hay gaps sin reporte.
   * defecto: una decisión antes del worktree, la pérdida de `tests_report_ref`
   *   o `tests_gaps`, o un Validator que no falla con `tests_report_missing`
   *   pasan inadvertidos.
   * why_not_detected: la guarda heredada exige `test_decision_ref` y el orden
   *   con decisión; no conoce `tests_gaps` y espera `test_decision_missing`.
   * comportamiento observable: el flujo vigente pasa; insertar
   *   `#### Decisión de pruebas` antes del worktree, quitar `tests_gaps` del
   *   Runner o `tests_report_missing` del Validator hace fallar la guarda.
   */
  it("G-2: reintroducir una decisión antes del worktree o perder el reporte de gaps rompe la guarda del flujo", () => {
    const runner = read(RUNNER);
    const validator = read(VALIDATOR);
    assertRunnerValidatorFlow(runner, validator);

    const withDecision = runner.replace(
      "### Política de worktrees",
      "#### Decisión de pruebas\n\nSe decide si generar pruebas antes del worktree.\n\n### Política de worktrees",
    );
    assert.notEqual(withDecision, runner, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertRunnerValidatorFlow(withDecision, validator), /Decisión de pruebas/);

    const withoutGaps = runner.replaceAll("tests_gaps", "gaps");
    assert.notEqual(withoutGaps, runner, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertRunnerValidatorFlow(withoutGaps, validator), /tests_gaps/);

    const withoutReportFailure = validator.replaceAll("tests_report_missing", "reporte_ausente");
    assert.notEqual(withoutReportFailure, validator, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertRunnerValidatorFlow(runner, withoutReportFailure),
      /tests_report_missing/,
    );
  });

  /**
   * gap_ref: G-3
   * criterio: Planner, plantilla y Plan-Auditor impiden gaps sin defecto, tareas
   *   de test y cobertura duplicada.
   * defecto: un gap sin defecto o motivo, una tarea que crea tests o cobertura
   *   duplicada pasan la auditoría.
   * why_not_detected: no existe guarda de la verificación por criterio ni del
   *   rechazo de relleno; el QA del plan es una lectura manual de la regla y
   *   `planner-mediated-references.test.js` solo cubre comunicación mediada.
   * comportamiento observable: el contrato vigente pasa; quitar la regla de
   *   defecto/motivo del Planner, quitar el rechazo del Plan-Auditor o volver a
   *   `Tests after implementation` en la plantilla hace fallar la guarda.
   */
  it("G-3: aprobar un gap sin defecto, una tarea de test genérica o cobertura duplicada rompe la guarda de gobernanza", () => {
    const planner = read(PLANNER);
    const planAuditor = read(PLAN_AUDITOR);
    const planTemplate = read(PLAN_TEMPLATE);
    assertPlannerAuditorGovernance(planner, planAuditor, planTemplate);

    const withoutGapRule = planner.replace(
      "`gap` exige un defecto nombrado y `why_not_detected`.",
      "",
    );
    assert.notEqual(withoutGapRule, planner, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerAuditorGovernance(withoutGapRule, planAuditor, planTemplate),
      /why_not_detected/,
    );

    const withoutRejection = planAuditor.replace("Un gap sin defecto o sin motivo", "Un gap incompleto");
    assert.notEqual(withoutRejection, planAuditor, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerAuditorGovernance(planner, withoutRejection, planTemplate),
      /gap sin defecto/,
    );

    const withFiller = `${planTemplate}\n\n- Tests after implementation\n`;
    assert.notEqual(withFiller, planTemplate, "la copia mutada debe diferir del contrato");
    assert.throws(
      () => assertPlannerAuditorGovernance(planner, planAuditor, withFiller),
      /Tests after implementation/,
    );
  });
});
