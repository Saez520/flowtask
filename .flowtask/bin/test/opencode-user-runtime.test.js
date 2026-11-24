import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_DIR = path.resolve(TEST_DIR, "..", "..");
const FLOWTASK_CLI = path.join(FLOWTASK_DIR, "bin", "flowtask.js");

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function writeStub(binDir, name, content) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Seed a completed Graphify state so install/update does not open prompts that
 * would consume the non-interactive stdin. Graphify is outside the behavior
 * under test.
 */
function seedGraphifyState(projectDir, targetDir) {
  writeJson(path.join(projectDir, targetDir, "config", "graphify.json"), {
    schema: 1,
    enabled: true,
    selectedClis: ["opencode"],
    initialized: true,
    graphPath: null,
    hooksInstalled: true,
    ignoredOutput: "graphify-out/",
    lastInitializationResult: "success",
    lastWarning: null,
    opencodeSkillRegistered: "skipped",
  });
}

function createSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  const projectDir = path.join(root, "project");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const binDir = path.join(root, "bin");
  for (const directory of [projectDir, home, xdg, binDir]) fs.mkdirSync(directory, { recursive: true });

  writeStub(binDir, "opencode", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"2.0.29\"; exit 0; fi\nexit 0\n");
  writeStub(binDir, "engram", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"3.6.0\"; exit 0; fi\nexit 0\n");
  writeStub(binDir, "graphify", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"0.0.0\"; exit 0; fi\nexit 0\n");
  writeStub(binDir, "npm", "#!/bin/sh\nexit 1\n");
  writeStub(binDir, "claude", `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
const statePath = path.join(configDir, ".claude.json");
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
};
if (args[0] === "--version") {
  console.log("2.1.309");
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "get" && args[2] === "engram") {
  if (readState().mcpServers?.engram) {
    process.stdout.write("engram:\\n  Scope: user\\n");
    process.exit(0);
  }
  process.stderr.write('No MCP server named "engram"\\n');
  process.exit(1);
}
if (args[0] === "mcp" && args[1] === "add") {
  const state = readState();
  state.mcpServers = { ...(state.mcpServers ?? {}), engram: { command: "engram", args: ["mcp"] } };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "remove") {
  const state = readState();
  if (state.mcpServers) delete state.mcpServers.engram;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
process.exit(1);
`);

  const gitInit = spawnSync("git", ["init", "--quiet", projectDir], { encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);
  fs.writeFileSync(path.join(projectDir, "README.md"), "fixture\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: projectDir, encoding: "utf8" });
  spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "init"], {
    cwd: projectDir,
    encoding: "utf8",
  });

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    FLOWTASK_GRAPHIFY_INSTALL_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
    GIT_TERMINAL_PROMPT: "0",
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.CLAUDE_PROJECT_DIR;

  return { root, projectDir, home, xdg, binDir, env };
}

function runCli(sandbox, args, input = "n\nn\nn\nn\n") {
  return spawnSync(process.execPath, [FLOWTASK_CLI, ...args], {
    cwd: sandbox.projectDir,
    env: sandbox.env,
    input,
    encoding: "utf8",
    timeout: 120000,
  });
}

function outputOf(result) {
  return String(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function globalPaths(sandbox) {
  const runtimeRoot = path.join(sandbox.xdg, "flowtask");
  return {
    runtimeRoot,
    manifestPath: path.join(runtimeRoot, "runtime.json"),
    opencodeConfigPath: path.join(sandbox.xdg, "opencode", "opencode.json"),
    registrationPath: path.join(sandbox.projectDir, ".opencode", "flowtask", "project.json"),
  };
}

describe("OpenCode user-level lifecycle", () => {
  // gap: C2 — dos updates duplican agentes, skills o plugins, o reescriben el estado estable
  it("C2: two updates keep one canonical state without duplicating the OpenCode surface", () => {
    const sandbox = createSandbox("flowtask-c2-update-");
    const paths = globalPaths(sandbox);
    seedGraphifyState(sandbox.projectDir, path.join(".opencode", "flowtask"));
    seedGraphifyState(sandbox.projectDir, path.join(".claude", "flowtask"));

    const install = runCli(sandbox, ["install", "--target", "opencode", "--persona", "senior", "--autonomy", "assistant"]);
    assert.equal(install.status, 0, `install failed:\n${outputOf(install)}`);
    assert.ok(fs.existsSync(paths.registrationPath), "install must register the project for OpenCode");
    assert.ok(fs.existsSync(paths.manifestPath), "install must build the user runtime");
    assert.ok(fs.existsSync(paths.opencodeConfigPath), "install must write the OpenCode global surface");

    const firstUpdate = runCli(sandbox, ["update"]);
    assert.equal(firstUpdate.status, 0, `first update failed:\n${outputOf(firstUpdate)}`);

    const before = {
      manifest: fs.readFileSync(paths.manifestPath, "utf8"),
      opencodeConfig: fs.readFileSync(paths.opencodeConfigPath, "utf8"),
      registration: fs.readFileSync(paths.registrationPath, "utf8"),
      payloads: fs.readdirSync(path.join(paths.runtimeRoot, "versions")).sort(),
    };

    const secondUpdate = runCli(sandbox, ["update"]);
    assert.equal(secondUpdate.status, 0, `second update failed:\n${outputOf(secondUpdate)}`);

    assert.equal(
      fs.readFileSync(paths.manifestPath, "utf8"),
      before.manifest,
      "a repeated update must not rewrite the runtime manifest",
    );
    assert.equal(
      fs.readFileSync(paths.opencodeConfigPath, "utf8"),
      before.opencodeConfig,
      "a repeated update must not rewrite the global OpenCode configuration",
    );
    assert.equal(
      fs.readFileSync(paths.registrationPath, "utf8"),
      before.registration,
      "a repeated update must preserve the registration identity",
    );
    assert.deepEqual(
      fs.readdirSync(path.join(paths.runtimeRoot, "versions")).sort(),
      before.payloads,
      "a repeated update must not publish another payload",
    );

    const config = JSON.parse(fs.readFileSync(paths.opencodeConfigPath, "utf8"));
    const sourceAgents = fs.readdirSync(path.join(FLOWTASK_DIR, "agents"))
      .filter((file) => file.endsWith(".md"));
    const flowtaskAgents = Object.keys(config.agents ?? {}).filter((name) => name.startsWith("flowtask-"));
    assert.equal(
      flowtaskAgents.length,
      sourceAgents.length,
      "the global surface must list each canonical agent exactly once",
    );
    assert.equal(new Set(flowtaskAgents).size, flowtaskAgents.length, "no duplicated agent entries");
    assert.equal(config.default_agent, "flowtask-runner");
    assert.equal(config.skills.length, 1, "the skills array must point at a single payload");
    assert.equal(config.plugins.length, 2, "the gate and the context-checkpoint are installed once");
    assert.ok(
      config.plugins.some((entry) => entry?.package === "flowtask-permission-gate@^2.0.0"),
      "the permission gate is registered by npm spec",
    );
    assert.ok(
      config.plugins.some((entry) => entry?.package === path.join(paths.runtimeRoot, "plugins", "flowtask-context-checkpoint")),
      "the context checkpoint keeps its local package path",
    );
    assert.equal(
      fs.existsSync(path.join(paths.runtimeRoot, "plugins", "flowtask-permission-gate")),
      false,
      "the npm-distributed gate is not copied into the user runtime",
    );
    const runnerPayload = config.agents["flowtask-runner"].system.match(/versions\/([^/]+)\//);
    assert.ok(runnerPayload, "the runner agent points at a versioned payload");
    assert.equal(
      config.skills[0],
      path.join(paths.runtimeRoot, "versions", runnerPayload[1], "skills"),
    );
    assert.equal(new Set(config.plugins).size, config.plugins.length, "no duplicated plugin entries");

    for (const copied of ["agents", "skills", "scripts"]) {
      assert.equal(
        fs.existsSync(path.join(sandbox.projectDir, ".opencode", "flowtask", copied)),
        false,
        `the OpenCode project must not receive the ${copied} engine`,
      );
    }
  });

  // gap: C3 — uninstall por proyecto borra configuración del usuario o deja la ficha publicada
  it("C3: uninstall --project removes the registration and preserves every user setting", () => {
    const sandbox = createSandbox("flowtask-c3-uninstall-");
    const paths = globalPaths(sandbox);
    const projectOpencodeDir = path.join(sandbox.projectDir, ".opencode");
    const userConfigPath = path.join(projectOpencodeDir, "opencode.json");
    const userCliPath = path.join(projectOpencodeDir, "cli.json");
    const userPluginDir = path.join(projectOpencodeDir, "plugins", "user-plugin");
    seedGraphifyState(sandbox.projectDir, path.join(".opencode", "flowtask"));
    writeJson(userConfigPath, {
      mcp: { user_server: { type: "local", command: ["user-server"] } },
      agents: { "user-agent": { description: "kept" } },
    });
    writeJson(userCliPath, {
      $schema: "https://opencode.ai/cli.json",
      plugin: ["./plugins/user-plugin/index.js"],
      userKey: "keep",
    });
    fs.mkdirSync(userPluginDir, { recursive: true });
    fs.writeFileSync(path.join(userPluginDir, "index.js"), "export default {};\n", "utf8");

    const install = runCli(sandbox, ["install", "--target", "opencode", "--persona", "senior", "--autonomy", "assistant"]);
    assert.equal(install.status, 0, `install failed:\n${outputOf(install)}`);
    assert.ok(fs.existsSync(paths.registrationPath), "install must write the registration");

    const userConfigBefore = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    const userCliBefore = JSON.parse(fs.readFileSync(userCliPath, "utf8"));
    assert.deepEqual(userConfigBefore.mcp.user_server, { type: "local", command: ["user-server"] });
    assert.deepEqual(userConfigBefore.agents["user-agent"], { description: "kept" });
    assert.equal(userCliBefore.userKey, "keep");

    const uninstall = runCli(sandbox, ["uninstall", "--project", "--yes"]);
    assert.equal(uninstall.status, 0, `uninstall --project failed:\n${outputOf(uninstall)}`);

    assert.equal(fs.existsSync(paths.registrationPath), false, "the project registration must be removed");
    assert.equal(
      fs.existsSync(path.join(projectOpencodeDir, "flowtask", "config", "review.json")),
      false,
      "the generated review configuration must be removed",
    );
    assert.equal(
      fs.readFileSync(path.join(sandbox.projectDir, ".git", "info", "exclude"), "utf8").includes("# FlowTask managed"),
      false,
      "the Git exclude block must be removed",
    );

    const userConfigAfter = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    assert.deepEqual(userConfigAfter.mcp.user_server, userConfigBefore.mcp.user_server, "user MCP servers are preserved");
    assert.deepEqual(userConfigAfter.agents["user-agent"], { description: "kept" }, "user agents are preserved");
    const userCliAfter = JSON.parse(fs.readFileSync(userCliPath, "utf8"));
    assert.deepEqual(userCliAfter.plugin, userCliBefore.plugin, "user CLI plugins are preserved");
    assert.equal(userCliAfter.userKey, "keep");
    assert.ok(fs.existsSync(path.join(userPluginDir, "index.js")), "a project-local user plugin is preserved");
    assert.ok(
      fs.existsSync(path.join(projectOpencodeDir, "flowtask", "config", "graphify.json")),
      "the project Graphify state is preserved",
    );
    assert.ok(
      fs.existsSync(path.join(projectOpencodeDir, "plugins", "agent-model-selector-opencode")),
      "the project-local model selector is preserved",
    );

    const afterFirst = {
      config: fs.readFileSync(userConfigPath, "utf8"),
      cli: fs.readFileSync(userCliPath, "utf8"),
      graphify: fs.readFileSync(path.join(projectOpencodeDir, "flowtask", "config", "graphify.json"), "utf8"),
    };
    const secondUninstall = runCli(sandbox, ["uninstall", "--project", "--yes"]);
    assert.equal(secondUninstall.status, 0, `second uninstall failed:\n${outputOf(secondUninstall)}`);
    assert.equal(fs.readFileSync(userConfigPath, "utf8"), afterFirst.config, "a second uninstall must not change user config");
    assert.equal(fs.readFileSync(userCliPath, "utf8"), afterFirst.cli, "a second uninstall must not change the user CLI config");
    assert.equal(
      fs.readFileSync(path.join(projectOpencodeDir, "flowtask", "config", "graphify.json"), "utf8"),
      afterFirst.graphify,
      "a second uninstall must not change preserved state",
    );
  });
});
