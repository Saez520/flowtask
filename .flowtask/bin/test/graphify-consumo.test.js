import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
let fixtureRoot;
let claudeFixtureRoot;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "graphify-consumo-"));
  claudeFixtureRoot = path.join(fixtureRoot, "claude");
  await mkdir(path.join(claudeFixtureRoot, "agents"), { recursive: true });
  await mkdir(path.join(claudeFixtureRoot, "flowtask", "skills", "graphify-protocol"), { recursive: true });

  await writeFile(
    path.join(claudeFixtureRoot, "agents", "flowtask-ca-writer.md"),
    "flowtask-ca-writer\n\ngraphify-protocol\nmemory-protocol\nConsulta Graphify\n.worktrees/",
    "utf8",
  );
  await writeFile(
    path.join(claudeFixtureRoot, "agents", "flowtask-planner.md"),
    "flowtask-planner\n\ngraphify-protocol\nmemory-protocol\nEvidencia verificable del grafo\nG-001\n**Consulta:**\n**Vía:**\n**Referencias:**\nSin evidencia derivada del grafo",
    "utf8",
  );

  const canonical = fs.readFileSync(path.join(ROOT, ".flowtask/skills/graphify-protocol/SKILL.md"), "utf8");
  await writeFile(
    path.join(claudeFixtureRoot, "flowtask", "skills", "graphify-protocol", "SKILL.md"),
    canonical.replace("compatibility: opencode", "compatibility: claude-code"),
    "utf8",
  );
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  assert.equal(fs.existsSync(fixtureRoot), false, "temporary fixtures should be removed");
});

function readRelative(relPath) {
  const sourcePath = path.join(ROOT, relPath);
  return fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : null;
}

function readFixture(relPath) {
  return fs.readFileSync(path.join(claudeFixtureRoot, relPath), "utf8");
}

describe("graphify-protocol MCP-only contract", () => {
  const skillPath = ".flowtask/skills/graphify-protocol/SKILL.md";

  it("keeps MCP as the only Graphify query path", () => {
    const content = readRelative(skillPath);
    assert.ok(content.includes("graphify_query_graph"));
    assert.ok(content.includes("búsqueda normal del proyecto"));
    assert.ok(content.includes("no pude consultar el grafo, estoy usando búsqueda normal"));
    assert.doesNotMatch(content, /node \.flowtask\/bin\/flowtask\.js graphify query --query/);
    assert.doesNotMatch(content, /source.*local/);
  });

  it("preserves evidence and worktree safety contracts", () => {
    const content = readRelative(skillPath);
    for (const required of [
      "## Evidencia verificable del grafo",
      "G-001",
      "**Consulta:**",
      "**Vía:**",
      "**Estado:**",
      "**Hallazgo:**",
      "**Referencias:**",
      "**Fecha/commit:**",
      "Sin evidencia derivada del grafo: se usó búsqueda normal",
      ".worktrees/",
    ]) assert.ok(content.includes(required), `missing ${required}`);
    assert.ok(content.includes("shim deprecated"));
  });
});

describe("graphify-protocol mirrors", () => {
  it("keeps the Claude normative content equal to the canonical skill", () => {
    const canonical = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");
    const claude = readFixture("flowtask/skills/graphify-protocol/SKILL.md");
    const normative = (text) => text.split("---").slice(2).join("---").trim();

    assert.equal(claude.includes("compatibility: claude-code"), true);
    assert.equal(normative(claude), normative(canonical));
  });
});

describe("Graphify agent integration", () => {
  it("removes the local fallback from the canonical agents and runner", () => {
    for (const relPath of [
      ".flowtask/agents/ca-writer.md",
      ".flowtask/agents/planner.md",
      ".flowtask/agents/runner.md",
      ".flowtask/skills/investigacion/SKILL.md",
    ]) {
      const content = readRelative(relPath);
      assert.ok(content.includes("graphify"), `${relPath} should retain Graphify context`);
      assert.doesNotMatch(content, /node \.flowtask\/bin\/flowtask\.js graphify query/);
      assert.doesNotMatch(content, /CLI local/);
    }
  });

  it("keeps the agents on their documented MCP/Inspector or normal-search path", () => {
    const caWriter = readRelative(".flowtask/agents/ca-writer.md");
    const planner = readRelative(".flowtask/agents/planner.md");
    const runner = readRelative(".flowtask/agents/runner.md");
    // Los contratos viven en Markdown con saltos de línea arbitrarios: se aplana
    // el whitespace para asentar frases del contrato sin depender del wrap.
    const flat = (text) => text.replace(/\s+/g, " ");
    const runnerFlat = flat(runner);

    assert.ok(caWriter.includes("búsqueda normal del proyecto"));
    assert.ok(planner.includes("búsqueda normal del proyecto"));

    // Contrato vigente: antes de delegar, el Runner evalúa la suficiencia de la
    // evidencia ya investigada (etapa 2 del chain de 3 pasos).
    assert.ok(
      runnerFlat.includes("evalúa la suficiencia de la evidencia ya investigada"),
      "runner.md should document the evidence-sufficiency evaluation before delegating",
    );
    assert.ok(
      runnerFlat.includes("la ausencia de referencias Graphify no activa por sí sola una delegación"),
      "runner.md should state that missing Graphify references alone do not trigger delegation",
    );

    // Contrato vigente: delega al Inspector cuando falta un elemento material.
    assert.ok(
      runnerFlat.includes("Si falta un elemento necesario, identifica el GAP material y delega al Inspector"),
      "runner.md should delegate to the Inspector when a material element is missing",
    );

    // Guarda de regresión: el Runner no debe volver a degradar a escalación
    // automática, ni perder la condicionalidad de la delegación.
    assert.doesNotMatch(
      runner,
      /escalación automática al Inspector/,
      "runner.md must not regress to automatic escalation to the Inspector",
    );
    assert.ok(
      runnerFlat.includes("no delega por defecto una consulta que la evidencia resuelve"),
      "runner.md should keep delegation conditional on a GAP the evidence does not resolve",
    );
  });
});

describe("MCP degradation state machine", () => {
  function simulateChain(integrationResult) {
    if (integrationResult.status === "success" && integrationResult.usable) {
      return { finalVia: "integración", usedNormalSearch: false };
    }
    return { finalVia: "normal", usedNormalSearch: true };
  }

  it("stops at MCP when it returns usable references", () => {
    assert.deepEqual(simulateChain({ status: "success", usable: true }), {
      finalVia: "integración",
      usedNormalSearch: false,
    });
  });

  it("uses normal search when MCP is unavailable or unusable", () => {
    for (const result of [{ status: "unavailable" }, { status: "failed" }, { status: "empty" }]) {
      assert.deepEqual(simulateChain(result), { finalVia: "normal", usedNormalSearch: true });
    }
  });
});

describe("documentation alignment", () => {
  it("documents the deprecated shim without describing it as a query fallback", () => {
    const readme = readRelative("README.md");
    const permissionGate = readRelative("docs/permission-gate.md");
    assert.ok(readme.includes("delegate to the Inspector for the concrete GAP"));
    assert.ok(
      readme.includes("evaluate the sufficiency of the evidence already gathered"),
      "README should document the sufficiency-evaluation stage of the chain",
    );
    assert.doesNotMatch(readme, /escalation to the Inspector/);
    assert.doesNotMatch(readme, /escalando al Inspector/);
    assert.doesNotMatch(readme, /then the local CLI/);
    assert.ok(permissionGate.includes("shim deprecated"));
    assert.ok(permissionGate.includes("no ejecuta consultas locales"));
  });
});
