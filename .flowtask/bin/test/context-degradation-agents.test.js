/**
 * Contract test of the role agents wiring for the context degradation.
 *
 * Each role agent loads the degradation skill and names the pack of its own
 * moment. The three agents that consume inherited evidence also declare that
 * the resolved evidence is inherited and not verified again.
 *
 * The test is read-only: it reads the agent documents and asserts the clauses
 * the flow depends on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const flat = (text) => text.replace(/\s+/g, " ");

function readAgent(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** The four role agents that consume a moment pack. */
const AGENTS = [
  { file: ".flowtask/agents/ca-writer.md", moment: "define" },
  { file: ".flowtask/agents/planner.md", moment: "plan" },
  { file: ".flowtask/agents/constructor.md", moment: "build" },
  { file: ".flowtask/agents/validator.md", moment: "validate" },
];

/** The agents that consume evidence inherited from a previous moment. */
const INHERITANCE_AGENTS = [
  { file: ".flowtask/agents/planner.md" },
  { file: ".flowtask/agents/constructor.md" },
  { file: ".flowtask/agents/validator.md" },
];

const INHERITANCE_MARKERS = ["se heredan", "heredá"];
const NO_REVERIFICATION_MARKERS = ["no se re-verifican", "no repitas comprobaciones resueltas"];

describe("role agents context degradation wiring", () => {
  it("loads the degradation skill and names the pack of its moment", () => {
    for (const agent of AGENTS) {
      const content = readAgent(agent.file);
      assert.ok(content.includes("context-degradation"), `${agent.file} must load the skill`);
      assert.ok(
        content.includes(`pack \`${agent.moment}\``),
        `${agent.file} must name the pack ${agent.moment}`,
      );
    }
  });

  it("declares the inheritance of the resolved evidence", () => {
    for (const agent of INHERITANCE_AGENTS) {
      const content = readAgent(agent.file);
      const flatLower = flat(content).toLowerCase();
      assert.ok(
        INHERITANCE_MARKERS.some((marker) => flatLower.includes(marker.toLowerCase())),
        `${agent.file} must declare the inheritance of the resolved evidence`,
      );
      assert.ok(
        NO_REVERIFICATION_MARKERS.some((marker) => flatLower.includes(marker.toLowerCase())),
        `${agent.file} must declare that the resolved evidence is not verified again`,
      );
    }
  });

  it("exposes no threshold figure in the added blocks", () => {
    for (const agent of AGENTS) {
      const content = readAgent(agent.file);
      const blocks = content
        .split("\n")
        .filter((line) => line.includes("context-degradation") || line.includes("pack `"))
        .join("\n");
      for (const figure of ["16000", "8000", "32000", "51200"]) {
        assert.equal(
          blocks.includes(figure),
          false,
          `${agent.file} must not expose the threshold figure ${figure}`,
        );
      }
    }
  });

  it("does not create a role agent for the degradation contract", () => {
    assert.equal(fs.existsSync(path.join(ROOT, ".flowtask/agents/context-degradation.md")), false);
  });
});
