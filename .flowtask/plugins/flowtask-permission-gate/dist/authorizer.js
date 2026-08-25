export const RUNNER_DELEGATION_MESSAGE = "Recordá que debés delegar esta operación al subagente correspondiente.";
/** Tokenize the small shell grammar used by FlowTask commands. */
export function tokenizeCommand(command) {
    const tokens = [];
    let token = "";
    let quote = "";
    let escaped = false;
    const trimmed = command.trim();
    for (let index = 0; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (escaped) {
            token += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote)
                quote = "";
            else
                token += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char === ";" || char === "&" || char === "|" || char === "`" || char === "<" || char === ">" || char === "(" || char === ")")
            return null;
        if (char === "$" && trimmed[index + 1] === "(")
            return null;
        if (/\s/.test(char)) {
            if (token) {
                tokens.push(token);
                token = "";
            }
            continue;
        }
        token += char;
    }
    if (escaped || quote)
        return null;
    if (token)
        tokens.push(token);
    return tokens;
}
function hasOnlyFlags(tokens) { return tokens.every((token) => token.startsWith("-")); }
function hasPaths(tokens) { return tokens.length > 0 && tokens.every((token) => !token.startsWith("-")); }
function hasFlagsAndPaths(tokens) {
    let pathsStarted = false;
    for (const token of tokens) {
        if (token === "--") {
            pathsStarted = true;
            continue;
        }
        if (token.startsWith("-") && !pathsStarted)
            continue;
        if (token.startsWith("-") && pathsStarted)
            return false;
        pathsStarted = true;
    }
    return true;
}
function isRedirectBoundary(char) {
    return char === undefined || /\s/.test(char) || char === "&" || char === "|";
}
/** Consume one of the explicitly safe redirects and return the next index. */
function consumeDevNullRedirect(command, redirectIndex) {
    if (command[redirectIndex + 1] === ">")
        return null;
    let targetIndex = redirectIndex + 1;
    while (/\s/.test(command[targetIndex] ?? ""))
        targetIndex += 1;
    if (!command.startsWith("/dev/null", targetIndex))
        return null;
    const endIndex = targetIndex + "/dev/null".length;
    return isRedirectBoundary(command[endIndex]) ? endIndex : null;
}
/** Split only on && and || while rejecting shell syntax outside the allowlist. */
function splitCommandSegments(command) {
    const segments = [];
    let segment = "";
    let quote = "";
    let escaped = false;
    const pushSegment = () => {
        if (!segment.trim())
            return false;
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
            if (char === quote)
                quote = "";
            continue;
        }
        if (char === "'" || char === '"') {
            segment += char;
            quote = char;
            continue;
        }
        if (char === "&" && command[index + 1] === "&") {
            if (!pushSegment())
                return null;
            index += 1;
            continue;
        }
        if (char === "|" && command[index + 1] === "|") {
            if (!pushSegment())
                return null;
            index += 1;
            continue;
        }
        if (char === "&") {
            if (command[index + 1] !== ">")
                return null;
            const nextIndex = consumeDevNullRedirect(command, index + 1);
            if (nextIndex === null)
                return null;
            index = nextIndex - 1;
            continue;
        }
        if (char === "2" && command[index + 1] === ">" && (segment.length === 0 || /\s/.test(segment.at(-1) ?? ""))) {
            const nextIndex = consumeDevNullRedirect(command, index + 1);
            if (nextIndex === null)
                return null;
            index = nextIndex - 1;
            continue;
        }
        if (char === ">") {
            const nextIndex = consumeDevNullRedirect(command, index);
            if (nextIndex === null)
                return null;
            index = nextIndex - 1;
            continue;
        }
        if (char === ";" || char === "|" || char === "<" || char === "`" || char === "(" || char === ")")
            return null;
        if (char === "$" && command[index + 1] === "(")
            return null;
        segment += char;
    }
    if (escaped || quote || !pushSegment())
        return null;
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
function hasUnsafeQuoteContext(segment) {
    let quote = "";
    let escaped = false;
    for (let index = 0; index < segment.length; index += 1) {
        const char = segment[index];
        if (quote === "'") {
            if (char === "'")
                quote = "";
            else if (char === "\\")
                return true;
            continue;
        }
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (!quote) {
            if (char === "'" || char === '"')
                quote = char;
        }
        else if (quote === '"') {
            if (char === '"')
                quote = "";
            else if (DOUBLE_QUOTE_LIVE_METACHARACTERS.has(char))
                return true;
        }
    }
    return quote !== "";
}
/** Flags that give `git diff` write or external-driver side effects. */
const GIT_DIFF_EFFECT_FLAGS = new Set(["--output", "--ext-diff", "--textconv"]);
function hasEffectFlags(tokens) {
    return tokens.some((token) => GIT_DIFF_EFFECT_FLAGS.has(token.split("=", 1)[0]));
}
export function isAuthorizedRunnerCommand(command) {
    const segments = splitCommandSegments(command);
    if (!segments)
        return false;
    return segments.every((segment) => {
        if (hasUnsafeQuoteContext(segment))
            return false;
        const tokens = tokenizeCommand(segment);
        if (!tokens?.length)
            return false;
        if (tokens[0] === "node" && tokens[1] === ".flowtask/bin/flowtask.js" && tokens[2] === "graphify")
            return tokens.length > 3;
        const worktreeScript = tokens[0].replaceAll("\\", "/");
        if (worktreeScript === "./.flowtask/scripts/worktree.sh" || worktreeScript.endsWith("/flowtask/scripts/worktree.sh")) {
            if (tokens.length === 2 && ["list", "prune"].includes(tokens[1]))
                return true;
            if (tokens[1] === "complete" && tokens.length === 3 && Boolean(tokens[2]))
                return true;
            return tokens.length === 5 && ["create", "complete"].includes(tokens[1]) && Boolean(tokens[2]) && tokens[3] === "--base" && Boolean(tokens[4]);
        }
        if (tokens[0] === "ls")
            return hasFlagsAndPaths(tokens.slice(1));
        if (tokens[0] === "echo")
            return true;
        if (tokens[0] !== "git")
            return false;
        if (tokens[1] === "worktree" && tokens[2] === "list")
            return hasOnlyFlags(tokens.slice(3));
        if (tokens[1] === "diff") {
            const rest = tokens.slice(2);
            return !hasEffectFlags(rest) && hasFlagsAndPaths(rest);
        }
        if (tokens[1] === "status")
            return hasOnlyFlags(tokens.slice(2));
        if (tokens[1] === "add")
            return hasPaths(tokens.slice(2));
        if (tokens[1] === "restore" && tokens[2] === "--staged")
            return hasPaths(tokens.slice(3));
        if (tokens[1] === "commit")
            return tokens.length === 4 && tokens[2] === "-m" && Boolean(tokens[3]);
        if (tokens[1] === "push" || tokens[1] === "merge")
            return tokens.length >= 2;
        return false;
    });
}
