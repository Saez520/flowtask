/**
 * Smoke de integración — contrato V2 de `execute.after`.
 *
 * Verifica contra el plugin BUILT (dist/index.js) y un contexto V2 falso:
 * 1. Que el setup registra `execute.before`, `execute.after` y `prompt`, y que
 *    el cleanup dispone las tres suscripciones.
 * 2. Que la mutación de `result.output`/`result.content` persiste y es visible
 *    por el caller V2 (contrato mutable de @opencode/plugin 2.0.29).
 * 3. Que la entrega reducida declara el tamaño real omitido y la delegación,
 *    sin preview y sin exponer la cifra del umbral.
 * 4. Que el aviso del primer pedido amplio del turno, el corte por `prompt`,
 *    la omisión por turno, el attachment y la medición no disponible conservan
 *    el comportamiento observable.
 * 5. Que la allowlist del runner no se rompió: read/glob/grep siguen
 *    autorizados y el comando graphify query sigue siendo válido.
 *
 * Sin red ni MCP. Exit 0 = SMOKE-PASS; exit no-zero = SMOKE-FAIL observable.
 */
import assert from "node:assert/strict";
import { isAuthorizedRunnerCommand, RUNNER_DELEGATION_MESSAGE } from "../dist/authorizer.js";
import {
  buildAttachmentDelivery,
  buildNarrowingNotice,
  buildReducedDelivery,
} from "../dist/context-budget.js";
import plugin from "../dist/index.js";

const runner = process.env.SMOKE_RUNNER ?? "flowtask-runner";
let seq = 0;

async function createGate(directory = process.cwd()) {
  const callbacks = {};
  const disposals = [];
  let disposed = false;

  const ctx = {
    location: { directory },
    tool: {
      hook: async (name, callback) => {
        assert.ok(name === "execute.before" || name === "execute.after", `hook de tool inesperado: ${name}`);
        callbacks[name] = callback;
        return { dispose: async () => disposals.push(name) };
      },
    },
    session: {
      hook: async (name, callback) => {
        assert.equal(name, "prompt", `hook de sesión inesperado: ${name}`);
        callbacks.prompt = callback;
        return { dispose: async () => disposals.push(name) };
      },
    },
  };

  const cleanup = await plugin.setup(ctx);
  return {
    id: plugin.id,
    before: (event) => callbacks["execute.before"]({ messageID: `m-${++seq}`, id: `c-${seq}`, ...event }),
    after: (event) =>
      callbacks["execute.after"]({
        messageID: `m-${++seq}`,
        id: `c-${seq}`,
        status: "completed",
        input: {},
        ...event,
      }),
    prompt: (sessionID) => callbacks.prompt({ sessionID, messageID: `m-${++seq}`, prompt: {} }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await cleanup?.();
    },
    disposals,
  };
}

try {
  const gate = await createGate();
  assert.equal(gate.id, "flowtask-permission-gate", "id del paquete V2");
  assert.equal(typeof gate.before, "function", "execute.before no registrado");
  assert.equal(typeof gate.after, "function", "execute.after no registrado");
  assert.equal(typeof gate.prompt, "function", "prompt no registrado");

  // 1) Aviso del primer pedido amplio del turno: se anuncia y no se ejecuta;
  //    la repetición se permite; `prompt` abre un turno nuevo y vuelve a avisar.
  const noticeSession = "smoke-notice";
  const broad = { pattern: "**/*" };
  await assert.rejects(
    gate.before({ tool: "glob", sessionID: noticeSession, agent: runner, input: broad }),
    (error) => error instanceof Error && error.message === buildNarrowingNotice("glob", broad),
    "el primer pedido amplio debe anunciarse",
  );
  await gate.before({ tool: "glob", sessionID: noticeSession, agent: runner, input: broad });
  await gate.prompt(noticeSession);
  await assert.rejects(
    gate.before({ tool: "glob", sessionID: noticeSession, agent: runner, input: broad }),
    (error) => error instanceof Error && error.message === buildNarrowingNotice("glob", broad),
    "el prompt debe abrir un turno nuevo con aviso",
  );

  // 2) Mutación visible sobre result.output: reducción con tamaño real y
  //    delegación, sin preview y sin exponer la cifra del umbral.
  const outputSession = "smoke-output";
  const output = { output: "a".repeat(60383), metadata: {} };
  await gate.after({ tool: "read", sessionID: outputSession, agent: runner, result: output });
  assert.equal(
    output.output,
    buildReducedDelivery("read", 60383, "call"),
    "mutación de result.output no persistió",
  );
  assert.ok(output.output.includes("60383"), "el mensaje declara el tamaño real omitido");
  assert.ok(output.output.includes("Inspector"), "el mensaje declara a quién delegar");
  assert.equal(output.output.includes("16000"), false, "el mensaje no expone la cifra del umbral");
  assert.equal(output.output.includes("aaaa"), false, "la entrega reducida no incluye preview");
  assert.equal(output.metadata.truncated, true, "la degradación queda observable");
  assert.equal(output.metadata.degradation.level, "reduced");

  // 3) Mutación visible sobre result.content (V2 puede entregar content string).
  const contentSession = "smoke-content";
  const contentResult = { content: "b".repeat(60383), metadata: {} };
  await gate.after({ tool: "read", sessionID: contentSession, agent: runner, result: contentResult });
  assert.equal(
    contentResult.content,
    buildReducedDelivery("read", 60383, "call"),
    "mutación de result.content no persistió",
  );
  assert.equal("output" in contentResult, false, "no inventa output cuando la entrega es content");

  // 4) Presupuesto de turno: lo acumulado omite la siguiente entrega y `prompt`
  //    reinicia el acumulado.
  const turnSession = "smoke-turn";
  const small = (char) => ({ output: char.repeat(6000), metadata: {} });
  await gate.after({ tool: "read", sessionID: turnSession, agent: runner, result: { output: "a".repeat(14485), metadata: {} } });
  await gate.after({ tool: "grep", sessionID: turnSession, agent: runner, result: small("b") });
  await gate.after({ tool: "grep", sessionID: turnSession, agent: runner, result: small("c") });
  const turnOmitted = small("d");
  await gate.after({ tool: "grep", sessionID: turnSession, agent: runner, result: turnOmitted });
  assert.equal(turnOmitted.output, buildReducedDelivery("grep", 6000, "turn"));
  assert.equal(turnOmitted.metadata.degradation.level, "turn_omitted");
  await gate.prompt(turnSession);
  const freshTurn = { output: "e".repeat(14485), metadata: {} };
  await gate.after({ tool: "read", sessionID: turnSession, agent: runner, result: freshTurn });
  assert.equal(freshTurn.output.length, 14485, "el turno nuevo vuelve a acumular desde cero");

  // 5) Attachment: se delega, no se entrega y queda observable; cubre el
  //    marcador textual y el file part V2 en content.
  const attachmentSession = "smoke-attachment";
  const attachment = {
    output: "Image read successfully",
    metadata: { attachment: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" },
  };
  await gate.after({ tool: "read", sessionID: attachmentSession, agent: runner, result: attachment });
  assert.equal(attachment.output, buildAttachmentDelivery("read", 23));
  assert.equal(attachment.metadata.attachment, undefined, "attachment no entregado al modelo");
  assert.equal(attachment.metadata.degradation.level, "attachment_delegated");
  assert.equal(attachment.metadata.truncated, true);

  const filePart = { content: [{ type: "file", mime: "application/pdf" }], metadata: {} };
  await gate.after({ tool: "read", sessionID: "smoke-file-part", agent: runner, result: filePart });
  assert.equal(filePart.metadata.degradation.level, "attachment_delegated", "file part PDF delegado");

  // 6) Medición no disponible: la salida se entrega intacta, deja traza y no lanza.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const unmeasurable = { output: { not: "a string" }, metadata: {} };
    await gate.after({ tool: "read", sessionID: "smoke-unmeasurable", agent: runner, result: unmeasurable });
    assert.deepEqual(unmeasurable.output, { not: "a string" });
    assert.equal(unmeasurable.metadata.degradation.level, "measurement_unavailable");
    assert.equal(warnings.length, 1, "la medición no disponible deja una traza");
    assert.ok(warnings[0].includes("could not measure"), warnings[0]);
  } finally {
    console.warn = originalWarn;
  }

  // 7) Allowlist intacta: read/glob/grep autorizados para runner (before no lanza
  //    delegación) y graphify query sigue autorizado por authorizer.ts.
  const allowSession = "smoke-allowlist";
  await gate.before({
    tool: "read",
    sessionID: allowSession,
    agent: runner,
    input: { file: "package.json", limit: 5 },
  });
  await gate.before({
    tool: "glob",
    sessionID: allowSession,
    agent: runner,
    input: { pattern: "*.json", path: "." },
  });
  await gate.before({
    tool: "grep",
    sessionID: allowSession,
    agent: runner,
    input: { pattern: "TODO", path: ".", include: "*.md" },
  });
  await assert.rejects(
    gate.before({
      tool: "bash",
      sessionID: allowSession,
      agent: runner,
      input: { command: "rm -rf build" },
    }),
    (error) => error instanceof Error && error.message === RUNNER_DELEGATION_MESSAGE,
    "la operación destructiva sigue denegada",
  );
  assert.equal(
    isAuthorizedRunnerCommand("node .flowtask/bin/flowtask.js graphify query --query \"context budget\""),
    true,
    "graphify query ya no autorizado",
  );

  // 8) Cleanup: las tres suscripciones se disponen.
  await gate.dispose();
  assert.deepEqual(
    [...gate.disposals].sort(),
    ["execute.after", "execute.before", "prompt"],
    "el cleanup debe disponer las tres suscripciones",
  );

  console.log(
    "SMOKE-PASS: hooks V2 registrados; output/content mutados; aviso, turno, attachment y medición no disponible; allowlist intacta",
  );
  process.exit(0);
} catch (error) {
  console.error(`[FlowTask Context Budget] SMOKE-FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
