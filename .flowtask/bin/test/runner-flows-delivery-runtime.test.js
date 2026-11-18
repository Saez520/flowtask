/**
 * Delivery verification against the user-level runtime: a registered project
 * reads the canonical and claude payloads, while an unregistered project keeps
 * the legacy in-project mirror.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkClaudeDelivery, checkOpenCodeDelivery } from "../lib/runner-flows.js";

const FLOW_ALPHA = "runner-flow-alpha";
const FLOW_BETA = "runner-flow-beta";
const FLOW_LEGACY = "runner-flow-legacy";

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalFlow(name, body) {
  return `---\nname: ${name}\ndescription: synthetic flow for delivery checks\n---\n\n${body}\n`;
}

function writeCanonicalFlow(skillsDir, name, body) {
  const content = canonicalFlow(name, body);
  writeFile(path.join(skillsDir, name, "SKILL.md"), content);
  return content;
}

describe("runner flow delivery with user runtime", () => {
  // gap: G-1 — el delivery vuelve a leer el espejo vacío del proyecto o el payloadId nulo del manifiesto schema 2.
  it("reads the user runtime payloads for registered projects and the legacy mirror otherwise", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-delivery-runtime-"));
    try {
      const canonicalSkillsDir = path.join(root, "canonical", "skills");
      const registeredProject = path.join(root, "registered-project");
      const legacyProject = path.join(root, "legacy-project");
      const runtimeRoot = path.join(root, "runtime");
      const partialRuntimeRoot = path.join(root, "runtime-partial");

      const alphaContent = writeCanonicalFlow(
        canonicalSkillsDir,
        FLOW_ALPHA,
        'Cargá skill({ name: "memory-protocol" }) antes de actuar.',
      );
      const betaContent = writeCanonicalFlow(
        canonicalSkillsDir,
        FLOW_BETA,
        "Componé el cierre sin llamadas de skill.",
      );
      const legacyContent = writeCanonicalFlow(
        canonicalSkillsDir,
        FLOW_LEGACY,
        "Flujo disponible solo en el espejo del proyecto.",
      );

      const canonicalFullSkills = path.join(runtimeRoot, "versions", "canonical-full", "skills");
      writeFile(path.join(canonicalFullSkills, FLOW_ALPHA, "SKILL.md"), alphaContent);
      writeFile(path.join(canonicalFullSkills, FLOW_BETA, "SKILL.md"), betaContent);

      const claudeFullSkills = path.join(runtimeRoot, "versions", "claude-full", "skills");
      writeFile(
        path.join(claudeFullSkills, FLOW_ALPHA, "SKILL.md"),
        `## Flujo adaptado\n\n**Read** \`${path.join(claudeFullSkills, "memory-protocol", "SKILL.md")}\`\n`,
      );
      writeFile(
        path.join(claudeFullSkills, FLOW_BETA, "SKILL.md"),
        "## Flujo adaptado\n\nSin llamadas de skill.\n",
      );

      writeJson(path.join(runtimeRoot, "runtime.json"), {
        schema: 2,
        payloads: {
          canonical: { payloadId: "canonical-full" },
          claude: { payloadId: "claude-full" },
        },
      });
      writeJson(path.join(runtimeRoot, "projects.json"), {
        schema: 1,
        updatedAt: "2026-11-17T00:00:00.000Z",
        projects: [
          {
            path: registeredProject,
            registeredAt: "2026-11-17T00:00:00.000Z",
            runtimeVersion: "1.27.10",
            targets: ["opencode", "claude"],
          },
        ],
      });

      // El espejo del proyecto registrado queda vacío a propósito: si la
      // verificación lo prefiere, deja de reportar present.
      fs.mkdirSync(path.join(registeredProject, ".opencode", "skills"), { recursive: true });
      writeJson(path.join(registeredProject, ".claude", "flowtask", "project.json"), { schema: 1 });

      // Runtime parcial: el payload canonical existe pero le falta un flujo y
      // no declara payload claude.
      const canonicalPartialSkills = path.join(
        partialRuntimeRoot,
        "versions",
        "canonical-partial",
        "skills",
      );
      writeFile(path.join(canonicalPartialSkills, FLOW_ALPHA, "SKILL.md"), alphaContent);
      writeJson(path.join(partialRuntimeRoot, "runtime.json"), {
        schema: 2,
        payloads: { canonical: { payloadId: "canonical-partial" } },
      });
      writeJson(path.join(partialRuntimeRoot, "projects.json"), {
        schema: 1,
        updatedAt: "2026-11-17T00:00:00.000Z",
        projects: [{ path: registeredProject, targets: ["opencode", "claude"] }],
      });

      // Proyecto no registrado: solo tiene el espejo legacy, y su flujo no
      // existe en el payload canonical.
      writeFile(
        path.join(legacyProject, ".opencode", "skills", FLOW_LEGACY, "SKILL.md"),
        legacyContent,
      );

      const flows = [{ name: FLOW_ALPHA }, { name: FLOW_BETA }];

      assert.deepEqual(
        checkOpenCodeDelivery({ projectDir: registeredProject, runtimeRoot, canonicalSkillsDir, flows }),
        { [FLOW_ALPHA]: "present", [FLOW_BETA]: "present" },
        "un proyecto registrado debe leerse del payload canonical",
      );
      assert.deepEqual(
        checkClaudeDelivery({ projectDir: registeredProject, runtimeRoot, canonicalSkillsDir, flows }),
        { [FLOW_ALPHA]: "present", [FLOW_BETA]: "present" },
        "un proyecto registrado debe leerse del payload claude anidado",
      );

      assert.deepEqual(
        checkOpenCodeDelivery({
          projectDir: legacyProject,
          runtimeRoot,
          canonicalSkillsDir,
          flows: [{ name: FLOW_LEGACY }],
        }),
        { [FLOW_LEGACY]: "present" },
        "un proyecto no registrado debe conservar el espejo legacy",
      );

      assert.deepEqual(
        checkOpenCodeDelivery({
          projectDir: registeredProject,
          runtimeRoot: partialRuntimeRoot,
          canonicalSkillsDir,
          flows,
        }),
        { [FLOW_ALPHA]: "present", [FLOW_BETA]: "missing" },
        "un flujo ausente del payload canonical debe reportarse missing",
      );
      assert.deepEqual(
        checkClaudeDelivery({
          projectDir: registeredProject,
          runtimeRoot: partialRuntimeRoot,
          canonicalSkillsDir,
          flows,
        }),
        { [FLOW_ALPHA]: "missing", [FLOW_BETA]: "missing" },
        "un payload claude ausente debe reportarse missing",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
