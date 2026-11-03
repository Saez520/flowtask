import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
// el whitespace para asentar frases sin depender del wrap.
const flat = (text) => text.replace(/\s+/g, " ");

const ROUTINE_WAIT_PATTERNS = [
  /espera la confirmaci[oó]n/i,
  /CHECKPOINT HUMANO/,
  /evento literal\s*`?ejecutar`?/i,
  /s[oó]lo omite confirmaciones\s+humanas/i,
  /s[oó]lo exime la espera/i,
];

/**
 * Falla si el texto vuelve a introducir una espera rutinaria posterior al gate.
 * Es la guarda compartida por todos los bloques del contrato.
 */
function assertNoRoutineWait(content) {
  for (const pattern of ROUTINE_WAIT_PATTERNS) {
    assert.doesNotMatch(content, pattern, `routine wait found: ${pattern}`);
  }
}

describe("investigacion hotfix start signal contract", () => {
  const content = read(".flowtask/skills/investigacion/SKILL.md");
  const flatContent = flat(content);

  it("uses the explicit acceptance of the diagnosis as start signal", () => {
    assert.ok(
      flatContent.includes("La aceptación explícita de la corrección acordada es la señal de inicio del hotfix"),
      "missing the hotfix start signal",
    );
    assert.ok(flatContent.includes("no se exige una segunda confirmación"), "missing the no-second-word rule");
    assert.ok(
      flatContent.includes(
        "la aceptación explícita del diagnóstico acordado como señal de inicio observable del Runner",
      ),
      "missing the isolated execution start signal",
    );
  });

  it("has no routine wait and keeps the risk consents", () => {
    assert.doesNotMatch(content, /evento literal/, "the literal event must not come back");
    assert.doesNotMatch(content, /espera una decisión explícita/, "the routine wait must not come back");
    assert.ok(
      flatContent.includes("Las acciones de riesgo conservan su consentimiento explícito"),
      "the explicit consent for risk actions must stay",
    );
  });

  it("separates declared irrecoverable failures from unverified ones", () => {
    assert.ok(
      flatContent.includes(
        "Un fallo irrecuperable declarado con evidencia y diagnóstico cierra por causa externa conservando trabajo e historial",
      ),
      "missing the declared irrecoverable closure",
    );
    assert.ok(
      flatContent.includes("un fallo irrecuperable no verificado produce pausa"),
      "missing the unverified failure pause",
    );
  });

  it("keeps the hotfix namespace and artifacts", () => {
    for (const artifact of [
      "hotfix/{id}/artifact/investigacion",
      "hotfix/{id}/artifact/plan",
      "hotfix/{id}/artifact/validacion",
    ]) {
      assert.ok(content.includes(artifact), `missing ${artifact}`);
    }
    assert.ok(content.includes("HF-{slug}"));
    assert.ok(content.includes("HF-{slug}-2"));
  });
});

describe("autonomy documentation contract", () => {
  it("publishes the autonomy page", () => {
    assert.ok(exists("docs/architecture/operational-autonomy.md"), "missing the autonomy page");
    const page = read("docs/architecture/operational-autonomy.md");
    const flatPage = flat(page);
    for (const section of [
      "## Purpose",
      "## Automatic transition after the gate",
      "## Consents that are preserved",
      "## Pause by exception",
      "## Resumption",
      "## Automatic decision record",
      "## Automatic mode",
      "## Limits",
      "## Verification",
    ]) {
      assert.ok(page.includes(section), `missing section ${section}`);
    }
    assert.ok(flatPage.includes("gate-then-auto"), "missing the autonomy policy");
    assert.ok(flatPage.includes("⏸ Pause by exception: {reason}"), "missing the canonical pause message");
    assert.ok(flatPage.includes("Preserved state:"), "missing the preserved state line");
    assert.ok(flatPage.includes("To resume:"), "missing the resume condition line");
    assert.ok(flatPage.includes("verified: false"), "missing the verified distinction");
    assertNoRoutineWait(page);
  });

  it("links the autonomy page from the architecture index", () => {
    const index = read("docs/architecture/INDEX.md");
    assert.ok(index.includes("operational-autonomy.md"), "the index must link the autonomy page");
  });

  it("describes the automatic start in the core flow", () => {
    const core = read("docs/core-flowtask.md");
    assert.ok(core.includes("AUTOMATIC START"), "missing the automatic start block");
    assert.ok(core.includes("no routine wait"), "missing the no-routine-wait note");
    assertNoRoutineWait(core);
  });

  it("keeps the hotfix start signal in the core flow, readme and presentation", () => {
    const core = read("docs/core-flowtask.md");
    const readme = read("README.md");
    const presentation = read("flowtask-presentation.md");

    assert.ok(
      flat(core).includes("that acceptance is the start signal and a second confirmation is not required"),
      "the core flow must describe the explicit acceptance as start signal",
    );
    assert.ok(
      readme.includes("explicitly accepts the agreed correction"),
      "the readme must describe the explicit acceptance",
    );
    assert.ok(
      presentation.includes("Technical gate") && presentation.includes("without waiting"),
      "the presentation must describe the technical gate without a routine wait",
    );
    assert.ok(
      presentation.includes("`--auto` does not add permissions: it declares that there is no routine wait"),
      "the presentation must describe --auto without permissions",
    );

    for (const [name, content] of [
      ["core-flowtask.md", core],
      ["README.md", readme],
      ["flowtask-presentation.md", presentation],
    ]) {
      assertNoRoutineWait(content);
      assert.doesNotMatch(content, /CHECKPOINT HUMANO/, `${name} must not restore the human checkpoint`);
      assert.doesNotMatch(content, /evento literal/, `${name} must not restore the literal event`);
    }
  });

  it("leaves the historical architecture documents untouched", () => {
    for (const historical of [
      "docs/architecture/sdd.md",
      "docs/architecture/systematic-flowtask.md",
    ]) {
      assert.ok(exists(historical), `missing ${historical}`);
    }
  });
});

describe("constructor pause and consent contract", () => {
  const content = read(".flowtask/agents/constructor.md");
  const flatContent = flat(content);

  it("does not ask for confirmation inside the approved plan", () => {
    assert.ok(
      flatContent.includes("Dentro del plan aprobado no se pide confirmación para avanzar"),
      "the constructor must not ask for confirmation inside the approved plan",
    );
  });

  it("declares the exception pause reasons", () => {
    assert.ok(flatContent.includes("Pausa por excepción"), "missing the exception pause section");
    for (const reason of [
      "falta de autoridad",
      "cambio de alcance o de requisitos",
      "límite expreso",
      "no hay hipótesis ni progreso verificable",
      "fallo externo no verificable",
      "consentimiento preservado",
    ]) {
      assert.ok(flatContent.includes(reason), `missing pause reason ${reason}`);
    }
  });

  it("uses the canonical three-line pause message", () => {
    assert.ok(flatContent.includes("⏸ Pausa por excepción: {motivo}"), "missing the pause line");
    assert.ok(flatContent.includes("Estado conservado:"), "missing the preserved state line");
    assert.ok(flatContent.includes("Para reanudar:"), "missing the resume condition line");
    assert.ok(
      flatContent.includes("no repitas acciones ya confirmadas"),
      "the constructor must not repeat already confirmed actions",
    );
  });

  it("keeps the preserved consents explicit", () => {
    for (const consent of [
      "--preserve-dirty",
      "cleanup --discard",
      "archivos protegidos",
      "trabajo ajeno",
    ]) {
      assert.ok(flatContent.includes(consent), `missing preserved consent ${consent}`);
    }
    assert.ok(
      flatContent.includes("requieren consentimiento humano explícito"),
      "the preserved consents must require explicit human consent",
    );
    assert.ok(
      flatContent.includes("Ni `--auto` ni la autonomía por política los conceden ni los sustituyen"),
      "autonomy must not grant the preserved consents",
    );
  });

  it("reports reason, preserved state and resume condition on a close conflict", () => {
    assert.ok(
      flatContent.includes(
        "El motivo del conflicto, el estado conservado (worktree, cambios y artifacts) y la condición de reanudación",
      ),
      "the conflict report must include reason, preserved state and resume condition",
    );
    assert.ok(
      flatContent.includes("resuelvas automáticamente sin esa confirmación"),
      "the constructor must not resolve conflicts automatically",
    );
  });
});

describe("runner autonomy contract", () => {
  const content = read(".flowtask/agents/runner.md");
  const flatContent = flat(content);

  it("declares the automatic transition after a gate pass", () => {
    assert.ok(flatContent.includes("Gate permitido"), "missing the gate pass message");
    assert.ok(flatContent.includes("sin espera intermedia"), "missing the no-wait transition");
    assert.ok(flatContent.includes("autonomy.decisions"), "missing the gate evidence entry");
    assert.ok(flatContent.includes("execution_gate"), "missing the execution gate policy");
    assert.ok(flatContent.includes("exception_pause"), "missing the exception pause policy");
    assert.ok(flatContent.includes("resume_gate"), "missing the resume gate policy");
    assert.ok(
      flatContent.includes(
        "orden original del desarrollador y el resultado PASS del Gate son la señal de inicio",
      ),
      "missing the start signal rule in the CA flow",
    );
  });

  it("keeps the gate failure as a single line without opening an execution", () => {
    assert.ok(
      flatContent.includes("⛔ Gate rechazado: {razón concreta}"),
      "the gate rejection must stay a single line",
    );
    assert.ok(
      flatContent.includes(
        "No se crea worktree, no se abre ejecución y no se invoca el Constructor ni el Validator",
      ),
      "a failing gate must not build, open an execution or dispatch",
    );
  });

  it("keeps the gate, the audit and the validation in force", () => {
    assert.ok(flatContent.includes("## Gate de Ejecución"), "the gate section must stay");
    assert.ok(flatContent.includes("## Control del Agent Loop"), "the loop control must stay");
    assert.ok(flatContent.includes("### Paso 5 — Validator"), "the validator step must stay");
    assert.ok(
      flatContent.includes("NUNCA omitas el Gate de Ejecución: es obligatorio en cualquier modo"),
      "the absolute restriction must forbid skipping the gate",
    );
    assert.ok(
      flatContent.includes("NUNCA confundas autonomía con consentimiento"),
      "the absolute restriction must separate autonomy from consent",
    );
  });

  it("keeps --auto free of permissions and the preserved consents", () => {
    assert.ok(
      flatContent.includes("`--auto` no altera el Gate ni los consentimientos"),
      "--auto must not alter the gate nor the consents",
    );
    assert.ok(
      flatContent.includes("Nunca autoriza preservar o descartar cambios, publicar, eliminar trabajo ajeno ni"),
      "--auto must never authorize risky actions",
    );
    for (const consent of [
      "--preserve-dirty",
      "cleanup --discard",
      "archivos protegidos",
      "eliminar trabajo ajeno",
    ]) {
      assert.ok(flatContent.includes(consent), `missing preserved consent ${consent}`);
    }
  });

  it("documents the canonical pause message and the resume conditions", () => {
    assert.ok(flatContent.includes("Pausa por excepción"), "missing the exception pause section");
    assert.ok(
      flatContent.includes("⏸ Pausa por excepción: {motivo}"),
      "missing the canonical pause message",
    );
    assert.ok(flatContent.includes("Estado conservado:"), "missing the preserved state line");
    assert.ok(flatContent.includes("Para reanudar:"), "missing the resume condition line");
    assert.ok(
      flatContent.includes("no repite comprobaciones ya verificadas ni reinicia contadores"),
      "the resume must reuse the evidence",
    );
    assert.ok(flatContent.includes("Nunca se pausa por rutina"), "the runner must not pause by routine");
  });

  it("separates declared irrecoverable failures from unverifiable ones", () => {
    assert.ok(
      flatContent.includes("Un fallo irrecuperable declarado con evidencia y diagnóstico cierra por causa externa"),
      "missing the declared irrecoverable closure",
    );
    assert.ok(
      flatContent.includes("Un fallo externo no verificable no se declara irrecuperable: es un fallo operativo"),
      "missing the unverifiable failure rule",
    );
  });

  it("uses the explicit acceptance as hotfix start signal", () => {
    assert.ok(
      flatContent.includes("la aceptación explícita de esa corrección es la señal de inicio del hotfix"),
      "missing the hotfix start signal",
    );
    assert.ok(flatContent.includes("No se espera una segunda palabra"), "missing the no-second-word rule");
  });

  it("has no routine wait after the gate", () => {
    assertNoRoutineWait(content);
  });
});

describe("agent-loop-termination pause and failure contract", () => {
  const content = read(".flowtask/skills/agent-loop-termination/SKILL.md");
  const flatContent = flat(content);

  it("requires a verifiable diagnosis to declare an irrecoverable failure", () => {
    assert.ok(flatContent.includes("diagnosis_ref"), "missing diagnosis_ref requirement");
    assert.ok(
      flatContent.includes("el fallo no se declara irrecuperable"),
      "an unverifiable failure must not be declared irrecoverable",
    );
    assert.ok(
      flatContent.includes("`progress_unavailable` o `authority_block`"),
      "an unverifiable failure must pause instead of closing",
    );
    assert.ok(
      flatContent.includes("nunca un cierre por causa externa y nunca un rechazo funcional"),
      "an operational failure must not close nor reject",
    );
  });

  it("keeps the external-cause closure for declared failures", () => {
    assert.ok(
      flatContent.includes('`close` con `verdict: "external_cause"`'),
      "the external_cause closure must stay in force",
    );
  });

  it("requires the operator report with reason, preserved state and resume condition", () => {
    assert.ok(flatContent.includes("Informe al operador"), "missing operator report section");
    assert.ok(flatContent.includes("Estado conservado"), "missing preserved state");
    assert.ok(flatContent.includes("Condición de reanudación"), "missing resume condition");
    assert.ok(
      flatContent.includes("La **verificación técnica para reanudar es la misma**"),
      "the technical verification must not depend on the profile",
    );
  });

  it("separates operational failure from functional rejection", () => {
    assert.ok(
      flatContent.includes("Un fallo operativo no es un rechazo funcional"),
      "missing the operational failure distinction",
    );
    assert.ok(
      flatContent.includes("no pide correcciones al Constructor"),
      "an operational failure must not request constructor corrections",
    );
  });

  it("does not introduce a new pause reason", () => {
    const before = [
      "invariant_violation",
      "explicit_limit",
      "authority_block",
      "no_verifiable_progress",
      "progress_unavailable",
    ];
    for (const reason of before) {
      assert.ok(flatContent.includes(reason), `missing pause reason ${reason}`);
    }
    assert.doesNotMatch(
      flatContent,
      /`pause_reason_[a-z_]+`/,
      "the termination contract must not add a new pause reason enum",
    );
  });
});

describe("agent-loop-run autonomy contract", () => {
  const content = read(".flowtask/skills/agent-loop-run/SKILL.md");
  const flatContent = flat(content);

  it("declares the gate-then-auto policy and the start signal", () => {
    assert.ok(flatContent.includes("gate-then-auto"), "missing gate-then-auto policy");
    assert.ok(flatContent.includes("PolicyDecision"), "missing PolicyDecision");
    assert.ok(flatContent.includes("autonomy"), "missing autonomy block");
    assert.ok(
      flatContent.includes("No se exige una segunda confirmación"),
      "the start signal must not require a second confirmation",
    );
  });

  it("states that the start signal is the original order plus the gate pass", () => {
    assert.ok(
      flatContent.includes("orden original del desarrollador que autoriza el trabajo"),
      "missing original developer order as part of the start signal",
    );
    assert.ok(flatContent.includes("resultado PASS del gate"), "missing gate pass in the start signal");
    assert.ok(
      flatContent.includes("aceptación explícita del diagnóstico acordado"),
      "missing explicit acceptance as hotfix start signal",
    );
  });

  it("keeps --auto free of permissions and static switches", () => {
    assert.ok(
      flatContent.includes("no altera el gate ni los consentimientos"),
      "--auto must not alter the gate nor replace consents",
    );
    assert.doesNotMatch(
      content,
      /--auto.*(?:permite|habilita|concede)/i,
      "--auto must never be described as granting permissions",
    );
    assert.ok(
      flatContent.includes("La capa de autonomía declara la iniciativa"),
      "missing the autonomy layer as the declared initiative",
    );
    assert.ok(
      flatContent.includes("no es un interruptor por flujo y no altera el gate, la auditoría, la validación ni los consentimientos"),
      "missing the rule that the autonomy layer is not a per-flow switch",
    );
    assert.ok(
      flatContent.includes("La política de ejecución sigue siendo `gate-then-auto`"),
      "missing the preserved execution policy",
    );
    assert.doesNotMatch(
      flatContent,
      /No hay interruptores por flujo ni configuración estática/,
      "the retired rule about per-flow switches and static configuration must not come back",
    );
  });

  it("declares the autonomy layer values, precedence and recorded fields", () => {
    for (const profile of ["assistant", "autonomous-dev", "hermes"]) {
      assert.ok(flatContent.includes(`\`${profile}\``), `missing autonomy profile ${profile}`);
    }
    assert.ok(
      flatContent.includes("`permisos > autonomía > persona`"),
      "missing the structural precedence between layers",
    );
    assert.ok(
      flatContent.includes("nunca lo amplía"),
      "the autonomy layer must not be allowed to widen the permission envelope",
    );
    assert.ok(flatContent.includes("`autonomy.profile`"), "missing the autonomy.profile field");
    assert.ok(flatContent.includes("`autonomy.source`"), "missing the autonomy.source field");
    assert.ok(flatContent.includes("`team`, `project`"), "missing the autonomy.source enumeration");
  });

  it("models PolicyDecision v1 with its fields and enums", () => {
    for (const field of [
      "id",
      "kind",
      "policy",
      "outcome",
      "verified",
      "reason",
      "command",
      "result",
      "evidence_refs",
      "at",
    ]) {
      assert.ok(flatContent.includes(`| \`${field}\` |`), `missing PolicyDecision field ${field}`);
    }
    assert.ok(flatContent.includes("`gate`, `pause` o `resume`"), "missing kind enumeration");
    assert.ok(
      flatContent.includes("`execution_gate`, `exception_pause` o `resume_gate`"),
      "missing policy enumeration",
    );
    assert.ok(
      flatContent.includes("`pass`, `fail`, `pause`, `resume` o `reject`"),
      "missing outcome enumeration",
    );
  });

  it("keeps the decision log append-only and blocks unverified escalation", () => {
    assert.ok(flatContent.includes("El registro es append-only"), "missing append-only rule");
    assert.ok(
      flatContent.includes("Un gate FAIL no abre ejecución y no crea registro"),
      "a failing gate must not open an execution",
    );
    assert.ok(
      flatContent.includes("`verified: false` nunca autoriza un permiso de riesgo ni un cierre"),
      "unverified decisions must not authorize risk or closure",
    );
  });

  it("adds the autonomy guarantees and the acceptance rows", () => {
    assert.ok(flatContent.includes("26. **Toda decisión automática deja evidencia.**"), "missing guarantee 26");
    assert.ok(
      flatContent.includes("27. **La reanudación reutiliza la evidencia.**"),
      "missing guarantee 27",
    );
    assert.ok(
      flatContent.includes("28. **La autonomía no concede permisos.**"),
      "missing guarantee 28",
    );
    for (const id of ["AC-31", "AC-32", "AC-33"]) {
      assert.ok(content.includes(`| ${id} |`), `missing acceptance row ${id}`);
    }
  });

  it("rejects a copy that reintroduces a routine wait", () => {
    const regressed = content.replace(
      "No se exige una segunda confirmación",
      "espera la confirmación",
    );
    assert.notEqual(regressed, content, "the regression copy must differ from the contract");
    assert.throws(() => assertNoRoutineWait(regressed), /routine wait/);
  });
});
