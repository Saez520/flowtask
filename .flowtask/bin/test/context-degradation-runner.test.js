/**
 * Contract test of the runner wiring for the context degradation.
 *
 * The runner is the surface that turns the degradation contract into an
 * observable behavior: it loads the skill, it shows only the pack of the
 * current moment, and it declares the durable context before acting after a
 * compaction or a handover.
 *
 * The test is read-only: it reads the agent document and asserts the clauses
 * the flow depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const RUNNER_REL_PATH = ".flowtask/agents/runner.md";

const CONTEXT_HEADING = "## Contexto: reglas por momento y recuperación";
const RECOVERY_HEADING = "### Recuperación tras compactación o relevo";
const RECONCILIATION_HEADING = "## Reconciliación post-compaction";

const flat = (text) => text.replace(/\s+/g, " ");

function readRunner() {
  return fs.readFileSync(path.join(ROOT, RUNNER_REL_PATH), "utf8");
}

/** The new context section, from its heading up to the reconciliation section. */
function extractContextSection(content) {
  const start = content.indexOf(CONTEXT_HEADING);
  assert.ok(start !== -1, `runner.md must contain the section ${CONTEXT_HEADING}`);
  const end = content.indexOf(RECONCILIATION_HEADING, start);
  assert.ok(end !== -1, `runner.md must contain the section ${RECONCILIATION_HEADING}`);
  return content.slice(start, end);
}

describe("runner context degradation wiring", () => {
  const content = readRunner();
  const flatContent = flat(content);
  const contextSection = extractContextSection(content);

  it("loads the degradation skill", () => {
    assert.ok(flatContent.includes("context-degradation"), "the runner must load the skill");
  });

  it("declares the six work moments with their pack", () => {
    assert.ok(flatContent.includes("Reglas vigentes por momento"), "missing the moments section");
    for (const moment of ["intake", "define", "plan", "build", "validate", "close"]) {
      assert.ok(flatContent.includes(`\`${moment}\``), `missing moment ${moment}`);
    }
  });

  it("declares the durable recovery with source, observation time and pause reasons", () => {
    assert.ok(flatContent.includes(RECOVERY_HEADING), "missing the recovery section");
    for (const phrase of [
      "decisiones vigentes",
      "progreso confirmado",
      "gasto acumulado",
      "última ronda confirmada",
      "observado:",
    ]) {
      assert.ok(flatContent.toLowerCase().includes(phrase.toLowerCase()), `missing ${phrase}`);
    }
    assert.ok(flatContent.includes("progress_unavailable"), "missing progress_unavailable");
    assert.ok(flatContent.includes("record_unavailable"), "missing record_unavailable");
    assert.ok(flatContent.includes("[No verificado]"), "missing the peripheral tag");
  });

  it("keeps the conservative failure rules of the recovery", () => {
    const flatLower = flatContent.toLowerCase();
    assert.ok(flatLower.includes("no elegís por conveniencia"), "missing the ambiguity rule");
    assert.ok(flatLower.includes("no fusiones registros contradictorios"), "missing the contradiction rule");
  });

  it("keeps the new sections in contract order", () => {
    const context = content.indexOf(CONTEXT_HEADING);
    const rules = content.indexOf("### Reglas vigentes por momento");
    const recovery = content.indexOf(RECOVERY_HEADING);
    const reconciliation = content.indexOf(RECONCILIATION_HEADING);
    assert.ok(context !== -1 && rules !== -1 && recovery !== -1 && reconciliation !== -1);
    assert.ok(context < rules, "the moments section must precede the recovery section");
    assert.ok(rules < recovery, "the moments section must precede the recovery section");
    assert.ok(recovery < reconciliation, "the recovery section must precede the reconciliation");
  });

  it("exposes no threshold figure in the new section", () => {
    for (const figure of ["16000", "8000", "32000", "51200"]) {
      assert.equal(
        contextSection.includes(figure),
        false,
        `the context section must not expose the threshold figure ${figure}`,
      );
    }
  });
});
