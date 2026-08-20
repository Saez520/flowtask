import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createProjectState,
  createGlobalState,
  resolveGlobalConfigDir,
  globalStatePath,
  projectStatePath,
  readJsonSafe,
  writeJsonAtomic,
  loadGlobalState,
  saveGlobalState,
  loadProjectState,
  saveProjectState,
  migrateProjectState,
  detectGraphify,
  installGraphify,
  installHooks,
  ensureGitignoreEntries,
  registerExtension,
  runExtension,
  clearExtensions,
  coordinateGraphify,
} from "../lib/graphify.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphify-test-"));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Schema v1 ────────────────────────────────────────────────────────────────

describe("Schema v1", () => {
  it("createProjectState returns all required fields with safe defaults", () => {
    const state = createProjectState();
    assert.equal(state.schema, 1);
    assert.equal(state.enabled, false);
    assert.deepEqual(state.selectedClis, []);
    assert.equal(state.initialized, false);
    assert.equal(state.graphPath, null);
    assert.equal(state.hooksInstalled, false);
    assert.equal(state.ignoredOutput, "graphify-out/");
    assert.equal(state.lastInitializationResult, null);
    assert.equal(state.lastWarning, null);
    // plan-grafo fields
    assert.equal(state.extract_status, "pending");
    assert.equal(state.extract_last_attempt, null);
    assert.equal(state.query_status, "pending");
    assert.equal(state.query_last_attempt, null);
    assert.equal(state.query_diagnostic, null);
    // plan-docs-media fields
    assert.equal(state.docs_media_status, "pending");
    assert.equal(state.docs_media_last_attempt, null);
    assert.equal(state.docs_media_attempt_status, null);
    assert.deepEqual(state.docs_media_output_paths, []);
    assert.equal(state.docs_media_finished_at, null);
    assert.equal(state.docs_media_diagnostic, null);
  });

  it("createGlobalState returns all required fields", () => {
    const state = createGlobalState();
    assert.equal(state.schema, 1);
    assert.equal(state.available, false);
    assert.equal(state.version, null);
    assert.equal(state.lastCheckedAt, null);
    assert.equal(state.lastInstallResult, null);
    assert.equal(state.lastWarning, null);
    assert.equal(state.lastInstallMethod, null);
    assert.equal(state.lastInstallCommand, null);
    assert.equal(state.lastInstallExitCode, null);
    assert.equal(state.lastInstallStderr, null);
  });
});

// ─── Paths ────────────────────────────────────────────────────────────────────

describe("Paths", () => {
  it("projectStatePath returns correct path", () => {
    const p = projectStatePath("/tmp/myproject");
    assert.equal(p, path.join("/tmp/myproject", ".flowtask", "config", "graphify.json"));
  });

  it("globalStatePath returns a path ending with flowtask/graphify.json", () => {
    const p = globalStatePath();
    assert.ok(p.endsWith(path.join("flowtask", "graphify.json")));
  });

  it("resolveGlobalConfigDir returns a non-empty string", () => {
    const dir = resolveGlobalConfigDir();
    assert.ok(typeof dir === "string" && dir.length > 0);
  });

  it("resolves project state under the active installation", () => {
    assert.equal(
      projectStatePath("/tmp/project", "/tmp/flowtask"),
      path.join("/tmp/flowtask", "config", "graphify.json"),
    );
  });

  it("migrates legacy state and removes it only after verification", () => {
    const projectDir = makeTempDir();
    const flowtaskDir = path.join(projectDir, "installation");
    const legacyPath = path.join(projectDir, ".flowtask", "config", "graphify.json");
    const state = createProjectState();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(state), "utf8");

    assert.equal(migrateProjectState(projectDir, flowtaskDir), true);
    assert.equal(fs.existsSync(legacyPath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(projectStatePath(projectDir, flowtaskDir), "utf8")), state);
    cleanupDir(projectDir);
  });

  it("preserves legacy state when installation destination cannot be written", () => {
    const projectDir = makeTempDir();
    const legacyPath = path.join(projectDir, ".flowtask", "config", "graphify.json");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify(createProjectState()), "utf8");

    assert.equal(migrateProjectState(projectDir, "/dev/null/flowtask"), false);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(fs.existsSync("/dev/null/flowtask/config/graphify.json"), false);
    cleanupDir(projectDir);
  });
});

// ─── Atomic read / write ──────────────────────────────────────────────────────

describe("Atomic read/write", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("readJsonSafe returns fallback when file does not exist", () => {
    const result = readJsonSafe(path.join(tempDir, "nonexistent.json"), { default: true });
    assert.deepEqual(result, { default: true });
  });

  it("readJsonSafe returns fallback when file is invalid JSON", () => {
    const filePath = path.join(tempDir, "invalid.json");
    fs.writeFileSync(filePath, "not json{{{", "utf8");
    const result = readJsonSafe(filePath, null);
    assert.equal(result, null);
  });

  it("readJsonSafe parses valid JSON", () => {
    const filePath = path.join(tempDir, "valid.json");
    fs.writeFileSync(filePath, '{"hello":"world"}', "utf8");
    const result = readJsonSafe(filePath);
    assert.deepEqual(result, { hello: "world" });
  });

  it("writeJsonAtomic creates file and parent directories", () => {
    const filePath = path.join(tempDir, "sub", "dir", "state.json");
    const ok = writeJsonAtomic(filePath, { test: true });
    assert.equal(ok, true);
    assert.ok(fs.existsSync(filePath));
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.deepEqual(content, { test: true });
  });

  it("writeJsonAtomic overwrites existing file atomically", () => {
    const filePath = path.join(tempDir, "state.json");
    writeJsonAtomic(filePath, { v: 1 });
    writeJsonAtomic(filePath, { v: 2 });
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(content.v, 2);
  });

  it("writeJsonAtomic leaves no orphan temp file on success", () => {
    const filePath = path.join(tempDir, "state.json");
    writeJsonAtomic(filePath, { ok: true });
    const files = fs.readdirSync(tempDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp"));
    assert.equal(tmpFiles.length, 0);
  });
});

// ─── Load / Save state ────────────────────────────────────────────────────────

describe("Load/Save state", () => {
  let tempDir;
  let origXdg;
  let origAppdata;

  beforeEach(() => {
    tempDir = makeTempDir();
    origXdg = process.env.XDG_CONFIG_HOME;
    origAppdata = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, "xdg");
  });

  afterEach(() => {
    cleanupDir(tempDir);
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    if (origAppdata !== undefined) process.env.APPDATA = origAppdata;
  });

  it("loadGlobalState creates fresh state when file missing", () => {
    const state = loadGlobalState();
    assert.equal(state.schema, 1);
    assert.equal(state.available, false);
  });

  it("saveGlobalState + loadGlobalState round-trips", () => {
    const state = createGlobalState();
    state.available = true;
    state.version = "1.2.3";
    saveGlobalState(state);
    const loaded = loadGlobalState();
    assert.equal(loaded.available, true);
    assert.equal(loaded.version, "1.2.3");
  });

  it("loadProjectState creates fresh state when file missing", () => {
    const state = loadProjectState(tempDir);
    assert.equal(state.schema, 1);
    assert.equal(state.enabled, false);
    assert.equal(state.docs_media_status, "pending");
  });

  it("saveProjectState + loadProjectState round-trips", () => {
    const state = createProjectState();
    state.enabled = true;
    state.selectedClis = ["opencode", "claude"];
    saveProjectState(tempDir, state);
    const loaded = loadProjectState(tempDir);
    assert.equal(loaded.enabled, true);
    assert.deepEqual(loaded.selectedClis, ["opencode", "claude"]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe("detectGraphify", () => {
  let tempDir;
  let origXdg;

  beforeEach(() => {
    tempDir = makeTempDir();
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, "xdg");
  });

  afterEach(() => {
    cleanupDir(tempDir);
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it("sets available=true and version when binary found", () => {
    const state = createGlobalState();
    detectGraphify(state, {
      detectFn: () => true,
      versionFn: () => "2.0.0",
    });
    assert.equal(state.available, true);
    assert.equal(state.version, "2.0.0");
    assert.ok(state.lastCheckedAt);
  });

  it("sets available=false and version=null when binary missing", () => {
    const state = createGlobalState();
    detectGraphify(state, {
      detectFn: () => false,
      versionFn: () => null,
    });
    assert.equal(state.available, false);
    assert.equal(state.version, null);
  });

  it("persists global state after detection", () => {
    const state = createGlobalState();
    detectGraphify(state, { detectFn: () => true, versionFn: () => "1.0" });
    const loaded = loadGlobalState();
    assert.equal(loaded.available, true);
  });
});

// ─── Installation adapter ─────────────────────────────────────────────────────

describe("installGraphify", () => {
  it("returns success when runner returns exit 0", () => {
    const result = installGraphify({
      command: "custom install graphifyy",
      runFn: () => ({ status: 0 }),
    });
    assert.equal(result.success, true);
    assert.equal(result.warning, null);
    assert.equal(result.method, "override");
    assert.equal(result.command, "custom install graphifyy");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
  });

  it("returns failure with warning when runner returns non-zero", () => {
    const result = installGraphify({
      command: "custom install graphifyy",
      runFn: () => ({ status: 1, stderr: "falló" }),
    });
    assert.equal(result.success, false);
    assert.ok(result.warning.includes("Reintenta con flowtask update"));
    assert.ok(result.warning.includes("contacta a un administrador"));
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "falló");
  });

  it("returns failure when runner throws", () => {
    const result = installGraphify({
      command: "custom install graphifyy",
      runFn: () => { throw new Error("network error"); },
    });
    assert.equal(result.success, false);
    assert.ok(result.warning.includes("network error"));
    assert.equal(result.exitCode, null);
    assert.equal(result.stderr, "network error");
  });

  it("resuelve el override antes de detectar instaladores", () => {
    const original = process.env.FLOWTASK_GRAPHIFY_INSTALL_COMMAND;
    process.env.FLOWTASK_GRAPHIFY_INSTALL_COMMAND = "operador --instala graphifyy";
    try {
      const result = installGraphify({
        detectFn: () => { throw new Error("no debe detectar"); },
        runFn: (command) => {
          assert.equal(command, "operador --instala graphifyy");
          return { status: 0 };
        },
      });
      assert.equal(result.method, "override");
      assert.equal(result.command, "operador --instala graphifyy");
    } finally {
      if (original === undefined) delete process.env.FLOWTASK_GRAPHIFY_INSTALL_COMMAND;
      else process.env.FLOWTASK_GRAPHIFY_INSTALL_COMMAND = original;
    }
  });

  it("selecciona pipx antes que uv", () => {
    const result = installGraphify({
      detectFn: (name) => name === "pipx" || name === "uv",
      runFn: (command) => {
        assert.equal(command, "pipx install graphifyy");
        return { status: 0 };
      },
    });
    assert.equal(result.method, "pipx");
    assert.equal(result.command, "pipx install graphifyy");
  });

  it("selecciona uv cuando pipx no está disponible", () => {
    const result = installGraphify({
      detectFn: (name) => name === "uv",
      runFn: (command) => {
        assert.equal(command, "uv tool install graphifyy");
        return { status: 0 };
      },
    });
    assert.equal(result.method, "uv");
    assert.equal(result.command, "uv tool install graphifyy");
  });

  it("rechaza sin instalador y no ejecuta el runner", () => {
    let called = false;
    const result = installGraphify({
      detectFn: () => false,
      runFn: () => { called = true; return { status: 0 }; },
    });
    assert.equal(called, false);
    assert.equal(result.success, false);
    assert.equal(result.method, "none");
    assert.equal(result.command, null);
    assert.equal(result.exitCode, null);
    assert.match(result.warning, /pipx.*uv/);
    assert.match(result.stderr, /pipx.*uv/);
  });

  it("trunca stderr a 2048 caracteres", () => {
    const stderr = "x".repeat(3000);
    const result = installGraphify({
      command: "custom install graphifyy",
      runFn: () => ({ status: 7, stderr }),
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr.length, 2048);
    assert.equal(result.stderr, stderr.slice(0, 2048));
  });
});

// ─── Hooks ────────────────────────────────────────────────────────────────────

describe("installHooks", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("returns success when hook runner returns exit 0", () => {
    const result = installHooks(tempDir, {
      runFn: (cmd, opts) => {
        assert.ok(cmd.includes("graphify hook install"));
        assert.equal(opts.cwd, tempDir);
        return { status: 0 };
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.warning, null);
  });

  it("returns failure with warning when hook runner fails", () => {
    const result = installHooks(tempDir, {
      runFn: () => ({ status: 1 }),
    });
    assert.equal(result.success, false);
    assert.ok(result.warning.includes("hooks fallaron"));
  });

  it("returns failure when hook runner throws", () => {
    const result = installHooks(tempDir, {
      runFn: () => { throw new Error("hook error"); },
    });
    assert.equal(result.success, false);
    assert.ok(result.warning.includes("hook error"));
  });
});

// ─── .gitignore ───────────────────────────────────────────────────────────────

describe("ensureGitignoreEntries", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("creates .gitignore with entries when file does not exist", () => {
    ensureGitignoreEntries(tempDir);
    const content = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8");
    assert.ok(content.includes("graphify-out/"));
  });

  it("adds entries to existing .gitignore", () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n", "utf8");
    ensureGitignoreEntries(tempDir);
    const content = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8");
    assert.ok(content.includes("node_modules"));
    assert.ok(content.includes("graphify-out/"));
  });

  it("is idempotent — does not duplicate entries", () => {
    ensureGitignoreEntries(tempDir);
    ensureGitignoreEntries(tempDir);
    const content = fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8");
    const count = (content.match(/graphify-out\//g) || []).length;
    assert.equal(count, 1);
  });
});

// ─── Extension registry ──────────────────────────────────────────────────────

describe("Extension registry", () => {
  beforeEach(() => { clearExtensions(); });
  afterEach(() => { clearExtensions(); });

  it("registerExtension stores handler", async () => {
    registerExtension("extract", () => ({ status: "success" }));
    const result = await runExtension("extract", {});
    assert.equal(result.status, "success");
  });

  it("runExtension returns null when no extension registered", async () => {
    const result = await runExtension("nonexistent", {});
    assert.equal(result, null);
  });

  it("runExtension catches handler errors", async () => {
    registerExtension("extract", () => { throw new Error("boom"); });
    const result = await runExtension("extract", {});
    assert.equal(result.status, "failed");
    assert.ok(result.warning.includes("boom"));
  });

  it("runExtension strips graphPath when status is not success", async () => {
    registerExtension("extract", () => ({
      status: "failed",
      graphPath: "/some/path/graph.json",
    }));
    const result = await runExtension("extract", {});
    assert.equal(result.status, "failed");
    assert.equal(result.graphPath, null);
  });

  it("runExtension preserves graphPath when status is success", async () => {
    registerExtension("extract", () => ({
      status: "success",
      graphPath: "/some/path/graph.json",
    }));
    const result = await runExtension("extract", {});
    assert.equal(result.status, "success");
    assert.equal(result.graphPath, "/some/path/graph.json");
  });

  it("registerExtension throws on invalid args", () => {
    assert.throws(() => registerExtension("", () => {}), /phaseName/);
    assert.throws(() => registerExtension("test", "not a function"), /handler/);
  });
});

// ─── Coordinator ──────────────────────────────────────────────────────────────

describe("coordinateGraphify", () => {
  let tempDir;
  let origXdg;

  // Mock readline that auto-answers questions
  function mockReadline(answers = {}) {
    return {
      createInterface: () => ({
        question: (prompt, cb) => {
          // Determine which question based on prompt content
          if (prompt.includes("Instalarlo")) cb(answers.install ?? "y");
          else if (prompt.includes("Habilitar")) cb(answers.enable ?? "y");
          else if (prompt.includes("hooks")) cb(answers.hooks ?? "y");
          else cb("y");
        },
        close: () => {},
      }),
    };
  }

  beforeEach(() => {
    tempDir = makeTempDir();
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, "xdg");
    clearExtensions();
  });

  afterEach(() => {
    cleanupDir(tempDir);
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    clearExtensions();
  });

  it("happy path: install + enable + hooks all accepted", async () => {
    const rl = mockReadline({ install: "y", enable: "y", hooks: "y" });
    const { projectState, warnings } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode", "claude"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "2.0.0",
        runFn: () => ({ status: 0 }),
        grafoExtensions: false,
      },
    });

    assert.equal(projectState.enabled, true);
    assert.equal(projectState.initialized, true);
    assert.equal(projectState.hooksInstalled, true);
    assert.deepEqual(projectState.selectedClis, ["opencode", "claude"]);
    assert.equal(projectState.docs_media_status, "pending");
    assert.equal(warnings.length, 0);
  });

  it("reject install: state is skipped, no hooks or init", async () => {
    const rl = mockReadline({ install: "n" });
    const { projectState, warnings } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => false,
        versionFn: () => null,
      },
    });

    assert.equal(projectState.enabled, false);
    assert.equal(projectState.lastInitializationResult, "skipped");
    assert.equal(projectState.hooksInstalled, false);
    assert.ok(warnings.length > 0);
  });

  it("reject enable: state is skipped but selectedClis preserved", async () => {
    const rl = mockReadline({ install: "y", enable: "n" });
    const { projectState } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
      },
    });

    assert.equal(projectState.enabled, false);
    assert.equal(projectState.lastInitializationResult, "skipped");
    assert.deepEqual(projectState.selectedClis, ["opencode"]);
  });

  it("install failure: state is failed, warning returned", async () => {
    const rl = mockReadline({ install: "y" });
    const { projectState, warnings } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => false,
        versionFn: () => null,
        installCmdFn: () => "custom install graphifyy",
        runFn: () => ({ status: 1, stderr: "error de prueba" }),
      },
    });

    assert.equal(projectState.enabled, false);
    assert.equal(projectState.lastInitializationResult, "failed");
    assert.ok(warnings.some((w) => w.includes("Reintenta con flowtask update")));
    const globalState = loadGlobalState();
    assert.equal(globalState.lastInstallMethod, "override");
    assert.equal(globalState.lastInstallCommand, "custom install graphifyy");
    assert.equal(globalState.lastInstallExitCode, 1);
    assert.equal(globalState.lastInstallStderr, "error de prueba");
  });

  it("hook failure: hooksInstalled=false, warning returned, flow continues", async () => {
    let callCount = 0;
    const rl = mockReadline({ install: "y", enable: "y", hooks: "y" });
    const { projectState, warnings } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: (cmd) => {
          callCount++;
          // Hook install fails
          if (cmd.includes("graphify hook install")) return { status: 1 };
          return { status: 0 };
        },
      },
    });

    assert.equal(projectState.enabled, true);
    assert.equal(projectState.hooksInstalled, false);
    assert.ok(warnings.some((w) => w.includes("hooks fallaron")));
  });

  it("never throws on any failure path", async () => {
    const rl = mockReadline({ install: "y", enable: "y", hooks: "y" });
    // All runners throw
    await assert.doesNotReject(
      coordinateGraphify({
        projectDir: tempDir,
        selectedClis: ["opencode"],
        readline: rl,
        opts: {
          detectFn: () => false,
          versionFn: () => null,
          installCmdFn: () => "custom install graphifyy",
          runFn: () => { throw new Error("total failure"); },
        },
      }),
    );
  });

  it("persiste metadata de instalación exitosa antes de redetectar", async () => {
    const rl = mockReadline({ install: "y", enable: "n" });
    const { projectState, globalState } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: (name) => name === "pipx",
        versionFn: () => "1.0",
        runFn: (command) => {
          assert.equal(command, "pipx install graphifyy");
          return { status: 0, stderr: "" };
        },
        grafoExtensions: false,
      },
    });

    assert.equal(projectState.lastInitializationResult, "skipped");
    assert.equal(globalState.lastInstallResult, "success");
    assert.equal(globalState.lastInstallMethod, "pipx");
    assert.equal(globalState.lastInstallCommand, "pipx install graphifyy");
    assert.equal(globalState.lastInstallExitCode, 0);
    assert.equal(globalState.lastInstallStderr, "");
    assert.deepEqual(loadGlobalState(), globalState);
  });

  it("runs registered extensions and persists their results", async () => {
    registerExtension("extract", () => ({
      status: "success",
      graphPath: "graphify-out/graph.json",
    }));
    registerExtension("query", () => ({
      status: "success",
      diagnostic: "all good",
    }));

    const rl = mockReadline({ install: "y", enable: "y", hooks: "n" });
    const { projectState } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
        grafoExtensions: false,
      },
    });

    assert.equal(projectState.extract_status, "success");
    assert.equal(projectState.graphPath, "graphify-out/graph.json");
    assert.equal(projectState.query_status, "success");
    assert.equal(projectState.query_diagnostic, "all good");
    assert.ok(projectState.extract_last_attempt);
    assert.ok(projectState.query_last_attempt);
  });

  it("clears a stale query diagnostic after a successful query", async () => {
    const previous = createProjectState();
    previous.query_status = "failed";
    previous.query_diagnostic = "grafo indisponible";
    saveProjectState(tempDir, previous);
    registerExtension("query", () => ({ status: "success" }));

    const { projectState } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: mockReadline({ install: "y", enable: "y", hooks: "n" }),
      opts: { detectFn: () => true, versionFn: () => "1.0", runFn: () => ({ status: 0 }), grafoExtensions: false },
    });

    assert.equal(projectState.query_status, "success");
    assert.equal(projectState.query_diagnostic, null);
    assert.equal(JSON.parse(fs.readFileSync(projectStatePath(tempDir), "utf8")).query_diagnostic, null);
  });

  it("preserves diagnostics for failed and skipped queries", async () => {
    for (const result of [
      { status: "failed", diagnostic: "MCP no disponible" },
      { status: "skipped", diagnostic: "graphPath no disponible" },
    ]) {
      clearExtensions();
      registerExtension("query", () => result);
      const { projectState } = await coordinateGraphify({
        projectDir: tempDir,
        selectedClis: ["opencode"],
        readline: mockReadline({ install: "y", enable: "y", hooks: "n" }),
        opts: { detectFn: () => true, versionFn: () => "1.0", runFn: () => ({ status: 0 }), grafoExtensions: false },
      });
      assert.equal(projectState.query_status, result.status);
      assert.equal(projectState.query_diagnostic, result.diagnostic);
    }
  });

  it("does not execute extract when extension is not registered", async () => {
    const rl = mockReadline({ install: "y", enable: "y", hooks: "n" });
    const { projectState } = await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
        grafoExtensions: false,
      },
    });

    assert.equal(projectState.extract_status, "pending");
    assert.equal(projectState.graphPath, null);
  });

  it("persists project state to disk", async () => {
    const rl = mockReadline({ install: "y", enable: "y", hooks: "n" });
    await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
      },
    });

    const statePath = projectStatePath(tempDir);
    assert.ok(fs.existsSync(statePath));
    const loaded = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(loaded.schema, 1);
    assert.equal(loaded.enabled, true);
  });

  it("does not modify profile.json", async () => {
    const profileDir = path.join(tempDir, ".flowtask", "config");
    fs.mkdirSync(profileDir, { recursive: true });
    const profilePath = path.join(profileDir, "profile.json");
    fs.writeFileSync(profilePath, '{"level":"senior"}', "utf8");

    const rl = mockReadline({ install: "y", enable: "y", hooks: "n" });
    await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
      },
    });

    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    assert.equal(profile.level, "senior");
  });

  it("ensures .gitignore entries after enable", async () => {
    const rl = mockReadline({ install: "y", enable: "y", hooks: "n" });
    await coordinateGraphify({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      readline: rl,
      opts: {
        detectFn: () => true,
        versionFn: () => "1.0",
        runFn: () => ({ status: 0 }),
      },
    });

    const gitignorePath = path.join(tempDir, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath));
    const content = fs.readFileSync(gitignorePath, "utf8");
    assert.ok(content.includes("graphify-out/"));
  });
});
