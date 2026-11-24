import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, visit } from "yaml";
import { getValidator } from "./schemas.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDERS = [
  { token: "${run_cwd}", key: "run_cwd" },
  { token: "${home}", key: "home" }
];
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const WILDCARD_ONLY_PATH = /^[/*]+$/;
const WILDCARD_ONLY_COMMAND = /^[*? ]+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NON_FIELD_KEYWORDS = new Set(["if", "anyOf", "oneOf"]);

let contractCache = null;

export function readAuthorityContract() {
  contractCache ??= JSON.parse(readFileSync(join(PACKAGE_ROOT, "authority-contract.v1.json"), "utf8"));
  return contractCache;
}

export function parseProfileYaml(text) {
  if (typeof text !== "string") {
    throw new TypeError("profile text must be a string");
  }
  const doc = parseDocument(text, { uniqueKeys: true, version: "1.2", schema: "core", strict: true });
  if (doc.errors.some((error) => error.code === "DUPLICATE_KEY")) {
    return { ok: false, fields: [{ field: "document", problem: "duplicate_key" }] };
  }
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    return { ok: false, fields: [{ field: "document", problem: "invalid_yaml" }] };
  }
  if (hasAliasOrAnchor(doc)) {
    return { ok: false, fields: [{ field: "document", problem: "alias_not_allowed" }] };
  }
  return { ok: true, document: doc.toJS() };
}

function hasAliasOrAnchor(doc) {
  let found = false;
  visit(doc, {
    Alias() {
      found = true;
    },
    Node(_key, node) {
      if (node.anchor) found = true;
    }
  });
  return found;
}

export function validateProfile(document) {
  const validate = getValidator("authority-profile");
  if (!validate(document)) {
    const fields = [];
    for (const error of validate.errors ?? []) {
      if (NON_FIELD_KEYWORDS.has(error.keyword)) continue;
      const field = fieldOf(error);
      fields.push({ field, problem: problemOf(error, field) });
    }
    return { ok: false, fields: uniqueFields(fields) };
  }
  const fields = semanticFields(document);
  return fields.length > 0 ? { ok: false, fields: uniqueFields(fields) } : { ok: true };
}

function fieldOf(error) {
  const segments = error.instancePath.split("/").filter(Boolean).map(decodePointerSegment);
  if (error.keyword === "required") segments.push(error.params.missingProperty);
  if (error.keyword === "additionalProperties") segments.push(error.params.additionalProperty);
  return segments.length > 0 ? segments.join(".") : "document";
}

function decodePointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function problemOf(error, field) {
  switch (error.keyword) {
    case "required":
      return "required";
    case "additionalProperties":
      return "unknown_field";
    case "const":
      return field === "version" ? "unsupported_version" : "invalid_value";
    case "type":
      return "wrong_type";
    case "maxItems":
      return "too_many_items";
    case "uniqueItems":
      return "duplicate_entry";
    case "pattern":
      return field.startsWith("filesystem.") ? "not_absolute_path" : "invalid_value";
    default:
      return "invalid_value";
  }
}

function semanticFields(doc) {
  const { always_denied_executables: deniedExecutables } = readAuthorityContract();
  const { filesystem, shell, tools } = doc;
  const fields = [];
  const flag = (field, problem) => fields.push({ field, problem });

  filesystem.readable_roots.forEach((entry, i) => {
    if (WILDCARD_ONLY_PATH.test(entry)) flag(`filesystem.readable_roots.${i}`, "wildcard_total");
  });
  filesystem.writable_roots.forEach((entry, i) => {
    if (WILDCARD_ONLY_PATH.test(entry)) flag(`filesystem.writable_roots.${i}`, "wildcard_total");
  });
  filesystem.deny.forEach((entry, i) => {
    if (WILDCARD_ONLY_PATH.test(entry)) flag(`filesystem.deny.${i}`, "wildcard_total");
  });
  shell.allow.forEach((entry, i) => {
    if (WILDCARD_ONLY_COMMAND.test(entry)) flag(`shell.allow.${i}`, "wildcard_total");
  });
  shell.deny.forEach((entry, i) => {
    if (WILDCARD_ONLY_COMMAND.test(entry)) flag(`shell.deny.${i}`, "wildcard_total");
  });

  shell.deny.forEach((entry, i) => {
    if (shell.allow.includes(entry)) flag(`shell.deny.${i}`, "in_deny_and_allow");
  });
  tools.deny.forEach((entry, i) => {
    if (tools.allow.includes(entry)) flag(`tools.deny.${i}`, "in_deny_and_allow");
  });
  tools.mcp_deny.forEach((pair, i) => {
    if (tools.mcp_allow.some((allowed) => samePair(allowed, pair))) flag(`tools.mcp_deny.${i}`, "in_deny_and_allow");
  });
  filesystem.deny.forEach((entry, i) => {
    if (filesystem.readable_roots.includes(entry)) flag(`filesystem.deny.${i}`, "in_deny_and_allow");
  });

  filesystem.writable_roots.forEach((root, i) => {
    if (filesystem.deny.some((pattern) => matchPath(pattern, root))) {
      flag(`filesystem.writable_roots.${i}`, "writable_root_denied");
    }
  });

  shell.allow.forEach((entry, i) => {
    if (startsWithDeniedExecutable(entry, deniedExecutables)) flag(`shell.allow.${i}`, "direct_harness_not_allowed");
  });

  return fields;
}

function samePair(a, b) {
  return a.server === b.server && a.tool === b.tool;
}

function startsWithDeniedExecutable(command, executables) {
  const tokens = command.trim().split(/\s+/);
  while (tokens.length > 0 && ENV_ASSIGNMENT.test(tokens[0])) tokens.shift();
  return tokens.length > 0 && executables.includes(tokens[0].split("/").pop());
}

function uniqueFields(fields) {
  const seen = new Set();
  return fields.filter(({ field, problem }) => {
    const key = `${field}\u0000${problem}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function fingerprintOf(document) {
  return createHash("sha256").update(JSON.stringify(canonicalize(document))).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export function expandPlaceholders(entry, context) {
  if (typeof entry !== "string") {
    throw new TypeError("entry must be a string");
  }
  for (const { token, key } of PLACEHOLDERS) {
    if (entry.startsWith(token)) {
      const value = context?.[key];
      if (typeof value !== "string" || !ABSOLUTE_PATH.test(value)) {
        throw new TypeError(`${token} needs an absolute ${key} in the context`);
      }
      return withoutTrailingSlash(value) + entry.slice(token.length);
    }
  }
  return entry;
}

function withoutTrailingSlash(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const escapeRegExp = (char) => char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function matchText(pattern, text) {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "s").test(text);
}

export function matchPath(pattern, path) {
  const base = pattern.length > 1 && pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  if (base === "/") return path.startsWith("/");
  let source = "";
  for (let i = 0; i < base.length; i++) {
    if (base[i] === "*" && base[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (base[i] === "*") {
      source += "[^/]*";
    } else if (base[i] === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(base[i]);
    }
  }
  return new RegExp(`^(?:${source})(?:/.*)?$`, "s").test(path);
}
