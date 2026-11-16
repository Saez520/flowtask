import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../../plugins/flowtask-permission-gate/dist/index.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-gate-registration-"));
  fixtures.push(root);
  return root;
}

function writeSkill(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), "---\nname: fixture\n---\n", "utf8");
}

/**
 * Minimal plugin context: captures the hooks and transforms the gate registers.
 */
function createContext({ directory, runtimeRoot }) {
  const transforms = { agent: [], skill: [] };
  const hooks = { context: [], prompt: [], before: [], after: [] };

  const ctx = {
    location: { directory },
    options: { runtimeRoot },
    agent: {
      transform: async (handler) => {
        transforms.agent.push(handler);
        return { dispose: async () => {} };
      },
    },
    skill: {
      transform: async (handler) => {
        transforms.skill.push(handler);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, handler) => {
        if (name === "context") hooks.context.push(handler);
        else if (name === "prompt") hooks.prompt.push(handler);
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name, handler) => {
        if (name === "execute.before") hooks.before.push(handler);
        else if (name === "execute.after") hooks.after.push(handler);
        return { dispose: async () => {} };
      },
    },
  };

  return { ctx, transforms, hooks };
}

describe("OpenCode registration gate", () => {
  // gap: C4 — una carpeta no registrada sigue exponiendo agentes o skills de FlowTask
  it("C4: an unregistered directory hides the FlowTask agents and skills without blocking tools", async () => {
    const root = makeTempRoot();
    const projectDir = path.join(root, "project");
    const runtimeRoot = path.join(root, "xdg", "flowtask");
    fs.mkdirSync(projectDir, { recursive: true });
    const payloadSkillsDir = path.join(runtimeRoot, "versions", "1.0.0-abc123", "skills");
    writeSkill(path.join(payloadSkillsDir, "investigacion"));

    const { ctx, transforms, hooks } = createContext({ directory: projectDir, runtimeRoot });
    const dispose = await plugin.setup(ctx);

    try {
      assert.equal(transforms.agent.length, 1, "the gate must register the agent transform");
      assert.equal(transforms.skill.length, 1, "the gate must register the skill transform");

      const removedAgents = [];
      await transforms.agent[0]({
        list: () => [
          { id: "flowtask-runner", name: "flowtask-runner" },
          { id: "flowtask-planner", name: "flowtask-planner" },
          { id: "build", name: "build" },
        ],
        remove: (id) => removedAgents.push(id),
      });
      assert.deepEqual(removedAgents, ["flowtask-runner", "flowtask-planner"]);

      const removedSkills = [];
      await transforms.skill[0]({
        list: () => [
          { id: "investigacion", path: path.join(payloadSkillsDir, "investigacion", "SKILL.md") },
          { id: "user-skill", path: path.join(root, "user", "skills", "user-skill", "SKILL.md") },
        ],
        remove: (id) => removedSkills.push(id),
      });
      assert.deepEqual(removedSkills, ["investigacion"], "only FlowTask payload skills are removed");

      assert.equal(hooks.context.length, 0, "an inactive project receives no activation message");

      assert.equal(hooks.before.length, 1, "the tool gate stays active");
      await hooks.before[0]({
        sessionID: "session-1",
        tool: "bash",
        agent: "build",
        input: { command: "ls" },
      });
    } finally {
      await dispose();
    }
  });
});
