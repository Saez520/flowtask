/**
 * Runtime contract of the context budget degradation.
 *
 * The test reads the built plugin of the permission gate and asserts the
 * observable contract of the three degradation levels: the narrowing notice,
 * the reduced delivery, the turn omission and the attachment delegation.
 *
 * Two rules are load-bearing and are asserted explicitly: no message exposes
 * the internal threshold figures, and every omission declares the real size
 * and the delegation target.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const {
  buildAttachmentDelivery,
  buildFallback,
  buildNarrowingNotice,
  buildReducedDelivery,
  registerNarrowingNotice,
  resetNarrowingNotices,
} = await import(
  path.join(ROOT, ".flowtask", "plugins", "flowtask-permission-gate", "dist", "context-budget.js")
);

describe("context budget degradation", () => {
  it("announces a broad request with the way to narrow it and without figures", () => {
    const notice = buildNarrowingNotice("read", { file: "big.txt" });
    assert.ok(notice.includes("Pedido amplio"), notice);
    assert.ok(notice.includes("limit"), notice);
    assert.ok(notice.includes("offset"), notice);
    assert.ok(notice.includes("Inspector"), notice);
    assert.equal(notice.includes("16000"), false, notice);
  });

  it("names the call budget and the real omitted size in a reduced delivery", () => {
    const message = buildReducedDelivery("read", 60383, "call");
    assert.ok(message.includes("60383"), message);
    assert.ok(message.includes("contenido del archivo"), message);
    assert.ok(message.includes("presupuesto por llamada"), message);
    assert.ok(message.includes("Inspector"), message);
    assert.equal(message.includes("16000"), false, message);
  });

  it("names the turn budget when the accumulated delivery is omitted", () => {
    const message = buildReducedDelivery("grep", 6000, "turn");
    assert.ok(message.includes("presupuesto acumulado del turno"), message);
    assert.equal(message.includes("32000"), false, message);
  });

  it("delegates an attachment and declares the measured text", () => {
    const message = buildAttachmentDelivery("read", 23);
    assert.ok(message.includes("imagen/PDF"), message);
    assert.ok(message.includes("Inspector"), message);
    assert.ok(message.includes("23"), message);
  });

  it("keeps the fallback as an alias of the reduced delivery by call", () => {
    assert.equal(buildFallback("read", 60383, 16000), buildReducedDelivery("read", 60383, "call"));
  });

  it("registers the narrowing notice once per session and resets it", () => {
    resetNarrowingNotices();
    const args = { pattern: "**/*" };
    assert.equal(registerNarrowingNotice("s-a", "glob", args), true);
    assert.equal(registerNarrowingNotice("s-a", "glob", args), false);
    assert.equal(registerNarrowingNotice("s-b", "glob", args), true);
    resetNarrowingNotices("s-a");
    assert.equal(registerNarrowingNotice("s-a", "glob", args), true);
    resetNarrowingNotices();
    assert.equal(registerNarrowingNotice("s-b", "glob", args), true);
  });
});
