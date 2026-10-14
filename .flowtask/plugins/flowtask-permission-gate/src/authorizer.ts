export const RUNNER_DELEGATION_MESSAGE = "Recordá que debés delegar esta operación al subagente correspondiente.";

export const FLOWTASK_SUBAGENTS = new Set([
  "flowtask-ca-writer", "flowtask-planner", "flowtask-plan-auditor", "flowtask-constructor",
  "flowtask-validator", "flowtask-initializer", "flowtask-logger", "flowtask-tester",
  "flowtask-review-orchestrator", "flowtask-inspector", "flowtask-onboarder",
  "flowtask-graphify-docs-media",
]);

/** V2 `subagent` resources the runner may select; the runner itself is never a child. */
export function isAuthorizedRunnerSubagent(agent: unknown): boolean {
  return typeof agent === "string" && FLOWTASK_SUBAGENTS.has(agent);
}

/** Tokenize the small shell grammar used by FlowTask commands. */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  const trimmed = command.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === ";" || char === "&" || char === "|" || char === "`" || char === "<" || char === ">" || char === "(" || char === ")") return null;
    if (char === "$" && trimmed[index + 1] === "(") return null;
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = ""; } continue; }
    token += char;
  }
  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function hasOnlyFlags(tokens: string[]): boolean { return tokens.every((token) => token.startsWith("-")); }
function hasPaths(tokens: string[]): boolean { return tokens.length > 0 && tokens.every((token) => !token.startsWith("-")); }
function hasFlagsAndPaths(tokens: string[]): boolean {
  let pathsStarted = false;
  for (const token of tokens) {
    if (token === "--") { pathsStarted = true; continue; }
    if (token.startsWith("-") && !pathsStarted) continue;
    if (token.startsWith("-") && pathsStarted) return false;
    pathsStarted = true;
  }
  return true;
}

function isRedirectBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char) || char === "&" || char === "|";
}

/** Consume one of the explicitly safe redirects and return the next index. */
function consumeDevNullRedirect(command: string, redirectIndex: number): number | null {
  if (command[redirectIndex + 1] === ">") return null;
  let targetIndex = redirectIndex + 1;
  while (/\s/.test(command[targetIndex] ?? "")) targetIndex += 1;
  if (!command.startsWith("/dev/null", targetIndex)) return null;
  const endIndex = targetIndex + "/dev/null".length;
  return isRedirectBoundary(command[endIndex]) ? endIndex : null;
}

/** Split only on && and || while rejecting shell syntax outside the allowlist. */
function splitCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let segment = "";
  let quote = "";
  let escaped = false;

  const pushSegment = (): boolean => {
    if (!segment.trim()) return false;
    segments.push(segment.trim());
    segment = "";
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      segment += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      segment += char;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      segment += char;
      quote = char;
      continue;
    }
    if (char === "&" && command[index + 1] === "&") {
      if (!pushSegment()) return null;
      index += 1;
      continue;
    }
    if (char === "|" && command[index + 1] === "|") {
      if (!pushSegment()) return null;
      index += 1;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== ">") return null;
      const nextIndex = consumeDevNullRedirect(command, index + 1);
      if (nextIndex === null) return null;
      index = nextIndex - 1;
      continue;
    }
    if (char === "2" && command[index + 1] === ">" && (segment.length === 0 || /\s/.test(segment.at(-1) ?? ""))) {
      const nextIndex = consumeDevNullRedirect(command, index + 1);
      if (nextIndex === null) return null;
      index = nextIndex - 1;
      continue;
    }
    if (char === ">") {
      const nextIndex = consumeDevNullRedirect(command, index);
      if (nextIndex === null) return null;
      index = nextIndex - 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "<" || char === "`" || char === "(" || char === ")") return null;
    if (char === "$" && command[index + 1] === "(") return null;
    segment += char;
  }
  if (escaped || quote || !pushSegment()) return null;
  return segments;
}

/** Metacharacters bash expands or interprets alive inside double quotes. */
const DOUBLE_QUOTE_LIVE_METACHARACTERS = new Set(["$", "`", "|"]);

/**
 * Reject quoting contexts bash treats differently from the tokenizer:
 * `$()` substitution, backticks and pipes stay alive inside double quotes, and
 * a backslash inside single quotes is literal in bash (so quote tracking could
 * diverge from real shell parsing). Fails closed on any quoting ambiguity.
 */
function hasUnsafeQuoteContext(segment: string): boolean {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else if (char === "\\") return true;
      continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (!quote) {
      if (char === "'" || char === '"') quote = char;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (DOUBLE_QUOTE_LIVE_METACHARACTERS.has(char)) return true;
    }
  }
  return quote !== "";
}

/** Flags that give `git diff` write or external-driver side effects. */
const GIT_DIFF_EFFECT_FLAGS = new Set(["--output", "--ext-diff", "--textconv"]);
function hasEffectFlags(tokens: string[]): boolean {
  return tokens.some((token) => GIT_DIFF_EFFECT_FLAGS.has(token.split("=", 1)[0]));
}

const BLOCKED_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "shred", "mv", "cp", "install", "touch", "mkdir", "truncate", "chmod", "chown",
  "tee", "dd", "sed", "perl", "python", "python3", "ruby", "bash", "sh", "zsh", "node",
  "npx", "npm", "pnpm", "yarn", "bun", "deno", "make", "makepkg", "pytest", "jest", "vitest",
  "tsc", "eslint", "biome", "docker", "curl", "wget", "sudo", "eval", "source", "exec", "awk", "gawk",
  "env", "xargs", "pip", "pip3", "corepack", "webpack", "vite", "rollup",
]);
const BLOCKED_EFFECT_FLAGS = new Set([
  "--force", "-f", "--delete", "--overwrite", "--output", "--exec", "--execute",
  "--upload-pack", "--receive-pack", "--ext-diff", "--textconv",
]);

function hasBlockedEffects(tokens: string[]): boolean {
  const command = tokens[0]?.replaceAll("\\", "/").split("/").at(-1) ?? "";
  if (BLOCKED_COMMANDS.has(command) || /^(?:python|python\d+(?:\.\d+)*|node\d*|ruby\d*|perl\d*|bash\d*|sh\d*)$/.test(command)) return true;
  if (command === "git" && tokens.some((token) => BLOCKED_EFFECT_FLAGS.has(token.split("=", 1)[0]))) return true;
  if (command === "find" && tokens.some((token) => ["-delete", "-exec", "-execdir", "-ok"].includes(token))) return true;
  if (/\.(?:sh|bash|zsh|py|pyc|rb|pl|js|mjs|cjs|ts|tsx|jsx)$/.test(tokens[0] ?? "")) return true;
  if (tokens.some((token) => BLOCKED_EFFECT_FLAGS.has(token.split("=", 1)[0]))) return true;
  if (command === "git") {
    const verb = tokens[1];
    if (["checkout", "reset", "clean", "rebase", "cherry-pick", "apply", "am", "stash", "config", "init", "clone", "fetch", "pull", "push", "merge", "add", "commit", "restore", "switch", "tag", "gc", "prune"].includes(verb ?? "")) return true;
  }
  return false;
}

/** Flags read-only adicionales permitidos en git log (no cuentan como límite). */
const GIT_LOG_READONLY_FLAGS = new Set([
  "--oneline", "--format", "--stat", "--name-only", "--no-merges",
  "--first-parent", "--all", "--no-patch", "--decorate", "--graph",
  "--abbrev-commit", "--no-abbrev-commit", "--oneline", "--raw",
]);

/**
 * Valida argumentos de git log: exige límite máximo 10 commits.
 * Acepta -n <N>, --max-count=<N> y forma corta -<N> con entero 1..10.
 * Permite flags read-only adicionales y paths tras --.
 * Rechaza git log sin límite, con límite > 10 o con argumentos no reconocidos.
 */
function isAuthorizedGitLog(args: string[]): boolean {
  let hasLimit = false;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    // Paths tras --
    if (token === "--") return hasLimit;
    // Forma corta -<N> (ej. -5, -10)
    if (/^-[1-9]\d*$/.test(token)) {
      const n = Number(token.slice(1));
      if (n < 1 || n > 10) return false;
      hasLimit = true;
      index += 1;
      continue;
    }
    // -n <N> o --max-count=<N>
    if (token === "-n" || token === "--max-count") {
      const next = args[index + 1];
      if (!next || !/^\d+$/.test(next)) return false;
      const n = Number(next);
      if (n < 1 || n > 10) return false;
      hasLimit = true;
      index += 2;
      continue;
    }
    if (token.startsWith("--max-count=")) {
      const n = Number(token.slice("--max-count=".length));
      if (!Number.isInteger(n) || n < 1 || n > 10) return false;
      hasLimit = true;
      index += 1;
      continue;
    }
    // --format=<val> o --format <val> (consumir valor si existe)
    if (token.startsWith("--format=") || token === "--format") {
      if (token === "--format") index += 1; // saltar el valor
      index += 1;
      continue;
    }
    // Flags read-only conocidos (sin valor)
    if (GIT_LOG_READONLY_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    // Cualquier otro token no reconocido → rechazar
    return false;
  }
  return hasLimit;
}

export function isAuthorizedRunnerCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (!segments) return false;
  return segments.every((segment) => {
    if (hasUnsafeQuoteContext(segment)) return false;
    const tokens = tokenizeCommand(segment);
    if (!tokens?.length) return false;
    if (tokens[0] === "node" && tokens[1] === ".flowtask/bin/flowtask.js" && tokens[2] === "graphify") return tokens.length > 3;
    const worktreeScript = tokens[0].replaceAll("\\", "/");
    if (worktreeScript === "./.flowtask/scripts/worktree.sh" || worktreeScript.endsWith("/flowtask/scripts/worktree.sh")) {
      if (tokens.length === 2 && ["list", "prune"].includes(tokens[1])) return true;
      if (tokens[1] === "recover" && tokens.length <= 3) return true; // recover | recover <tx-id>
      if (tokens[1] === "create") {
        return tokens.length === 5 && Boolean(tokens[2]) && tokens[3] === "--base" && Boolean(tokens[4]);
      }
      // `complete` and `cleanup` share the shape "<id> [--base <branch>] [own-flag]"
      // but each one owns a different trailing flag.  Keeping them in a single
      // table avoids the trap of accepting `complete --discard` (public discard
      // belongs to cleanup only) or `cleanup --preserve-dirty`.
      const ownFlag: Record<string, string> = { complete: "--preserve-dirty", cleanup: "--discard" };
      if (ownFlag[tokens[1]] !== undefined && Boolean(tokens[2]) && tokens[2] !== "--base") {
        const args = tokens.slice(3);
        const flag = ownFlag[tokens[1]];
        if (args.length === 0) return true;
        if (args.length === 1 && args[0] === flag) return true;
        if (args.length === 2 && args[0] === "--base" && Boolean(args[1])) return true;
        if (args.length === 3 && args[0] === "--base" && Boolean(args[1]) && args[2] === flag) return true;
      }
      return false;
    }
    if (tokens[0] === "ls") return hasFlagsAndPaths(tokens.slice(1));
    if (tokens[0] === "cat") return tokens.length >= 2; // read-only file access for runner diagnostics
    if (tokens[0] === "echo") return true;
    if (tokens[0] !== "git") return !hasBlockedEffects(tokens);
    if (tokens[1] === "worktree" && tokens[2] === "list") return hasOnlyFlags(tokens.slice(3));
    if (tokens[1] === "diff") {
      const rest = tokens.slice(2);
      return !hasEffectFlags(rest) && hasFlagsAndPaths(rest);
    }
    if (tokens[1] === "status") return hasOnlyFlags(tokens.slice(2));
    if (tokens[1] === "add") return hasPaths(tokens.slice(2));
    if (tokens[1] === "restore" && tokens[2] === "--staged") return hasPaths(tokens.slice(3));
    if (tokens[1] === "commit") return tokens.length === 4 && tokens[2] === "-m" && Boolean(tokens[3]);
    if (tokens[1] === "push" || tokens[1] === "merge") return tokens.length >= 2;
    // Git read-only commands for runner coordination and diagnostics
    if (tokens[1] === "branch") return tokens.length >= 2 && hasOnlyFlags(tokens.slice(2));
     if (tokens[1] === "log") return isAuthorizedGitLog(tokens.slice(2));
    if (tokens[1] === "show") return tokens.length >= 2;
    if (tokens[1] === "rev-parse") return hasFlagsAndPaths(tokens.slice(2));
    // Git is default-deny: only explicitly reviewed read-only/admin commands
    // and the existing narrowly-shaped coordination commands are authorized.
    return false;
  });
}
