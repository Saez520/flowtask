import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyOpencodeGlobalSurface, removeOpencodeGlobalSurface } from "./opencode-global.js";
import { resolveUserPayloadPaths } from "./user-runtime.js";

const RUNTIME_MANIFEST = Object.freeze({
  payloads: { canonical: { payloadId: "1.0.0-test" } },
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-global-"));
  const flowtaskDir = path.join(root, "source");
  const runtimeRoot = path.join(root, "config", "flowtask");
  writeJson(path.join(flowtaskDir, "opencode.json"), {});
  return { root, flowtaskDir, runtimeRoot };
}

function apply(config, { flowtaskDir, runtimeRoot }) {
  return applyOpencodeGlobalSurface(config, {
    flowtaskDir,
    runtimeManifest: RUNTIME_MANIFEST,
    runtimeRoot,
    commandSource: { agents: {}, commands: {} },
  });
}

test("the global surface registers the gate by npm spec and keeps the checkpoint local", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const oldGate = {
      package: path.join(runtimeRoot, "plugins", "flowtask-permission-gate"),
      options: { configDir: path.join(runtimeRoot, "config"), runtimeRoot },
    };
    const result = apply({ plugins: [oldGate, foreign, "user-plugin"] }, { flowtaskDir, runtimeRoot });

    assert.deepEqual(result.config.plugins, [
      foreign,
      "user-plugin",
      {
        package: "flowtask-permission-gate@^2.0.0",
        options: { configDir: path.join(runtimeRoot, "config"), runtimeRoot },
      },
      {
        package: path.join(runtimeRoot, "plugins", "flowtask-context-checkpoint"),
        options: { runtimeRoot },
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("applying the global surface twice is idempotent and preserves foreign entries", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const first = apply({ plugins: [foreign] }, { flowtaskDir, runtimeRoot });
    const second = apply(first.config, { flowtaskDir, runtimeRoot });

    assert.deepEqual(second.config, first.config);
    assert.equal(second.config.plugins.filter((entry) => entry?.package === "flowtask-permission-gate@^2.0.0").length, 1);
    assert.ok(second.config.plugins.includes(foreign));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface drops the npm gate and the local checkpoint only", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = path.join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const configPath = path.join(xdg, "opencode", "opencode.json");
    writeJson(configPath, {
      plugins: [
        { package: "flowtask-permission-gate@^2.0.0", options: { runtimeRoot } },
        foreign,
        {
          package: path.join(runtimeRoot, "plugins", "flowtask-context-checkpoint"),
          options: { runtimeRoot },
        },
      ],
    });

    const result = removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(readJson(configPath).plugins, [foreign]);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CANONICAL_AGENT_NAMES = [
  "planner", "validator", "ca-writer", "plan-auditor", "graphify-docs-media", "runner",
  "constructor", "inspector", "review-orchestrator", "initializer", "logger", "tester", "onboarder",
];

function applyWithCanonicalAgents(config, { flowtaskDir, runtimeRoot }) {
  const payload = resolveUserPayloadPaths(runtimeRoot, RUNTIME_MANIFEST, "canonical");
  fs.mkdirSync(payload.agentsDir, { recursive: true });
  const agents = {};
  for (const name of CANONICAL_AGENT_NAMES) {
    const file = name === "runner" ? path.join(payload.payloadDir, "runner.md") : path.join(payload.agentsDir, `${name}.md`);
    fs.writeFileSync(file, `# ${name}\n`, "utf8");
    agents[`flowtask-${name}`] = { description: name };
  }
  return applyOpencodeGlobalSurface(config, {
    flowtaskDir,
    runtimeManifest: RUNTIME_MANIFEST,
    runtimeRoot,
    commandSource: { agents, commands: {} },
  });
}

function legacyState() {
  return {
    agent: {
      "flowtask-planner": { model: "opencode-go/deepseek-v4.1-flash", variant: "max", options: {}, permission: {} },
      "flowtask-validator": { model: "provider/model#high", variant: "high" },
      "flowtask-runner": { permission: {} },
      "third-party": { model: "other/model", variant: "low" },
    },
    agents: {
      "flowtask-planner": { description: "planner" },
      "flowtask-validator": { description: "validator", model: "kept/model#low" },
      "third-party-agents": { model: "foreign/model" },
    },
  };
}

test("a legacy agent section keeps its model and variant under agents", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const { config } = applyWithCanonicalAgents(legacyState(), { flowtaskDir, runtimeRoot });

    assert.equal(config.agents["flowtask-planner"].model, "opencode-go/deepseek-v4.1-flash#max");
    assert.equal(config.agents["flowtask-planner"].description, "planner");
    assert.equal(Object.keys(config.agent ?? {}).some((name) => name.startsWith("flowtask-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing agents model wins and a variant already in the model is not duplicated", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const { config } = applyWithCanonicalAgents(legacyState(), { flowtaskDir, runtimeRoot });

    assert.equal(config.agents["flowtask-validator"].model, "kept/model#low");

    const second = applyWithCanonicalAgents({
      agent: { "flowtask-planner": { model: "provider/model#high", variant: "high" } },
    }, { flowtaskDir, runtimeRoot });
    assert.equal(second.config.agents["flowtask-planner"].model, "provider/model#high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("foreign entries in agent and agents stay untouched and an emptied agent is removed", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const { config } = applyWithCanonicalAgents(legacyState(), { flowtaskDir, runtimeRoot });
    assert.deepEqual(config.agent, { "third-party": { model: "other/model", variant: "low" } });
    assert.deepEqual(config.agents["third-party-agents"], { model: "foreign/model" });

    const onlyOurs = applyWithCanonicalAgents({ agent: { "flowtask-runner": { permission: {} } } }, { flowtaskDir, runtimeRoot });
    assert.equal("agent" in onlyOurs.config, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrating the legacy agent section twice gives the same result", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const first = applyWithCanonicalAgents(legacyState(), { flowtaskDir, runtimeRoot });
    const second = applyWithCanonicalAgents(first.config, { flowtaskDir, runtimeRoot });
    assert.deepEqual(second.config, first.config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy permission rules are reported as warnings instead of being lost silently", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const result = applyWithCanonicalAgents({
      agent: {
        "flowtask-planner": { permission: { bash: "deny" } },
        "flowtask-runner": { permission: {} },
      },
    }, { flowtaskDir, runtimeRoot });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /agent\.flowtask-planner\.permission/);
    assert.deepEqual(applyWithCanonicalAgents({}, { flowtaskDir, runtimeRoot }).warnings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the replica of the real conflicting state resolves to the chosen model", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const agent = {};
    const agents = {};
    for (const name of ["planner", "validator", "ca-writer", "plan-auditor", "graphify-docs-media", "runner", "constructor", "inspector", "review-orchestrator"]) {
      agent[`flowtask-${name}`] = ["runner", "constructor", "inspector", "review-orchestrator"].includes(name)
        ? {}
        : { model: name === "planner" ? "opencode-go/deepseek-v4.1-flash" : "p/m", variant: name === "planner" ? "max" : "high" };
      agents[`flowtask-${name}`] = { description: name };
    }
    for (const name of ["initializer", "logger", "tester", "onboarder"]) agents[`flowtask-${name}`] = { description: name };

    const { config } = applyWithCanonicalAgents({ agent, agents }, { flowtaskDir, runtimeRoot });
    assert.equal(config.agents["flowtask-planner"].model, "opencode-go/deepseek-v4.1-flash#max");
    assert.equal("agent" in config, false);
    assert.equal(Object.keys(config.agents).length, 13);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface also cleans the legacy agent entries", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = path.join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const configPath = path.join(xdg, "opencode", "opencode.json");
    writeJson(configPath, legacyState());

    const result = removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    });

    assert.equal(result.ok, true);
    assert.ok(result.removed.includes("agent.flowtask-planner"));
    assert.deepEqual(readJson(configPath), {
      agent: { "third-party": { model: "other/model", variant: "low" } },
      agents: { "third-party-agents": { model: "foreign/model" } },
    });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
