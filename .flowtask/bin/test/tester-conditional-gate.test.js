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
const MEMORY_CONTRACT = ".flowtask/skills/memory-contract/SKILL.md";
const TOPIC_KEYS = ".flowtask/skills/topic-keys-convention/SKILL.md";
const CHECKPOINT_MIXIN = ".flowtask/skills/checkpoint-mixin/SKILL.md";
const PACKAGE = ".flowtask/package.json";
const OPENCODE = "opencode.json";
const AGENTS_DIR = path.join(ROOT, ".flowtask", "agents");

// El identificador de la ejecución y el de la fase se componen por partes:
// la prueba no publica identificadores de coordinación.
const COORDINATION_ID = ["CA", "tester", "conditional", "gate"].join("-");
const COORDINATION_PATTERN = new RegExp(COORDINATION_ID, "i");
const PHASE_PATTERN = new RegExp(["F", "2", "\\.", "5"].join(""));

const FUNCTIONAL_FILES = [
  TESTER,
  RUNNER,
  VALIDATOR,
  MEMORY_CONTRACT,
  TOPIC_KEYS,
  CHECKPOINT_MIXIN,
];

const TESTER_TOKENS = [
  "## Modo de invocación",
  "mode: decide | generate",
  "## Decisión condicional",
  "regression_risk",
  "business_logic",
  "ambiguous_criterion",
  "explicit_test_request",
  "risk_not_discardable",
  "tests_required",
  "negative_evidence",
  "decision_id",
  "test-gate",
  "tests-report",
  "tests_not_required",
  "not_covered",
  "failed",
  "unverified",
  "no modifica producción",
  "no re-evalúa",
  "no inventa la lectura",
  "no agrega dependencias",
  "hilo fresco",
];

const RUNNER_TOKENS = [
  "#### Decisión de pruebas",
  "### Paso 4.5 — Generación de pruebas",
  "test_decision_ref",
  "tests_report_ref",
  "tests_required",
  "persistencia_fallida",
  "progress_unavailable",
  "no se pide confirmación",
  "no re-evalúa",
  "✔ Decisión de pruebas:",
];

const VALIDATOR_TOKENS = [
  "### Herencia del reporte de pruebas",
  "test_decision_ref",
  "tests_report_ref",
  "tests_required",
  "tests_report_missing",
  "test_decision_missing",
  "failed",
  "unverified",
  "no re-ejecuta",
];

// El orden de inicio del flujo: registro, decisión, worktree, construcción,
// generación y validación.
const RUNNER_ORDER = [
  "abre la ejecución con el `AgentRunRecord`",
  "#### Decisión de pruebas",
  "### Política de worktrees",
  "invoca constructor usando el formato canónico",
  "### Paso 4.5 — Generación de pruebas",
  "### Paso 5 — Validator",
];

// Una pregunta al desarrollador por las pruebas devuelve la espera rutinaria
// que el gate eliminó.
const TEST_QUESTION_PATTERNS = [
  /¿[^\n]{0,160}\bpruebas\b/i,
  /[^\n]{0,80}\bconfirmame\b[^\n]{0,80}\bpruebas\b/i,
];

// Un interruptor por entrega devuelve la configuración estática que el
// contrato excluye.
const TEST_SWITCH_PATTERNS = [
  /[^\n]{0,80}\b(switch|interruptor|feature[_-]?flag|toggle)\b[^\n]{0,80}\bpruebas\b/i,
  /[^\n]{0,40}\b(tests_enabled|test_generation|generar_pruebas)\b[^\n]{0,40}\b(config|configuraci[óo]n|setting|option|flag)\b/i,
];

/**
 * Contrato del Tester: dos modos, decisión condicional con evidencia negativa
 * y default conservador, y generación acotada con reporte y taxonomía.
 */
function assertTesterContract(tester) {
  const testerFlat = flat(tester);

  for (const token of TESTER_TOKENS) {
    assert.ok(testerFlat.includes(token), `tester.md debe declarar ${token}`);
  }

  assert.ok(
    testerFlat.includes("`failed` es un incumplimiento funcional"),
    "tester.md debe declarar la distinción failed: incumplimiento funcional",
  );
  assert.ok(
    testerFlat.includes("`unverified` es una limitación de herramienta"),
    "tester.md debe declarar la distinción unverified: limitación de herramienta",
  );
  assert.ok(
    testerFlat.includes("`negative_evidence`") &&
      testerFlat.includes("`tests_required: false` solo es válido con `negative_evidence`"),
    "tester.md debe exigir evidencia negativa de las cuatro condiciones",
  );
  assert.ok(
    testerFlat.includes("`risk_not_discardable`"),
    "tester.md debe registrar el riesgo no descartable ante evidencia insuficiente",
  );
  assert.ok(
    testerFlat.includes("`decision_id`") && testerFlat.includes("`ca/CA-{ID}/artifact/test-gate`"),
    "tester.md debe declarar el artifact de decisión",
  );
  assert.ok(
    testerFlat.includes("`ca/CA-{ID}/artifact/tests-report`"),
    "tester.md debe declarar el artifact de reporte de pruebas",
  );
}

/**
 * Contrato del Runner: decisión previa al worktree, generación posterior a la
 * construcción y herencia al Validator, sin espera rutinaria.
 */
function assertRunnerContract(runner) {
  const runnerFlat = flat(runner);

  for (const token of RUNNER_TOKENS) {
    assert.ok(runnerFlat.includes(token), `runner.md debe declarar ${token}`);
  }

  assert.ok(
    runnerFlat.includes(
      "El orden de inicio es: `AgentRunRecord` → decisión de pruebas → worktree → Constructor.",
    ),
    "runner.md debe declarar el orden de inicio del flujo",
  );

  let previous = -1;
  for (const marker of RUNNER_ORDER) {
    const index = runner.indexOf(marker);
    assert.ok(index > previous, `runner.md debe declarar ${marker} en orden`);
    previous = index;
  }
}

/**
 * Contrato del Validator: herencia del reporte de pruebas y veredicto según
 * la decisión registrada.
 */
function assertValidatorContract(validator) {
  const validatorFlat = flat(validator);

  for (const token of VALIDATOR_TOKENS) {
    assert.ok(validatorFlat.includes(token), `validator.md debe declarar ${token}`);
  }

  assert.ok(
    validatorFlat.includes("no se espera reporte"),
    "validator.md debe declarar que no se espera reporte cuando no hay pruebas requeridas",
  );
  assert.ok(
    validatorFlat.includes("tests_required: false"),
    "validator.md debe declarar la decisión sin pruebas requeridas",
  );
}

/**
 * Contrato de memoria: claves, owners, lectores y sufijos de la decisión
 * condicional y del reporte de pruebas.
 */
function assertMemoryContract(memoryContract, topicKeys, checkpointMixin) {
  const memoryFlat = flat(memoryContract);
  const topicFlat = flat(topicKeys);
  const checkpointFlat = flat(checkpointMixin);

  for (const row of [
    "| `ca/CA-{ID}/artifact/test-gate` | tester | Runner, Validator | `ca-artifact` |",
    "| `flow-state/CA-{ID}/test-gate` | tester | Runner, Validator | `decision` |",
    "| `ca/CA-{ID}/artifact/tests-report` | tester | Runner, Validator | `ca-artifact` |",
    "| `flow-state/{ID}/tests` | tester | Runner, Validator | `decision` |",
  ]) {
    assert.ok(memoryFlat.includes(row), `memory-contract debe declarar la fila ${row}`);
  }

  for (const row of [
    "| `ca/CA-{ID}/artifact/test-gate` | Tester | Decisión condicional de pruebas | Runner, Validator |",
    "| `flow-state/CA-{ID}/test-gate` | Tester | Estado de la decisión de pruebas | Runner, Validator |",
    "| `flow-state/CA-{ID}/test-gate` | Tester | `flow-state/CA-021/test-gate` |",
  ]) {
    assert.ok(topicFlat.includes(row), `topic-keys-convention debe declarar la fila ${row}`);
  }

  assert.ok(
    checkpointFlat.includes("| tester | `tests` (generación), `test-gate` (decisión) |"),
    "checkpoint-mixin debe mapear el tester a los sufijos de generación y decisión",
  );
  assert.ok(
    checkpointFlat.includes("El Tester mantiene tratamiento ligero en los dos checkpoints"),
    "checkpoint-mixin debe declarar que el tester conserva el tratamiento ligero",
  );
  assert.ok(
    checkpointFlat.includes("Ninguno de los dos habilita continuidad de sesión"),
    "checkpoint-mixin debe declarar que la decisión no habilita continuidad de sesión",
  );
}

/**
 * Higiene: sin identificadores de coordinación en las superficies funcionales,
 * sin agente nuevo, sin interruptor y sin cambio de versión.
 */
function assertHygiene(opencode, packageJson, agentFiles) {
  for (const relPath of FUNCTIONAL_FILES) {
    const content = read(relPath);
    assert.doesNotMatch(
      content,
      COORDINATION_PATTERN,
      `${relPath} no debe publicar el identificador de la ejecución`,
    );
    assert.doesNotMatch(
      content,
      PHASE_PATTERN,
      `${relPath} no debe publicar el identificador de la fase`,
    );
  }

  assert.doesNotMatch(
    opencode,
    /flowtask-test-gate/,
    "opencode.json no debe registrar flowtask-test-gate: el Tester ya está registrado",
  );
  assert.ok(
    opencode.includes('"flowtask-tester"'),
    "opencode.json debe conservar el registro del Tester",
  );
  assert.ok(
    !agentFiles.includes("test-gate.md"),
    "no debe agregarse un agente nuevo para la decisión de pruebas",
  );
  assert.ok(
    packageJson.includes('"version": "1.26.0"'),
    "la versión vigente no debe cambiar",
  );
}

/**
 * El contrato no admite una pregunta por las pruebas ni un interruptor por
 * entrega: las dos devolvieron la espera y la configuración estática.
 */
function assertNoWaitNorSwitch(contents) {
  const joined = contents.map(flat).join(" ");
  for (const pattern of TEST_QUESTION_PATTERNS) {
    assert.doesNotMatch(joined, pattern, `pregunta por pruebas: ${pattern}`);
  }
  for (const pattern of TEST_SWITCH_PATTERNS) {
    assert.doesNotMatch(joined, pattern, `interruptor por pruebas: ${pattern}`);
  }
}

describe("contrato de la decisión condicional de pruebas", () => {
  it("declara los dos modos y la decisión condicional del Tester", () => {
    assertTesterContract(read(TESTER));
  });

  it("declara la decisión previa y la generación posterior en el Runner", () => {
    assertRunnerContract(read(RUNNER));
  });

  it("declara la herencia del reporte de pruebas en el Validator", () => {
    assertValidatorContract(read(VALIDATOR));
  });

  it("declara las claves, los owners, los lectores y los sufijos", () => {
    assertMemoryContract(read(MEMORY_CONTRACT), read(TOPIC_KEYS), read(CHECKPOINT_MIXIN));
  });

  it("conserva la higiene de coordinación, el registro y la versión", () => {
    const agentFiles = fs
      .readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();
    assertHygiene(read(OPENCODE), read(PACKAGE), agentFiles);
  });

  it("no admite una pregunta por las pruebas ni un interruptor por entrega", () => {
    assertNoWaitNorSwitch([read(TESTER), read(RUNNER), read(VALIDATOR)]);
  });
});

describe("mutaciones del contrato de la decisión condicional", () => {
  it("rechaza una copia que pierde la decisión", () => {
    const original = read(TESTER);
    const mutated = original.replaceAll("tests_required", "flag");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterContract(mutated), /tests_required/);
  });

  it("rechaza una copia que renombra el riesgo no descartable", () => {
    const original = read(TESTER);
    const mutated = original.replaceAll("risk_not_discardable", "riesgo_ignorado");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterContract(mutated), /risk_not_discardable/);
  });

  it("rechaza una copia que pregunta al desarrollador por las pruebas", () => {
    const original = read(RUNNER);
    const mutated = `${original}\n\n¿Confirmás que genere las pruebas antes de validar?\n`;
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertNoWaitNorSwitch([mutated]), /pregunta por pruebas/);
  });

  it("rechaza una copia que agrega un interruptor por entrega", () => {
    const original = read(TESTER);
    const mutated = `${original}\n\n- Si \`tests_enabled\` está activo en la configuración, genera pruebas.\n`;
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertNoWaitNorSwitch([mutated]), /interruptor por pruebas/);
  });

  it("rechaza una copia que quita la respuesta de pruebas no requeridas", () => {
    const original = read(TESTER);
    const mutated = original.replaceAll("tests_not_required", "skip");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterContract(mutated), /tests_not_required/);
  });

  it("rechaza una copia que quita la distinción entre fallo funcional y herramienta", () => {
    const original = read(TESTER);
    const mutated = original.replace(
      "`unverified` es una limitación de herramienta o de entorno: no se pudo comprobar.",
      "",
    );
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterContract(mutated), /unverified/);
  });

  it("rechaza una copia que quita el artifact de decisión", () => {
    const original = read(TESTER);
    const mutated = original.replaceAll("test-gate", "decision-record");
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    assert.throws(() => assertTesterContract(mutated), /test-gate/);
  });

  it("rechaza una copia que registra un agente nuevo para la decisión", () => {
    const original = read(OPENCODE);
    const mutated = `${original}\n`;
    assert.notEqual(mutated, original, "la copia mutada debe diferir del contrato");
    const agentFiles = fs
      .readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith(".md"))
      .sort();
    assert.throws(
      () => assertHygiene(`${mutated}\n"flowtask-test-gate": {}\n`, read(PACKAGE), agentFiles),
      /flowtask-test-gate/,
    );
  });
});
