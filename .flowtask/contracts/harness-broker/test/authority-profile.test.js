import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandPlaceholders,
  fingerprintOf,
  matchPath,
  matchText,
  parseProfileYaml,
  validateProfile
} from "../lib/authority.js";
import { getValidator } from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY_EXAMPLES = join(ROOT, "examples", "authority");
const manifest = JSON.parse(readFileSync(join(AUTHORITY_EXAMPLES, "manifest.json"), "utf8"));

const CLOSED_PROBLEMS = new Set([
  "required",
  "unknown_field",
  "unsupported_version",
  "wrong_type",
  "invalid_value",
  "not_absolute_path",
  "too_many_items",
  "duplicate_entry",
  "wildcard_total",
  "in_deny_and_allow",
  "writable_root_denied",
  "direct_harness_not_allowed",
  "name_mismatch",
  "invalid_yaml",
  "duplicate_key",
  "alias_not_allowed"
]);

const readExample = (file) => readFileSync(join(AUTHORITY_EXAMPLES, file), "utf8");

function fieldsOf(text) {
  const parsed = parseProfileYaml(text);
  if (!parsed.ok) return parsed.fields;
  const verdict = validateProfile(parsed.document);
  return verdict.ok ? [] : verdict.fields;
}

function standardDocument() {
  const parsed = parseProfileYaml(readExample("valid/authority-profile.standard.yaml"));
  assert.equal(parsed.ok, true);
  return parsed.document;
}

describe("authority profile examples", () => {
  it("lists every YAML example under valid and invalid", () => {
    const onDisk = ["valid", "invalid"].flatMap((folder) =>
      readdirSync(join(AUTHORITY_EXAMPLES, folder)).map((file) => `${folder}/${file}`)
    );
    assert.deepEqual(manifest.map((entry) => entry.file).sort(), onDisk.sort());
  });

  for (const entry of manifest.filter((item) => item.valid)) {
    it(`${entry.file} is accepted and identified by its name and version`, () => {
      const parsed = parseProfileYaml(readExample(entry.file));
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      assert.deepEqual(validateProfile(parsed.document), { ok: true });
      assert.equal(parsed.document.version, 1);
      assert.equal(basename(entry.file), `authority-profile.${parsed.document.name}.yaml`);
    });
  }

  for (const entry of manifest.filter((item) => !item.valid)) {
    it(`${entry.file} is rejected naming exactly its invalid fields`, () => {
      const fields = fieldsOf(readExample(entry.file));
      assert.deepEqual([...new Set(fields.map((item) => item.field))].sort(), [...entry.error_paths].sort());
      for (const { problem } of fields) {
        assert.ok(CLOSED_PROBLEMS.has(problem), `${entry.file} reports an open problem: ${problem}`);
      }
    });
  }

  it("rejects an empty path entry as an invalid value", () => {
    const document = standardDocument();
    document.filesystem.readable_roots = [""];
    const verdict = validateProfile(document);
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.fields, [{ field: "filesystem.readable_roots.0", problem: "invalid_value" }]);
  });
});

describe("authority profile contract schema", () => {
  it("compiles authority-profile in strict mode and every valid example satisfies it", () => {
    const validate = getValidator("authority-profile");
    assert.equal(typeof validate, "function");
    for (const entry of manifest.filter((item) => item.valid)) {
      const parsed = parseProfileYaml(readExample(entry.file));
      assert.equal(validate(parsed.document), true, `${entry.file}: ${JSON.stringify(validate.errors)}`);
    }
  });
});

describe("yaml strictness", () => {
  it("reports a duplicate key", () => {
    assert.deepEqual(parseProfileYaml("name: a\nname: b\n"), {
      ok: false,
      fields: [{ field: "document", problem: "duplicate_key" }]
    });
  });

  it("reports an anchor even without an alias", () => {
    assert.deepEqual(parseProfileYaml("version: &one 1\n"), {
      ok: false,
      fields: [{ field: "document", problem: "alias_not_allowed" }]
    });
  });

  it("reports more than one document as invalid YAML", () => {
    assert.deepEqual(parseProfileYaml("version: 1\n---\nversion: 2\n"), {
      ok: false,
      fields: [{ field: "document", problem: "invalid_yaml" }]
    });
  });

  it("reports an unknown tag as invalid YAML", () => {
    assert.deepEqual(parseProfileYaml("name: !custom standard\n"), {
      ok: false,
      fields: [{ field: "document", problem: "invalid_yaml" }]
    });
  });

  it("parses an empty document to null, which the validator rejects as the document", () => {
    const parsed = parseProfileYaml("");
    assert.deepEqual(parsed, { ok: true, document: null });
    assert.deepEqual(validateProfile(parsed.document), {
      ok: false,
      fields: [{ field: "document", problem: "wrong_type" }]
    });
  });

  it("throws a TypeError when the text is not a string", () => {
    assert.throws(() => parseProfileYaml(42), TypeError);
  });
});

describe("no defaults", () => {
  it("does not complete a missing section and leaves the input untouched", () => {
    const document = standardDocument();
    delete document.network;
    const before = structuredClone(document);
    const verdict = validateProfile(document);
    assert.equal(verdict.ok, false);
    assert.deepEqual(document, before);
    assert.equal(document.network, undefined);
  });
});

describe("fingerprint", () => {
  it("is the same for the same profile with other key order and other YAML layout", () => {
    const document = standardDocument();
    const reordered = Object.fromEntries(Object.entries(document).reverse());
    const asFlowJson = parseProfileYaml(JSON.stringify(document)).document;
    assert.equal(fingerprintOf(reordered), fingerprintOf(document));
    assert.equal(fingerprintOf(asFlowJson), fingerprintOf(document));
  });

  it("changes when one character of the content changes", () => {
    const document = standardDocument();
    const changed = structuredClone(document);
    changed.description = `${changed.description}.`;
    assert.notEqual(fingerprintOf(changed), fingerprintOf(document));
  });

  it("is 64 lowercase hexadecimal characters", () => {
    assert.match(fingerprintOf(standardDocument()), /^[0-9a-f]{64}$/);
  });
});

describe("path and glob matching", () => {
  it("matches a path equal to the pattern or below it", () => {
    assert.equal(matchPath("/work/run", "/work/run"), true);
    assert.equal(matchPath("/work/run", "/work/run/src/a.js"), true);
    assert.equal(matchPath("/work/run", "/work/running"), false);
  });

  it("ignores a trailing slash in the pattern", () => {
    assert.equal(matchPath("/work/run/", "/work/run/x"), true);
    assert.equal(matchPath("/work/run/", "/work/other"), false);
  });

  it("matches every absolute path under the root pattern", () => {
    assert.equal(matchPath("/", "/anything/at/all"), true);
    assert.equal(matchPath("/", "relative"), false);
  });

  it("keeps a single star inside one segment and lets a double star cross segments", () => {
    assert.equal(matchPath("/work/*/x", "/work/a/b/x"), false);
    assert.equal(matchPath("/work/*/x", "/work/a/x/y"), true);
    assert.equal(matchPath("/work/**/x", "/work/a/b/x"), true);
  });

  it("treats a question mark as one character other than a slash", () => {
    assert.equal(matchPath("/w/?", "/w/a"), true);
    assert.equal(matchPath("/w/?", "/w/ab"), false);
  });

  it("escapes regular expression characters in the pattern", () => {
    assert.equal(matchPath("/a/b.c", "/a/bxc"), false);
    assert.equal(matchPath("/a/b.c", "/a/b.c"), true);
  });

  it("matches a command text with star and question mark over the whole text", () => {
    assert.equal(matchText("git diff *", "git diff --stat"), true);
    assert.equal(matchText("git diff *", "git diff"), false);
    assert.equal(matchText("npm test", "npm test x"), false);
    assert.equal(matchText("echo (x)", "echo (x)"), true);
    assert.equal(matchText("a?c", "abc"), true);
    assert.equal(matchText("a?c", "abbc"), false);
  });

  it("expands a leading placeholder with the absolute context value and no trailing slash", () => {
    assert.equal(expandPlaceholders("${run_cwd}/sub", { run_cwd: "/work/run/" }), "/work/run/sub");
    assert.equal(expandPlaceholders("/abs/path", {}), "/abs/path");
  });

  it("rejects a placeholder without an absolute context value", () => {
    assert.throws(() => expandPlaceholders("${home}/.ssh", { run_cwd: "/w" }), TypeError);
    assert.throws(() => expandPlaceholders("${run_cwd}", { run_cwd: "relative" }), TypeError);
  });
});
