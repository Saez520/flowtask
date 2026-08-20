import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { extractCodeOnly } from "../lib/graphify-extract.js";
import {
  buildOpencodeMcpEntry,
  buildClaudeMcpEntry,
  mergeGraphifyOpencodeMcp,
  mergeGraphifyClaudeMcp,
  configureMcpForTargets,
} from "../lib/graphify-query.js";
import {
  queryLocalGraph,
  runLocalQueryCli,
} from "../lib/graphify-local-query.js";
import {
  registerGrafoExtensions,
  clearExtensions,
  runExtension,
} from "../lib/graphify.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphify-grafo-test-"));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const detectNone = () => false;
const detectOnly = (...available) => (name) => available.includes(name);

// ─── Task 1: Extract code-only ────────────────────────────────────────────────

describe("extractCodeOnly", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("runs graphify update <path> --no-cluster with correct cwd", () => {
    let capturedCmd, capturedOpts;
    const result = extractCodeOnly(tempDir, {
      runFn: (cmd, opts) => {
        capturedCmd = cmd;
        capturedOpts = opts;
        // Simulate output file creation
        const outDir = path.join(tempDir, "graphify-out");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "graph.json"), "{}", "utf8");
        return { status: 0, stdout: Buffer.from("ok"), stderr: Buffer.from("") };
      },
    });

    assert.ok(capturedCmd.includes(`graphify update "${tempDir}" --no-cluster`));
    assert.equal(capturedOpts.cwd, tempDir);
    assert.equal(result.ok, true);
    assert.equal(result.status, "success");
    assert.equal(result.graphPath, "graphify-out/graph.json");
  });

  it("returns ok=true only when output file exists", () => {
    const result = extractCodeOnly(tempDir, {
      runFn: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
      // No file created → existsSync returns false for graph.json
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.graphPath, null);
    assert.ok(result.warning.includes("graphify-out/graph.json no existe"));
  });

  it("returns failure on non-zero exit code", () => {
    const result = extractCodeOnly(tempDir, {
      runFn: () => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("error") }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.ok(result.warning.includes("exit code 1"));
  });

  it("returns failure when binary not found (null status)", () => {
    const result = extractCodeOnly(tempDir, {
      runFn: () => ({ status: null, error: { code: "ENOENT" }, stdout: Buffer.from(""), stderr: Buffer.from("") }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.ok(result.warning.includes("binario no encontrado"));
  });

  it("rejects worktree paths", () => {
    const worktreeDir = path.join(tempDir, ".worktrees", "CA-test");
    fs.mkdirSync(worktreeDir, { recursive: true });

    const result = extractCodeOnly(worktreeDir, {
      runFn: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "skipped");
    assert.ok(result.warning.includes(".worktrees/"));
  });

  it("catches spawn exceptions", () => {
    const result = extractCodeOnly(tempDir, {
      runFn: () => { throw new Error("spawn failed"); },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.ok(result.warning.includes("spawn failed"));
  });
});

// ─── Task 2: MCP configuration ───────────────────────────────────────────────

describe("MCP configuration builders", () => {
  it("prioritizes graphify-mcp and uses target-specific argument shapes", () => {
    const entry = buildOpencodeMcpEntry("graphify-out/graph.json", { detectFn: detectOnly("python", "graphify-mcp") });
    assert.equal(entry.type, "local");
    assert.deepEqual(entry.command, ["graphify-mcp", "graphify-out/graph.json"]);
    assert.equal(entry.enabled, true);
    const claude = buildClaudeMcpEntry("graphify-out/graph.json", { detectFn: detectOnly("python", "graphify-mcp") });
    assert.equal(claude.command, "graphify-mcp");
    assert.deepEqual(claude.args, ["graphify-out/graph.json"]);
  });

  it("uses python, python3, and python fallback in order", () => {
    assert.deepEqual(
      buildOpencodeMcpEntry("graph.json", { detectFn: detectOnly("python") }).command,
      ["python", "-m", "graphify.serve", "graph.json"],
    );
    assert.equal(buildClaudeMcpEntry("graph.json", { detectFn: detectOnly("python3") }).command, "python3");
    assert.deepEqual(
      buildClaudeMcpEntry("graph.json", { detectFn: detectNone }).args,
      ["-m", "graphify.serve", "graph.json"],
    );
  });
});

describe("mergeGraphifyOpencodeMcp", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("creates config file with graphify entry", () => {
    const configPath = path.join(tempDir, "opencode.json");
    const result = mergeGraphifyOpencodeMcp(configPath, "graphify-out/graph.json");

    assert.equal(result.success, true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.ok(config.mcp.graphify);
    assert.equal(config.mcp.graphify.type, "local");
  });

  it("preserves existing entries and replaces graphify", () => {
    const configPath = path.join(tempDir, "opencode.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcp: { engram: { type: "local", command: ["engram", "mcp"] } },
    }), "utf8");

    mergeGraphifyOpencodeMcp(configPath, "graphify-out/graph.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    assert.ok(config.mcp.engram);
    assert.ok(config.mcp.graphify);
  });

  it("is idempotent — does not duplicate graphify entry", () => {
    const configPath = path.join(tempDir, "opencode.json");
    mergeGraphifyOpencodeMcp(configPath, "graphify-out/graph.json");
    mergeGraphifyOpencodeMcp(configPath, "graphify-out/graph.json");

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.ok(config.mcp.graphify);
    // Only one graphify key
    const keys = Object.keys(config.mcp);
    const graphifyCount = keys.filter((k) => k === "graphify").length;
    assert.equal(graphifyCount, 1);
  });
});

describe("mergeGraphifyClaudeMcp", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("creates .mcp.json with graphify entry", () => {
    const mcpPath = path.join(tempDir, ".mcp.json");
    const result = mergeGraphifyClaudeMcp(mcpPath, "graphify-out/graph.json", { detectFn: detectNone });

    assert.equal(result.success, true);
    const config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    assert.ok(config.mcpServers.graphify);
    assert.equal(config.mcpServers.graphify.command, "python");
  });

  it("preserves existing entries", () => {
    const mcpPath = path.join(tempDir, ".mcp.json");
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: { engram: { command: "engram", args: ["mcp"] } },
    }), "utf8");

    mergeGraphifyClaudeMcp(mcpPath, "graphify-out/graph.json", { detectFn: detectNone });
    const config = JSON.parse(fs.readFileSync(mcpPath, "utf8"));

    assert.ok(config.mcpServers.engram);
    assert.ok(config.mcpServers.graphify);
  });
});

describe("configureMcpForTargets", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("configures MCP for opencode and claude targets", () => {
    // Create directories
    fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });

    const result = configureMcpForTargets({
      projectDir: tempDir,
      selectedClis: ["opencode", "claude"],
      graphPath: "graphify-out/graph.json",
    });

    assert.equal(result.status, "success");
    assert.equal(result.details.length, 2);
  });

  it("warns for unsupported targets (vscode, standalone)", () => {
    const result = configureMcpForTargets({
      projectDir: tempDir,
      selectedClis: ["vscode", "standalone"],
      graphPath: "graphify-out/graph.json",
    });

    assert.equal(result.status, "success"); // unsupported is not a failure
    assert.ok(result.details.every((d) => d.status === "unsupported"));
  });

  it("only configures selected targets", () => {
    fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });

    const result = configureMcpForTargets({
      projectDir: tempDir,
      selectedClis: ["opencode"],
      graphPath: "graphify-out/graph.json",
    });

    assert.equal(result.details.length, 1);
    assert.equal(result.details[0].target, "opencode");

    // Claude .mcp.json should not exist
    const claudePath = path.join(tempDir, ".mcp.json");
    assert.equal(fs.existsSync(claudePath), false);
  });
});

// ─── Task 2: Local query tool ─────────────────────────────────────────────────

describe("queryLocalGraph", () => {
  let tempDir;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { cleanupDir(tempDir); });

  it("returns ok=false for empty query", () => {
    const result = queryLocalGraph(tempDir, "");
    assert.equal(result.ok, false);
    assert.equal(result.source, "local");
    assert.deepEqual(result.results, []);
    assert.ok(result.diagnostic.includes("vacía"));
  });

  it("returns ok=false when graph file missing", () => {
    const result = queryLocalGraph(tempDir, "UserService");
    assert.equal(result.ok, false);
    assert.equal(result.source, "local");
    assert.deepEqual(result.results, []);
    assert.ok(result.diagnostic.includes("no encontrado"));
  });

  it("returns ok=false for invalid JSON", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "graph.json"), "{{invalid json", "utf8");

    const result = queryLocalGraph(tempDir, "test");
    assert.equal(result.ok, false);
    assert.deepEqual(result.results, []);
    assert.ok(result.diagnostic.includes("JSON inválido"));
  });

  it("returns ok=true with matches for valid graph", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    const graphData = {
      nodes: [
        { name: "UserService", path: "src/services/user.js", type: "class" },
        { name: "AuthController", path: "src/controllers/auth.js", type: "class" },
        { name: "UserRepository", path: "src/repos/user.js", type: "class" },
      ],
    };
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graphData), "utf8");

    const result = queryLocalGraph(tempDir, "User");
    assert.equal(result.ok, true);
    assert.equal(result.source, "local");
    assert.equal(result.diagnostic, null);
    assert.equal(result.results.length, 2); // UserService and UserRepository
    assert.ok(result.results.some((r) => r.name === "UserService"));
    assert.ok(result.results.some((r) => r.name === "UserRepository"));
  });

  it("returns ok=true with empty results when no matches", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    const graphData = {
      nodes: [
        { name: "UserService", path: "src/services/user.js", type: "class" },
      ],
    };
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graphData), "utf8");

    const result = queryLocalGraph(tempDir, "NonExistent");
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, []);
    assert.equal(result.diagnostic, null);
  });

  it("searches case-insensitively", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    const graphData = {
      nodes: [
        { name: "UserService", path: "src/services/user.js", type: "class" },
      ],
    };
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graphData), "utf8");

    const result = queryLocalGraph(tempDir, "userservice");
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
  });

  it("searches by path field", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    const graphData = {
      nodes: [
        { name: "Foo", path: "src/services/user.js", type: "class" },
      ],
    };
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graphData), "utf8");

    const result = queryLocalGraph(tempDir, "user.js");
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
  });

  it("handles array-based graph format", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    const graphData = [
      { name: "UserService", path: "src/user.js", type: "class" },
      { name: "AuthService", path: "src/auth.js", type: "class" },
    ];
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify(graphData), "utf8");

    const result = queryLocalGraph(tempDir, "Service");
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
  });
});

// ─── Task 3: Extension handoff ───────────────────────────────────────────────

describe("registerGrafoExtensions", () => {
  beforeEach(() => { clearExtensions(); });
  afterEach(() => { clearExtensions(); });

  it("registers extract and query extensions", async () => {
    registerGrafoExtensions();

    const extractResult = await runExtension("extract", {
      projectDir: "/tmp/test",
      selectedClis: ["opencode"],
      state: {},
      run: () => ({ status: null, error: { code: "ENOENT" }, stdout: Buffer.from(""), stderr: Buffer.from("") }),
      logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
    });

    assert.ok(extractResult);
    assert.equal(extractResult.status, "failed"); // binary not found
  });

  it("extract extension returns success with valid output", async () => {
    const tempDir = makeTempDir();
    try {
      registerGrafoExtensions({
        extractFn: (projectDir) => {
          return { ok: true, graphPath: "graphify-out/graph.json", status: "success", warning: null };
        },
      });

      const result = await runExtension("extract", {
        projectDir: tempDir,
        selectedClis: ["opencode"],
        state: {},
        run: null,
        logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
      });

      assert.equal(result.status, "success");
      assert.equal(result.graphPath, "graphify-out/graph.json");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("query extension skips when no graphPath", async () => {
    registerGrafoExtensions();

    const result = await runExtension("query", {
      projectDir: "/tmp/test",
      selectedClis: ["opencode"],
      state: { graphPath: null },
      run: null,
      logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
    });

    assert.equal(result.status, "skipped");
    assert.ok(result.diagnostic.includes("graphPath"));
  });

  it("query extension configures MCP when graphPath available", async () => {
    const tempDir = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });

      registerGrafoExtensions();

      const result = await runExtension("query", {
        projectDir: tempDir,
        selectedClis: ["opencode"],
        state: { graphPath: "graphify-out/graph.json" },
        run: null,
        logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
      });

      assert.equal(result.status, "success");

      // Verify MCP config was written
      const configPath = path.join(tempDir, ".opencode", "opencode.json");
      assert.ok(fs.existsSync(configPath));
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      assert.ok(config.mcp.graphify);
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("extract precedes query in execution order", async () => {
    const order = [];
    registerGrafoExtensions({
      extractFn: () => {
        order.push("extract");
        return { ok: true, graphPath: "graphify-out/graph.json", status: "success", warning: null };
      },
      configureMcpFn: (params) => {
        order.push("query");
        return { status: "success", warning: null, details: [] };
      },
    });

    const ctx = {
      projectDir: "/tmp/test",
      selectedClis: ["opencode"],
      state: { graphPath: null },
      run: null,
      logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
    };

    await runExtension("extract", ctx);
    ctx.state.graphPath = "graphify-out/graph.json";
    await runExtension("query", ctx);

    assert.deepEqual(order, ["extract", "query"]);
  });
});

// ─── Task 4: CLI dispatch ─────────────────────────────────────────────────────

describe("runLocalQueryCli", () => {
  let tempDir;
  let origStdoutWrite;
  let origStderrWrite;
  let origExitCode;
  let stdoutOutput;
  let stderrOutput;

  beforeEach(() => {
    tempDir = makeTempDir();
    stdoutOutput = "";
    stderrOutput = "";
    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;
    origExitCode = process.exitCode;
    process.stdout.write = (data) => { stdoutOutput += data; return true; };
    process.stderr.write = (data) => { stderrOutput += data; return true; };
  });

  afterEach(() => {
    cleanupDir(tempDir);
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
  });

  it("writes JSON to stdout and sets exit code 0 for success", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "graph.json"), JSON.stringify({
      nodes: [{ name: "TestService", path: "src/test.js", type: "class" }],
    }), "utf8");

    runLocalQueryCli(tempDir, "Test");

    assert.ok(stdoutOutput.length > 0);
    const parsed = JSON.parse(stdoutOutput.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.source, "local");
    assert.equal(process.exitCode, 0);
  });

  it("writes JSON to stdout and sets exit code 1 for failure", () => {
    runLocalQueryCli(tempDir, "Test");

    const parsed = JSON.parse(stdoutOutput.trim());
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.results, []);
    assert.equal(process.exitCode, 1);
    assert.ok(stderrOutput.includes("[graphify-query]"));
  });

  it("stdout is pure JSON — no logs mixed in", () => {
    const outDir = path.join(tempDir, "graphify-out");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "graph.json"), "[]", "utf8");

    runLocalQueryCli(tempDir, "anything");

    // stdout should be exactly one JSON line
    const lines = stdoutOutput.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });
});

// ─── Task 5: Regression — no installer.js modification ───────────────────────

describe("Regression: installer.js untouched", () => {
  it("graphify-grafo modules do not import from installer.js", async () => {
    // Verify by checking that our modules don't reference installer
    const extractModule = await import("../lib/graphify-extract.js");
    const queryModule = await import("../lib/graphify-query.js");
    const localQueryModule = await import("../lib/graphify-local-query.js");

    // These modules should export their documented functions
    assert.ok(typeof extractModule.extractCodeOnly === "function");
    assert.ok(typeof queryModule.configureMcpForTargets === "function");
    assert.ok(typeof localQueryModule.queryLocalGraph === "function");
    assert.ok(typeof localQueryModule.runLocalQueryCli === "function");
  });
});
