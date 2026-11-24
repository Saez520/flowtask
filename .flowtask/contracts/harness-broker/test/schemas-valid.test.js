import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSchemaFile,
  getValidator,
  listSchemaNames,
  readSchema,
  schemaUrn
} from "../lib/schemas.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "examples");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function fieldOf(error) {
  if (error.keyword === "required") return error.params.missingProperty;
  if (error.keyword === "additionalProperties") return error.params.additionalProperty;
  const segments = error.instancePath.split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "";
}

function declaredProperties(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) declaredProperties(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === "if") continue;
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [name, subschema] of Object.entries(value)) {
        found.push({ name, subschema });
      }
    }
    declaredProperties(value, found);
  }
  return found;
}

function validateFile(schemaName, relativePath) {
  const validate = getValidator(schemaName);
  return { accepted: validate(readJson(join(ROOT, relativePath))), errors: validate.errors ?? [] };
}

describe("schema files", () => {
  it("compiles every v1 schema in strict mode", () => {
    const names = listSchemaNames();
    assert.ok(names.length > 0, "no schemas found under schemas/v1");
    for (const name of names) {
      assert.equal(typeof getValidator(name), "function", `${name} did not compile`);
    }
  });

  it("declares 2020-12 and the URN identifier of each schema", () => {
    for (const name of listSchemaNames()) {
      const schema = readSchema(name);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", name);
      assert.equal(schema.$id, schemaUrn(name), name);
    }
  });

  it("gives every declared property a non-empty description", () => {
    for (const name of listSchemaNames()) {
      for (const { name: property, subschema } of declaredProperties(readSchema(name))) {
        const description = subschema.description;
        assert.ok(
          typeof description === "string" && description.trim().length > 0,
          `${name}: property "${property}" has no description`
        );
      }
    }
  });
});

describe("examples manifest", () => {
  const manifest = readJson(join(EXAMPLES, "manifest.json"));

  it("lists every example file under valid and invalid", () => {
    const onDisk = ["valid", "invalid"].flatMap((folder) =>
      readdirSync(join(EXAMPLES, folder)).map((file) => `${folder}/${file}`)
    );
    const listed = manifest.map((entry) => entry.file);
    assert.deepEqual([...listed].sort(), [...onDisk].sort());
  });

  it("gives every invalid example at least one expected error path", () => {
    for (const entry of manifest.filter((item) => !item.valid)) {
      assert.ok(
        Array.isArray(entry.error_paths) && entry.error_paths.length > 0,
        `${entry.file} has no error_paths`
      );
    }
  });

  for (const entry of manifest) {
    it(`${entry.file} is ${entry.valid ? "accepted" : "rejected"} by ${entry.schema}`, () => {
      const { accepted, errors } = validateFile(entry.schema, join("examples", entry.file));
      if (entry.valid) {
        assert.equal(accepted, true, JSON.stringify(errors));
        return;
      }
      assert.equal(accepted, false, `${entry.file} was accepted`);
      const named = new Set(errors.map(fieldOf));
      for (const path of entry.error_paths) {
        assert.ok(named.has(path), `${entry.file} does not name the field ${path}`);
      }
    });
  }
});

const DATA_CHECKS = [
  { title: "state machine data", data: "state-machine.v1.json", schema: "state-machine" },
  { title: "adapter interface data", data: "adapter-interface.v1.json", schema: "adapter-interface" },
  { title: "conformance cases data", data: join("conformance", "cases.v1.json"), schema: "conformance-cases" }
];

describe("versioned data files", () => {
  for (const check of DATA_CHECKS) {
    const present = existsSync(join(ROOT, check.data)) && existsSync(join(ROOT, "schemas", "v1", `${check.schema}.schema.json`));
    it(`${check.title} matches its schema`, { skip: present ? false : `${check.data} or its schema is not created yet` }, () => {
      const { accepted, errors } = validateFile(check.schema, check.data);
      assert.equal(accepted, true, JSON.stringify(errors));
    });
  }

  const scenarioSchema = join(ROOT, "conformance", "scenario.schema.json");
  const scenarioDir = join(ROOT, "conformance", "scenarios");
  const scenarioFiles = existsSync(scenarioDir) ? readdirSync(scenarioDir).filter((file) => file.endsWith(".json")) : [];
  const scenariosPresent = existsSync(scenarioSchema) && scenarioFiles.length > 0;
  it("every simulated child scenario matches the scenario schema", { skip: scenariosPresent ? false : "scenario schema or scenario files are not created yet" }, () => {
    const validate = compileSchemaFile(scenarioSchema);
    for (const file of scenarioFiles) {
      const path = join(scenarioDir, file);
      const accepted = validate(readJson(path));
      assert.equal(accepted, true, `${relative(ROOT, path)}: ${JSON.stringify(validate.errors)}`);
    }
  });
});
