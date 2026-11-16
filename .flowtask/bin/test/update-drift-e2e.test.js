import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FLOWTASK_DIR = path.resolve(TEST_DIR, "..", "..");
const FLOWTASK_CLI = path.join(FLOWTASK_DIR, "bin", "flowtask.js");

const TARGETS = [
  {
    id: "standalone",
    cliSource: "controlled",
    registration: ".flowtask/project.json",
    engineRoot: ".flowtask/agents",
    managedFile: null,
  },
  {
    id: "opencode",
    cliSource: "canonical",
    registration: ".opencode/flowtask/project.json",
    engineRoot: ".opencode/flowtask/agents",
    managedFile: null,
  },
  {
    id: "vscode",
    cliSource: "controlled",
    registration: ".vscode/flowtask/project.json",
    engineRoot: ".vscode/flowtask/agents",
    managedFile: null,
  },
  {
    id: "claude",
    cliSource: "canonical",
    registration: ".claude/flowtask/project.json",
    engineRoot: null,
    managedFile: ".claude/agents/flowtask-plan-auditor.md",
  },
];

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

/**
 * The repository source carries `plugins/flowtask-classifier-hook/PLAN-CA-023.md`.
 * Because `update` preserves every destination path containing `CA-` but the
 * source still lists it as a managed file, the standalone/vscode mirror check
 * fails against the source as-is (DEV-01, pre-existing and outside this CA).
 * The controlled copy drops that file; it keeps every other canonical asset and
 * the CLI so the run still exercises the real update pipeline.
 */
function createControlledSource(root) {
  const source = path.join(root, "source");
  fs.cpSync(FLOWTASK_DIR, source, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(FLOWTASK_DIR, entry).split(path.sep).join("/");
      if (relative === "") return true;
      if (relative === "bin/test" || relative.startsWith("bin/test/")) return false;
      if (relative === "bin/ferris-search-darwin-arm64") return false;
      if (relative === "bin/ferris-search-windows-x64.exe") return false;
      if (relative === "plugins/flowtask-classifier-hook/PLAN-CA-023.md") return false;
      return true;
    },
  });
  return source;
}

function writeStub(binDir, name, content) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

function createSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  const projectDir = path.join(root, "project");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const binDir = path.join(root, "bin");
  for (const directory of [projectDir, home, xdg, binDir]) fs.mkdirSync(directory, { recursive: true });

  const npmMarker = path.join(root, "npm-calls.log");
  writeStub(binDir, "npm", "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_MARKER\"\nexit 1\n");
  writeStub(binDir, "opencode", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"0.0.0-e2e\"; exit 0; fi\nexit 0\n");
  writeStub(binDir, "engram", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"0.0.0-e2e\"; exit 0; fi\nexit 0\n");
  writeStub(binDir, "claude", `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR;
const statePath = configDir
  ? path.join(configDir, ".claude.json")
  : path.join(process.env.HOME, ".claude.json");
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
};
if (args[0] === "--version") {
  console.log("0.0.0-e2e");
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

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    NPM_MARKER: npmMarker,
    FLOWTASK_GRAPHIFY_INSTALL_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.CLAUDE_PROJECT_DIR;

  return { root, projectDir, home, xdg, binDir, env, npmMarker };
}

function resolveCli(sandbox, target) {
  if (target.cliSource !== "controlled") return FLOWTASK_CLI;
  const source = createControlledSource(sandbox.root);
  return path.join(source, "bin", "flowtask.js");
}

function runCli(cli, args, { sandbox, input = "" }) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: sandbox.projectDir,
    env: sandbox.env,
    input,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function outputOf(result) {
  return stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function treeDigest(directory) {
  const entries = [];
  const walk = (current, prefix) => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of children) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push(`${relative}->${fs.readlinkSync(absolute)}`);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
        entries.push(`${relative}:${hash}`);
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory, "");
  return entries;
}

/**
 * Rebuild the path printed after `↺ <target>:` from its one-line notice,
 * following the wrapped continuation lines of the 68-column frame.
 */
function restoredNoticePath(output, target) {
  const lines = output.split("\n");
  const marker = `↺ ${target}:`;
  const start = lines.findIndex((line) => line.includes(marker));
  assert.notEqual(start, -1, `missing ${marker} notice:\n${output}`);
  const firstLine = lines[start].slice(lines[start].indexOf(marker) + marker.length);
  const parts = [firstLine.replace(/\s*│\s*$/, "")];
  for (let index = start + 1; index < lines.length; index += 1) {
    const continuation = lines[index].match(/^│ {4}(.*?)\s*│$/);
    if (!continuation) break;
    parts.push(continuation[1]);
  }
  return parts.join("").replace(/\s+/g, "");
}

// gap: G1 — update prepara el worktree manager o escribe antes de detectar la ausencia de instalación
test("G1: update detects an empty project before writing or preparing the Worktree Manager", () => {
  const sandbox = createSandbox("flowtask-update-empty-");
  const before = {
    project: treeDigest(sandbox.projectDir),
    home: treeDigest(sandbox.home),
    xdg: treeDigest(sandbox.xdg),
  };

  const result = runCli(FLOWTASK_CLI, ["update"], { sandbox, input: "\n" });
  const output = outputOf(result);

  assert.notEqual(result.status, 0, `update must fail without an installation:\n${output}`);
  assert.match(output, /No FlowTask installation found/);
  assert.deepEqual(treeDigest(sandbox.projectDir), before.project, "update wrote inside the project before detecting");
  assert.deepEqual(treeDigest(sandbox.home), before.home, "update wrote inside HOME before detecting");
  assert.deepEqual(treeDigest(sandbox.xdg), before.xdg, "update wrote inside XDG_CONFIG_HOME before detecting");
  assert.equal(
    fs.existsSync(sandbox.npmMarker),
    false,
    "update invoked npm (Worktree Manager preparation) before detecting the absence of an installation",
  );
});

// gap: G2 — un target queda sin detección y la matriz e2e no lo observa
test("G2: update detects and syncs every supported target", () => {
  for (const target of TARGETS) {
    const sandbox = createSandbox(`flowtask-update-detect-${target.id}-`);
    const cli = resolveCli(sandbox, target);

    const install = runCli(
      cli,
      ["install", "--target", target.id, "--persona", "senior", "--autonomy", "assistant"],
      { sandbox, input: "n\n" },
    );
    assert.equal(install.status, 0, `install ${target.id} failed:\n${outputOf(install)}`);
    assert.ok(
      fs.existsSync(path.join(sandbox.projectDir, target.registration)),
      `install ${target.id} did not write ${target.registration}`,
    );
    if (target.engineRoot) {
      assert.equal(
        fs.existsSync(path.join(sandbox.projectDir, target.engineRoot)),
        false,
        `install ${target.id} copied the engine into ${target.engineRoot}`,
      );
    }

    const update = runCli(cli, ["update"], { sandbox, input: "n\nn\nn\n" });
    const output = outputOf(update);
    assert.equal(update.status, 0, `update ${target.id} failed:\n${output}`);
    assert.match(
      output,
      new RegExp(`│\\s+detect\\s+[^\\n]*\\b${target.id}\\b`),
      `update did not report ${target.id} in the detect row:\n${output}`,
    );
    assert.match(
      output,
      new RegExp(`│\\s+sync\\s+${target.id}\\b`),
      `update did not sync ${target.id}:\n${output}`,
    );
    assert.ok(
      fs.existsSync(path.join(sandbox.projectDir, target.registration)),
      `update ${target.id} removed or did not refresh ${target.registration}`,
    );
  }
});

// gap: G3 — una edición manual en un gestionado sobrevive o se restaura sin figurar en el informe
test("G3: update restores a hand-edited managed file and reports its path", () => {
  // Only the Claude target materializes managed project artifacts; the other
  // destinations keep the engine in the user runtime and carry a registration.
  for (const target of TARGETS.filter((entry) => entry.managedFile)) {
    const sandbox = createSandbox(`flowtask-update-drift-${target.id}-`);
    const cli = resolveCli(sandbox, target);

    const install = runCli(
      cli,
      ["install", "--target", target.id, "--persona", "senior", "--autonomy", "assistant"],
      { sandbox, input: "n\n" },
    );
    assert.equal(install.status, 0, `install ${target.id} failed:\n${outputOf(install)}`);

    const managedPath = path.join(sandbox.projectDir, target.managedFile);
    assert.ok(fs.existsSync(managedPath), `install ${target.id} did not write ${target.managedFile}`);
    const canonical = fs.readFileSync(managedPath);
    fs.appendFileSync(managedPath, "\nmanual drift\n");
    assert.notDeepEqual(fs.readFileSync(managedPath), canonical);

    const update = runCli(cli, ["update"], { sandbox, input: "n\nn\nn\n" });
    const output = outputOf(update);
    assert.equal(update.status, 0, `update ${target.id} failed:\n${output}`);
    assert.deepEqual(
      fs.readFileSync(managedPath),
      canonical,
      `${target.id}: the hand-edited managed file did not return to canonical content`,
    );

    const reported = restoredNoticePath(output, target.id);
    const reportedAbsolute = path.isAbsolute(reported) ? reported : path.resolve(sandbox.projectDir, reported);
    assert.ok(fs.existsSync(reportedAbsolute), `${target.id}: the report names a missing path ${reported}`);
    assert.equal(
      fs.realpathSync(reportedAbsolute),
      fs.realpathSync(managedPath),
      `${target.id}: the report does not name the restored file`,
    );
  }
});
