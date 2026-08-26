/**
 * Smoke de integración — contrato de mutación de `tool.execute.after`.
 *
 * Verifica contra el plugin BUILT (dist/index.js):
 * 1. Que la mutación de `output.output` persiste y es visible por el caller
 *    (contrato mutable de OpenCode 1.18.x verificado en research v1.18.15).
 * 2. Que la allowlist del runner no se rompió: read/glob/grep siguen
 *    autorizados y el comando graphify query sigue siendo válido.
 *
 * Sin red ni MCP. Exit 0 = SMOKE-PASS; exit no-zero = SMOKE-FAIL observable
 * (GAP-003: si el hook no es mutable, el gate no debe entregar saturante
 * sin control — este smoke detecta el drift de versión).
 */
import assert from "node:assert/strict";
import { isAuthorizedRunnerCommand } from "../dist/authorizer.js";
import { buildFallback } from "../dist/context-budget.js";
import plugin from "../dist/index.js";

const runner = process.env.SMOKE_RUNNER ?? "flowtask-runner";

try {
  const hooks = await plugin({ directory: process.cwd() });
  if (typeof hooks["tool.execute.after"] !== "function") {
    console.error("[FlowTask Context Budget] SMOKE-FAIL: hook no disponible — no entrega saturante sin control.");
    process.exit(1);
  }

  await hooks["chat.message"]({ sessionID: "smoke-s", agent: runner }, { message: {}, parts: [] });

  // 1) Mutación visible: output grande debe ser reemplazado por el fallback exacto.
  const output = { title: "read", output: "a".repeat(60383), metadata: {} };
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "smoke-s", callID: "smoke-1" }, output);
  assert.equal(output.output, buildFallback("read", 60383, 16000), "mutación de output.output no persistió");

  // 2) Allowlist intacta: read/glob/grep autorizados para runner (before no lanza
  //    delegación) y graphify query sigue autorizado por authorizer.ts.
  await hooks["tool.execute.before"](
    { tool: "read", sessionID: "smoke-s", callID: "smoke-2" },
    { args: { file: "package.json", limit: 5 } },
  );
  await hooks["tool.execute.before"](
    { tool: "glob", sessionID: "smoke-s", callID: "smoke-3" },
    { args: { pattern: "*.json", path: "." } },
  );
  await hooks["tool.execute.before"](
    { tool: "grep", sessionID: "smoke-s", callID: "smoke-4" },
    { args: { pattern: "TODO", path: ".", include: "*.md" } },
  );
  assert.equal(
    isAuthorizedRunnerCommand("node .flowtask/bin/flowtask.js graphify query --query \"context budget\""),
    true,
    "graphify query ya no autorizado",
  );

  console.log("SMOKE-PASS: mutation persisted; allowlist intact (read/glob/grep + graphify query)");
  await hooks.dispose?.();
  process.exit(0);
} catch (error) {
  console.error(`[FlowTask Context Budget] SMOKE-FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}