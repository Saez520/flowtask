import fs from "node:fs";
import path from "node:path";

export const TARGET_DIRECT_KEYS = Object.freeze([
  "descriptor_version", "operation", "target_kind", "target_repo", "target_common_dir",
  "parent_repo", "parent_common_dir", "submodule_path", "gitlink_sha", "target_head",
  "base", "base_sha", "branch", "worktree_path", "link_parent", "namespace", "owner",
  "phase", "tx_id", "index_snapshot_ref",
]);

const KEY_SET = new Set(TARGET_DIRECT_KEYS);
const SHA = /^[0-9a-f]{40}$/i;
const OPERATIONS = new Set(["create", "link-parent", "abort", "complete"]);
const PHASES = new Set(["initial", "descriptor_written", "validated", "worktree_created", "ready", "snapshot_captured", "staged_started", "staged", "verified", "complete_validated", "remove_started", "removed", "closed", "reconciled", "index_reconcile_started", "index_restored", "recovered", "aborted", "blocked"]);

function fail(message) { throw new TypeError(`Invalid target_direct_descriptor: ${message}`); }

function normalizedAbsolute(value, key) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value) fail(`${key} must be normalized absolute`);
}

function validRelativeSubmodule(value) {
  return value && !path.isAbsolute(value) && value !== "." && value !== ".." && !value.startsWith("../") && !value.includes("/../") && !value.includes("\t") && !value.includes("\0");
}

/** Serialize the Runner's descriptor as a validated, duplicate-free UTF-8/LF record. */
export function serializeTargetDirectDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("object required");
  const keys = Object.keys(input);
  if (keys.length !== TARGET_DIRECT_KEYS.length) fail("missing or unknown key");
  for (const key of keys) {
    if (!KEY_SET.has(key)) fail(`unknown key ${key}`);
    if (typeof input[key] !== "string" || input[key].length === 0 || /[\r\n]/u.test(input[key])) fail(`invalid ${key}`);
  }
  if (input.descriptor_version !== "1" || input.target_kind !== "submodule" || input.link_parent !== "staged-only") fail("unsupported contract");
  if (!OPERATIONS.has(input.operation)) fail("operation");
  if (!PHASES.has(input.phase)) fail("phase");
  for (const key of ["target_repo", "target_common_dir", "parent_repo", "parent_common_dir", "worktree_path", "index_snapshot_ref"]) {
    normalizedAbsolute(input[key], key);
  }
  if (!validRelativeSubmodule(input.submodule_path) || path.normalize(input.submodule_path) !== input.submodule_path) fail("submodule_path");
  for (const key of ["gitlink_sha", "target_head", "base_sha"]) if (!SHA.test(input[key])) fail(`${key} must be a commit id`);
  if (!/^td-[A-Za-z0-9._-]+$/u.test(input.tx_id) || input.namespace !== "CA-worktree-submodule-target-direct") fail("transaction namespace");
  if (input.branch !== `worktree/${input.tx_id.slice(3)}`) fail("branch identity");
  if (input.worktree_path !== path.join(input.target_repo, ".worktrees", input.tx_id.slice(3))) fail("worktree identity");
  return `${TARGET_DIRECT_KEYS.map((key) => `${key}=${input[key]}`).join("\n")}\n`;
}

/** Rehydrate only the persisted record; unknown, duplicate, or malformed keys fail closed. */
export function rehydrateTargetDirectDescriptor(record) {
  if (Buffer.isBuffer(record)) record = record.toString("utf8");
  if (typeof record !== "string" || !record.endsWith("\n")) fail("LF record required");
  const result = Object.create(null);
  const lines = record.slice(0, -1).split("\n");
  if (lines.length !== TARGET_DIRECT_KEYS.length) fail("wrong key count");
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) fail("malformed line");
    const key = line.slice(0, separator);
    if (Object.hasOwn(result, key) || !KEY_SET.has(key)) fail(`duplicate or unknown key ${key}`);
    result[key] = line.slice(separator + 1);
  }
  serializeTargetDirectDescriptor(result);
  return Object.freeze({ ...result });
}

export function persistTargetDirectDescriptor(file, descriptor) {
  const record = serializeTargetDirectDescriptor(descriptor);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, record, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

export function loadTargetDirectDescriptor(file) {
  return rehydrateTargetDirectDescriptor(fs.readFileSync(file));
}

/** The single Runner→Constructor boundary: serialize, persist/rehydrate, then dispatch. */
export function dispatchTargetDirectDescriptor(descriptor, dispatch) {
  const rehydrated = rehydrateTargetDirectDescriptor(serializeTargetDirectDescriptor(descriptor));
  if (typeof dispatch !== "function") fail("dispatch callback required");
  return dispatch(rehydrated);
}
