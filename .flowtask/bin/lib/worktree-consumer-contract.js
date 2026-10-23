import { composeClosureMessage } from "./worktree-commit-message.js";
import fs from "node:fs";
import path from "node:path";

const WORK_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;
const BASE_ORDER = ["development", "main", "trunk"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Canonical consumer operation → the real tool exposed by the worktree manager. */
export const WORKTREE_TOOLS = Object.freeze({
  create: "worktree_create",
  complete: "worktree_complete",
  cleanup: "worktree_cleanup",
  recover: "worktree_recover",
  list: "worktree_list",
  prune: "worktree_prune",
  status: "worktree_status",
});

/** The only authorization value the manager accepts for a destructive call. */
export const AUTHORIZATION = "I_AUTHORIZE_THIS_CALL";

/** Operations that change repository state and therefore need explicit consent. */
export const DESTRUCTIVE_OPERATIONS = Object.freeze(["complete", "cleanup", "prune", "recover"]);

/** Operations that only observe the repository and never mutate it. */
export const READ_ONLY_OPERATIONS = Object.freeze(["list", "status"]);

/** Operations that mutate the repository and are planned before they run. */
export const MUTATING_OPERATIONS = Object.freeze(["create", "complete", "cleanup", "prune", "recover"]);

/**
 * Fields accepted by each real tool. The consumer never sends a field that
 * is not listed here, so a request is never rejected as an unknown field by
 * the manager.
 */
export const TOOL_FIELDS = Object.freeze({
  worktree_create: Object.freeze(["repo", "work_id", "base", "dry_run", "parent_repo", "submodule_path", "confirm", "plan_hash", "init_submodules", "prepare", "verify"]),
  worktree_complete: Object.freeze(["repo", "work_id", "base", "dry_run", "authorization", "confirm", "plan_hash", "transaction_id", "preserve_dirty", "target_direct", "parent_repo", "commit_title", "commit_body"]),
  worktree_cleanup: Object.freeze(["repo", "work_id", "base", "dry_run", "authorization", "confirm", "plan_hash", "discard", "discard_consent"]),
  worktree_recover: Object.freeze(["repo", "transaction_id", "dry_run", "authorization", "confirm", "target_direct", "parent_repo"]),
  worktree_list: Object.freeze(["repo"]),
  worktree_prune: Object.freeze(["repo", "dry_run", "authorization", "confirm", "plan_hash"]),
  worktree_status: Object.freeze(["repo", "work_id"]),
});

const REQUEST_FIELDS = new Set([
  "operation", "transport", "repo_root", "work_id", "base", "worktrees_dir", "branch_prefix",
  "confirm", "authorization", "transaction_id", "plan_hash", "dry_run", "target_direct",
  "parent_repo", "submodule_path", "discard_consent", "discard", "init_submodules",
  "prepare", "verify", "preserve_dirty", "commit_title", "commit_body",
]);

/** Error codes that need the caller to act before the request can be retried. */
const BLOCKED_CODES = new Set([
  "authorization_required", "authorization_mismatch", "discard_consent_required",
  "invalid_configuration", "invalid_descriptor", "invalid_identity", "invalid_repository",
  "invalid_request", "operation_failed", "plan_mismatch", "resource_locked",
  "target_direct_requires_parent_repo", "target_direct_requires_parent_and_submodule_path",
  "transaction_id_required", "unknown_tool", "unsupported_dry_run", "usage_error",
]);

function requireBoolean(request, key) {
  if (request[key] === undefined) return false;
  if (typeof request[key] !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return request[key];
}

function requireIdentifier(request, key) {
  const value = request[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.includes("\n") || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`invalid ${key}`);
  }
  return value;
}

/**
 * The real path of a directory.
 *
 * The manager resolves the repository and publishes the paths it derives from
 * it, so the consumer compares the same identity and never reports a mismatch
 * for a repository that is reached through a symbolic link.
 */
function resolveRealPath(target) {
  try { return fs.realpathSync(target); } catch { return target; }
}

/**
 * Validate the single canonical consumer request and normalize it into the
 * frozen shape used by the adapter, the bridge and the transport mapping.
 */
export function validateWorktreeRequest(request, deps) {
  if (!request || typeof request !== "object") throw new TypeError("request required");
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key)) throw new TypeError(`unknown request field: ${key}`);
  }
  const operation = request.operation;
  if (typeof operation !== "string" || !Object.hasOwn(WORKTREE_TOOLS, operation)) throw new TypeError("unsupported operation");

  const { repo_root: repoRoot } = request;
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot) || !deps.isDirectory(repoRoot)) {
    throw new TypeError("repo_root must be an existing absolute directory");
  }
  const resolvedRepo = resolveRealPath(path.resolve(repoRoot));

  const transport = request.transport ?? undefined;
  if (transport !== undefined && transport !== "cli" && transport !== "mcp") throw new TypeError("transport must be cli or mcp");

  const confirmProvided = request.confirm !== undefined;
  const confirm = requireBoolean(request, "confirm");
  let confirmed = confirm;
  if (request.authorization !== undefined) {
    if (typeof request.authorization !== "string") throw new TypeError("authorization must be a string");
    if (request.authorization !== AUTHORIZATION) throw new TypeError(`authorization must be ${AUTHORIZATION}`);
    // A confirmation and an authorization value that disagree are rejected
    // instead of being resolved silently.
    if (confirmProvided && !confirm) throw new TypeError("authorization_mismatch");
    confirmed = true;
  }

  const workId = request.work_id;
  const needsWorkId = operation !== "list" && operation !== "prune" && operation !== "recover";
  if (workId !== undefined && (typeof workId !== "string" || !workId || workId.startsWith("/") || workId.startsWith("-") || workId.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("--") || !WORK_ID_SEGMENT.test(part)))) {
    throw new TypeError("invalid work_id");
  }
  if (needsWorkId && workId === undefined) throw new TypeError("work_id is required");

  const configuredDir = request.worktrees_dir ?? ".worktrees";
  if (typeof configuredDir !== "string" || !configuredDir || path.isAbsolute(configuredDir) || configuredDir.split(/[\\/]/).some((part) => part === "..")) throw new TypeError("worktrees_dir must stay within repo_root");
  const worktreesDir = path.resolve(resolvedRepo, configuredDir);
  if (worktreesDir !== resolvedRepo && !worktreesDir.startsWith(`${resolvedRepo}${path.sep}`)) throw new TypeError("worktrees_dir must stay within repo_root");

  const prefix = request.branch_prefix ?? "worktree/";
  if (typeof prefix !== "string" || prefix.includes("\n") || prefix.startsWith("-")) throw new TypeError("invalid branch_prefix");
  const base = resolveBase(request.base, deps.listLocalBranches(resolvedRepo));

  const planHash = request.plan_hash;
  if (planHash !== undefined && (typeof planHash !== "string" || !SHA256_PATTERN.test(planHash))) throw new TypeError("plan_hash must be a sha256 digest");

  const transactionId = requireIdentifier(request, "transaction_id");

  const dryRun = requireBoolean(request, "dry_run");
  const targetDirect = requireBoolean(request, "target_direct");
  const discard = requireBoolean(request, "discard");
  const discardConsent = requireBoolean(request, "discard_consent");
  const initSubmodules = requireBoolean(request, "init_submodules");
  const prepare = requireBoolean(request, "prepare");
  const verify = requireBoolean(request, "verify");
  const preserveDirty = requireBoolean(request, "preserve_dirty");

  const commitTitle = request.commit_title;
  if (commitTitle !== undefined && (typeof commitTitle !== "string" || commitTitle.includes("\u0000"))) throw new TypeError("commit_title must be a string");
  const commitBody = request.commit_body;
  if (commitBody !== undefined && (typeof commitBody !== "string" || commitBody.includes("\u0000"))) throw new TypeError("commit_body must be a string");

  if (request.commit_title !== undefined && operation !== "complete") throw new TypeError("commit_title is only valid for complete");
  if (request.commit_body !== undefined && operation !== "complete") throw new TypeError("commit_body is only valid for complete");

  for (const key of ["init_submodules", "prepare", "verify"]) {
    if (request[key] === true && operation !== "create") throw new TypeError(`${key} is only valid for create`);
  }
  if (request.preserve_dirty === true && operation !== "complete") throw new TypeError("preserve_dirty is only valid for complete");
  if (discard && operation !== "cleanup") throw new TypeError("discard is only valid for cleanup");
  if (discard && !discardConsent) throw new TypeError("discard_consent is required to discard");

  let parentRepo = request.parent_repo;
  if (parentRepo !== undefined) {
    if (typeof parentRepo !== "string" || !path.isAbsolute(parentRepo)) throw new TypeError("parent_repo must be an absolute directory");
    parentRepo = path.resolve(parentRepo);
  }
  const submodulePath = request.submodule_path;
  if (submodulePath !== undefined && (typeof submodulePath !== "string" || !submodulePath || path.isAbsolute(submodulePath) || submodulePath.split(/[\\/]/).some((part) => !part || part === ".." || part === "."))) {
    throw new TypeError("submodule_path must be a relative path inside the parent repository");
  }
  if (targetDirect && !parentRepo) throw new TypeError("target_direct requires parent_repo");
  if (operation === "create" && parentRepo && !submodulePath) throw new TypeError("target_direct requires submodule_path");

  if (DESTRUCTIVE_OPERATIONS.includes(operation) && !dryRun && !confirmed) {
    throw new TypeError(`${operation} is destructive and requires confirm`);
  }

  return Object.freeze({
    operation,
    transport,
    repo_root: resolvedRepo,
    work_id: workId,
    base,
    worktrees_dir: worktreesDir,
    branch: workId === undefined ? undefined : `${prefix}${workId}`,
    path: workId === undefined ? undefined : path.resolve(worktreesDir, ...workId.split("/")),
    confirmed,
    authorization: confirmed ? AUTHORIZATION : undefined,
    transaction_id: transactionId,
    plan_hash: planHash,
    dry_run: dryRun,
    target_direct: targetDirect,
    parent_repo: parentRepo,
    submodule_path: submodulePath,
    discard,
    discard_consent: discardConsent,
    init_submodules: initSubmodules,
    prepare,
    verify,
    preserve_dirty: preserveDirty,
    commit_title: commitTitle,
    commit_body: commitBody,
  });
}

/**
 * Build the wire request for the real tool. The same canonical request is
 * used for the preflight and for the execute call; only `dry_run`, `plan_hash`
 * and `transaction_id` change between the two steps.
 */
export function buildToolRequest(request, overrides = {}) {
  const tool = WORKTREE_TOOLS[request.operation];
  const allowed = TOOL_FIELDS[tool];
  const args = { repo: request.repo_root };

  const assign = (key, value) => { if (allowed.includes(key)) args[key] = value; };

  if (request.work_id !== undefined) assign("work_id", request.work_id);
  if (request.operation !== "list" && request.operation !== "prune" && request.operation !== "recover") assign("base", request.base);
  assign("init_submodules", request.init_submodules);
  assign("prepare", request.prepare);
  assign("verify", request.verify);
  assign("preserve_dirty", request.preserve_dirty);

  if (request.operation === "complete") {
    if (request.commit_title === undefined) {
      const composed = composeClosureMessage({ workId: request.work_id, title: undefined, body: undefined });
      assign("commit_title", composed.subject);
      assign("commit_body", composed.body);
    } else {
      assign("commit_title", request.commit_title);
      if (request.commit_body !== undefined) assign("commit_body", request.commit_body);
    }
  }
  assign("discard", request.discard);
  assign("discard_consent", request.discard_consent);
  assign("target_direct", request.target_direct);
  if (request.parent_repo !== undefined) assign("parent_repo", request.parent_repo);
  if (request.submodule_path !== undefined) assign("submodule_path", request.submodule_path);

  assign("confirm", request.confirmed === true);
  if (request.confirmed === true) assign("authorization", AUTHORIZATION);

  assign("dry_run", overrides.dry_run === true);
  if (overrides.plan_hash !== undefined) assign("plan_hash", overrides.plan_hash);
  const transactionId = overrides.transaction_id ?? request.transaction_id;
  if (transactionId !== undefined) assign("transaction_id", transactionId);

  return { tool, args };
}

export function resolveBase(base, branches) {
  if (!Array.isArray(branches)) throw new TypeError("unable to read local branches");
  if (base !== undefined && base !== null) {
    if (typeof base !== "string" || !base || base.startsWith("-") || base.includes("\n") || !branches.includes(base)) throw new TypeError("explicit base branch does not exist");
    return base;
  }
  return BASE_ORDER.find((candidate) => branches.includes(candidate)) ?? "main";
}

/** Map a manager error code to the consumer status vocabulary. */
export function statusForErrorCode(code) {
  if (!code) return "failure";
  if (code === "intervention_required") return "intervention_required";
  if (code.startsWith("unknown_fields")) return "blocked";
  return BLOCKED_CODES.has(code) ? "blocked" : "failure";
}

/** Normalize the nine-key envelope published by every transport. */
export function normalizeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const result = envelope.result;
  const accepted = result === "success" || result === "no_pending_work";
  return {
    accepted,
    result: result ?? "failure",
    operation: envelope.operation,
    repository: envelope.repository,
    data: envelope.data && typeof envelope.data === "object" ? envelope.data : {},
    warnings: Array.isArray(envelope.warnings) ? envelope.warnings : [],
    error: envelope.error && typeof envelope.error === "object" ? envelope.error : null,
    transaction_id: envelope.transaction_id ?? null,
  };
}
