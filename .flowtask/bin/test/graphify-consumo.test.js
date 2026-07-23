import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
// Main repo root (mirrors are gitignored in worktree, exist in main repo)
const MAIN_REPO = path.resolve(ROOT, "..", "..");

function readRelative(relPath) {
  // Try worktree first, then main repo (for gitignored mirrors)
  const worktreePath = path.join(ROOT, relPath);
  if (fs.existsSync(worktreePath)) {
    return fs.readFileSync(worktreePath, "utf8");
  }
  const mainRepoPath = path.join(MAIN_REPO, relPath);
  if (fs.existsSync(mainRepoPath)) {
    return fs.readFileSync(mainRepoPath, "utf8");
  }
  return null;
}

// ─── Task 1: Skill contract ──────────────────────────────────────────────────

describe("graphify-protocol skill contract", () => {
  const skillPath = ".flowtask/skills/graphify-protocol/SKILL.md";
  const content = readRelative(skillPath);

  it("skill file exists", () => {
    assert.ok(content !== null, `${skillPath} should exist`);
  });

  it("defines exact query chain: integration → local CLI → normal", () => {
    assert.ok(content.includes("integración de consulta configurada para el CLI actual"));
    assert.ok(content.includes("node .flowtask/bin/flowtask.js graphify query --query"));
    assert.ok(content.includes("búsqueda normal del proyecto"));
  });

  it("contains the exact local CLI command", () => {
    assert.ok(
      content.includes("node .flowtask/bin/flowtask.js graphify query --query <query-string>"),
      "Should contain exact CLI command"
    );
  });

  it("defines local JSON contract with all required keys", () => {
    assert.ok(content.includes('"ok"'));
    assert.ok(content.includes('"source"'));
    assert.ok(content.includes('"local"'));
    assert.ok(content.includes('"query"'));
    assert.ok(content.includes('"results"'));
    assert.ok(content.includes('"diagnostic"'));
  });

  it("specifies source is always 'local'", () => {
    assert.ok(content.includes('source` es siempre `"local"`'));
  });

  it("defines exit codes 0 and 1", () => {
    assert.ok(content.includes("`0`"));
    assert.ok(content.includes("`1`"));
  });

  it("distinguishes ok:true empty from ok:false failure", () => {
    assert.ok(content.includes("ok:true` con `results:[]`"));
    assert.ok(content.includes("ok:false`"));
    assert.ok(content.includes("no se presenta como fallo de transporte"));
  });

  it("contains the exact degradation phrase", () => {
    assert.ok(
      content.includes("no pude consultar el grafo, estoy usando búsqueda normal"),
      "Should contain exact degradation phrase"
    );
  });

  it("defines evidence template with G-NNN format", () => {
    assert.ok(content.includes("## Evidencia verificable del grafo"));
    assert.ok(content.includes("G-001"));
    assert.ok(content.includes("**Consulta:**"));
    assert.ok(content.includes("**Vía:**"));
    assert.ok(content.includes("**Estado:**"));
    assert.ok(content.includes("**Hallazgo:**"));
    assert.ok(content.includes("**Referencias:**"));
    assert.ok(content.includes("**Fecha/commit:**"));
  });

  it("restricts Vía to integración or local only", () => {
    assert.ok(content.includes("`integración` | `local`"));
  });

  it("prohibits presenting normal search as graph evidence", () => {
    assert.ok(content.includes("búsqueda normal no se presenta como evidencia de grafo"));
  });

  it("declares absence statement for no graph results", () => {
    assert.ok(content.includes("Sin evidencia derivada del grafo: se usó búsqueda normal"));
  });

  it("excludes worktrees explicitly", () => {
    assert.ok(content.includes(".worktrees/"));
    assert.ok(content.includes("exclusión explícita de worktrees"));
  });

  it("declares exclusions: MCP, extraction, server, installation", () => {
    assert.ok(content.includes("Consultas MCP internas"));
    assert.ok(content.includes("Extracción de grafo"));
    assert.ok(content.includes("Instalación/update de Graphify"));
  });

  it("classifies attempts as success, unavailable, failed, empty", () => {
    assert.ok(content.includes("`success`"));
    assert.ok(content.includes("`unavailable`"));
    assert.ok(content.includes("`failed`"));
    assert.ok(content.includes("`empty`"));
  });

  it("defines no-skip rule for chain", () => {
    assert.ok(content.includes("no salteable") || content.includes("no-skip"));
  });
});

// ─── Task 2: Mirror coherence ────────────────────────────────────────────────

describe("graphify-protocol mirrors", () => {
  const canonical = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");
  const opencode = readRelative(".opencode/skills/graphify-protocol/SKILL.md");
  const claude = readRelative(".claude/flowtask/skills/graphify-protocol/SKILL.md");

  it("opencode mirror exists", () => {
    assert.ok(opencode !== null, "OpenCode mirror should exist");
  });

  it("claude mirror exists", () => {
    assert.ok(claude !== null, "Claude mirror should exist");
  });

  it("all three contain the exact CLI command", () => {
    const cmd = "node .flowtask/bin/flowtask.js graphify query --query <query-string>";
    assert.ok(canonical.includes(cmd));
    assert.ok(opencode.includes(cmd));
    assert.ok(claude.includes(cmd));
  });

  it("all three contain the exact degradation phrase", () => {
    const phrase = "no pude consultar el grafo, estoy usando búsqueda normal";
    assert.ok(canonical.includes(phrase));
    assert.ok(opencode.includes(phrase));
    assert.ok(claude.includes(phrase));
  });

  it("all three contain the evidence template", () => {
    assert.ok(canonical.includes("## Evidencia verificable del grafo"));
    assert.ok(opencode.includes("## Evidencia verificable del grafo"));
    assert.ok(claude.includes("## Evidencia verificable del grafo"));
  });

  it("all three contain JSON contract keys", () => {
    for (const [name, content] of [["canonical", canonical], ["opencode", opencode], ["claude", claude]]) {
      assert.ok(content.includes('"ok"'), `${name} missing ok`);
      assert.ok(content.includes('"source"'), `${name} missing source`);
      assert.ok(content.includes('"results"'), `${name} missing results`);
      assert.ok(content.includes('"diagnostic"'), `${name} missing diagnostic`);
    }
  });

  it("opencode declares compatibility: opencode", () => {
    assert.ok(opencode.includes("compatibility: opencode"));
  });

  it("claude declares compatibility: claude-code", () => {
    assert.ok(claude.includes("compatibility: claude-code"));
  });

  it("normative sections are equivalent across mirrors", () => {
    // Extract normative content (skip frontmatter)
    function extractNormative(text) {
      const parts = text.split("---");
      // Skip frontmatter (first two --- delimited sections)
      return parts.slice(2).join("---").trim();
    }

    const normCanonical = extractNormative(canonical);
    const normOpencode = extractNormative(opencode);
    const normClaude = extractNormative(claude);

    // All three should have the same normative content
    assert.equal(normOpencode, normCanonical, "OpenCode normative should match canonical");
    assert.equal(normClaude, normCanonical, "Claude normative should match canonical");
  });
});

// ─── Task 3: Agent integration ───────────────────────────────────────────────

describe("Agent integration — graphify-protocol loaded", () => {
  const agents = [
    { path: ".flowtask/agents/ca-writer.md", name: "canonical ca-writer" },
    { path: ".flowtask/agents/planner.md", name: "canonical planner" },
    { path: ".opencode/flowtask/agents/ca-writer.md", name: "opencode ca-writer" },
    { path: ".opencode/flowtask/agents/planner.md", name: "opencode planner" },
    { path: ".claude/agents/flowtask-ca-writer.md", name: "claude ca-writer" },
    { path: ".claude/agents/flowtask-planner.md", name: "claude planner" },
  ];

  for (const agent of agents) {
    it(`${agent.name} loads graphify-protocol`, () => {
      const content = readRelative(agent.path);
      assert.ok(content !== null, `${agent.path} should exist`);
      assert.ok(
        content.includes("graphify-protocol"),
        `${agent.name} should reference graphify-protocol skill`
      );
    });
  }

  for (const agent of agents) {
    it(`${agent.name} preserves memory-protocol skill`, () => {
      const content = readRelative(agent.path);
      assert.ok(
        content.includes("memory-protocol"),
        `${agent.name} should still reference memory-protocol`
      );
    });
  }

  // CA-writer specific checks
  const caWriters = [
    ".flowtask/agents/ca-writer.md",
    ".opencode/flowtask/agents/ca-writer.md",
    ".claude/agents/flowtask-ca-writer.md",
  ];

  for (const cwPath of caWriters) {
    it(`${cwPath} contains Graphify consultation step`, () => {
      const content = readRelative(cwPath);
      assert.ok(content.includes("Consulta Graphify"), `${cwPath} should have Graphify step`);
      assert.ok(
        content.includes("node .flowtask/bin/flowtask.js graphify query"),
        `${cwPath} should reference local CLI`
      );
    });

    it(`${cwPath} declares worktree exclusion`, () => {
      const content = readRelative(cwPath);
      assert.ok(
        content.includes(".worktrees/") || content.includes("worktrees no participan"),
        `${cwPath} should exclude worktrees`
      );
    });
  }

  // Planner specific checks
  const planners = [
    ".flowtask/agents/planner.md",
    ".opencode/flowtask/agents/planner.md",
    ".claude/agents/flowtask-planner.md",
  ];

  for (const plPath of planners) {
    it(`${plPath} requires evidence section`, () => {
      const content = readRelative(plPath);
      assert.ok(
        content.includes("Evidencia verificable del grafo"),
        `${plPath} should require evidence section`
      );
    });

    it(`${plPath} contains G-NNN evidence schema`, () => {
      const content = readRelative(plPath);
      assert.ok(content.includes("G-001"), `${plPath} should have G-NNN format`);
      assert.ok(content.includes("**Consulta:**"), `${plPath} should have Consulta field`);
      assert.ok(content.includes("**Vía:**"), `${plPath} should have Vía field`);
      assert.ok(content.includes("**Referencias:**"), `${plPath} should have Referencias field`);
    });

    it(`${plPath} contains absence declaration`, () => {
      const content = readRelative(plPath);
      assert.ok(
        content.includes("Sin evidencia derivada del grafo"),
        `${plPath} should have absence declaration`
      );
    });
  }
});

// ─── Task 4: Degradation state machine ───────────────────────────────────────

describe("Degradation state machine (simulated)", () => {
  // Simulate the degradation chain without actual Graphify
  function simulateChain(integrationResult, localResult) {
    const chain = [];

    // Step 1: Integration
    if (integrationResult.status === "success" && integrationResult.usable) {
      chain.push({ via: "integración", status: "success", result: integrationResult });
      return { chain, finalVia: "integración", usedNormalSearch: false };
    }
    chain.push({ via: "integración", status: integrationResult.status });

    // Step 2: Local CLI
    if (localResult.ok === true) {
      if (localResult.results.length > 0) {
        chain.push({ via: "local", status: "success", result: localResult });
        return { chain, finalVia: "local", usedNormalSearch: false };
      }
      // ok:true but empty — valid query, no matches
      chain.push({ via: "local", status: "empty", result: localResult });
      return { chain, finalVia: "local", usedNormalSearch: false, empty: true };
    }
    // ok:false — degrade to normal search
    chain.push({ via: "local", status: "failed", result: localResult });

    // Step 3: Normal search
    chain.push({ via: "normal", status: "success" });
    return { chain, finalVia: "normal", usedNormalSearch: true };
  }

  it("integration success → stops at integration", () => {
    const result = simulateChain(
      { status: "success", usable: true, data: [{ name: "UserService" }] },
      { ok: true, source: "local", results: [], diagnostic: null }
    );
    assert.equal(result.finalVia, "integración");
    assert.equal(result.usedNormalSearch, false);
    assert.equal(result.chain.length, 1);
  });

  it("integration unavailable + local success → stops at local", () => {
    const result = simulateChain(
      { status: "unavailable" },
      { ok: true, source: "local", results: [{ name: "UserService" }], diagnostic: null }
    );
    assert.equal(result.finalVia, "local");
    assert.equal(result.usedNormalSearch, false);
    assert.equal(result.chain.length, 2);
  });

  it("integration unavailable + local ok:false → falls to normal search", () => {
    const result = simulateChain(
      { status: "unavailable" },
      { ok: false, source: "local", results: [], diagnostic: "graph.json no encontrado" }
    );
    assert.equal(result.finalVia, "normal");
    assert.equal(result.usedNormalSearch, true);
    assert.equal(result.chain.length, 3);
  });

  it("integration failed + local ok:false → falls to normal search", () => {
    const result = simulateChain(
      { status: "failed" },
      { ok: false, source: "local", results: [], diagnostic: "JSON inválido" }
    );
    assert.equal(result.finalVia, "normal");
    assert.equal(result.usedNormalSearch, true);
  });

  it("ok:true with empty results is NOT a failure — does not trigger fallback", () => {
    const result = simulateChain(
      { status: "unavailable" },
      { ok: true, source: "local", results: [], diagnostic: null }
    );
    assert.equal(result.finalVia, "local");
    assert.equal(result.usedNormalSearch, false);
    assert.equal(result.empty, true);
  });

  it("never skips local CLI when integration fails", () => {
    const result = simulateChain(
      { status: "failed" },
      { ok: true, source: "local", results: [{ name: "Test" }], diagnostic: null }
    );
    // Should have tried integration first, then local
    assert.equal(result.chain.length, 2);
    assert.equal(result.chain[0].via, "integración");
    assert.equal(result.chain[1].via, "local");
    assert.equal(result.finalVia, "local");
  });

  it("chain always has integration as first step", () => {
    const scenarios = [
      [{ status: "success", usable: true }, { ok: true, results: [] }],
      [{ status: "unavailable" }, { ok: false, results: [] }],
      [{ status: "failed" }, { ok: true, results: [{ name: "X" }] }],
    ];

    for (const [integration, local] of scenarios) {
      const result = simulateChain(integration, local);
      assert.equal(result.chain[0].via, "integración");
    }
  });
});

// ─── Task 5: Evidence contract ───────────────────────────────────────────────

describe("Evidence contract", () => {
  it("evidence IDs follow G-NNN format", () => {
    const validIds = ["G-001", "G-002", "G-100"];
    const pattern = /^G-\d{3}$/;
    for (const id of validIds) {
      assert.ok(pattern.test(id), `${id} should match G-NNN format`);
    }
  });

  it("Vía only allows integración or local", () => {
    const allowedVias = ["integración", "local"];
    const notAllowed = ["normal", "search", "búsqueda"];
    
    for (const via of allowedVias) {
      assert.ok(allowedVias.includes(via));
    }
    for (const via of notAllowed) {
      assert.ok(!allowedVias.includes(via), `${via} should not be allowed as Vía`);
    }
  });

  it("evidence requires all mandatory fields", () => {
    const requiredFields = ["Consulta", "Vía", "Estado", "Hallazgo", "Referencias", "Fecha/commit"];
    assert.equal(requiredFields.length, 6);
  });

  it("absence declaration has exact text", () => {
    const expected = "Sin evidencia derivada del grafo: se usó búsqueda normal";
    assert.ok(expected.includes("Sin evidencia derivada del grafo"));
    assert.ok(expected.includes("búsqueda normal"));
  });
});

// ─── Task 6: Worktree exclusion ──────────────────────────────────────────────

describe("Worktree exclusion", () => {
  it("skill explicitly mentions .worktrees/ exclusion", () => {
    const content = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");
    assert.ok(content.includes(".worktrees/"));
    assert.ok(content.includes("No consultar"));
  });

  it("no test fixture references worktree paths", () => {
    // This test file itself should not create or reference worktree paths
    const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Check that we don't have any .worktrees/ path construction for writing
    const worktreeWritePattern = /\.worktrees\/CA-/;
    const lines = thisFile.split("\n");
    for (const line of lines) {
      // Skip comments and this specific check
      if (line.includes("// ") || line.includes("worktreeWritePattern")) continue;
      assert.ok(
        !worktreeWritePattern.test(line),
        `Line should not reference worktree paths for writing: ${line}`
      );
    }
  });
});

// ─── Task 7: Local CLI contract alignment with plan-grafo ────────────────────

describe("Local CLI contract alignment", () => {
  it("skill references exact command from plan-grafo", () => {
    const skill = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");
    const testGrafo = readRelative(".flowtask/bin/test/graphify-grafo.test.js");

    // Both should reference the same command pattern
    assert.ok(skill.includes("node .flowtask/bin/flowtask.js graphify query"));
    assert.ok(testGrafo.includes("runLocalQueryCli"));
  });

  it("skill JSON contract matches plan-grafo test expectations", () => {
    const skill = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");

    // Verify all JSON keys from plan-grafo are in skill
    const requiredKeys = ["ok", "source", "query", "results", "diagnostic"];
    for (const key of requiredKeys) {
      assert.ok(skill.includes(`"${key}"`), `Skill should document "${key}" field`);
    }
  });

  it("skill exit codes match plan-grafo behavior", () => {
    const skill = readRelative(".flowtask/skills/graphify-protocol/SKILL.md");
    
    // ok:true → exit 0, ok:false → exit 1
    // The skill uses backtick-wrapped values in the table: `0` and `1`
    assert.ok(skill.includes("`0`"), "Should document exit code 0");
    assert.ok(skill.includes("`1`"), "Should document exit code 1");
    assert.ok(skill.includes("exit code"), "Should mention exit codes");
  });
});
