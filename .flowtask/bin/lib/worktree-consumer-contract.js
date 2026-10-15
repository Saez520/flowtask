import path from "node:path";

const WORK_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;
const BASE_ORDER = ["development", "main", "trunk"];

export function validateWorktreeRequest(request, deps) {
  if (!request || typeof request !== "object") throw new TypeError("request required");
  const { transport, repo_root: repoRoot, work_id: workId } = request;
  if (!["cli", "mcp"].includes(transport)) throw new TypeError("transport must be cli or mcp");
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot) || !deps.isDirectory(repoRoot)) throw new TypeError("repo_root must be an existing absolute directory");
  if (typeof workId !== "string" || !workId || workId.startsWith("/") || workId.startsWith("-") || workId.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("--") || !WORK_ID_SEGMENT.test(part))) throw new TypeError("invalid work_id");
  const configuredDir = request.worktrees_dir ?? ".worktrees";
  if (typeof configuredDir !== "string" || !configuredDir || path.isAbsolute(configuredDir) || configuredDir.split(/[\\/]/).some((part) => part === "..")) throw new TypeError("worktrees_dir must stay within repo_root");
  const worktreesDir = path.resolve(repoRoot, configuredDir);
  if (worktreesDir !== repoRoot && !worktreesDir.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) throw new TypeError("worktrees_dir must stay within repo_root");
  const prefix = request.branch_prefix ?? "worktree/";
  if (typeof prefix !== "string" || prefix.includes("\n") || prefix.startsWith("-")) throw new TypeError("invalid branch_prefix");
  const base = resolveBase(request.base, deps.listLocalBranches(repoRoot));
  return Object.freeze({
    transport, repo_root: path.resolve(repoRoot), work_id: workId, base,
    worktrees_dir: worktreesDir, branch: `${prefix}${workId}`,
    path: path.resolve(worktreesDir, ...workId.split("/")),
    init_submodules: request.init_submodules === true,
    prepare: request.prepare === true, verify: request.verify === true,
    preserve_dirty: request.preserve_dirty === true, discard: request.discard === true,
  });
}

export function resolveBase(base, branches) {
  if (!Array.isArray(branches)) throw new TypeError("unable to read local branches");
  if (base !== undefined && base !== null) {
    if (typeof base !== "string" || !base || base.startsWith("-") || base.includes("\n") || !branches.includes(base)) throw new TypeError("explicit base branch does not exist");
    return base;
  }
  return BASE_ORDER.find((candidate) => branches.includes(candidate)) ?? "main";
}

export function normalizeWorktreeResult({ request, response, transactionId }) {
  const text = typeof response === "string" ? response : response?.output;
  if (typeof text !== "string") return { status: "uncertain", reason: "transport returned no parseable result", transaction_id: transactionId, transport: request.transport };
  const fields = Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map((line) => {
    const colon = line.indexOf(":");
    return colon < 1 ? ["", ""] : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
  }).filter(([key]) => key));
  const result = fields.result;
  const status = result === "success" ? "success" : result === "intervention_required" ? "intervention_required" : result === "no_pending_work" ? "no_pending_work" : result === "blocked" ? "blocked" : result === "failed" ? "failure" : "uncertain";
  return { status, operation: fields.operation, work_id: request.work_id, path: fields.path, branch: fields.branch, base_branch: fields.base_branch, transaction_id: fields.transaction_id ?? transactionId, transport: request.transport, raw_fields: fields };
}
