import {
  commandName,
  expandPlaceholders,
  isEnvAssignment,
  matchPath,
  matchText,
  readAuthorityContract
} from "./authority.js";
import { getValidator } from "./schemas.js";

const CATEGORIES = new Set(["filesystem", "shell", "network", "tools"]);
const OPERATIONS = new Set(["read", "write"]);
const OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const LOG_DECISIONS = { allow: "allowed", deny: "denied", ask_parent: "asked" };
const DURATION = /^\d+[smhd]?$/;
const INTERPRETER_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HEX_ONLY = /^[0-9a-f]+$/;
const LITERAL_HOST_MARKERS = /[:[]/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function decide(profile, action, context) {
  if (action === null || typeof action !== "object" || !CATEGORIES.has(action.category)) {
    throw new TypeError("action needs a known category");
  }
  switch (action.category) {
    case "filesystem":
      return decideFilesystem(profile, action, context);
    case "shell":
      return decideShell(profile, action.command);
    case "network":
      return decideNetwork(profile, action);
    default:
      return decideTool(profile, action);
  }
}

function verdict(decision, rule, reason) {
  return { decision, rule, reason };
}

function uncovered(profile, category) {
  return verdict(profile.on_uncovered[category], null, "uncovered");
}

function isWithin(base, path) {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path === base || path.startsWith(prefix);
}

function isCanonicalPath(path) {
  if (!path.startsWith("/")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function decideFilesystem(profile, action, context) {
  if (!OPERATIONS.has(action.operation)) throw new TypeError("filesystem operation must be read or write");
  if (typeof action.path !== "string") throw new TypeError("filesystem path must be a string");
  if (context === null || typeof context !== "object" || typeof context.run_cwd !== "string") {
    throw new TypeError("context must be an object with the absolute run_cwd");
  }
  const { path } = action;
  if (!isCanonicalPath(path)) return verdict("deny", null, "path_not_canonical");

  const mainRepository = context.main_repository ?? null;
  const outsideRun = !isWithin(context.run_cwd, path);
  const protectedHit =
    (context.protected_paths ?? []).some((root) => isWithin(root, path)) ||
    (mainRepository !== null && isWithin(mainRepository, path) && outsideRun);
  if (protectedHit) return verdict("deny", "contract.implicit_denial", "protected_path");

  const denyIndex = profile.filesystem.deny.findIndex((entry) =>
    matchPath(expandPlaceholders(entry, context), path)
  );
  if (denyIndex >= 0) return verdict("deny", `filesystem.deny[${denyIndex}]`, "denied_by_rule");

  const [writableRoot] = profile.filesystem.writable_roots;
  const writable = writableRoot === undefined ? null : expandPlaceholders(writableRoot, context);
  if (action.operation === "write") {
    if (writable !== null && matchPath(writable, path)) {
      return verdict("allow", "filesystem.writable_roots[0]", "allowed_by_rule");
    }
    return uncovered(profile, "filesystem");
  }

  const readableIndex = profile.filesystem.readable_roots.findIndex((root) =>
    matchPath(expandPlaceholders(root, context), path)
  );
  if (readableIndex >= 0) return verdict("allow", `filesystem.readable_roots[${readableIndex}]`, "allowed_by_rule");
  if (writable !== null && matchPath(writable, path)) {
    return verdict("allow", "filesystem.writable_roots[0]", "allowed_by_rule");
  }
  return uncovered(profile, "filesystem");
}

function decideShell(profile, command) {
  if (typeof command !== "string") throw new TypeError("shell command must be a string");
  const split = splitSegments(command);
  if (split === null) return { ...verdict("deny", null, "ambiguous_syntax"), segments: [] };
  const segments = split.map((text) => decideSegment(profile, text));
  const decision = segments.some((segment) => segment.decision === "deny")
    ? "deny"
    : segments.some((segment) => segment.decision === "ask_parent")
      ? "ask_parent"
      : "allow";
  const first = segments.find((segment) => segment.decision === decision) ?? segments[0];
  return { decision, rule: first.rule, reason: first.reason, segments };
}

function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "$") {
      if (char === "\\" && next !== undefined) {
        current += char + next;
        i++;
        continue;
      }
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\" && next !== undefined && next !== "\n" && next !== "\r") {
      current += char + next;
      i++;
      continue;
    }
    if (char === "\\") return null;
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "`" || (char === "$" && next === "(")) return null;
      current += char;
      continue;
    }
    if (char === "$" && next === "'") {
      quote = "$";
      current += "$'";
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) return null;
    if ("<>(){}".includes(char) || char === "\n" || char === "\r") return null;
    if (char === ";" || char === "|" || char === "&") {
      const doubled = (char === "&" || char === "|") && next === char;
      if (doubled) i++;
      segments.push(current);
      current = "";
      continue;
    }
    if (char === " " || char === "\t") {
      if (current !== "" && !current.endsWith(" ")) current += " ";
      continue;
    }
    current += char;
  }
  if (quote !== null) return null;
  segments.push(current);
  const trimmed = segments.map((segment) => segment.trim());
  return trimmed.some((segment) => segment === "") ? null : trimmed;
}

function splitWords(segment) {
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    const next = segment[i + 1];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "$") {
      if (char === "\\" && next !== undefined) {
        current += char + next;
        i++;
        continue;
      }
      current += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && next !== undefined) {
        current += char + next;
        i++;
        continue;
      }
      current += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += char + next;
      i++;
      continue;
    }
    if (char === " ") {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    if (char === "$" && next === "'") {
      quote = "$";
      current += "$'";
      i++;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    current += char;
  }
  if (current !== "") words.push(current);
  return words;
}

function decodeWord(raw) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const char = raw[i];
    if (char === "'") {
      const end = raw.indexOf("'", i + 1);
      const stop = end === -1 ? raw.length : end;
      out += raw.slice(i + 1, stop);
      i = stop + 1;
    } else if (char === '"') {
      i++;
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < raw.length && '\\"$`'.includes(raw[i + 1])) {
          out += raw[i + 1];
          i += 2;
        } else {
          out += raw[i];
          i++;
        }
      }
      i++;
    } else if (char === "$" && raw[i + 1] === "'") {
      i += 2;
      while (i < raw.length && raw[i] !== "'") {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          const [decoded, consumed] = decodeAnsiEscape(raw.slice(i + 1));
          out += decoded;
          i += 1 + consumed;
        } else {
          out += raw[i];
          i++;
        }
      }
      i++;
    } else if (char === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 2;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

const ANSI_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };

function decodeAnsiEscape(rest) {
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest) ?? /^u([0-9a-fA-F]{1,4})/.exec(rest) ?? /^U([0-9a-fA-F]{1,8})/.exec(rest);
  if (hex !== null) return [String.fromCodePoint(parseInt(hex[1], 16)), hex[0].length];
  const octal = /^[0-7]{1,3}/.exec(rest);
  if (octal !== null) return [String.fromCharCode(parseInt(octal[0], 8)), octal[0].length];
  return [ANSI_SIMPLE[rest[0]] ?? rest[0], 1];
}

function effectiveWords(segment, wrappers) {
  const raw = splitWords(segment);
  const values = raw.map(decodeWord);
  let index = 0;
  while (index < raw.length) {
    if (isEnvAssignment(raw[index])) {
      index++;
    } else if (wrappers.includes(commandName(values[index]))) {
      index++;
      while (
        index < raw.length &&
        (values[index].startsWith("-") || isEnvAssignment(raw[index]) || DURATION.test(values[index]))
      ) {
        index++;
      }
    } else {
      break;
    }
  }
  return { words: values.slice(index), values };
}

function decideSegment(profile, text) {
  const contract = readAuthorityContract();
  const { words, values } = effectiveWords(text, contract.command_wrappers);
  const executable = words.length > 0 ? commandName(words[0]) : "";

  const naiveWords = text.split(" ");
  const invokesHarness = [...values, ...naiveWords].some((value) =>
    contract.always_denied_executables.includes(commandName(value))
  );
  if (invokesHarness) {
    return segmentVerdict(text, "deny", "contract.direct_harness_denial", "direct_harness_invocation");
  }

  const interpreted =
    contract.command_interpreters.includes(executable) &&
    words.slice(1).some((arg) => arg === "-c" || INTERPRETER_FLAG.test(arg));
  if (interpreted || executable === "eval") {
    return segmentVerdict(text, "deny", null, "ambiguous_syntax");
  }

  const denyIndex = profile.shell.deny.findIndex((pattern) => matchText(pattern, text));
  if (denyIndex >= 0) return segmentVerdict(text, "deny", `shell.deny[${denyIndex}]`, "denied_by_rule");
  const allowIndex = profile.shell.allow.findIndex((pattern) => matchText(pattern, text));
  if (allowIndex >= 0) return segmentVerdict(text, "allow", `shell.allow[${allowIndex}]`, "allowed_by_rule");
  return segmentVerdict(text, profile.on_uncovered.shell, null, "uncovered");
}

function segmentVerdict(command, decision, rule, reason) {
  return { command, decision, rule, reason };
}

function decideNetwork(profile, action) {
  const { host, port } = action;
  if (typeof host !== "string") throw new TypeError("network host must be a string");
  const name = host.toLowerCase().replace(/\.$/, "");
  if (IPV4.test(name) || LITERAL_HOST_MARKERS.test(name) || HEX_ONLY.test(name)) {
    return verdict("deny", null, "numeric_destination");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("network port must be an integer from 1 to 65535");
  }
  const { default_network_port: defaultPort } = readAuthorityContract();
  const index = profile.network.allow.findIndex((entry) => {
    const destination = splitDestination(entry, defaultPort);
    return destination.port === port && hostMatches(destination.host, name);
  });
  if (index >= 0) return verdict("allow", `network.allow[${index}]`, "allowed_by_rule");
  return uncovered(profile, "network");
}

function splitDestination(entry, defaultPort) {
  const separator = entry.lastIndexOf(":");
  if (separator === -1) return { host: entry, port: defaultPort };
  return { host: entry.slice(0, separator), port: Number(entry.slice(separator + 1)) };
}

function hostMatches(pattern, host) {
  if (pattern.startsWith("*.")) return host.endsWith(`.${pattern.slice(2)}`);
  return pattern === host;
}

function decideTool(profile, action) {
  if (action.mcp !== undefined) {
    const { server, tool } = action.mcp;
    const matches = (entry) => entry.server === server && (entry.tool === "*" || entry.tool === tool);
    const denyIndex = profile.tools.mcp_deny.findIndex(matches);
    if (denyIndex >= 0) return verdict("deny", `tools.mcp_deny[${denyIndex}]`, "denied_by_rule");
    const allowIndex = profile.tools.mcp_allow.findIndex(matches);
    if (allowIndex >= 0) return verdict("allow", `tools.mcp_allow[${allowIndex}]`, "allowed_by_rule");
    return uncovered(profile, "tools");
  }
  if (typeof action.tool !== "string") throw new TypeError("tools action needs a tool name or an mcp pair");
  const denyIndex = profile.tools.deny.indexOf(action.tool);
  if (denyIndex >= 0) return verdict("deny", `tools.deny[${denyIndex}]`, "denied_by_rule");
  const allowIndex = profile.tools.allow.indexOf(action.tool);
  if (allowIndex >= 0) return verdict("allow", `tools.allow[${allowIndex}]`, "allowed_by_rule");
  return uncovered(profile, "tools");
}

export function outcomeOf(decision) {
  const verdictValue = decision?.decision;
  if (verdictValue === "allow") {
    return { answer: { option_kind: "allow_once", decided_by: "authority_policy" }, counts: "granted" };
  }
  if (verdictValue === "deny") {
    return {
      answer: { option_kind: "reject_once", decided_by: "authority_policy" },
      counts: "rejected",
      run_ends: { state: "failed", reason: "permission_rejected" }
    };
  }
  if (verdictValue === "ask_parent") {
    return { pause: { state: "input_required", cause: "permission_pending" } };
  }
  throw new TypeError("outcomeOf needs a decision returned by decide");
}

export function answerPending(decision, optionKind) {
  if (!OPTION_KINDS.has(optionKind)) throw new TypeError("optionKind must be a permission option kind");
  if (decision?.decision !== "ask_parent") return { ok: false, reason: "not_consultable" };
  if (optionKind.startsWith("allow_")) {
    return {
      ok: true,
      answer: { option_kind: "allow_once", decided_by: "parent" },
      persisted: false,
      run_ends: null
    };
  }
  return {
    ok: true,
    answer: { option_kind: "reject_once", decided_by: "parent" },
    persisted: false,
    run_ends: { state: "failed", reason: "permission_rejected" }
  };
}

export function redactCommand(command) {
  if (typeof command !== "string") throw new TypeError("command must be a string");
  let result = "";
  let index = 0;
  for (const word of wordsOf(command)) {
    result += command.slice(index, word.start);
    result += ENV_NAME_PATTERN.test(word.text)
      ? `${word.text.slice(0, word.text.indexOf("="))}=<redacted>`
      : word.text;
    index = word.end;
  }
  return result + command.slice(index);
}

function wordsOf(command) {
  const words = [];
  let quote = null;
  let start = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const isSpace = quote === null && (char === " " || char === "\t");
    if (isSpace) {
      if (start !== null) {
        words.push({ start, end: i, text: command.slice(start, i) });
        start = null;
      }
      continue;
    }
    if (start === null) start = i;
    if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === "\\") {
      i++;
    } else if (quote === '"') {
      if (char === '"') quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  if (start !== null) words.push({ start, end: command.length, text: command.slice(start) });
  return words;
}

export function buildLogEntry({ run_id, timestamp, cwd, command, decision, rule, exit_code }) {
  const entry = { run_id, timestamp, cwd, command: redactCommand(command), decision, rule, exit_code };
  if (!getValidator("terminal-log-entry")(entry)) {
    throw new TypeError("terminal log entry does not match its schema");
  }
  return entry;
}

export function logDecisionOf(decision) {
  if (!Object.hasOwn(LOG_DECISIONS, decision)) throw new TypeError("unknown decision");
  return LOG_DECISIONS[decision];
}

export function formatLogLine(entry) {
  if (!getValidator("terminal-log-entry")(entry)) {
    throw new TypeError("terminal log entry does not match its schema");
  }
  return `${JSON.stringify(entry)}\n`;
}

export function parseLog(text) {
  if (typeof text !== "string") throw new TypeError("log text must be a string");
  if (text === "") return { ok: true, entries: [] };
  const validate = getValidator("terminal-log-entry");
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      return { ok: false, line: i + 1, errors: [{ message: "line is not JSON" }] };
    }
    if (!validate(entry)) return { ok: false, line: i + 1, errors: validate.errors };
    entries.push(entry);
  }
  return { ok: true, entries };
}
