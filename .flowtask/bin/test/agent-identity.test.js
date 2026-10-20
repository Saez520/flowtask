import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HERMES_RESERVED_NAME,
  LAYERS,
  allocateBaseName,
  buildIdentity,
  classifyAgentDefinition,
  formatIdentityFailure,
  loadAgentDefinitions,
  resolveAgentsDir,
  runIdentityCheck,
  verifyConstructorContinuity,
  verifyInvocationIdentity,
} from "../../skills/handshake-protocol/scripts/agent-identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, ".flowtask", "skills", "handshake-protocol", "scripts", "agent-identity.js");

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const orchestratorIdentity = buildIdentity({ layer: "orchestrator", baseName: "Aitana" }).identity;
const subagentIdentity = buildIdentity({ layer: "subagent", baseName: "Aitana", agentType: "planner" }).identity;
const hermesIdentity = buildIdentity({ layer: "hermes" }).identity;

describe("capas de identidad", () => {
  it("expone las tres capas con su etiqueta visible", () => {
    assert.equal(LAYERS.hermes.label, "núcleo Hermes");
    assert.equal(LAYERS.hermes.devOnly, true);
    assert.equal(LAYERS.orchestrator.label, "orquestador");
    assert.equal(LAYERS.subagent.label, "subagente");
    assert.equal(LAYERS.orchestrator.devOnly, false);
    assert.equal(LAYERS.subagent.devOnly, false);
  });

  it("construye la identidad de cada capa contra su regla de nombre", () => {
    const hermes = buildIdentity({ layer: "hermes" });
    assert.equal(hermes.ok, true);
    assert.equal(hermes.identity.instance_name, HERMES_RESERVED_NAME);
    assert.equal(hermes.identity.base_name, null);
    assert.equal(hermes.identity.agent_type, null);
    assert.equal(hermes.identity.display, "[capa: núcleo Hermes] Hermes (dev-only)");
    assert.equal(hermes.identity.dev_only, true);

    const orchestrator = buildIdentity({ layer: "orchestrator", baseName: "Aitana" });
    assert.equal(orchestrator.ok, true);
    assert.equal(orchestrator.identity.instance_name, "Aitana");
    assert.equal(orchestrator.identity.agent_type, null);
    assert.equal(orchestrator.identity.display, "[capa: orquestador] Aitana");

    const subagent = buildIdentity({ layer: "subagent", baseName: "Aitana", agentType: "planner" });
    assert.equal(subagent.ok, true);
    assert.equal(subagent.identity.instance_name, "Aitana-planner");
    assert.equal(subagent.identity.base_name, "Aitana");
    assert.equal(subagent.identity.agent_type, "planner");
    assert.equal(subagent.identity.display, "[capa: subagente] Aitana-planner");
  });

  it("rechaza una capa desconocida y un nombre base vacío", () => {
    const unknown = buildIdentity({ layer: "core", baseName: "Aitana" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "layer_unknown");

    const empty = buildIdentity({ layer: "orchestrator", baseName: "  " });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "base_name_missing");

    const missingType = buildIdentity({ layer: "subagent", baseName: "Aitana" });
    assert.equal(missingType.ok, false);
    assert.equal(missingType.reason, "agent_type_missing");
  });

  it("reserva el nombre Hermes para la capa del núcleo", () => {
    const reserved = buildIdentity({ layer: "orchestrator", baseName: "Hermes" });
    assert.equal(reserved.ok, false);
    assert.equal(reserved.reason, "base_name_reserved");
    assert.match(reserved.expected, /reservado/);

    const reservedSubagent = buildIdentity({ layer: "subagent", baseName: "hermes", agentType: "planner" });
    assert.equal(reservedSubagent.ok, false);
    assert.equal(reservedSubagent.reason, "base_name_reserved");
  });
});

describe("asignación de nombre base", () => {
  it("asigna el primer nombre libre de la lista", () => {
    const result = allocateBaseName({ baseNames: ["Aitana", "Kael", "Lyra"] });
    assert.equal(result.ok, true);
    assert.equal(result.baseName, "Aitana");
  });

  it("conserva el nombre de dos trabajos activos en paralelo sin colisión", () => {
    const first = allocateBaseName({ baseNames: ["Aitana", "Kael"] });
    const second = allocateBaseName({
      baseNames: ["Aitana", "Kael"],
      activeWorks: [{ base_name: first.baseName, status: "active", work_ref: "work-a" }],
    });
    assert.equal(first.baseName, "Aitana");
    assert.equal(second.baseName, "Kael");
    assert.notEqual(first.baseName.toLowerCase(), second.baseName.toLowerCase());
  });

  it("detiene cuando el nombre pedido está ocupado", () => {
    const result = allocateBaseName({
      baseNames: ["Aitana", "Kael"],
      activeWorks: [{ base_name: "Aitana", status: "active", work_ref: "work-a" }],
      requestedBaseName: "Aitana",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "base_name_conflict");
    assert.match(result.found, /ocupado/);
  });

  it("detiene cuando la lista de nombres se agota", () => {
    const result = allocateBaseName({
      baseNames: ["Aitana"],
      activeWorks: [{ base_name: "Aitana", status: "active", work_ref: "work-a" }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "base_name_unavailable");
    assert.match(result.found, /agotada/);
  });

  it("libera el nombre de un trabajo cerrado", () => {
    const result = allocateBaseName({
      baseNames: ["Aitana", "Kael"],
      activeWorks: [{ base_name: "Aitana", status: "closed", work_ref: "work-a" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.baseName, "Aitana");
  });

  it("toma un nombre agregado a la lista sin cambiar las reglas", () => {
    const result = allocateBaseName({
      baseNames: ["Aitana", "Kael", "Zev"],
      activeWorks: [
        { base_name: "Aitana", status: "active", work_ref: "work-a" },
        { base_name: "Kael", status: "active", work_ref: "work-b" },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.baseName, "Zev");
  });

  it("detiene con nombres base duplicados", () => {
    const duplicated = allocateBaseName({ baseNames: ["Aitana", "Aitana"] });
    assert.equal(duplicated.ok, false);
    assert.equal(duplicated.reason, "duplicate_active_base_name");
    assert.match(duplicated.found, /duplicados/);

    const duplicatedActive = allocateBaseName({
      baseNames: ["Aitana", "Kael"],
      activeWorks: [
        { base_name: "Aitana", status: "active", work_ref: "work-a" },
        { base_name: "aitana", status: "active", work_ref: "work-b" },
      ],
    });
    assert.equal(duplicatedActive.ok, false);
    assert.equal(duplicatedActive.reason, "duplicate_active_base_name");
  });

  it("detiene con una lista de nombres inválida", () => {
    assert.equal(allocateBaseName({ baseNames: [] }).reason, "base_names_invalid");
    assert.equal(allocateBaseName({ baseNames: ["Aitana", "  "] }).reason, "base_names_invalid");
    assert.equal(allocateBaseName({}).reason, "base_names_invalid");
  });
});

describe("verificación de identidad invocada", () => {
  it("acepta la identidad registrada cuando la presentada coincide", () => {
    const result = verifyInvocationIdentity({ registered: subagentIdentity, presented: subagentIdentity });
    assert.equal(result.ok, true);
    assert.equal(result.resumedLiterally, true);
    assert.equal(result.identity, subagentIdentity);
  });

  it("detiene cuando la identidad falta", () => {
    const missing = verifyInvocationIdentity({ registered: subagentIdentity, presented: null });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "identity_missing");
    assert.equal(missing.action, "stop");
    assert.equal(missing.preserved, subagentIdentity);

    const noRegistered = verifyInvocationIdentity({ registered: null, presented: subagentIdentity });
    assert.equal(noRegistered.ok, false);
    assert.equal(noRegistered.reason, "identity_missing");
    assert.equal(noRegistered.action, "stop");
  });

  it("detiene cuando la identidad es distinta", () => {
    const other = buildIdentity({ layer: "subagent", baseName: "Aitana", agentType: "constructor" }).identity;
    const result = verifyInvocationIdentity({ registered: subagentIdentity, presented: other });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(result.action, "stop");
    assert.equal(result.preserved, subagentIdentity);
    assert.match(result.expected, /Aitana-planner/);
    assert.match(result.found, /Aitana-constructor/);
  });

  it("no permite que una capa se presente como otra", () => {
    const result = verifyInvocationIdentity({ registered: subagentIdentity, presented: orchestratorIdentity });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(result.action, "stop");
    assert.match(result.expected, /\[capa: subagente\]/);
    assert.match(result.found, /\[capa: orquestador\]/);
    assert.equal(result.preserved, subagentIdentity);
  });

  it("no muta la identidad registrada", () => {
    const registered = { ...subagentIdentity };
    const snapshot = JSON.stringify(registered);
    verifyInvocationIdentity({ registered, presented: orchestratorIdentity });
    assert.equal(JSON.stringify(registered), snapshot);
  });
});

describe("continuidad del constructor", () => {
  it("acepta identidad coincidente con checkpoint restaurable", () => {
    const result = verifyConstructorContinuity({
      registered: subagentIdentity,
      presented: subagentIdentity,
      checkpointRestorable: true,
    });
    assert.equal(result.ok, true);
  });

  it("detiene sin checkpoint restaurable", () => {
    const result = verifyConstructorContinuity({
      registered: subagentIdentity,
      presented: subagentIdentity,
      checkpointRestorable: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "constructor_continuity_unavailable");
    assert.equal(result.action, "stop");
    assert.equal(result.preserved, subagentIdentity);
  });

  it("detiene ante identidad faltente antes de evaluar el checkpoint", () => {
    const result = verifyConstructorContinuity({
      registered: subagentIdentity,
      presented: null,
      checkpointRestorable: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "identity_missing");
  });
});

describe("definiciones de agentes", () => {
  it("clasifica el orquestador y los subagentes por su frontmatter", () => {
    assert.deepEqual(classifyAgentDefinition({ name: "runner", mode: "primary" }), { ok: true, layer: "orchestrator" });
    assert.deepEqual(classifyAgentDefinition({ name: "planner", mode: "subagent" }), { ok: true, layer: "subagent" });

    const unknown = classifyAgentDefinition({ name: "runner", mode: "light" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "agent_layer_unknown");

    const orphan = classifyAgentDefinition({ name: "otro", mode: "primary" });
    assert.equal(orphan.ok, false);
    assert.equal(orphan.reason, "agent_layer_unknown");
  });

  it("lee el frontmatter inicial de las definiciones de agentes", () => {
    const resolved = resolveAgentsDir({ cwd: ROOT });
    assert.ok(resolved, "debe resolverse un directorio de agentes");

    const loaded = loadAgentDefinitions(resolved);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.definitions.length, 13);

    const orchestrator = loaded.definitions.find((definition) => definition.name === "runner");
    assert.equal(orchestrator.mode, "primary");

    const planner = loaded.definitions.find((definition) => definition.name === "planner");
    assert.equal(planner.mode, "subagent");
  });

  it("falla de forma cerrada cuando el directorio no existe", () => {
    const loaded = loadAgentDefinitions(path.join(ROOT, ".flowtask", "agents", "ausente"));
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, "agents_dir_missing");
  });
});

describe("check de identidad", () => {
  it("imprime una línea por capa y una por subagente", () => {
    const result = runIdentityCheck({ agentsDir: path.join(ROOT, ".flowtask", "agents"), baseNames: ["Aitana", "Kael"] });
    assert.equal(result.ok, true);
    assert.ok(result.lines.includes("[capa: núcleo Hermes] Hermes (dev-only)"));
    assert.ok(result.lines.includes("[capa: orquestador] Aitana"));
    assert.ok(result.lines.includes("[capa: subagente] Aitana-planner"));
    assert.equal(result.lines.filter((line) => line.startsWith("[capa: subagente] ")).length, 12);
    assert.equal(result.lines.filter((line) => line.startsWith("[capa: orquestador] ")).length, 1);
    assert.equal(result.lines.filter((line) => line.startsWith("[capa: núcleo Hermes] ")).length, 1);
    assert.ok(result.summary.join(" ").includes("nombres paralelos únicos"));
    assert.ok(result.summary.join(" ").includes("fail-closed"));
  });

  it("detiene ante un nombre base reservado", () => {
    const result = runIdentityCheck({ agentsDir: path.join(ROOT, ".flowtask", "agents"), baseNames: ["Hermes", "Kael"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "base_name_reserved");
    assert.match(formatIdentityFailure(result), /Hermes/);
  });

  it("detiene ante nombres base duplicados", () => {
    const result = runIdentityCheck({ agentsDir: path.join(ROOT, ".flowtask", "agents"), baseNames: ["Aitana", "Aitana"] });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "duplicate_active_base_name");
    assert.match(formatIdentityFailure(result), /duplicados/);
  });
});

describe("cli de identidad", () => {
  it("check sale 0 e imprime las tres capas y el resumen", () => {
    const result = runCli(["check", "--names", "Aitana,Kael"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[capa: orquestador\] Aitana/);
    assert.match(result.stdout, /\[capa: subagente\] Aitana-ca-writer/);
    assert.match(result.stdout, /\[capa: subagente\] Aitana-planner/);
    assert.match(result.stdout, /\[capa: núcleo Hermes\] Hermes \(dev-only\)/);
    assert.match(result.stdout, /nombres paralelos únicos/);
    assert.match(result.stdout, /fail-closed/);
    assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("[capa: subagente] ")).length, 12);
  });

  it("check sale 1 ante un nombre reservado", () => {
    const result = runCli(["check", "--names", "Hermes,Kael"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /reservado/);
    assert.match(result.stdout, /Hermes/);
    assert.doesNotMatch(result.stdout, /\[capa: orquestador\]/);
  });

  it("check sale 1 ante nombres base duplicados", () => {
    const result = runCli(["check", "--names", "Aitana,Aitana"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /duplicados/);
    assert.doesNotMatch(result.stdout, /\[capa: orquestador\]/);
  });

  it("roles sale 0 e imprime solo las identidades", () => {
    const result = runCli(["roles", "--names", "Aitana,Kael"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /\[capa: subagente\] Aitana-planner/);
    assert.doesNotMatch(result.stdout, /nombres paralelos únicos/);
    assert.doesNotMatch(result.stdout, /fail-closed/);
  });

  it("declara los nombres de ejemplo cuando no se proveen", () => {
    const result = runCli(["roles"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /nombres de ejemplo/);
  });

  it("explica los subcomandos en la ayuda", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /roles/);
    assert.match(result.stdout, /check/);
  });
});
