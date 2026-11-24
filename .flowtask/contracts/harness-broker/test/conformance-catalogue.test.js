import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getValidator } from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogue = JSON.parse(readFileSync(join(ROOT, "conformance", "cases.v1.json"), "utf8"));
const cases = catalogue.cases;
const CRITERIA = [
  ...Array.from({ length: 33 }, (_, index) => `C${index + 1}`),
  ...Array.from({ length: 18 }, (_, index) => `A${index + 1}`)
];

const REASONS = {
  broker: "requires a running delegation broker, which this package does not contain",
  adapter: "requires a real harness adapter, which this package does not contain",
  gate: "requires the FlowTask permission gate, which this package does not contain and which does not enforce the denial of direct harness invocation yet",
  harness: "requires the real harness, which this package does not contain"
};

function skipReason(item) {
  if (item.requires !== "none") {
    const capability = item.capability === null ? "" : `, capability ${item.capability}`;
    return `${REASONS[item.requires]}${capability}`;
  }
  if (item.level === "harness") {
    return REASONS.harness;
  }
  return null;
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("catalogue file", () => {
  it("validates against its schema", () => {
    const validate = getValidator("conformance-cases");
    assert.equal(validate(catalogue), true, JSON.stringify(validate.errors));
  });

  it("gives every case a unique identifier", () => {
    const ids = cases.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("covers every criterion C1 to C33 and A1 to A18 with at least one case", () => {
    const covered = new Set(cases.flatMap((item) => item.criteria));
    const missing = CRITERIA.filter((criterion) => !covered.has(criterion));
    assert.deepEqual(missing, [], `criteria without a case: ${missing.join(", ")}`);
  });

  it("points only at scenarios that exist", () => {
    for (const item of cases.filter((entry) => entry.scenario !== null)) {
      const path = join(ROOT, "conformance", "scenarios", `${item.scenario}.json`);
      assert.ok(existsSync(path), `${item.id} cites missing scenario ${item.scenario}`);
    }
  });
});

describe("conformance report", () => {
  for (const item of cases) {
    const reason = skipReason(item);
    it(`${item.id}: ${item.title}`, { skip: reason ?? false }, () => {
      const references = [...item.check.matchAll(/test\/[a-z-]+\.test\.js/g)].map((match) => match[0]);
      assert.ok(references.length > 0, `${item.id} names no test of this package`);
      for (const reference of references) {
        assert.ok(existsSync(join(ROOT, reference)), `${item.id} cites missing ${reference}`);
      }
    });
  }
});

describe("network independence", () => {
  it("contains no network module import or fetch call in lib, conformance or test", () => {
    const networkModules = ["net", "http", "https", "http2", "dns", "tls", "dgram"];
    const forbidden = [new RegExp(`node:(${networkModules.join("|")})\\b`), new RegExp("fetch\\(")];
    const sources = ["lib", "conformance", "test"]
      .flatMap((folder) => listFiles(join(ROOT, folder)))
      .filter((file) => /\.(js|json)$/.test(file));
    const offenders = sources.filter((file) => forbidden.some((pattern) => pattern.test(readFileSync(file, "utf8"))));
    assert.deepEqual(offenders.map((file) => file.slice(ROOT.length + 1)), []);
  });
});
