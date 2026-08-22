export const RUNNER_DELEGATION_MESSAGE = "Recordá que debés delegar esta operación al subagente correspondiente.";

/** Tokenize the small shell grammar used by FlowTask commands. */
export function tokenizeCommand(command: string): string[] | null {
  if (/[;&|`<>]|\$\(/.test(command)) return null;
  const tokens: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; else token += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = ""; } continue; }
    token += char;
  }
  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function hasOnlyFlags(tokens: string[]): boolean { return tokens.every((token) => token.startsWith("-")); }
function hasPaths(tokens: string[]): boolean { return tokens.length > 0 && tokens.every((token) => !token.startsWith("-")); }

export function isAuthorizedRunnerCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return false;
  if (tokens[0] === "node" && tokens[1] === ".flowtask/bin/flowtask.js" && tokens[2] === "graphify") return tokens.length > 3;
  const worktreeScript = tokens[0].replaceAll("\\", "/");
  if (worktreeScript === "./.flowtask/scripts/worktree.sh" || worktreeScript.endsWith("/flowtask/scripts/worktree.sh")) {
    if (tokens.length === 2 && tokens[1] === "list") return true;
    return tokens.length === 5 && ["create", "complete"].includes(tokens[1]) && Boolean(tokens[2]) && tokens[3] === "--base" && Boolean(tokens[4]);
  }
  if (tokens[0] !== "git") return false;
  if (tokens[1] === "status") return hasOnlyFlags(tokens.slice(2));
  if (tokens[1] === "add") return hasPaths(tokens.slice(2));
  if (tokens[1] === "restore" && tokens[2] === "--staged") return hasPaths(tokens.slice(3));
  if (tokens[1] === "commit") return tokens.length === 4 && tokens[2] === "-m" && Boolean(tokens[3]);
  if (tokens[1] === "push" || tokens[1] === "merge") return tokens.length >= 2;
  return false;
}
