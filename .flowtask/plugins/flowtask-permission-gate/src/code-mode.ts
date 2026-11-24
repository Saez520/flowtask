import { isAuthorizedRunnerMcpTool } from "./authorizer.js";

export const RUNNER_EXECUTE_TOOL = "execute";

/** Identifiers that would add execution primitives or reach outside the MCP surface. */
const FORBIDDEN_IDENTIFIERS = new Set(["fetch", "eval", "Function", "require", "process"]);

const WORD_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Positions that carry code: comments and single- or double-quoted literals are
 * data. Template literals stay code because their interpolations execute.
 * Returns null when a literal or block comment is unterminated so the caller
 * rejects the script.
 */
function buildCodeMask(script: string): boolean[] | null {
  const mask = new Array<boolean>(script.length).fill(true);
  let index = 0;
  while (index < script.length) {
    const char = script[index];
    if (char === "/" && script[index + 1] === "/") {
      mask[index] = false;
      mask[index + 1] = false;
      index += 2;
      while (index < script.length && script[index] !== "\n") {
        mask[index] = false;
        index += 1;
      }
      continue;
    }
    if (char === "/" && script[index + 1] === "*") {
      mask[index] = false;
      mask[index + 1] = false;
      index += 2;
      let closed = false;
      while (index < script.length) {
        if (script[index] === "*" && script[index + 1] === "/") {
          mask[index] = false;
          mask[index + 1] = false;
          index += 2;
          closed = true;
          break;
        }
        mask[index] = false;
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      mask[index] = false;
      index += 1;
      let closed = false;
      while (index < script.length) {
        const current = script[index];
        mask[index] = false;
        if (current === "\\") {
          if (index + 1 < script.length) mask[index + 1] = false;
          index += 2;
          continue;
        }
        index += 1;
        if (current === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) return null;
      continue;
    }
    index += 1;
  }
  return mask;
}

type ToolSegment = { name: string; end: number };

/**
 * Reads one contiguous `.name` or `["name"]` segment starting at `index`.
 * Returns null unless the segment is in code position, has a non-empty name,
 * and ends exactly where the next segment may start.
 */
function readToolSegment(script: string, mask: boolean[], index: number): ToolSegment | null {
  if (index >= script.length || !mask[index]) return null;
  if (script[index] === ".") {
    const start = index + 1;
    if (start >= script.length || !mask[start] || !WORD_CHARACTER.test(script[start])) return null;
    let end = start;
    while (end < script.length && mask[end] && WORD_CHARACTER.test(script[end])) end += 1;
    return { name: script.slice(start, end), end };
  }
  if (script[index] === "[") {
    const quote = script[index + 1];
    if (quote !== "'" && quote !== '"') return null;
    let end = index + 2;
    let name = "";
    while (end < script.length) {
      const current = script[end];
      if (current === "\\") {
        if (end + 1 >= script.length) return null;
        name += script[end + 1];
        end += 2;
        continue;
      }
      if (current === quote) {
        if (!name) return null;
        if (script[end + 1] !== "]") return null;
        return { name, end: end + 2 };
      }
      name += current;
      end += 1;
    }
  }
  return null;
}

/**
 * Authorizes an `execute` script only when every `tools` access is one of the
 * two contiguous literal segments followed immediately by `(`, and the resolved
 * MCP name belongs to the runner surface. Any forbidden identifier, unresolved
 * reference, or missing invocation rejects the whole script: nothing is
 * rewritten and no part of it runs.
 */
export function isAuthorizedRunnerScript(script: unknown): boolean {
  if (typeof script !== "string" || !script) return false;
  const mask = buildCodeMask(script);
  if (!mask) return false;
  let authorizedReferences = 0;
  for (let index = 0; index < script.length; index += 1) {
    if (!mask[index] || !WORD_CHARACTER.test(script[index])) continue;
    if (index > 0 && mask[index - 1] && WORD_CHARACTER.test(script[index - 1])) continue;
    let end = index;
    while (end < script.length && mask[end] && WORD_CHARACTER.test(script[end])) end += 1;
    const word = script.slice(index, end);
    if (FORBIDDEN_IDENTIFIERS.has(word)) return false;
    if (word !== "tools") continue;
    const server = readToolSegment(script, mask, end);
    if (!server) return false;
    const capability = readToolSegment(script, mask, server.end);
    if (!capability) return false;
    const next = script[capability.end];
    if (next === "." || next === "[") return false;
    if (next !== "(") return false;
    if (!isAuthorizedRunnerMcpTool(`${server.name}_${capability.name}`)) return false;
    authorizedReferences += 1;
  }
  return authorizedReferences > 0;
}
