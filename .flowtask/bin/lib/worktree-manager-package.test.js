/**
 * Acquisition boundary of the Worktree Manager.
 *
 * These tests exercise the npm command line, the package verification and the
 * visible degradation without network access: the npm executable is a local
 * fixture that installs a prepared package into the prefix, so the assertions
 * observe the exact contract the installer relies on.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareGlobalWorktreeManager, prepareWorktreeManagerForRun } from "./installer.js";
import { WORKTREE_MANAGER_OWNER_FILE } from "./worktree-manager-runtime.js";

const fixtures = [];

function mkTmp(prefix = "flowtask-wm-package-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

const MCP_TRANSPORT_SOURCE = `import json
import sys

TOOLS = (
    "worktree_create", "worktree_complete", "worktree_cleanup",
    "worktree_recover", "worktree_list", "worktree_prune", "worktree_status",
)

for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "initialize":
        answer = {"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "fixture", "version": "1.0.0"}}}
    elif message.get("method") == "tools/list":
        answer = {"jsonrpc": "2.0", "id": message["id"], "result": {"tools": [{"name": name} for name in TOOLS]}}
    else:
        answer = {"jsonrpc": "2.0", "id": message.get("id"), "result": {}}
    sys.stdout.write(json.dumps(answer) + "\\n")
    sys.stdout.flush()
`;

/** A package shaped like the published tarball: manifest plus the three entrypoints. */
function writePackage(root, { version = "9.9.9", omitMcpTransport = false } = {}) {
  const packageDir = path.join(root, "package");
  fs.mkdirSync(path.join(packageDir, "worktree_manager"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "worktree-for-agents", version }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "worktree.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  fs.writeFileSync(path.join(packageDir, "worktree_manager", "__init__.py"), `__version__ = "${version}"\n`, "utf8");
  fs.writeFileSync(
    path.join(packageDir, "worktree_manager", "__main__.py"),
    "import sys\nfrom . import __version__\n\nif \"--version\" in sys.argv:\n    print(__version__)\n",
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "worktree_manager", "mcp_server.py"), "", "utf8");
  fs.writeFileSync(path.join(packageDir, "worktree_manager", "mcp_contract.py"), "", "utf8");
  fs.writeFileSync(path.join(packageDir, "worktree_manager", "mcp_operations.py"), "", "utf8");
  if (!omitMcpTransport) {
    fs.writeFileSync(path.join(packageDir, "worktree_manager", "mcp_transport.py"), MCP_TRANSPORT_SOURCE, "utf8");
  }
  return packageDir;
}

/**
 * A local npm replacement. It installs the prepared package into the prefix the
 * installer passes and can fail on demand; it never touches the network.
 */
function writeNpmFixture(root) {
  const file = path.join(root, "fake-npm.mjs");
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_NPM_ARGS) fs.writeFileSync(process.env.FAKE_NPM_ARGS, JSON.stringify(args));
if (process.env.FAKE_NPM_FAIL) {
  process.stderr.write("npm ERR! code ENOTFOUND\\nnpm ERR! network request to the registry failed\\n");
  process.exit(1);
}
const prefix = args[args.indexOf("--prefix") + 1];
const target = path.join(prefix, "node_modules", "worktree-for-agents");
fs.mkdirSync(target, { recursive: true });
fs.cpSync(process.env.FAKE_NPM_PACKAGE, target, { recursive: true });
`, { mode: 0o755 });
  return file;
}

/**
 * gap_ref: G1 — C1
 * defecto: A regression in the npm download, the package verification or the
 *   global publication could publish incomplete files or the wrong version.
 * why_not_detected: No existing test exercised the npm boundary; the installer
 *   fixture was a local submodule.
 * comportamiento observable: The npm command receives `worktree-for-agents@latest`;
 *   the verified package version is published with `source: "npm"`,
 *   `sourceCommit: null` and complete entrypoints; an incomplete package fails
 *   with WORKTREE_MANAGER_DOWNLOAD_FAILED and never reaches the destination.
 */
test("the npm package is verified before the global copy is published with an npm marker", () => {
  const root = mkTmp();
  const packageDir = writePackage(root);
  const npm = writeNpmFixture(root);
  const capture = path.join(root, "npm-args.json");
  const workDir = path.join(root, "work");
  const globalDir = path.join(root, "global", "worktree-manager");

  const report = prepareGlobalWorktreeManager({
    npmBin: npm,
    workDir,
    globalManagerDir: globalDir,
    env: { ...process.env, FAKE_NPM_PACKAGE: packageDir, FAKE_NPM_ARGS: capture },
  });

  const args = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(args[0], "install");
  assert.ok(args.includes("--ignore-scripts"), "package lifecycle scripts must not run");
  assert.ok(args.includes("--no-save"));
  assert.ok(args.includes("--no-package-lock"));
  assert.equal(args[args.indexOf("--prefix") + 1].startsWith(workDir), true, "the prefix is the isolated work directory");
  assert.equal(args.at(-1), "worktree-for-agents@latest");

  assert.equal(report.source, "global");
  assert.equal(report.sourceKind, "npm");
  assert.equal(report.version, "9.9.9");
  assert.equal(fs.existsSync(path.join(globalDir, "worktree.sh")), true);
  assert.equal(fs.existsSync(path.join(globalDir, "worktree_manager", "mcp_transport.py")), true);
  assert.equal(fs.statSync(path.join(globalDir, "worktree.sh")).mode & 0o777, 0o755, "the entrypoint stays executable");
  assert.equal(fs.existsSync(path.join(globalDir, "package.json")), false, "the manager is published without npm metadata");

  const marker = JSON.parse(fs.readFileSync(path.join(globalDir, WORKTREE_MANAGER_OWNER_FILE), "utf8"));
  assert.equal(marker.source, "npm");
  assert.equal(marker.sourceCommit, null);
  assert.equal(marker.version, "9.9.9");
  assert.ok(marker.files.includes("worktree.sh"));
  assert.ok(marker.files.includes("worktree_manager/mcp_transport.py"));
  assert.deepEqual(fs.readdirSync(workDir), [], "the temporary npm prefix is removed");

  const brokenRoot = mkTmp();
  const brokenPackage = writePackage(brokenRoot, { omitMcpTransport: true });
  const brokenNpm = writeNpmFixture(brokenRoot);
  const brokenWorkDir = path.join(brokenRoot, "work");
  const brokenGlobal = path.join(brokenRoot, "global", "worktree-manager");
  assert.throws(
    () => prepareGlobalWorktreeManager({
      npmBin: brokenNpm,
      workDir: brokenWorkDir,
      globalManagerDir: brokenGlobal,
      env: { ...process.env, FAKE_NPM_PACKAGE: brokenPackage },
    }),
    (error) => error.code === "WORKTREE_MANAGER_DOWNLOAD_FAILED" && /mcp_transport\.py/.test(error.message),
  );
  assert.equal(fs.existsSync(brokenGlobal), false, "an incomplete package is never published");
  assert.deepEqual(fs.readdirSync(brokenWorkDir), [], "the failed download is cleaned up");
});

/**
 * gap_ref: G2 — C3
 * defecto: The installer could abort on a network failure or continue silently
 *   without a warning.
 * why_not_detected: There was no fault injection at the download boundary and
 *   no capture of the visible warning.
 * comportamiento observable: install and update return null, emit the two
 *   warning lines with the cause and `flowtask update`, and leave the previous
 *   managed copy unchanged.
 */
test("a download failure degrades visibly and leaves the previous managed copy untouched", () => {
  const root = mkTmp();
  const npm = writeNpmFixture(root);
  const workDir = path.join(root, "work");
  const globalDir = path.join(root, "global", "worktree-manager");
  fs.mkdirSync(globalDir, { recursive: true });
  const markerPath = path.join(globalDir, WORKTREE_MANAGER_OWNER_FILE);
  const marker = {
    schema: 1,
    managedBy: "flowtask",
    component: "worktree-manager",
    source: "submodule",
    sourceCommit: "584e909",
    version: "1.0.1",
    files: ["worktree.sh", "worktree_manager/__main__.py"],
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(globalDir, "custom.txt"), "preserve-me", "utf8");
  const markerBefore = fs.readFileSync(markerPath, "utf8");

  const runDegraded = (mode) => {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      const report = prepareWorktreeManagerForRun({
        npmBin: npm,
        workDir,
        globalManagerDir: globalDir,
        env: { ...process.env, FAKE_NPM_FAIL: "1" },
      }, { mode });
      return { report, output: lines.join("\n") };
    } finally {
      console.log = originalLog;
    }
  };

  const install = runDegraded("install");
  assert.equal(install.report, null, "a download failure must not abort the installation");
  assert.match(install.output, /Worktree Manager could not be installed/);
  assert.match(install.output, /registry/);
  assert.match(install.output, /Worktrees are not available from this install/);
  assert.match(install.output, /Run 'flowtask update'/);

  const update = runDegraded("update");
  assert.equal(update.report, null, "a download failure must not abort the update");
  assert.match(update.output, /Worktree Manager could not be updated/);
  assert.match(update.output, /Worktrees are not available from this update/);
  assert.match(update.output, /previous copy, if any, was left unchanged/);

  assert.equal(fs.readFileSync(markerPath, "utf8"), markerBefore, "the previous marker is untouched");
  assert.equal(fs.readFileSync(path.join(globalDir, "custom.txt"), "utf8"), "preserve-me");
  assert.deepEqual(fs.readdirSync(workDir), [], "the failed download is cleaned up");
});
