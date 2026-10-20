import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECK_STATUS,
  CONTRACT_VERSION,
  DEFAULT_TIMEOUT_MS,
  FINDING_SEVERITY,
  MAX_TIMEOUT_MS,
  ROUNDS,
  VERDICTS,
  aggregateVerdict,
  classifyCheckOutcome,
  discoverChecks,
  parseCliArgs,
  renderValidationReport,
  runChecks,
  runValidation,
  scanCoordinationReferences,
  validateInvocationDescriptor,
} from "../../skills/validation-contract/scripts/validation-contract.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, ".flowtask", "skills", "validation-contract", "scripts", "validation-contract.js");
const MODULE = path.join(ROOT, ".flowtask", "skills", "validation-contract", "scripts", "validation-contract.js");

// Los valores con forma de coordinación se construyen en runtime para que el
// propio archivo de prueba no contenga referencias concretas.
const COORDINATION_ID = ["CA", "ejemplo"].join("-");
const COORDINATION_HOTFIX = ["HF", "ejemplo"].join("-");
const COORDINATION_NAMESPACE = ["ca", "ejemplo", "artifact"].join("/");
const COORDINATION_FLOW = ["flow", "state"].join("-");
const COORDINATION_KEY = ["topic", "key"].join("_");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(directory, name, content) {
  const target = path.join(directory, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

function baseDescriptor(overrides = {}) {
  return {
    schema_version: CONTRACT_VERSION,
    execution_id: "ejecucion-local",
    round: ROUNDS.closure,
    environment: "development",
    project_root: ROOT,
    plan_ref: "plan-local",
    scope: {
      goal: "validar el núcleo del contrato",
      files: [],
      criteria: [{ id: "AC-1", material: true, statement: "el descriptor declara un criterio material" }],
    },
    ...overrides,
  };
}

function aggregateInput({ descriptor = {}, checkResults = [], findings = [], scanUnverified = [] } = {}) {
  return {
    descriptor: {
      round: ROUNDS.closure,
      scope: { criteria: [{ id: "AC-1", material: true, statement: "criterio material" }] },
      checks: [{ id: "c1", criteria: ["AC-1"] }],
      manual_verified: [],
      manual_unverified: [],
      ...descriptor,
    },
    checkResults,
    findings,
    scanUnverified,
  };
}

function passedResult(id = "c1", criteria = ["AC-1"]) {
  return { id, command: "node", args: [], status: CHECK_STATUS.passed, cause: null, result_summary: "ok", criteria };
}

function failedResult(id = "c1", criteria = ["AC-1"]) {
  return { id, command: "node", args: [], status: CHECK_STATUS.failed, cause: "nonzero_exit", result_summary: "fallo", criteria };
}

function unverifiedResult(id = "c1", criteria = ["AC-1"]) {
  return { id, command: "node", args: [], status: CHECK_STATUS.unverified, cause: "tool_unavailable", result_summary: "(sin salida)", criteria };
}

function runCli(args, input = null) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      input: input ?? undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("núcleo del contrato ejecutable", () => {
  it("acepta un descriptor válido de ronda de cierre", () => {
    const result = validateInvocationDescriptor(baseDescriptor());
    assert.equal(result.ok, true);
    assert.equal(result.descriptor.schema_version, CONTRACT_VERSION);
    assert.equal(result.descriptor.round, ROUNDS.closure);
    assert.equal(result.descriptor.environment, "development");
    assert.equal(result.descriptor.scope.criteria.length, 1);
    assert.equal(result.descriptor.scope.criteria[0].material, true);
  });

  it("acepta un descriptor válido de ronda intermedia sin referencia al plan", () => {
    const descriptor = baseDescriptor({ round: ROUNDS.intermediate });
    delete descriptor.plan_ref;
    const result = validateInvocationDescriptor(descriptor);
    assert.equal(result.ok, true);
    assert.equal(result.descriptor.round, ROUNDS.intermediate);
    assert.equal(result.descriptor.plan_ref, null);
  });

  it("rechaza una clave desconocida en cualquier nivel", () => {
    const unknownTop = validateInvocationDescriptor(baseDescriptor({ extra: true }));
    assert.equal(unknownTop.ok, false);
    assert.equal(unknownTop.reason, "unknown_key");
    assert.equal(unknownTop.found, "extra");

    const unknownScope = validateInvocationDescriptor(baseDescriptor({
      scope: { goal: "g", files: [], criteria: [{ id: "AC-1", statement: "s" }], extra: 1 },
    }));
    assert.equal(unknownScope.ok, false);
    assert.equal(unknownScope.reason, "unknown_key");
  });

  it("rechaza la ausencia de ejecución y un round inválido", () => {
    const noExecution = baseDescriptor();
    delete noExecution.execution_id;
    const missing = validateInvocationDescriptor(noExecution);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "execution_id_missing");

    const invalidRound = validateInvocationDescriptor(baseDescriptor({ round: "nope" }));
    assert.equal(invalidRound.ok, false);
    assert.equal(invalidRound.reason, "round_invalid");
  });

  it("exige referencia al plan en ronda de cierre", () => {
    const descriptor = baseDescriptor();
    delete descriptor.plan_ref;
    const result = validateInvocationDescriptor(descriptor);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "plan_ref_missing");
  });

  it("exige un objetivo y criterios declarados", () => {
    const noGoal = baseDescriptor({ scope: { files: [], criteria: [{ id: "AC-1", statement: "s" }] } });
    const goal = validateInvocationDescriptor(noGoal);
    assert.equal(goal.ok, false);
    assert.equal(goal.reason, "scope_goal_missing");

    const emptyCriteria = baseDescriptor({ scope: { goal: "g", files: [], criteria: [] } });
    const criteria = validateInvocationDescriptor(emptyCriteria);
    assert.equal(criteria.ok, false);
    assert.equal(criteria.reason, "scope_criteria_missing");
  });

  it("rechaza criterios duplicados y criterios sin enunciado", () => {
    const duplicated = validateInvocationDescriptor(baseDescriptor({
      scope: {
        goal: "g",
        files: [],
        criteria: [
          { id: "AC-1", statement: "uno" },
          { id: "AC-1", statement: "dos" },
        ],
      },
    }));
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.reason, "criterion_id_duplicate");

    const withoutStatement = validateInvocationDescriptor(baseDescriptor({
      scope: { goal: "g", files: [], criteria: [{ id: "AC-1" }] },
    }));
    assert.equal(withoutStatement.ok, false);
    assert.equal(withoutStatement.reason, "criterion_invalid");
  });

  it("rechaza un directorio de trabajo fuera de la raíz del proyecto", () => {
    const result = validateInvocationDescriptor(baseDescriptor({
      checks: [{ id: "c1", command: "node", args: ["-e", "process.exit(0)"], cwd: "../fuera" }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "cwd_outside_project_root");
  });

  it("rechaza comprobaciones duplicadas, shell con argumentos y timeouts fuera de rango", () => {
    const duplicated = validateInvocationDescriptor(baseDescriptor({
      checks: [
        { id: "c1", command: "node", args: [] },
        { id: "c1", command: "node", args: [] },
      ],
    }));
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.reason, "check_id_duplicate");

    const shellWithArgs = validateInvocationDescriptor(baseDescriptor({
      checks: [{ id: "c1", command: "node -e 1", args: ["-e"], shell: true }],
    }));
    assert.equal(shellWithArgs.ok, false);
    assert.equal(shellWithArgs.reason, "shell_requires_empty_args");

    const low = validateInvocationDescriptor(baseDescriptor({
      checks: [{ id: "c1", command: "node", args: [], timeout_ms: 10 }],
    }));
    assert.equal(low.ok, false);
    assert.equal(low.reason, "timeout_out_of_range");

    const high = validateInvocationDescriptor(baseDescriptor({
      checks: [{ id: "c1", command: "node", args: [], timeout_ms: MAX_TIMEOUT_MS + 1 }],
    }));
    assert.equal(high.ok, false);
    assert.equal(high.reason, "timeout_out_of_range");
  });

  it("rechaza hallazgos sin evidencia, con severidad inválida o sin criterio", () => {
    const noEvidence = validateInvocationDescriptor(baseDescriptor({
      findings: [{ severity: FINDING_SEVERITY.blocker, criterion: "AC-1", evidence: "" }],
    }));
    assert.equal(noEvidence.ok, false);
    assert.equal(noEvidence.reason, "finding_invalid");

    const badSeverity = validateInvocationDescriptor(baseDescriptor({
      findings: [{ severity: "grave", criterion: "AC-1", evidence: "algo" }],
    }));
    assert.equal(badSeverity.ok, false);
    assert.equal(badSeverity.reason, "finding_invalid");

    const blockerWithoutCriterion = validateInvocationDescriptor(baseDescriptor({
      findings: [{ severity: FINDING_SEVERITY.blocker, evidence: "algo" }],
    }));
    assert.equal(blockerWithoutCriterion.ok, false);
    assert.equal(blockerWithoutCriterion.reason, "finding_invalid");
  });

  it("rechaza referencias a criterios o comprobaciones inexistentes", () => {
    const unknownCriterion = validateInvocationDescriptor(baseDescriptor({
      manual_verified: [{ criterion: "AC-99", evidence: "revisado a mano" }],
    }));
    assert.equal(unknownCriterion.ok, false);
    assert.equal(unknownCriterion.reason, "criterion_not_found");

    const unknownCheck = validateInvocationDescriptor(baseDescriptor({
      findings: [{ severity: FINDING_SEVERITY.minor, criterion: "AC-1", evidence: "algo", check_id: "c9" }],
    }));
    assert.equal(unknownCheck.ok, false);
    assert.equal(unknownCheck.reason, "check_id_not_found");
  });

  it("rechaza decisiones de diseño incompletas", () => {
    const result = validateInvocationDescriptor(baseDescriptor({
      design_decisions: [{ id: "D-1", decision: "decisión", implemented: "sí" }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "design_decision_invalid");
  });

  it("clasifica el desenlace de una comprobación", () => {
    assert.deepEqual(classifyCheckOutcome({ exitCode: 0 }), { status: CHECK_STATUS.passed, cause: null });
    assert.deepEqual(classifyCheckOutcome({ exitCode: 1 }), { status: CHECK_STATUS.failed, cause: "nonzero_exit" });
    assert.deepEqual(
      classifyCheckOutcome({ errorCode: "ENOENT" }),
      { status: CHECK_STATUS.unverified, cause: "tool_unavailable" },
    );
    assert.deepEqual(
      classifyCheckOutcome({ timedOut: true }),
      { status: CHECK_STATUS.unverified, cause: "timeout" },
    );
    assert.deepEqual(
      classifyCheckOutcome({ exitCode: 126 }),
      { status: CHECK_STATUS.unverified, cause: "tool_unavailable" },
    );
    assert.deepEqual(
      classifyCheckOutcome({ exitCode: 127 }),
      { status: CHECK_STATUS.unverified, cause: "tool_unavailable" },
    );
    assert.deepEqual(
      classifyCheckOutcome({ signal: "SIGTERM" }),
      { status: CHECK_STATUS.unverified, cause: "signal" },
    );
    assert.deepEqual(
      classifyCheckOutcome({ errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      { status: CHECK_STATUS.unverified, cause: "output_limit" },
    );
  });

  it("renderiza el reporte con conteos y sin indicador numérico de aprobación", () => {
    const aggregate = aggregateVerdict(aggregateInput({ checkResults: [passedResult()] }));
    const report = renderValidationReport({
      descriptor: {
        execution_id: "ejecucion-local",
        round: ROUNDS.closure,
        environment: "development",
        plan_ref: "plan-local",
        scope: { goal: "objetivo", files: ["a.js"], criteria: [{ id: "AC-1", material: true, statement: "s" }] },
        manual_unverified: [],
      },
      checkResults: [passedResult()],
      findings: [],
      verdict: aggregate,
      criteria: aggregate.criteria,
      designDecisions: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(report.evidence.schema_version, CONTRACT_VERSION);
    assert.equal(report.evidence.generated_at, "2026-01-01T00:00:00.000Z");
    assert.equal(report.evidence.verdict, VERDICTS.approved);
    assert.doesNotMatch(report.markdown, /Score/i);
    assert.match(report.markdown, /## Comprobaciones/);
    assert.match(report.markdown, /## Criterios/);
    assert.match(report.markdown, /## Bloqueantes/);
    assert.match(report.markdown, /## Menores/);
    assert.match(report.markdown, /## No verificado/);
    assert.match(report.markdown, /## Decisiones de diseño/);
    assert.match(report.markdown, /## Evidencia/);
    assert.match(report.markdown, /```json/);
    assert.match(report.markdown, /## Conteos/);
  });

  it("no escribe en el repositorio desde el módulo", () => {
    const source = fs.readFileSync(MODULE, "utf8");
    for (const forbidden of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync"]) {
      assert.equal(source.includes(forbidden), false, `el módulo no debe usar ${forbidden}`);
    }
  });
});

describe("veredicto agregado", () => {
  it("rechaza cuando existe un hallazgo bloqueante", () => {
    const result = aggregateVerdict(aggregateInput({
      checkResults: [passedResult()],
      findings: [{ severity: FINDING_SEVERITY.blocker, criterion: "AC-1", evidence: "bloqueante" }],
    }));
    assert.equal(result.verdict, VERDICTS.rejected);
    assert.equal(result.final, false);
  });

  it("produce fallo operativo cuando hay comprobaciones no verificadas", () => {
    const result = aggregateVerdict(aggregateInput({ checkResults: [unverifiedResult()] }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
    assert.equal(result.final, false);
  });

  it("produce fallo operativo cuando una comprobación falla sin disposición", () => {
    const result = aggregateVerdict(aggregateInput({ checkResults: [failedResult()] }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
  });

  it("rechaza cuando una comprobación fallida está vinculada a un bloqueante", () => {
    const result = aggregateVerdict(aggregateInput({
      checkResults: [failedResult()],
      findings: [{ severity: FINDING_SEVERITY.blocker, criterion: "AC-1", evidence: "roto", check_id: "c1" }],
    }));
    assert.equal(result.verdict, VERDICTS.rejected);
  });

  it("produce fallo operativo cuando una comprobación fallida se declara no verificada", () => {
    const result = aggregateVerdict(aggregateInput({
      descriptor: { manual_unverified: [{ criterion: "AC-1", cause: "sin permisos", check_id: "c1" }] },
      checkResults: [failedResult()],
    }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
  });

  it("produce fallo operativo cuando un criterio material queda sin cubrir", () => {
    const result = aggregateVerdict(aggregateInput({
      descriptor: { checks: [{ id: "c1", criteria: [] }] },
      checkResults: [{ ...passedResult(), criteria: [] }],
    }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
  });

  it("aprueba cuando todo criterio material queda cubierto", () => {
    const result = aggregateVerdict(aggregateInput({ checkResults: [passedResult()] }));
    assert.equal(result.verdict, VERDICTS.approved);
    assert.equal(result.criteria[0].state, "verified");
    assert.equal(result.counts.criteria.verified, 1);
  });

  it("no aprueba sin ninguna comprobación exitosa aunque la verificación manual cubra el criterio", () => {
    const result = aggregateVerdict(aggregateInput({
      descriptor: {
        checks: [],
        manual_verified: [{ criterion: "AC-1", evidence: "revisado a mano" }],
      },
      checkResults: [],
    }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
  });

  it("aprueba cuando una comprobación exitosa cubre el criterio junto a una verificación manual", () => {
    const result = aggregateVerdict(aggregateInput({
      descriptor: {
        scope: { criteria: [
          { id: "AC-1", material: true, statement: "criterio material" },
          { id: "AC-2", material: true, statement: "criterio manual" },
        ] },
        checks: [{ id: "c1", criteria: ["AC-1"] }],
        manual_verified: [{ criterion: "AC-2", evidence: "revisado a mano" }],
      },
      checkResults: [passedResult("c1", ["AC-1"])],
    }));
    assert.equal(result.verdict, VERDICTS.approved);
    assert.equal(result.criteria[1].state, "verified");
  });

  it("produce fallo operativo cuando no hay criterios materiales", () => {
    const result = aggregateVerdict(aggregateInput({
      descriptor: {
        scope: { criteria: [{ id: "AC-1", material: false, statement: "no material" }] },
        checks: [{ id: "c1", criteria: ["AC-1"] }],
      },
      checkResults: [passedResult()],
    }));
    assert.equal(result.verdict, VERDICTS.operational_failure);
  });

  it("solo marca final en ronda de cierre aprobada", () => {
    const closure = aggregateVerdict(aggregateInput({ checkResults: [passedResult()] }));
    assert.equal(closure.final, true);

    const intermediate = aggregateVerdict(aggregateInput({
      descriptor: { round: ROUNDS.intermediate },
      checkResults: [passedResult()],
    }));
    assert.equal(intermediate.verdict, VERDICTS.approved);
    assert.equal(intermediate.final, false);
  });

  it("produce el mismo veredicto en desarrollo y en producción", () => {
    const development = aggregateVerdict(aggregateInput({ checkResults: [passedResult()] }));
    const production = aggregateVerdict(aggregateInput({ checkResults: [passedResult()] }));
    assert.equal(development.verdict, production.verdict);
    assert.equal(development.final, production.final);
  });

  it("cuenta hallazgos, comprobaciones y criterios", () => {
    const result = aggregateVerdict(aggregateInput({
      checkResults: [passedResult(), failedResult("c2")],
      findings: [
        { severity: FINDING_SEVERITY.minor, criterion: "AC-1", evidence: "mejora" },
      ],
    }));
    assert.equal(result.counts.checks.total, 2);
    assert.equal(result.counts.findings.minor, 1);
    assert.equal(result.counts.criteria.total, 1);
  });
});

describe("escáner de referencias de coordinación", () => {
  it("detecta identificadores, namespaces, rutas de estado y claves literales", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, "ids.js", `const a = "${COORDINATION_ID}";\nconst b = "${COORDINATION_HOTFIX}";\n`);
    writeFile(directory, "namespace.js", `const c = "${COORDINATION_NAMESPACE}/plan";\n`);
    writeFile(directory, "flow.js", `const d = "${COORDINATION_FLOW}/${COORDINATION_ID}/construct";\n`);
    writeFile(directory, "key.js", `const e = { ${COORDINATION_KEY}: "valor" };\n`);

    const result = scanCoordinationReferences({ files: ["ids.js", "namespace.js", "flow.js", "key.js"], projectRoot: directory });
    assert.equal(result.findings.length >= 4, true);
    for (const finding of result.findings) {
      assert.equal(finding.severity, FINDING_SEVERITY.blocker);
      assert.equal(finding.source, "scanner");
      assert.equal(finding.evidence.length <= 240, true);
    }
    assert.equal(result.unverified.length, 0);
  });

  it("no detecta placeholders ni nombres genéricos", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, "placeholder.js", "const a = \"{execution_id}\";\nconst b = \"{artifact_namespace}\";\n");
    const result = scanCoordinationReferences({ files: ["placeholder.js"], projectRoot: directory });
    assert.equal(result.findings.length, 0);
  });

  it("respeta los literales permitidos", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, "allowed.js", `const a = "${COORDINATION_ID}";\n`);
    const result = scanCoordinationReferences({
      files: ["allowed.js"],
      projectRoot: directory,
      allowedLiterals: [COORDINATION_ID],
    });
    assert.equal(result.findings.length, 0);
  });

  it("excluye por defecto los directorios de configuración y el historial", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, "node_modules/pkg/index.js", `const a = "${COORDINATION_ID}";\n`);
    writeFile(directory, ".git/config", `const a = "${COORDINATION_ID}";\n`);
    writeFile(directory, "docs/project-history.md", `const a = "${COORDINATION_ID}";\n`);
    writeFile(directory, "docs/roadmap/notas.md", `const a = "${COORDINATION_ID}";\n`);
    writeFile(directory, "src/app.js", `const a = "${COORDINATION_ID}";\n`);

    const result = scanCoordinationReferences({ files: ["."], projectRoot: directory });
    const paths = result.findings.map((finding) => finding.path);
    assert.equal(paths.includes("src/app.js"), true);
    assert.equal(paths.some((item) => item.startsWith("node_modules/")), false);
    assert.equal(paths.some((item) => item.startsWith(".git/")), false);
    assert.equal(paths.includes("docs/project-history.md"), false);
    assert.equal(paths.some((item) => item.startsWith("docs/roadmap/")), false);
  });

  it("escanea un archivo explícito dentro del directorio de configuración", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, ".flowtask/bin/prueba.js", `const a = "${COORDINATION_ID}";\n`);
    const result = scanCoordinationReferences({ files: [".flowtask/bin/prueba.js"], projectRoot: directory });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, ".flowtask/bin/prueba.js");
  });

  it("marca como no verificado un archivo ilegible o binario", () => {
    const directory = tempDir("vc-scan-");
    writeFile(directory, "binario.js", "const a = 1;\0const b = 2;\n");
    const result = scanCoordinationReferences({ files: ["binario.js"], projectRoot: directory });
    assert.equal(result.findings.length, 0);
    assert.equal(result.unverified.length, 1);
    assert.equal(result.unverified[0].cause, "binary");
  });
});

describe("integración de ejecución y CLI", () => {
  it("aprueba cuando la comprobación declarada termina con éxito", () => {
    const descriptor = baseDescriptor({
      checks: [{ id: "ok", command: "node", args: ["-e", "process.exit(0)"], criteria: ["AC-1"] }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.verdict, VERDICTS.approved);
    assert.equal(outcome.result.final, true);
    assert.equal(outcome.result.checks[0].status, CHECK_STATUS.passed);
  });

  it("produce fallo operativo cuando la comprobación falla sin hallazgo", () => {
    const descriptor = baseDescriptor({
      checks: [{ id: "ko", command: "node", args: ["-e", "process.exit(1)"], criteria: ["AC-1"] }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.result.verdict, VERDICTS.operational_failure);
  });

  it("rechaza cuando la comprobación fallida queda vinculada a un bloqueante", () => {
    const descriptor = baseDescriptor({
      checks: [{ id: "ko", command: "node", args: ["-e", "process.exit(1)"], criteria: ["AC-1"] }],
      findings: [{ severity: FINDING_SEVERITY.blocker, criterion: "AC-1", evidence: "la comprobación falló", check_id: "ko" }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.result.verdict, VERDICTS.rejected);
  });

  it("clasifica como no verificada una herramienta inexistente", () => {
    const descriptor = baseDescriptor({
      checks: [{ id: "ausente", command: "herramienta-inexistente-xyz", args: [], criteria: ["AC-1"] }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.result.checks[0].status, CHECK_STATUS.unverified);
    assert.equal(outcome.result.checks[0].cause, "tool_unavailable");
    assert.equal(outcome.result.verdict, VERDICTS.operational_failure);
  });

  it("clasifica como no verificada una comprobación que excede el tiempo límite", () => {
    const descriptor = baseDescriptor({
      checks: [{
        id: "lenta",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeout_ms: 100,
        criteria: ["AC-1"],
      }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.result.checks[0].status, CHECK_STATUS.unverified);
    assert.equal(outcome.result.checks[0].cause, "timeout");
  });

  it("rechaza un directorio de trabajo fuera de la raíz del proyecto", () => {
    const descriptor = baseDescriptor({
      checks: [{ id: "c1", command: "node", args: ["-e", "process.exit(0)"], cwd: "../fuera" }],
    });
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "cwd_outside_project_root");
  });

  it("usa un ejecutor inyectado sin lanzar procesos", () => {
    const calls = [];
    const results = runChecks({
      checks: [{ id: "inyectada", command: "node", args: ["-e", "process.exit(0)"] }],
      projectRoot: ROOT,
      executor: (call) => {
        calls.push(call);
        return { status: 0, stdout: "listo\n", stderr: "", signal: null, error: null };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(results[0].status, CHECK_STATUS.passed);
    assert.equal(results[0].result_summary, "listo");
  });

  it("descubre las comprobaciones del proyecto sin ejecutarlas", () => {
    const discovery = discoverChecks({ projectRoot: ROOT });
    assert.equal(discovery.ok, true);
    const ids = discovery.checks.map((check) => check.id);
    assert.equal(ids.includes("flowtask-tests"), true);
    assert.equal(new Set(ids).size, ids.length);
    for (const check of discovery.checks) {
      assert.deepEqual(check.criteria, []);
    }
  });

  it("no modifica los archivos del alcance durante la validación", () => {
    const directory = tempDir("vc-fixture-");
    const fixture = writeFile(directory, "dato.txt", "contenido estable\n");
    const before = fs.statSync(fixture);
    const beforeHash = crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");

    const descriptor = {
      ...baseDescriptor(),
      project_root: directory,
      plan_ref: "plan-local",
      scope: { goal: "comprobar que nada cambia", files: ["dato.txt"], criteria: [{ id: "AC-1", statement: "el archivo no cambia" }] },
      checks: [{ id: "ok", command: "node", args: ["-e", "process.exit(0)"], criteria: ["AC-1"] }],
    };
    const outcome = runValidation({ descriptor });
    assert.equal(outcome.ok, true);

    const after = fs.statSync(fixture);
    const afterHash = crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");
    assert.equal(afterHash, beforeHash);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  });

  it("muestra la ayuda con uso, subcomandos y códigos", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Uso:/);
    assert.match(result.stdout, /Subcomandos:/);
    assert.match(result.stdout, /Códigos de salida/);
  });

  it("ejecuta la validación desde un archivo y desde la entrada estándar", () => {
    const directory = tempDir("vc-cli-");
    const descriptorPath = writeFile(directory, "descriptor.json", JSON.stringify(baseDescriptor({
      checks: [{ id: "ok", command: "node", args: ["-e", "process.exit(0)"], criteria: ["AC-1"] }],
    })));

    const fromFile = runCli(["run", "--input", descriptorPath, "--json"]);
    assert.equal(fromFile.status, 0);
    const parsed = JSON.parse(fromFile.stdout);
    assert.equal(parsed.verdict, VERDICTS.approved);
    assert.equal(parsed.final, true);

    const payload = JSON.stringify(baseDescriptor({
      checks: [{ id: "ok", command: "node", args: ["-e", "process.exit(0)"], criteria: ["AC-1"] }],
    }));
    const fromStdin = runCli(["run", "--input", "-", "--json"], payload);
    assert.equal(fromStdin.status, 0);
    assert.equal(JSON.parse(fromStdin.stdout).verdict, VERDICTS.approved);
  });

  it("devuelve el código de contrato inválido ante un round desconocido", () => {
    const directory = tempDir("vc-cli-");
    const descriptorPath = writeFile(directory, "descriptor.json", JSON.stringify({ round: "nope" }));
    const result = runCli(["run", "--input", descriptorPath]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /round_invalid/);
  });

  it("devuelve el código de fallo operativo ante una herramienta ausente", () => {
    const directory = tempDir("vc-cli-");
    const descriptorPath = writeFile(directory, "descriptor.json", JSON.stringify(baseDescriptor({
      checks: [{ id: "ausente", command: "herramienta-inexistente-xyz", args: [], criteria: ["AC-1"] }],
    })));
    const result = runCli(["run", "--input", descriptorPath, "--json"]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).verdict, VERDICTS.operational_failure);
  });

  it("devuelve el código de rechazo funcional ante un bloqueante", () => {
    const directory = tempDir("vc-cli-");
    const descriptorPath = writeFile(directory, "descriptor.json", JSON.stringify(baseDescriptor({
      checks: [{ id: "ok", command: "node", args: ["-e", "process.exit(0)"], criteria: ["AC-1"] }],
      findings: [{ severity: FINDING_SEVERITY.blocker, criterion: "AC-1", evidence: "bloqueante" }],
    })));
    const result = runCli(["run", "--input", descriptorPath]);
    assert.equal(result.status, 1);
  });

  it("lista las comprobaciones descubiertas con el subcomando discover", () => {
    const result = runCli(["discover", "--project-root", ROOT, "--json"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.checks.some((check) => check.id === "flowtask-tests"), true);
  });

  it("parsea las opciones del CLI", () => {
    const options = parseCliArgs(["run", "--input", "-", "--project-root", "/tmp/x", "--json", "--timeout-ms", "500"]);
    assert.equal(options.command, "run");
    assert.equal(options.input, "-");
    assert.equal(options.projectRoot, "/tmp/x");
    assert.equal(options.json, true);
    assert.equal(options.timeoutMs, 500);
  });
});
