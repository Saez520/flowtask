import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, ".flowtask", "bin", "flowtask.js");

function runDeprecatedQuery(cwd) {
  try {
    execFileSync(process.execPath, [CLI, "graphify", "query", "--query", "UserService"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("graphify query debe terminar con error");
  } catch (error) {
    return error;
  }
}

describe("deprecated graphify query shim", () => {
  it("fails with an actionable deprecation message and no stdout", () => {
    const error = runDeprecatedQuery(ROOT);

    assert.equal(error.status, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /Deprecated/);
    assert.match(error.stderr, /graphify_query_graph/);
    assert.match(error.stderr, /Inspector/);
  });

  it("does not read or query a local graph", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-graphify-shim-"));
    try {
      const graphDir = path.join(tempDir, "graphify-out");
      fs.mkdirSync(graphDir, { recursive: true });
      fs.writeFileSync(path.join(graphDir, "graph.json"), "not-json", "utf8");

      const error = runDeprecatedQuery(tempDir);

      assert.equal(error.status, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /no ejecuta consultas locales/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not import the removed local query implementation", () => {
    const source = fs.readFileSync(CLI, "utf8");
    assert.doesNotMatch(source, /graphify-local-query/);
    assert.equal(fs.existsSync(path.join(ROOT, ".flowtask", "bin", "lib", "graphify-local-query.js")), false);
  });
});
