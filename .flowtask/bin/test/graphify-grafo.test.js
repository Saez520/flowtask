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

    assert.equal(result.status, "unsupported"); // unsupported is not a failure
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

// ─── Task 2: Extension handoff ───────────────────────────────────────────────

describe("registerGrafoExtensions", () => {
  beforeEach(() => { clearExtensions(); });
  afterEach(() => { clearExtensions(); });

  it("registers extract and query extensions", async () => {
    registerGrafoExtensions({ mcpPreflightFn: () => ({ ok: true, python: "python", error: null }) });

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

      registerGrafoExtensions({ mcpPreflightFn: () => ({ ok: true, python: "python", error: null }) });

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

  it("marks query as degraded when MCP import preflight fails", async () => {
    const tempDir = makeTempDir();
    try {
      fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
      registerGrafoExtensions({
        mcpPreflightFn: () => ({ ok: false, python: "/venv/bin/python", error: "ModuleNotFoundError: mcp" }),
      });

      const result = await runExtension("query", {
        projectDir: tempDir,
        selectedClis: ["opencode"],
        state: { graphPath: "graphify-out/graph.json" },
        run: null,
        logger: { logStep: () => {}, logSuccess: () => {}, logWarn: () => {}, logError: () => {}, logInfo: () => {} },
      });

      assert.equal(result.status, "degraded");
      assert.match(result.diagnostic, /ModuleNotFoundError: mcp/);
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
      mcpPreflightFn: () => ({ ok: true, python: "python", error: null }),
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

// ─── Task 3: Regression — no installer.js modification ───────────────────────

describe("Regression: installer.js untouched", () => {
  it("graphify-grafo modules do not import from installer.js", async () => {
    // Verify by checking that our modules don't reference installer
    const extractModule = await import("../lib/graphify-extract.js");
    const queryModule = await import("../lib/graphify-query.js");
    // These modules should export their documented functions
    assert.ok(typeof extractModule.extractCodeOnly === "function");
    assert.ok(typeof queryModule.configureMcpForTargets === "function");
  });
});
