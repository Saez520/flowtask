import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIR = join(PACKAGE_ROOT, "schemas", "v1");
const SCHEMA_SUFFIX = ".schema.json";
const URN_PREFIX = "urn:flowtask:harness-broker:v1:";

export function schemaUrn(name) {
  return `${URN_PREFIX}${name}`;
}

export function listSchemaNames() {
  return readdirSync(SCHEMAS_DIR)
    .filter((file) => file.endsWith(SCHEMA_SUFFIX))
    .map((file) => file.slice(0, -SCHEMA_SUFFIX.length))
    .sort();
}

export function readSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}${SCHEMA_SUFFIX}`), "utf8"));
}

export function createValidator() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of listSchemaNames()) {
    ajv.addSchema(readSchema(name));
  }
  return ajv;
}

let sharedValidator = null;

export function getValidator(name) {
  sharedValidator ??= createValidator();
  return sharedValidator.getSchema(schemaUrn(name));
}

export function compileSchemaFile(absolutePath) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(absolutePath, "utf8")));
}
