import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyOpencodeGlobalSurface,
  ensureOpencodeGlobalSurface,
  removeOpencodeGlobalSurface,
  resolveOpencodeUserPaths,
} from "./opencode-global.js";
import { setLogSink } from "./logger.js";
import { WORKTREE_MANAGER_MCP_MODULE } from "./worktree-mcp-registration.js";
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

function apply(config, { flowtaskDir, runtimeRoot, worktreeManager = null }) {
  return applyOpencodeGlobalSurface(config, {
    flowtaskDir,
    runtimeManifest: RUNTIME_MANIFEST,
    runtimeRoot,
    commandSource: { agents: {}, commands: {} },
    worktreeManager,
  });
}

function createWorktreeManager(root, name = "manager") {
  const managerDir = path.join(root, name);
  fs.mkdirSync(path.join(managerDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(path.join(managerDir, "worktree_manager", "mcp_transport.py"), "", "utf8");
  return managerDir;
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

test("the global surface registers the worktree manager with the absolute interpreter", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const managerDir = createWorktreeManager(root);
  const pythonBin = "/opt/homebrew/bin/python3.12";
  try {
    const result = apply({}, { flowtaskDir, runtimeRoot, worktreeManager: { managerDir, pythonBin } });

    assert.equal(result.worktreeManagerManaged, true);
    assert.deepEqual(result.config.mcp.worktree_manager, {
      type: "local",
      command: [pythonBin, "-m", WORKTREE_MANAGER_MCP_MODULE],
      environment: { PYTHONPATH: managerDir },
      enabled: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the global surface preserves a foreign worktree manager entry", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const managerDir = createWorktreeManager(root);
  const foreign = { type: "remote", url: "https://example.test/mcp", enabled: true };
  try {
    const result = apply(
      { mcp: { worktree_manager: foreign } },
      { flowtaskDir, runtimeRoot, worktreeManager: { managerDir, pythonBin: "/usr/bin/python3" } },
    );

    assert.equal(result.worktreeManagerManaged, false);
    assert.deepEqual(result.config.mcp.worktree_manager, foreign);
    assert.ok(result.warnings.some((warning) => warning.includes("worktree_manager")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reapplying the worktree manager refreshes only the managed PYTHONPATH", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const firstManager = createWorktreeManager(root, "manager-a");
  const secondManager = createWorktreeManager(root, "manager-b");
  try {
    const first = apply({}, { flowtaskDir, runtimeRoot, worktreeManager: { managerDir: firstManager, pythonBin: "/usr/bin/python3" } });
    const second = apply(first.config, { flowtaskDir, runtimeRoot, worktreeManager: { managerDir: secondManager, pythonBin: "/usr/bin/python3" } });
    const third = apply(second.config, { flowtaskDir, runtimeRoot, worktreeManager: { managerDir: secondManager, pythonBin: "/usr/bin/python3" } });

    assert.deepEqual(second.config.mcp.worktree_manager.environment, { PYTHONPATH: secondManager });
    assert.deepEqual(third.config, second.config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface drops the managed worktree entry only", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = path.join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  const managerDir = createWorktreeManager(root);
  const template = { type: "local", command: ["engram", "mcp"], enabled: true };
  const foreign = { type: "local", command: ["other"], enabled: true };
  try {
    const configPath = path.join(xdg, "opencode", "opencode.json");
    writeJson(configPath, {
      mcp: {
        engram: template,
        worktree_manager: {
          type: "local",
          command: ["/usr/bin/python3", "-m", WORKTREE_MANAGER_MCP_MODULE],
          environment: { PYTHONPATH: managerDir },
          enabled: true,
        },
        foreign,
      },
    });

    const result = removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {}, mcp: { engram: template } },
    });

    assert.ok(result.removed.includes("mcp.worktree_manager"));
    assert.deepEqual(readJson(configPath).mcp, { foreign });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface preserves a foreign worktree entry", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = path.join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  const foreign = { type: "remote", url: "https://example.test/mcp" };
  try {
    const configPath = path.join(xdg, "opencode", "opencode.json");
    writeJson(configPath, { mcp: { worktree_manager: foreign } });

    const result = removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {}, mcp: {} },
    });

    assert.equal(result.removed.includes("mcp.worktree_manager"), false);
    assert.deepEqual(readJson(configPath).mcp, { worktree_manager: foreign });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeRuntimeManifest(runtimeRoot) {
  fs.mkdirSync(path.join(runtimeRoot, "versions", "1.0.0-test"), { recursive: true });
  writeJson(path.join(runtimeRoot, "runtime.json"), {
    schema: 2,
    payloads: { canonical: { payloadId: "1.0.0-test", files: [] } },
  });
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

test("the default OpenCode directory is ~/.config/opencode on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const paths = withPlatform(platform, () => withEnv(
      { XDG_CONFIG_HOME: undefined, APPDATA: "C:/Users/x/AppData/Roaming" },
      () => resolveOpencodeUserPaths({ homeDir: "C:/Users/x" }),
    ));
    assert.equal(paths.configDir, path.join("C:/Users/x", ".config", "opencode"), platform);
    assert.equal(paths.configPath, path.join("C:/Users/x", ".config", "opencode", "opencode.json"), platform);
  }
});

test("XDG_CONFIG_HOME takes precedence over the home directory", () => {
  const paths = withPlatform("win32", () => withEnv(
    { XDG_CONFIG_HOME: "/custom/xdg" },
    () => resolveOpencodeUserPaths({ homeDir: "/home/x" }),
  ));
  assert.equal(paths.configDir, path.join("/custom/xdg", "opencode"));
});

test("an explicit configDir overrides the platform default", () => {
  assert.equal(resolveOpencodeUserPaths({ configDir: "/explicit" }).configDir, "/explicit");
});

test("ensuring the global surface merges into an existing file and keeps foreign entries", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  try {
    writeRuntimeManifest(runtimeRoot);
    const configPath = path.join(xdg, "opencode", "opencode.json");
    const foreign = { type: "local", command: ["other"], enabled: true };
    writeJson(configPath, { theme: "dark", mcp: { foreign }, agents: { mine: { mode: "primary" } } });
    const result = withEnv({ XDG_CONFIG_HOME: xdg }, () => ensureOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.path, configPath);
    const written = readJson(configPath);
    assert.equal(written.theme, "dark");
    assert.deepEqual(written.mcp.foreign, foreign);
    assert.deepEqual(written.agents.mine, { mode: "primary" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Windows install announces once that the earlier APPDATA file was left untouched", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  const appData = path.join(root, "AppData");
  const legacy = path.join(appData, "opencode", "opencode.json");
  const messages = [];
  try {
    writeRuntimeManifest(runtimeRoot);
    writeJson(legacy, { agents: { "flowtask-runner": {} } });
    const before = fs.readFileSync(legacy, "utf8");
    setLogSink((entry) => messages.push(entry.message));
    withPlatform("win32", () => withEnv({ XDG_CONFIG_HOME: xdg, APPDATA: appData }, () => {
      ensureOpencodeGlobalSurface({ flowtaskDir, runtimeRoot, commandSource: { agents: {}, commands: {} } });
    }));

    const notices = messages.filter((message) => message.includes(legacy));
    assert.equal(notices.length, 1);
    assert.equal(fs.readFileSync(legacy, "utf8"), before);
  } finally {
    setLogSink(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no earlier-file notice appears without FlowTask entries or outside Windows", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  const appData = path.join(root, "AppData");
  const legacy = path.join(appData, "opencode", "opencode.json");
  const messages = [];
  try {
    writeRuntimeManifest(runtimeRoot);
    writeJson(legacy, { agents: { mine: {} } });
    setLogSink((entry) => messages.push(entry.message));
    const run = (platform) => withPlatform(platform, () => withEnv({ XDG_CONFIG_HOME: xdg, APPDATA: appData }, () => {
      ensureOpencodeGlobalSurface({ flowtaskDir, runtimeRoot, commandSource: { agents: {}, commands: {} } });
    }));
    run("win32");
    writeJson(legacy, { agents: { "flowtask-runner": {} } });
    run("linux");

    assert.equal(messages.some((message) => message.includes(legacy)), false);
  } finally {
    setLogSink(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a JSONC file alone is left byte for byte intact and the JSON file is created without a default agent", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  const messages = [];
  try {
    writeRuntimeManifest(runtimeRoot);
    const jsoncPath = path.join(xdg, "opencode", "opencode.jsonc");
    fs.mkdirSync(path.dirname(jsoncPath), { recursive: true });
    const original = '{\n  // my settings\n  "theme": "dark", /* inline */\n}\n';
    fs.writeFileSync(jsoncPath, original, "utf8");
    setLogSink((entry) => messages.push(entry.message));
    const result = withEnv({ XDG_CONFIG_HOME: xdg }, () => ensureOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "created");
    assert.equal(fs.readFileSync(jsoncPath, "utf8"), original);
    const written = readJson(path.join(xdg, "opencode", "opencode.json"));
    assert.equal(Object.prototype.hasOwnProperty.call(written, "default_agent"), false);
    assert.ok(messages.some((message) => message.includes(jsoncPath) && message.includes("not modified")));
  } finally {
    setLogSink(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a JSONC file next to a JSON file preserves foreign entries and the JSONC bytes", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  try {
    writeRuntimeManifest(runtimeRoot);
    const dir = path.join(xdg, "opencode");
    const foreign = { type: "local", command: ["other"], enabled: true };
    writeJson(path.join(dir, "opencode.json"), { theme: "dark", mcp: { foreign } });
    const jsoncPath = path.join(dir, "opencode.jsonc");
    const original = '{ // mine\n  "default_agent": "build" }\n';
    fs.writeFileSync(jsoncPath, original, "utf8");
    const result = withEnv({ XDG_CONFIG_HOME: xdg }, () => ensureOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    }));

    assert.equal(result.ok, true);
    const written = readJson(path.join(dir, "opencode.json"));
    assert.equal(written.theme, "dark");
    assert.deepEqual(written.mcp.foreign, foreign);
    assert.equal(Object.prototype.hasOwnProperty.call(written, "default_agent"), false);
    assert.equal(fs.readFileSync(jsoncPath, "utf8"), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid JSON file still fails closed when a JSONC file exists", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  try {
    writeRuntimeManifest(runtimeRoot);
    const dir = path.join(xdg, "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.json"), "{ not json", "utf8");
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), "{}", "utf8");
    const result = withEnv({ XDG_CONFIG_HOME: xdg }, () => ensureOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), "{ not json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface works with a JSONC file next to the JSON file", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const xdg = path.join(root, "xdg");
  try {
    const dir = path.join(xdg, "opencode");
    writeJson(path.join(dir, "opencode.json"), { theme: "dark", default_agent: "flowtask-runner" });
    const jsoncPath = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(jsoncPath, "{}", "utf8");
    const result = withEnv({ XDG_CONFIG_HOME: xdg }, () => removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(readJson(path.join(dir, "opencode.json")), { theme: "dark" });
    assert.equal(fs.readFileSync(jsoncPath, "utf8"), "{}");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
