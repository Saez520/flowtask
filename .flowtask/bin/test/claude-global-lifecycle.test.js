import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  readClaudeRuntimeManifest,
  ensureClaudeRuntime,
  removeClaudeRuntime,
} from "../lib/claude-runtime.js";
import { migrateLegacyClaudeProject } from "../lib/claude-install.js";
import { resolveActiveRuntimePaths } from "../lib/claude.js";
import { adaptRunnerForRuntime } from "../lib/runner-content.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_SOURCE = path.resolve(TEST_DIR, "..", "..");
const CLI = path.join(FLOWTASK_SOURCE, "bin", "flowtask.js");
const VERSION = JSON.parse(fs.readFileSync(path.join(FLOWTASK_SOURCE, "package.json"), "utf8")).version;
const USER_HOOK_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "Notification",
  "SessionStart",
];

const FIXTURES = [];

function makeRoot(prefix = "flowtask-global-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  FIXTURES.push(root);
  return root;
}

function cleanupFixtures() {
  while (FIXTURES.length > 0) {
    fs.rmSync(FIXTURES.pop(), { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function snapshotTree(target, output = {}) {
  if (!fs.existsSync(target)) return output;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    output[target] = sha256File(target);
    return output;
  }
  for (const entry of fs.readdirSync(target)) {
    snapshotTree(path.join(target, entry), output);
  }
  return output;
}

function withoutGraphify(snapshot) {
  for (const key of Object.keys(snapshot)) {
    if (key.endsWith(`${path.sep}config${path.sep}graphify.json`)) delete snapshot[key];
  }
  return snapshot;
}

function writeFakeClaude(root) {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "claude");
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const state = process.env.FAKE_CLAUDE_STATE;

if (args[0] === "mcp" && args[1] === "get" && args[2] === "engram") {
  if (fs.existsSync(state)) {
    process.stdout.write("engram:\\n  Scope: user\\n");
    process.exit(0);
  }
  process.stderr.write("No MCP server named engram\\n");
  process.exit(1);
}
if (args[0] === "mcp" && args[1] === "add") {
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, JSON.stringify(args));
  process.exit(0);
}
if (args[0] === "mcp" && args[1] === "remove") {
  fs.rmSync(state, { force: true });
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("2.1.309\\n");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  return { binDir, state: path.join(root, "user", ".claude", "fake-mcp-state.json"), log: path.join(root, "claude-calls.log") };
}

function createGitProject(root, name) {
  const projectDir = path.join(root, "projects", name);
  fs.mkdirSync(projectDir, { recursive: true });
  const run = (args) => spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
  run(["init", "-q"]);
  run(["config", "user.email", "tester@example.com"]);
  run(["config", "user.name", "Tester"]);
  return projectDir;
}

function commitAll(projectDir, message = "fixture") {
  const add = spawnSync("git", ["add", "-A"], { cwd: projectDir, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync("git", ["commit", "-qm", message], { cwd: projectDir, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
}

function writeUserState(homeDir) {
  const claudeDir = path.join(homeDir, ".claude");
  const hooks = {};
  for (const event of USER_HOOK_EVENTS) {
    hooks[event] = [{
      matcher: event === "SessionStart" ? "startup" : "",
      hooks: [{ type: "command", command: `echo user-${event}` }],
    }];
  }
  writeJson(path.join(claudeDir, "settings.json"), {
    hooks,
    mcpServers: { engram: { type: "stdio", command: "engram", args: ["mcp"], env: {} } },
    userKey: "keep",
  });
  for (const skill of ["user-skill-a", "user-skill-b", "synced"]) {
    const dir = path.join(claudeDir, "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
  }
  writeJson(path.join(homeDir, ".claude.json"), {
    installMethod: "native",
    projects: { "/existing/project": { allowedTools: [] } },
    mcpServers: {},
  });
  return {
    claudeDir,
    settingsPath: path.join(claudeDir, "settings.json"),
    statePath: path.join(homeDir, ".claude.json"),
    skillsDir: path.join(claudeDir, "skills"),
  };
}

function environment(root, fake) {
  const home = path.join(root, "user");
  const { CLAUDE_PROJECT_DIR, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, ...inherited } = process.env;
  return {
    ...inherited,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_CLAUDE_STATE: fake.state,
    FAKE_CLAUDE_LOG: fake.log,
  };
}

function runCli(projectDir, env, args, input = "n\n") {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: projectDir,
    env,
    input,
    encoding: "utf8",
    timeout: 180000,
  });
}

function runLauncher(launcherPath, projectDir, env, input = {}) {
  return spawnSync(process.execPath, [launcherPath], {
    input: JSON.stringify({ cwd: projectDir, ...input }),
    encoding: "utf8",
    env: { ...env, CLAUDE_PROJECT_DIR: "" },
    timeout: 60000,
  });
}

function assertExit(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${label}:\n${result.stdout}\n${result.stderr}`);
}

function userHookCount(settings) {
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => (group.hooks ?? []).map((hook) => hook.command)),
  );
}

function assertUserStatePreserved(before, root) {
  const settings = readJson(before.settingsPath);
  const commands = userHookCount(settings);
  for (const event of USER_HOOK_EVENTS) {
    assert.ok(commands.includes(`echo user-${event}`), `hook ${event} was not preserved`);
  }
  assert.deepEqual(settings.mcpServers, { engram: { type: "stdio", command: "engram", args: ["mcp"], env: {} } });
  assert.equal(settings.userKey, "keep");
  assert.deepEqual(snapshotTree(before.skillsDir), before.skills);
  assert.equal(fs.readFileSync(before.statePath, "utf8"), before.stateFile);
}

function writeMinimalRuntimeSource(root) {
  const flowtaskDir = path.join(root, "runtime-source");
  const skills = ["investigacion", "memory-protocol", "zero-assumptions"];
  for (const skill of skills) {
    const dir = path.join(flowtaskDir, "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\n---\n`, "utf8");
  }
  fs.mkdirSync(path.join(flowtaskDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "scripts", "worktree.sh"), "#!/bin/sh\n", "utf8");
  fs.mkdirSync(path.join(flowtaskDir, "bin", "lib"), { recursive: true });
  for (const file of [
    "target-direct-transport.js",
    "worktree-consumer-adapter.js",
    "worktree-consumer-contract.js",
    "worktree-commit-message.js",
  ]) {
    fs.writeFileSync(path.join(flowtaskDir, "bin", "lib", file), `// ${file}\n`, "utf8");
  }
  fs.mkdirSync(path.join(flowtaskDir, "claude"), { recursive: true });
  fs.copyFileSync(
    path.join(FLOWTASK_SOURCE, "claude", "session-start.mjs"),
    path.join(flowtaskDir, "claude", "session-start.mjs"),
  );
  fs.mkdirSync(path.join(flowtaskDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(flowtaskDir, "agents", "runner.md"), minimalRuntimeRunner("base"), "utf8");
  writeJson(path.join(flowtaskDir, "package.json"), { name: "flowtask-cli", version: "9.9.9" });
  return flowtaskDir;
}

function minimalRuntimeRunner(marker) {
  return [
    "---",
    "name: runner",
    "---",
    `# Runtime runner ${marker}`,
    "",
    'FLOWTASK_SCRIPTS="./.flowtask/scripts"',
    "Skills live in `.flowtask/skills/`.",
    "Transport: `.flowtask/bin/lib/target-direct-transport.js`.",
    "",
    "## Skills disponibles",
    "",
    'skill({ name: "investigacion" })',
    'skill({ name: "memory-protocol" })',
    'skill({ name: "zero-assumptions" })',
    "",
    "***",
    "",
  ].join("\n");
}

describe("Claude global lifecycle", () => {
  it("installs the runtime once per user and gates every session by project registration", () => {
    const root = makeRoot();
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    const user = writeUserState(path.join(root, "user"));
    const before = {
      settingsPath: user.settingsPath,
      skillsDir: user.skillsDir,
      skills: snapshotTree(user.skillsDir),
      statePath: user.statePath,
      stateFile: fs.readFileSync(user.statePath, "utf8"),
    };
    const projectA = createGitProject(root, "a");
    const projectC = createGitProject(root, "c");
    const projectD = createGitProject(root, "d");
    writeJson(path.join(projectA, ".mcp.json"), {
      mcpServers: { graphify: { type: "stdio", command: "graphify", args: ["mcp"] } },
      userOwned: true,
    });
    commitAll(projectA);
    const mcpBefore = fs.readFileSync(path.join(projectA, ".mcp.json"), "utf8");

    try {
      const installed = runCli(projectA, env, ["install", "--target", "claude", "--persona", "senior"]);
      assertExit(installed, "install");

      const manifestPath = path.join(user.claudeDir, "flowtask", "runtime.json");
      const manifest = readJson(manifestPath);
      assert.equal(manifest.schema, 1);
      assert.equal(manifest.version, VERSION);
      assert.match(manifest.payloadId, new RegExp(`^${VERSION.replaceAll(".", "\\.")}-[0-9a-f]{12}$`));
      assert.equal(manifest.hookCommand, `"${process.execPath}" "${path.join(user.claudeDir, "flowtask", "bin", "session-start.mjs")}"`);
      assert.equal(manifest.mcp.engram.scope, "user");
      assert.equal(manifest.mcp.engram.managed, true);

      const active = resolveActiveRuntimePaths(path.join(user.claudeDir, "flowtask"), manifest);
      for (const file of manifest.files) {
        assert.equal(sha256File(path.join(active.payloadDir, file.path)), file.sha256, `hash mismatch for ${file.path}`);
      }
      assert.equal(sha256File(path.join(user.claudeDir, "flowtask", "bin", "session-start.mjs")), manifest.launcher.sha256);
      for (const relative of ["runner.md", "session-start.md", "skills/investigacion/SKILL.md", "scripts/worktree.sh", "bin/lib/target-direct-transport.js"]) {
        assert.ok(fs.existsSync(path.join(active.payloadDir, relative)), `payload is missing ${relative}`);
      }
      assert.equal(Buffer.byteLength(fs.readFileSync(active.sessionStartPath, "utf8"), "utf8") < 10000, true);

      const configDir = path.join(user.claudeDir, "flowtask", "config");
      for (const file of ["profile.json", "autonomy.json", "permissions.json"]) {
        assert.ok(fs.existsSync(path.join(configDir, file)), `runtime config is missing ${file}`);
      }

      const registry = readJson(path.join(projectA, ".claude", "flowtask", "project.json"));
      assert.equal(registry.schema, 1);
      assert.equal(registry.projectPath, fs.realpathSync(projectA));
      assert.equal(registry.runtimeVersion, VERSION);
      assert.deepEqual(registry.materialized, { agents: VERSION, commands: VERSION });
      assert.equal(fs.readFileSync(path.join(projectA, ".claude", "flowtask", ".gitignore"), "utf8"), "*\n");

      const agentsDir = path.join(projectA, ".claude", "agents");
      const agents = fs.readdirSync(agentsDir).filter((file) => file.startsWith("flowtask-") && file.endsWith(".md"));
      assert.equal(agents.length, 12);
      for (const file of agents) {
        const content = fs.readFileSync(path.join(agentsDir, file), "utf8");
        assert.match(content, /<!-- FLOWTASK:MANAGED v1 -->/);
        assert.doesNotMatch(content, /^model:/m);
      }
      const commandsDir = path.join(projectA, ".claude", "commands");
      const commands = fs.readdirSync(commandsDir).filter((file) => file.endsWith(".md"));
      assert.equal(commands.length, 7);
      for (const file of commands) {
        assert.match(fs.readFileSync(path.join(commandsDir, file), "utf8"), /<!-- FLOWTASK:MANAGED v1 -->/);
      }

      for (const forbidden of ["CLAUDE.md", ".claude/session-start.md", ".claude/settings.json", ".claude/flowtask/skills", ".claude/flowtask/scripts", ".claude/flowtask/bin", ".claude/flowtask/runner.md"]) {
        assert.equal(fs.existsSync(path.join(projectA, forbidden)), false, `the project must not receive ${forbidden}`);
      }
      for (const layer of ["profile.json", "autonomy.json", "permissions.json", "review.json"]) {
        assert.equal(
          fs.existsSync(path.join(projectA, ".claude", "flowtask", "config", layer)),
          false,
          `the runtime layer ${layer} lives once per user, not in the project`,
        );
      }
      assert.equal(fs.readFileSync(path.join(projectA, ".mcp.json"), "utf8"), mcpBefore, "project MCP servers are untouched");
      assert.equal(fs.existsSync(path.join(projectC, ".claude")), false, "an unregistered project receives no artifacts");

      const status = spawnSync("git", ["status", "--short"], { cwd: projectA, encoding: "utf8" });
      assert.equal(status.stdout.trim(), "", "the registration and materialization must not dirty git status");
      for (const ignored of [".claude/flowtask/project.json", ".claude/agents/flowtask-ca-writer.md", ".claude/commands/update.md"]) {
        const check = spawnSync("git", ["check-ignore", "-q", "--", ignored], { cwd: projectA });
        assert.equal(check.status, 0, `${ignored} must be ignored`);
      }
      assert.equal(fs.existsSync(path.join(projectA, "project.json")), false, "the registry must not live at the project root");

      assertUserStatePreserved(before, root);
      const settings = readJson(user.settingsPath);
      const flowTaskHooks = userHookCount(settings).filter((command) => command.includes("session-start.mjs"));
      assert.equal(flowTaskHooks.length, 1, "the user hook is added once");
      assert.equal(userHookCount(settings).length, 7);
      const flowTaskGroup = settings.hooks.SessionStart.find((group) =>
        group.hooks.some((hook) => hook.command.includes("session-start.mjs")),
      );
      assert.equal(flowTaskGroup.matcher, "^(startup|resume|clear|compact|fork)$");
      assert.equal(flowTaskGroup.hooks.find((hook) => hook.command.includes("session-start.mjs")).timeout, 10);
      assert.ok(fs.existsSync(fake.state), "Engram is registered in the user scope");
      const calls = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(calls.filter((args) => args[0] === "mcp" && args[1] === "add").length, 1);
      assert.ok(calls.some((args) => args.join(" ") === "mcp add --scope user engram -- engram mcp"));

      const indexPath = path.join(user.claudeDir, "flowtask", "projects.json");
      const index = readJson(indexPath);
      assert.equal(index.schema, 1);
      assert.deepEqual(index.projects.map((entry) => entry.path), [fs.realpathSync(projectA)]);
      assert.equal(typeof index.projects[0].registeredAt, "string");
      assert.equal(index.projects[0].runtimeVersion, VERSION);
      fs.rmSync(indexPath);
      const reconstructed = runLauncher(path.join(user.claudeDir, "flowtask", "bin", "session-start.mjs"), projectA, env);
      assertExit(reconstructed, "launcher index reconstruction");
      assert.deepEqual(readJson(indexPath).projects.map((entry) => entry.path), [fs.realpathSync(projectA)]);

      const launcher = path.join(user.claudeDir, "flowtask", "bin", "session-start.mjs");
      const registered = runLauncher(launcher, projectA, env);
      assertExit(registered, "registered launcher");
      assert.match(registered.stdout, /# FlowTask session start/);
      assert.match(registered.stdout, /ToolSearch/);
      assert.match(registered.stdout, /mem_context/);
      assert.ok(registered.stdout.includes(path.join(active.skillsDir, "investigacion", "SKILL.md")));
      assert.ok(registered.stdout.includes(path.join(active.skillsDir, "memory-protocol", "SKILL.md")));
      assert.ok(registered.stdout.includes(path.join(active.skillsDir, "zero-assumptions", "SKILL.md")));
      assert.ok(registered.stdout.includes(active.runnerPath));
      assert.match(registered.stdout, /Read the runner definition/);
      assert.equal(registered.stdout.includes("FLOWTASK_SCRIPTS"), false, "the hook must not emit the runner");
      assert.equal(registered.stderr, "");
      assert.ok(Buffer.byteLength(registered.stdout, "utf8") < 10000);

      const unregistered = runLauncher(launcher, projectC, env);
      assertExit(unregistered, "unregistered launcher");
      assert.equal(unregistered.stdout, "");
      assert.equal(unregistered.stderr, "");

      fs.mkdirSync(path.join(projectD, ".claude", "flowtask"), { recursive: true });
      fs.copyFileSync(
        path.join(projectA, ".claude", "flowtask", "project.json"),
        path.join(projectD, ".claude", "flowtask", "project.json"),
      );
      const copied = runLauncher(launcher, projectD, env);
      assertExit(copied, "copied registration launcher");
      assert.equal(copied.stdout, "", "a copied registration must not activate by presence");

      const subagent = runLauncher(launcher, projectA, env, { agent_id: "sub-1" });
      assertExit(subagent, "subagent launcher");
      assert.equal(subagent.stdout, "");

      const manifestBackup = fs.readFileSync(manifestPath, "utf8");
      fs.renameSync(manifestPath, `${manifestPath}.bak`);
      try {
        const missing = runLauncher(launcher, projectA, env);
        assertExit(missing, "missing runtime launcher");
        assert.equal(missing.stdout.trim(), "FlowTask runtime is missing or incompatible. Run: flowtask install");
        assert.equal(missing.stderr, "");
      } finally {
        fs.renameSync(`${manifestPath}.bak`, manifestPath);
      }

      const incompatible = JSON.parse(manifestBackup);
      incompatible.schema = 2;
      writeJson(manifestPath, incompatible);
      try {
        const unsupported = runLauncher(launcher, projectA, env);
        assertExit(unsupported, "unsupported schema launcher");
        assert.equal(unsupported.stdout.trim(), "FlowTask runtime is missing or incompatible. Run: flowtask install");
        assert.equal(unsupported.stdout.includes("# FlowTask session start"), false);
      } finally {
        fs.writeFileSync(manifestPath, manifestBackup, "utf8");
      }

      const sessionStartBefore = fs.readFileSync(active.sessionStartPath, "utf8");
      const padding = 10000 - Buffer.byteLength(sessionStartBefore, "utf8");
      fs.writeFileSync(active.sessionStartPath, `${sessionStartBefore}${"x".repeat(padding)}`, "utf8");
      try {
        const oversized = runLauncher(launcher, projectA, env);
        assertExit(oversized, "oversized launcher");
        assert.equal(oversized.stdout.trim(), "FlowTask startup exceeds the hook limit. Run: flowtask update");
        assert.equal(oversized.stdout.includes("# FlowTask session start"), false);
      } finally {
        fs.writeFileSync(active.sessionStartPath, sessionStartBefore, "utf8");
      }
    } finally {
      cleanupFixtures();
    }
  });

  it("installs a fresh runtime with the minimum autonomy and honors an explicit choice", () => {
    const root = makeRoot("flowtask-autonomy-");
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    writeUserState(path.join(root, "user"));
    const projectDefault = createGitProject(root, "default-autonomy");
    const projectExplicit = createGitProject(root, "explicit-autonomy");

    try {
      assertExit(
        runCli(projectDefault, env, ["install", "--target", "claude", "--persona", "senior"]),
        "install default autonomy",
      );

      const runtimeRoot = path.join(root, "user", ".claude", "flowtask");
      const configPath = path.join(runtimeRoot, "config", "autonomy.json");
      assert.deepEqual(readJson(configPath), { version: 1, profile: "assistant" });
      let manifest = readClaudeRuntimeManifest(runtimeRoot);
      let active = resolveActiveRuntimePaths(runtimeRoot, manifest);
      assert.match(
        fs.readFileSync(active.runnerPath, "utf8"),
        /Current autonomy: assistant \(source: project\)\./,
      );

      assertExit(
        runCli(projectExplicit, env, [
          "install", "--target", "claude", "--persona", "senior", "--autonomy", "autonomous-dev",
        ]),
        "install explicit autonomy",
      );

      assert.deepEqual(readJson(configPath), { version: 1, profile: "autonomous-dev" });
      manifest = readClaudeRuntimeManifest(runtimeRoot);
      active = resolveActiveRuntimePaths(runtimeRoot, manifest);
      assert.match(
        fs.readFileSync(active.runnerPath, "utf8"),
        /Current autonomy: autonomous-dev \(source: project\)\./,
      );
    } finally {
      cleanupFixtures();
    }
  });

  it("updates one runtime version idempotently and keeps every project on it", () => {
    const root = makeRoot();
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    const user = writeUserState(path.join(root, "user"));
    const projectA = createGitProject(root, "a");
    const projectB = createGitProject(root, "b");
    const projectC = createGitProject(root, "c");

    try {
      assertExit(runCli(projectA, env, ["install", "--target", "claude", "--persona", "senior"]), "install A");
      assertExit(runCli(projectB, env, ["install", "--target", "claude", "--persona", "senior"]), "install B");

      const manifestPath = path.join(user.claudeDir, "flowtask", "runtime.json");
      const manifest = readJson(manifestPath);
      const registryA = readJson(path.join(projectA, ".claude", "flowtask", "project.json"));
      const registryB = readJson(path.join(projectB, ".claude", "flowtask", "project.json"));
      assert.equal(registryA.runtimeVersion, VERSION);
      assert.equal(registryB.runtimeVersion, VERSION);
      const index = readJson(path.join(user.claudeDir, "flowtask", "projects.json"));
      assert.deepEqual(
        index.projects.map((entry) => entry.path).sort(),
        [fs.realpathSync(projectA), fs.realpathSync(projectB)].sort(),
      );

      const before = {
        manifest: fs.readFileSync(manifestPath, "utf8"),
        settings: fs.readFileSync(user.settingsPath, "utf8"),
        registryA: fs.readFileSync(path.join(projectA, ".claude", "flowtask", "project.json"), "utf8"),
        registryB: fs.readFileSync(path.join(projectB, ".claude", "flowtask", "project.json"), "utf8"),
        treeA: withoutGraphify(snapshotTree(path.join(projectA, ".claude"))),
        skills: snapshotTree(user.skillsDir),
        addCalls: fs.readFileSync(fake.log, "utf8").trim().split("\n").filter((line) => JSON.parse(line)[1] === "add").length,
      };
      assert.equal(before.addCalls, 1, "the second install must reuse the user-scope MCP registration");

      assertExit(runCli(projectA, env, ["update"]), "update A");
      assertExit(runCli(projectA, env, ["update"]), "update A again");

      assert.equal(fs.readFileSync(manifestPath, "utf8"), before.manifest, "update must not rewrite an unchanged runtime");
      assert.equal(fs.readFileSync(user.settingsPath, "utf8"), before.settings, "update must not duplicate the hook");
      assert.equal(
        fs.readFileSync(path.join(projectA, ".claude", "flowtask", "project.json"), "utf8"),
        before.registryA,
        "update must preserve registeredAt and the registration identity",
      );
      assert.deepEqual(
        withoutGraphify(snapshotTree(path.join(projectA, ".claude"))),
        before.treeA,
        "update must not rewrite project artifacts",
      );
      assert.deepEqual(snapshotTree(user.skillsDir), before.skills, "update must preserve the user skills");
      assert.equal(
        fs.readFileSync(fake.log, "utf8").trim().split("\n").filter((line) => JSON.parse(line)[1] === "add").length,
        1,
        "update must not duplicate the user-scope MCP registration",
      );

      fs.rmSync(path.join(projectB, ".claude", "flowtask"), { recursive: true, force: true });
      assertExit(runCli(projectA, env, ["update"]), "update after project B disappeared");
      const reconciled = readJson(path.join(user.claudeDir, "flowtask", "projects.json"));
      assert.deepEqual(reconciled.projects.map((entry) => entry.path), [fs.realpathSync(projectA)]);

      const manifestBeforeUnregistered = fs.readFileSync(manifestPath, "utf8");
      const unregisteredUpdate = runCli(projectC, env, ["update"]);
      assertExit(unregisteredUpdate, "update in an unregistered project");
      assert.match(unregisteredUpdate.stdout, /not registered/i);
      assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBeforeUnregistered);
      assert.equal(fs.existsSync(path.join(projectC, ".claude", "flowtask", "project.json")), false);
      assert.deepEqual(
        readJson(path.join(user.claudeDir, "flowtask", "projects.json")).projects.map((entry) => entry.path),
        [fs.realpathSync(projectA)],
      );
      assert.match(fs.readFileSync(path.join(user.claudeDir, "flowtask", "projects.json"), "utf8"), /schema/);

      // The runtime pointer must be swapped atomically and keep the previous
      // payload complete for a session that is already running.
      const atomicRoot = makeRoot("flowtask-runtime-");
      const flowtaskDir = writeMinimalRuntimeSource(atomicRoot);
      const runtimeRoot = path.join(atomicRoot, "user", ".claude", "flowtask");
      const body1 = adaptRunnerForRuntime(minimalRuntimeRunner("one"), runtimeRoot);
      const body2 = adaptRunnerForRuntime(minimalRuntimeRunner("two"), runtimeRoot);
      const body3 = adaptRunnerForRuntime(minimalRuntimeRunner("three"), runtimeRoot);

      const first = ensureClaudeRuntime(flowtaskDir, { runtimeRoot, runnerBody: body1, version: "1.0.0" });
      assert.equal(first.action, "installed");
      const firstManifest = readClaudeRuntimeManifest(runtimeRoot);
      assert.equal(firstManifest.payloadId, first.payloadId);
      const firstActive = resolveActiveRuntimePaths(runtimeRoot, firstManifest);
      assert.ok(fs.existsSync(path.join(firstActive.payloadDir, "runner.md")));

      const unchanged = ensureClaudeRuntime(flowtaskDir, { runtimeRoot, runnerBody: body1, version: "1.0.0" });
      assert.equal(unchanged.action, "unchanged");
      assert.equal(unchanged.payloadId, first.payloadId);

      const second = ensureClaudeRuntime(flowtaskDir, { runtimeRoot, runnerBody: body2, version: "1.1.0" });
      assert.equal(second.action, "updated");
      assert.equal(second.previousPayloadId, first.payloadId);
      assert.notEqual(second.payloadId, first.payloadId);
      const secondManifest = readClaudeRuntimeManifest(runtimeRoot);
      assert.equal(secondManifest.payloadId, second.payloadId);
      assert.equal(secondManifest.previousPayloadId, first.payloadId);
      assert.equal(secondManifest.retainedPayloads[0].payloadId, first.payloadId);
      assert.ok(fs.existsSync(path.join(runtimeRoot, "versions", first.payloadId)), "the previous payload is retained");
      for (const file of firstManifest.files) {
        assert.equal(
          sha256File(path.join(runtimeRoot, "versions", first.payloadId, file.path)),
          file.sha256,
          `the previous payload is incomplete at ${file.path}`,
        );
      }
      const secondActive = resolveActiveRuntimePaths(runtimeRoot, secondManifest);
      for (const file of secondManifest.files) {
        assert.equal(sha256File(path.join(secondActive.payloadDir, file.path)), file.sha256);
      }

      const third = ensureClaudeRuntime(flowtaskDir, { runtimeRoot, runnerBody: body3, version: "1.2.0" });
      assert.equal(third.action, "updated");
      assert.equal(third.previousPayloadId, second.payloadId);
      const thirdManifest = readClaudeRuntimeManifest(runtimeRoot);
      const thirdActive = resolveActiveRuntimePaths(runtimeRoot, thirdManifest);
      assert.equal(
        sha256File(path.join(runtimeRoot, "bin", "session-start.mjs")),
        thirdManifest.launcher.sha256,
        "the stable launcher matches the manifest",
      );
      assert.equal(fs.existsSync(path.join(runtimeRoot, "versions", first.payloadId)), false, "older payloads are pruned");
      assert.ok(fs.existsSync(path.join(runtimeRoot, "versions", second.payloadId)));
      assert.ok(fs.existsSync(thirdActive.payloadDir));

      const adaptedRunner = fs.readFileSync(thirdActive.runnerPath, "utf8");
      assert.ok(adaptedRunner.includes(`${runtimeRoot}/scripts`));
      assert.ok(adaptedRunner.includes(`${runtimeRoot}/skills/`));
      assert.ok(adaptedRunner.includes(`${runtimeRoot}/bin/lib/`));
      assert.equal(adaptedRunner.includes('FLOWTASK_SCRIPTS="./.flowtask/scripts"'), false);
      assert.equal(adaptedRunner.includes(".flowtask/skills/"), false);
      assert.equal(adaptedRunner.includes(".flowtask/bin/lib/"), false);
      const startup = fs.readFileSync(thirdActive.sessionStartPath, "utf8");
      assert.ok(startup.includes(path.join(thirdActive.skillsDir, "investigacion", "SKILL.md")));
      assert.ok(startup.includes(thirdActive.runnerPath));

      fs.appendFileSync(thirdActive.runnerPath, "\ntampered\n");
      assert.throws(
        () => readClaudeRuntimeManifest(runtimeRoot),
        (error) => error.code === "runtime_payload_modified",
      );
      const removal = removeClaudeRuntime(runtimeRoot);
      assert.ok(removal.preserved.includes(thirdActive.runnerPath), "a modified file is never deleted");
      assert.equal(removal.removed.includes(thirdActive.runnerPath), false);
      assert.equal(fs.existsSync(thirdActive.runnerPath), true);
      assert.equal(fs.existsSync(path.join(runtimeRoot, "runtime.json")), false);

      const unknownRoot = path.join(root, "unmanaged");
      fs.mkdirSync(unknownRoot, { recursive: true });
      fs.writeFileSync(path.join(unknownRoot, "stray.txt"), "keep", "utf8");
      assert.throws(
        () => ensureClaudeRuntime(flowtaskDir, { runtimeRoot: unknownRoot, runnerBody: body1, version: "1.0.0" }),
        (error) => error.code === "runtime_root_unmanaged",
      );
      assert.equal(fs.existsSync(path.join(unknownRoot, "runtime.json")), false);
    } finally {
      cleanupFixtures();
    }
  });

  it("repairs a missing user-scope Engram registration on update", () => {
    const root = makeRoot("flowtask-update-mcp-");
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    writeUserState(path.join(root, "user"));
    const projectDir = createGitProject(root, "update-mcp");
    const manifestPath = path.join(root, "user", ".claude", "flowtask", "runtime.json");

    try {
      assertExit(runCli(projectDir, env, ["install", "--target", "claude", "--persona", "senior"]), "install");
      assert.equal(readJson(manifestPath).mcp.engram.managed, true);
      assert.equal(fs.existsSync(fake.state), true, "install must register Engram");

      fs.rmSync(fake.state, { force: true });
      assertExit(runCli(projectDir, env, ["update"]), "update");

      assert.equal(fs.existsSync(fake.state), true, "update must restore the user-scope registration");
      assert.equal(readJson(manifestPath).mcp.engram.managed, true);
    } finally {
      cleanupFixtures();
    }
  });

  it("migrates a legacy project and removes only FlowTask-owned state on uninstall", () => {
    const root = makeRoot("flowtask-legacy-");
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    const user = writeUserState(path.join(root, "user"));
    const before = {
      settingsPath: user.settingsPath,
      skillsDir: user.skillsDir,
      skills: snapshotTree(user.skillsDir),
      statePath: user.statePath,
      stateFile: fs.readFileSync(user.statePath, "utf8"),
    };
    const legacy = createGitProject(root, "legacy");
    const other = createGitProject(root, "other");

    const legacyFlowtask = path.join(legacy, ".claude", "flowtask");
    writeJson(path.join(legacyFlowtask, ".installation-method"), { method: "unified-installation-v2", target: "claude" });
    writeJson(path.join(legacyFlowtask, "config", "profile.json"), {
      level: "senior",
      persona: "tutor-senior",
      onboarded: true,
    });
    writeJson(path.join(legacyFlowtask, "config", "autonomy.json"), { version: 1, profile: "autonomous-dev" });
    writeJson(path.join(legacyFlowtask, "config", "permissions.json"), { version: 1, envelope: "standard" });
    writeJson(path.join(legacyFlowtask, "config", "review.json"), { enabled: true });
    writeJson(path.join(legacyFlowtask, "config", "graphify.json"), {
      schema: 1,
      enabled: false,
      selectedClis: ["claude"],
      initialized: false,
    });
    fs.mkdirSync(path.join(legacyFlowtask, "skills", "legacy-skill"), { recursive: true });
    fs.writeFileSync(path.join(legacyFlowtask, "skills", "legacy-skill", "SKILL.md"), "legacy skill\n", "utf8");
    fs.mkdirSync(path.join(legacyFlowtask, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(legacyFlowtask, "scripts", "legacy.sh"), "#!/bin/sh\n", "utf8");
    fs.mkdirSync(path.join(legacyFlowtask, "agents"), { recursive: true });
    fs.writeFileSync(path.join(legacyFlowtask, "agents", "legacy.md"), "legacy agent\n", "utf8");
    fs.mkdirSync(path.join(legacyFlowtask, "commands"), { recursive: true });
    fs.writeFileSync(path.join(legacyFlowtask, "commands", "legacy.md"), "legacy command\n", "utf8");
    fs.writeFileSync(path.join(legacy, ".claude", "session-start.md"), "legacy startup\n", "utf8");
    fs.mkdirSync(path.join(legacy, ".claude", "agents"), { recursive: true });
    fs.writeFileSync(path.join(legacy, ".claude", "agents", "user.md"), "user agent\n", "utf8");
    fs.mkdirSync(path.join(legacy, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(legacy, ".claude", "commands", "user.md"), "user command\n", "utf8");
    writeJson(path.join(legacy, ".claude", "settings.json"), {
      hooks: {
        SessionStart: [{
          matcher: "^(startup|resume|clear|compact|fork)$",
          hooks: [
            { type: "command", command: 'cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"' },
            { type: "command", command: "echo user-hook" },
          ],
        }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop-hook" }] }],
      },
      userKey: "keep",
    });
    fs.writeFileSync(
      path.join(legacy, "CLAUDE.md"),
      "# User doc\n\nKeep this.\n\n<!-- FLOWTASK:START -->\ngenerated\n<!-- FLOWTASK:END -->\n\nTail.\n",
      "utf8",
    );
    const template = readJson(path.join(FLOWTASK_SOURCE, "claude", "mcp.json"));
    writeJson(path.join(legacy, ".mcp.json"), {
      mcpServers: {
        engram: template.mcpServers.engram,
        graphify: { type: "stdio", command: "graphify", args: ["mcp"] },
      },
      userOwned: true,
    });

    try {
      assertExit(runCli(legacy, env, ["update"]), "legacy update");

      const runtimeConfig = path.join(user.claudeDir, "flowtask", "config");
      assert.deepEqual(readJson(path.join(runtimeConfig, "profile.json")), {
        level: "senior",
        persona: "tutor-senior",
        onboarded: true,
      });
      assert.deepEqual(readJson(path.join(runtimeConfig, "autonomy.json")), { version: 1, profile: "autonomous-dev" });
      assert.deepEqual(readJson(path.join(runtimeConfig, "permissions.json")), { version: 1, envelope: "standard" });
      const registry = readJson(path.join(legacyFlowtask, "project.json"));
      assert.equal(registry.schema, 1);
      assert.equal(registry.projectPath, fs.realpathSync(legacy));

      for (const removed of ["skills", "scripts", "agents", "commands", ".installation-method"]) {
        assert.equal(fs.existsSync(path.join(legacyFlowtask, removed)), false, `${removed} must be retired`);
      }
      for (const removed of ["profile.json", "autonomy.json", "permissions.json", "review.json"]) {
        assert.equal(fs.existsSync(path.join(legacyFlowtask, "config", removed)), false, `${removed} must be migrated`);
      }
      const preservedGraphify = readJson(path.join(legacyFlowtask, "config", "graphify.json"));
      assert.equal(preservedGraphify.schema, 1, "the project Graphify state is preserved, not deleted");
      assert.equal(preservedGraphify.enabled, false);
      assert.equal(fs.existsSync(path.join(legacy, ".claude", "session-start.md")), false);
      assert.equal(fs.readFileSync(path.join(legacy, ".claude", "commands", "user.md"), "utf8"), "user command\n");
      assert.equal(fs.readFileSync(path.join(legacy, ".claude", "agents", "user.md"), "utf8"), "user agent\n");
      const legacySettings = readJson(path.join(legacy, ".claude", "settings.json"));
      const legacyCommands = userHookCount(legacySettings);
      assert.equal(legacyCommands.includes('cat "$CLAUDE_PROJECT_DIR/.claude/session-start.md"'), false);
      assert.ok(legacyCommands.includes("echo user-hook"));
      assert.ok(legacyCommands.includes("echo stop-hook"));
      assert.equal(legacySettings.userKey, "keep");
      const legacyExclude = fs.readFileSync(path.join(legacy, ".git", "info", "exclude"), "utf8");
      assert.match(legacyExclude, /# FlowTask managed/);
      const claudeMd = fs.readFileSync(path.join(legacy, "CLAUDE.md"), "utf8");
      assert.match(claudeMd, /# User doc/);
      assert.match(claudeMd, /Keep this\./);
      assert.match(claudeMd, /Tail\./);
      assert.equal(claudeMd.includes("FLOWTASK"), false);
      assert.equal(claudeMd.includes("generated"), false);
      const mcp = readJson(path.join(legacy, ".mcp.json"));
      assert.equal(Object.hasOwn(mcp.mcpServers, "engram"), false);
      assert.deepEqual(mcp.mcpServers.graphify, { type: "stdio", command: "graphify", args: ["mcp"] });
      assert.equal(mcp.userOwned, true);

      const idempotencyPaths = [
        path.join(user.claudeDir, "flowtask", "runtime.json"),
        path.join(user.claudeDir, "flowtask", "config", "profile.json"),
        path.join(user.claudeDir, "flowtask", "config", "autonomy.json"),
        path.join(user.claudeDir, "flowtask", "config", "permissions.json"),
        path.join(legacyFlowtask, "project.json"),
        path.join(legacy, ".claude", "settings.json"),
        path.join(legacy, "CLAUDE.md"),
        path.join(legacy, ".mcp.json"),
        path.join(legacyFlowtask, "config", "graphify.json"),
      ];
      const firstHashes = idempotencyPaths.map((file) => sha256File(file));
      assertExit(runCli(legacy, env, ["update"]), "second legacy update");
      const changedAfterMigrationUpdate = idempotencyPaths.filter(
        (file, index) => sha256File(file) !== firstHashes[index],
      );

      assertExit(runCli(other, env, ["install", "--target", "claude", "--persona", "senior"]), "install other");
      assert.deepEqual(
        readJson(path.join(user.claudeDir, "flowtask", "projects.json")).projects.map((entry) => entry.path).sort(),
        [fs.realpathSync(legacy), fs.realpathSync(other)].sort(),
      );

      const launcher = path.join(user.claudeDir, "flowtask", "bin", "session-start.mjs");
      assert.ok(runLauncher(launcher, legacy, env).stdout.length > 0);
      assert.ok(runLauncher(launcher, other, env).stdout.length > 0);

      assertExit(runCli(legacy, env, ["uninstall", "--project", "--yes"]), "uninstall --project");
      assert.equal(fs.existsSync(path.join(legacyFlowtask, "project.json")), false);
      assert.equal(fs.existsSync(path.join(user.claudeDir, "flowtask", "runtime.json")), true);
      assert.equal(fs.existsSync(path.join(other, ".claude", "flowtask", "project.json")), true);
      assert.deepEqual(
        readJson(path.join(user.claudeDir, "flowtask", "projects.json")).projects.map((entry) => entry.path),
        [fs.realpathSync(other)],
      );
      assert.equal(runLauncher(launcher, legacy, env).stdout, "");
      assert.ok(runLauncher(launcher, other, env).stdout.length > 0);
      assert.equal(fs.readFileSync(path.join(legacy, ".claude", "agents", "user.md"), "utf8"), "user agent\n");
      assert.equal(fs.readFileSync(path.join(legacy, ".claude", "commands", "user.md"), "utf8"), "user command\n");
      assert.equal(fs.existsSync(path.join(legacyFlowtask, "config", "graphify.json")), true);
      const excludeAfterProject = fs.readFileSync(path.join(legacy, ".git", "info", "exclude"), "utf8");
      assert.equal(excludeAfterProject.includes("# FlowTask managed"), false);

      assertExit(runCli(other, env, ["uninstall", "--yes"]), "uninstall global");
      assert.equal(fs.existsSync(path.join(user.claudeDir, "flowtask")), false, "the runtime root must be removed");
      assert.equal(fs.existsSync(path.join(other, ".claude", "flowtask", "project.json")), false);
      assert.equal(fs.existsSync(path.join(other, ".claude", "agents", "flowtask-ca-writer.md")), false);
      assert.equal(fs.existsSync(path.join(other, ".claude", "commands", "update.md")), false);
      assert.notEqual(runLauncher(launcher, other, env).status, 0, "the removed launcher must not start");
      assertUserStatePreserved(before, root);
      const settingsAfter = readJson(user.settingsPath);
      assert.equal(userHookCount(settingsAfter).length, 6);
      assert.equal(fs.existsSync(fake.state), false, "the Engram registration added by FlowTask is removed");
      const removeCalls = fs.readFileSync(fake.log, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line))
        .filter((args) => args[0] === "mcp" && args[1] === "remove");
      assert.equal(removeCalls.length, 1);
      assert.equal(removeCalls[0].join(" "), "mcp remove --scope user engram");

      const settingsBeforeSecondUninstall = fs.readFileSync(user.settingsPath, "utf8");
      const idempotent = runCli(other, env, ["uninstall", "--yes"]);
      assertExit(idempotent, "second uninstall");
      assert.equal(fs.readFileSync(user.settingsPath, "utf8"), settingsBeforeSecondUninstall);
      assert.notEqual(runLauncher(launcher, other, env).status, 0, "the removed launcher must not start");

      // Malformed legacy settings and MCP files must be preserved and reported,
      // never rewritten while the migration retires the demonstrable artifacts.
      const malformed = createGitProject(root, "malformed");
      const malformedFlowtask = path.join(malformed, ".claude", "flowtask");
      writeJson(path.join(malformedFlowtask, ".installation-method"), { method: "legacy", target: "claude" });
      fs.mkdirSync(path.join(malformedFlowtask, "skills"), { recursive: true });
      fs.writeFileSync(path.join(malformedFlowtask, "skills", "legacy.md"), "legacy\n", "utf8");
      fs.mkdirSync(path.join(malformed, ".claude"), { recursive: true });
      const malformedSettingsPath = path.join(malformed, ".claude", "settings.json");
      const malformedMcpPath = path.join(malformed, ".mcp.json");
      fs.writeFileSync(malformedSettingsPath, '{ "hooks": {\n', "utf8");
      fs.writeFileSync(malformedMcpPath, "not json at all", "utf8");
      const malformedSettingsBefore = fs.readFileSync(malformedSettingsPath);
      const malformedMcpBefore = fs.readFileSync(malformedMcpPath);
      const migration = migrateLegacyClaudeProject({
        projectDir: malformed,
        runtimeRoot: path.join(root, "malformed-runtime"),
        flowtaskDir: FLOWTASK_SOURCE,
      });
      assert.equal(migration.migrated, true);
      assert.equal(fs.existsSync(path.join(malformedFlowtask, "skills")), false);
      assert.equal(fs.existsSync(path.join(malformedFlowtask, ".installation-method")), false);
      assert.deepEqual(fs.readFileSync(malformedSettingsPath), malformedSettingsBefore);
      assert.deepEqual(fs.readFileSync(malformedMcpPath), malformedMcpBefore);
      assert.ok(migration.manualReview.some((message) => message.includes(malformedSettingsPath)));
      assert.ok(migration.manualReview.some((message) => message.includes(malformedMcpPath)));

      assert.deepEqual(
        changedAfterMigrationUpdate,
        [],
        `a repeated update must not change anything; changed: ${changedAfterMigrationUpdate.join(", ")}`,
      );
    } finally {
      cleanupFixtures();
    }
  });

  it("pre-approves Engram tools only with the explicit flag and preserves the rule", () => {
    const root = makeRoot();
    const fake = writeFakeClaude(root);
    const env = environment(root, fake);
    const user = writeUserState(path.join(root, "user"));
    const settings = readJson(user.settingsPath);
    settings.permissions = {
      allow: ["Bash(git status)"],
      deny: ["Read(.env)"],
    };
    writeJson(user.settingsPath, settings);
    const projectDefault = createGitProject(root, "default");
    const projectExplicit = createGitProject(root, "explicit");

    try {
      assertExit(
        runCli(projectDefault, env, ["install", "--target", "claude", "--persona", "senior"]),
        "install without the flag",
      );
      const withoutFlag = readJson(user.settingsPath);
      assert.deepEqual(
        withoutFlag.permissions.allow,
        ["Bash(git status)"],
        "the allowlist must not change without the flag",
      );

      assertExit(
        runCli(projectExplicit, env, ["install", "--target", "claude", "--persona", "senior", "--allow-engram-tools"]),
        "install with the flag",
      );
      const withFlag = readJson(user.settingsPath);
      assert.deepEqual(withFlag.permissions.allow, ["Bash(git status)", "mcp__engram__*"]);
      assert.deepEqual(withFlag.permissions.deny, ["Read(.env)"]);
      assert.equal(withFlag.userKey, "keep");

      const beforeUpdate = fs.readFileSync(user.settingsPath, "utf8");
      assertExit(runCli(projectExplicit, env, ["update", "--allow-engram-tools"]), "update with the flag");
      assert.equal(
        fs.readFileSync(user.settingsPath, "utf8"),
        beforeUpdate,
        "a repeated flag must not rewrite the settings",
      );
      assert.equal(
        readJson(user.settingsPath).permissions.allow.filter((rule) => rule === "mcp__engram__*").length,
        1,
      );

      assertExit(runCli(projectExplicit, env, ["uninstall", "--yes"]), "uninstall");
      assert.deepEqual(
        readJson(user.settingsPath).permissions.allow,
        ["Bash(git status)", "mcp__engram__*"],
        "uninstall preserves the accepted allowlist entry",
      );
    } finally {
      cleanupFixtures();
    }
  });
});
