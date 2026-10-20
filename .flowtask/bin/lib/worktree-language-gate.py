#!/usr/bin/env python3
"""Reproducible inventory and language gate for the worktree management surfaces.

The gate enumerates every human-readable text of the Python package, of its
standalone entry point and of the consumer entry point and compatibility
adapter. Each entry is classified as English, explicitly allowed or pending.
The gate fails closed when a text that is neither English nor explicitly
allowed is found, and it never changes the text it inspects.
"""
from __future__ import annotations

import argparse
import ast
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import tokenize
from pathlib import Path

SCHEMA_INVENTORY = "worktree-language-inventory/v1"
SCHEMA_ALLOWLIST = "worktree-language-allowlist/v1"

SURFACES = ("python-package", "standalone-entrypoint", "consumer-entrypoint", "consumer-adapter")

# The most specific category wins when a token matches more than one pattern.
CATEGORY_PRIORITY = (
    "L-CMD",
    "L-REF",
    "L-ENV",
    "L-CONF",
    "L-ACRONYM",
    "L-CMDNAME",
    "L-PROTO",
    "L-PATH",
    "L-ID",
)

SPANISH_CHARACTERS = re.compile(r"[áéíóúÁÉÍÓÚñÑüÜ¿¡]")
TOKEN_RE = re.compile(r"[A-Za-z0-9_./$+=@-]+")
WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
PLACEHOLDER_RE = re.compile(r"\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9]+")
MARKER_RE = re.compile(r"\b(?:TODO|FIXME|TBD|XXX)\b|por\s+traducir|sin\s+traducir", re.IGNORECASE)
REDIRECT_RE = re.compile(r"(?<!&)>(?!&)")

SPANISH_LEXICON = frozenset(
    {
        "archivo", "archivos", "repositorio", "repositorios", "trabajo", "trabajos",
        "gestor", "mensaje", "mensajes", "advertencia", "advertencias", "recuperacion",
        "respaldo", "respaldos", "bloqueo", "bloqueos", "configuracion", "operacion",
        "operaciones", "ruta", "rutas", "salida", "salidas", "estado", "estados",
        "clave", "claves", "valor", "valores", "crear", "completar", "limpiar",
        "listar", "recuperar", "fallo", "fallos", "valido", "invalido", "requiere",
        "debe", "presente", "ausente", "inicializado", "permiso", "denegado",
        "hola", "mundo", "gracias", "adios", "aqui", "hoy", "noche", "estoy", "usted",
    }
)

# Stop words that are not English words. The ambiguous ones are excluded on purpose.
SPANISH_STOPWORDS = frozenset(
    {
        "la", "el", "en", "los", "las", "un", "una", "es", "se", "del", "al", "por",
        "con", "para", "su", "como", "mas", "que", "lo", "le", "ha", "son", "ser",
        "sus", "este", "esta", "pero", "sin", "sobre", "entre", "cuando", "porque",
        "tambien", "muy", "ya", "si", "ni", "ante", "bajo", "desde", "hasta",
        "tras", "cada", "otro", "otra", "otros", "otras", "todo", "todos", "toda",
        "todas", "estan", "fue", "sido", "puede", "pueden", "debe", "deben", "tiene",
        "tienen", "hacer", "hace", "hizo", "donde", "cual",
    }
)

ENGLISH_STOPWORDS = frozenset(
    {
        "the", "and", "of", "to", "in", "is", "it", "for", "on", "with", "as", "at",
        "by", "be", "this", "that", "from", "not", "are", "was", "were", "has", "have",
        "had", "will", "would", "can", "could", "should", "must", "its", "their",
        "there", "these", "those", "they", "them", "we", "you", "our", "but", "if",
        "then", "else", "when", "which", "who", "whom", "what", "where", "how", "all",
        "any", "each", "more", "most", "other", "some", "such", "only", "own", "same",
        "so", "than", "too", "very", "just", "into", "over", "under", "again",
        "further", "once", "here", "why", "does", "did", "doing", "done",
    }
)

MACHINE_VALUE_RE = re.compile(r"^[A-Za-z0-9_./:$+=@-]+$")
VARIABLE_ONLY_RE = re.compile(r"^\$?\{?[A-Za-z_][A-Za-z0-9_]*\}?$|^\$[0-9]+$")
ALLCAPS_RE = re.compile(r"^[A-Z][A-Z0-9]*$")
ALLCAPS_HYPHEN_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")
ALLCAPS_UNDERSCORE_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$")
SNAKE_RE = re.compile(r"^_*[a-z0-9]+(?:_[a-z0-9]+)+_*$")
KEBAB_RE = re.compile(r"^-+[a-z0-9]+(?:-[a-z0-9]+)+$")
PATH_EXTENSION_RE = re.compile(r"\.(py|sh|md|json|txt|conf|lock|log|bin)$")


class GateError(Exception):
    """A violation that the gate reports and that makes it fail closed."""

    def __init__(self, code: str, detail: str, path: str = "", line: int = 0):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.path = path
        self.line = line

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail, "path": self.path, "line": self.line}


# --------------------------------------------------------------------- allowlist


def load_allowlist(path: Path) -> dict:
    """Read and validate the allowlist. An invalid allowlist is never ignored."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GateError("invalid_allowlist", f"the allowlist is unreadable: {exc}") from exc
    try:
        document = json.loads(raw)
    except ValueError as exc:
        raise GateError("invalid_allowlist", f"the allowlist is not valid JSON: {exc}") from exc
    if not isinstance(document, dict):
        raise GateError("invalid_allowlist", "the allowlist must be a JSON object")
    if document.get("schema") != SCHEMA_ALLOWLIST:
        raise GateError("invalid_allowlist", f"the allowlist schema must be {SCHEMA_ALLOWLIST}")
    if document.get("policy") != "literal-level":
        raise GateError("invalid_allowlist", "the allowlist policy must be literal-level")
    categories = document.get("categories")
    if not isinstance(categories, dict) or not categories:
        raise GateError("invalid_allowlist", "the allowlist must declare its categories")
    for identifier, spec in categories.items():
        if not isinstance(spec, dict):
            raise GateError("invalid_allowlist", f"the category {identifier} must be an object")
        for token in spec.get("tokens", []):
            if not isinstance(token, str) or not token:
                raise GateError("invalid_allowlist", f"the category {identifier} has an invalid token")
        for pattern in spec.get("patterns", []):
            try:
                re.compile(pattern)
            except re.error as exc:
                raise GateError(
                    "invalid_allowlist", f"the category {identifier} has an invalid pattern: {exc}"
                ) from exc
    exceptions = document.get("exceptions", [])
    if not isinstance(exceptions, list):
        raise GateError("invalid_allowlist", "the allowlist exceptions must be a list")
    seen_ids: set[str] = set()
    seen_pairs: set[tuple[str, str]] = set()
    for exception in exceptions:
        if not isinstance(exception, dict):
            raise GateError("invalid_allowlist", "every allowlist exception must be an object")
        identifier = exception.get("id")
        literal = exception.get("literal")
        scope = exception.get("scope")
        if not isinstance(identifier, str) or not identifier:
            raise GateError("invalid_allowlist", "every allowlist exception needs an identifier")
        if not isinstance(literal, str) or not literal:
            raise GateError("invalid_allowlist", f"the exception {identifier} needs a literal")
        if not isinstance(scope, str) or not scope:
            raise GateError("invalid_allowlist", f"the exception {identifier} needs a scope")
        if not exception.get("reason") or not exception.get("owner"):
            raise GateError("invalid_allowlist", f"the exception {identifier} needs a reason and an owner")
        if identifier in seen_ids:
            raise GateError("duplicate_allowlist_entry", f"the exception identifier {identifier} is duplicated")
        if (literal, scope) in seen_pairs:
            raise GateError(
                "duplicate_allowlist_entry", f"the exception {identifier} repeats a literal and scope pair"
            )
        seen_ids.add(identifier)
        seen_pairs.add((literal, scope))
    return document


class Allowlist:
    """Indexed view of the allowlist used by the classifier."""

    def __init__(self, document: dict):
        self.document = document
        self.categories: dict[str, dict] = {}
        for identifier, spec in document.get("categories", {}).items():
            self.categories[identifier] = {
                "tokens": frozenset(spec.get("tokens", [])),
                "patterns": [re.compile(pattern) for pattern in spec.get("patterns", [])],
            }
        self.exceptions = list(document.get("exceptions", []))

    def _tokens(self, identifier: str) -> frozenset:
        return self.categories.get(identifier, {}).get("tokens", frozenset())

    def category_of(self, token: str) -> str | None:
        """The category that claims a token, or None when no category does."""
        if ALLCAPS_HYPHEN_RE.match(token):
            parts = token.split("-")
            known = self._tokens("L-ACRONYM") | self._tokens("L-REF") | self._tokens("L-CMDNAME")
            if not all(part in known or part.isdigit() for part in parts):
                return None
            for identifier in ("L-ACRONYM", "L-REF", "L-CMDNAME"):
                if self._tokens(identifier) & set(parts):
                    return identifier
            return "L-ACRONYM"
        for identifier in CATEGORY_PRIORITY:
            spec = self.categories.get(identifier)
            if spec is None:
                continue
            if token in spec["tokens"]:
                return identifier
            for pattern in spec["patterns"]:
                if pattern.match(token):
                    return identifier
        return None

    def is_machine_candidate(self, token: str) -> bool:
        """True when the token looks like a machine literal and must be classified."""
        if not any(character.isalnum() for character in token):
            return False
        if "/" in token:
            return True
        if token.startswith("--") or (len(token) == 2 and token.startswith("-")):
            return True
        if ALLCAPS_RE.match(token) and len(token) >= 2:
            return True
        if ALLCAPS_HYPHEN_RE.match(token):
            return True
        if ALLCAPS_UNDERSCORE_RE.match(token):
            return True
        if SNAKE_RE.match(token) or KEBAB_RE.match(token):
            return True
        if PATH_EXTENSION_RE.search(token):
            return True
        return False


# ------------------------------------------------------------------- extraction


def _entry(surface: str, path: str, line: int, kind: str, type_: str, text: str) -> dict:
    return {
        "surface": surface,
        "path": path,
        "line": line,
        "kind": kind,
        "type": type_,
        "text": text,
    }


def _literal_parts(node: ast.AST) -> list[str]:
    """The literal text of an expression, with formatted values left empty."""
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return [node.value]
        return []
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("")
        return ["".join(parts)]
    if isinstance(node, ast.BinOp):
        return _literal_parts(node.left) + _literal_parts(node.right)
    return []


def _call_name(node: ast.Call) -> str:
    function = node.func
    if isinstance(function, ast.Name):
        return function.id
    if isinstance(function, ast.Attribute):
        return function.attr
    return ""


def extract_python(path: Path, display: str, surface: str) -> list[dict]:
    """Every human-readable text of one Python module."""
    source = path.read_text(encoding="utf-8")
    entries: list[dict] = []
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        raise GateError("invalid_allowlist", f"the module cannot be parsed: {exc}", display) from exc
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        text = token.string.lstrip("#").strip()
        if text:
            entries.append(_entry(surface, display, token.start[0], "comment", "comment", text))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        document = ast.get_docstring(node, clean=False)
        if not document or not document.strip():
            continue
        body = getattr(node, "body", [])
        line = body[0].lineno if body else 1
        entries.append(_entry(surface, display, line, "docstring", "comment", document.strip()))
    module = path.name.startswith("mcp_")
    recovery = path.name == "recovery_manager.py"
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node)
        kind = ""
        type_ = ""
        arguments: list[ast.AST] = []
        if name == "print":
            kind, type_, arguments = "output", "output", list(node.args)
        elif name == "ManagerError" and len(node.args) >= 2:
            kind, type_, arguments = "diagnostic", "error", [node.args[1]]
        elif name == "ValueError" and node.args:
            kind, type_, arguments = "diagnostic", "error", [node.args[0]]
        elif (
            name == "append"
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "warnings"
            and node.args
        ):
            kind, type_, arguments = "warning", "warning", [node.args[0]]
        elif name in ("add_argument", "add_parser", "add_subparsers"):
            for keyword in node.keywords:
                if keyword.arg in ("help", "description"):
                    kind, type_, arguments = "help", "help", [keyword.value]
                    break
        if not kind:
            continue
        for argument in arguments:
            for text in _literal_parts(argument):
                if not text.strip():
                    continue
                entry_kind, entry_type = kind, type_
                if module and kind in ("output", "diagnostic", "warning", "help"):
                    entry_kind, entry_type = "mcp", "mcp"
                elif recovery and kind in ("output", "diagnostic", "warning", "help"):
                    entry_kind, entry_type = "recovery", "recovery"
                entries.append(
                    _entry(surface, display, node.lineno, entry_kind, entry_type, text.strip())
                )
    return entries


SHELL_MESSAGE_RE = re.compile(
    r"^\s*(?P<command>printf|echo|notice|reject)\s+(?P<body>.+?)\s*$"
)


def _unquote(token: str) -> str:
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "'\"":
        return token[1:-1]
    return token


def _shell_message(line: str) -> tuple[str, str] | None:
    """The literal message of a shell output statement with its command."""
    match = SHELL_MESSAGE_RE.match(line)
    if not match:
        return None
    command = match.group("command")
    body = match.group("body").strip()
    try:
        tokens = shlex.split(body, posix=False)
    except ValueError:
        return None
    if not tokens:
        return None
    if command == "printf":
        first = _unquote(tokens[0])
        if first in ("%s", "%s\\n", "%s\n"):
            if len(tokens) < 2:
                return None
            candidate = tokens[1]
        else:
            candidate = tokens[0]
    else:
        candidate = tokens[0]
    text = _unquote(candidate)
    if not text.strip():
        return None
    if VARIABLE_ONLY_RE.match(text.strip()):
        return None
    return command, text


def extract_shell(path: Path, display: str, surface: str) -> list[dict]:
    """Every human-readable text of one shell script."""
    entries: list[dict] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            if stripped.startswith("#!"):
                continue
            text = stripped.lstrip("#").strip()
            if text:
                entries.append(_entry(surface, display, number, "comment", "comment", text))
            continue
        if REDIRECT_RE.search(line):
            continue
        found = _shell_message(line)
        if found is None:
            continue
        command, message = found
        kind, type_ = "output", "operation"
        if command == "reject" or ">&2" in line:
            kind, type_ = "diagnostic", "error"
        entries.append(_entry(surface, display, number, kind, type_, message.strip()))
    return entries


def is_machine_value(text: str) -> bool:
    """True when a literal is a machine value and not a human-readable text."""
    stripped = text.strip().rstrip(":.,;")
    if not stripped:
        return True
    if not any(character.isalpha() for character in stripped):
        return True
    if any(character.isspace() for character in stripped):
        return False
    return bool(MACHINE_VALUE_RE.match(stripped))


# ------------------------------------------------------------------- detection


def alphabetic_length(text: str) -> int:
    return sum(1 for character in text if character.isalpha())


def mask_machine_literals(text: str, allowlist: Allowlist) -> str:
    """Replace every machine literal with spaces so only human words remain."""

    def replace(match: re.Match) -> str:
        token = match.group(0)
        if allowlist.category_of(token) is not None:
            return " " * len(token)
        return token

    return TOKEN_RE.sub(replace, text)


def detect_signals(text: str, allowlist: Allowlist, check_unclassified: bool) -> list[str]:
    """The language signals of a text that is already free of machine literals."""
    signals: list[str] = []
    if SPANISH_CHARACTERS.search(text):
        signals.append("spanish_signal")
    words = [word.lower() for word in WORD_RE.findall(text)]
    if words and set(words) & SPANISH_LEXICON:
        signals.append("spanish_signal")
    spanish_hits = sum(1 for word in words if word in SPANISH_STOPWORDS)
    english_hits = sum(1 for word in words if word in ENGLISH_STOPWORDS)
    if spanish_hits >= 2 and spanish_hits > english_hits:
        signals.append("spanish_signal")
    if MARKER_RE.search(text):
        signals.append("unresolved_marker")
    if any(ord(character) > 127 for character in text):
        signals.append("non_ascii_character")
    if check_unclassified:
        for token in TOKEN_RE.findall(text):
            if allowlist.is_machine_candidate(token) and allowlist.category_of(token) is None:
                signals.append("unclassified_machine_literal")
                break
    return signals


def evaluate_entry(entry: dict, allowlist: Allowlist) -> tuple[str, list[str], list[str], str]:
    """Classify one entry. It returns its status, exception ids, signals and reason."""
    text = entry["text"]
    applied: list[str] = []
    masked = mask_machine_literals(PLACEHOLDER_RE.sub(" ", text), allowlist)
    for exception in allowlist.exceptions:
        literal = exception["literal"]
        if literal not in text:
            continue
        scope = exception["scope"]
        if scope != entry["surface"] and entry["surface"] not in scope.split(","):
            continue
        if literal == text.strip():
            raise GateError(
                "whole_message_exemption",
                f"the exception {exception['id']} exempts a complete message",
                entry["path"],
                entry["line"],
            )
        total = alphabetic_length(text)
        covered = alphabetic_length(literal)
        if total and covered / total > 0.6:
            raise GateError(
                "whole_message_exemption",
                f"the exception {exception['id']} covers {covered} of {total} alphabetic characters",
                entry["path"],
                entry["line"],
            )
        masked = masked.replace(literal, " " * len(literal))
        applied.append(exception["id"])
    signals = detect_signals(masked, allowlist, check_unclassified=True)
    if not signals and alphabetic_length(masked) == 0 and alphabetic_length(text) > 0:
        raise GateError(
            "whole_message_exemption",
            "the allowlist categories cover the complete message",
            entry["path"],
            entry["line"],
        )
    if signals:
        return "pending", applied, signals, signals[0]
    if applied:
        covered_signals = detect_signals(text, allowlist, check_unclassified=False)
        reason = covered_signals[0] if covered_signals else "non_ascii_character"
        return "allowlisted", applied, [], reason
    return "english", applied, [], "no_language_signal"


# ---------------------------------------------------------------- runtime checks


def _run(command: list[str], cwd: Path) -> subprocess.CompletedProcess:
    environment = dict(os.environ)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        command,
        cwd=str(cwd),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=120,
        env=environment,
    )


def _language_is_clean(text: str, allowlist: Allowlist) -> bool:
    masked = mask_machine_literals(PLACEHOLDER_RE.sub(" ", text), allowlist)
    return not detect_signals(masked, allowlist, check_unclassified=False)


def _runtime_check(
    allowlist: Allowlist,
    surface: str,
    arguments: list[str],
    script: Path,
    expected_exit: int,
) -> dict:
    record: dict = {"surface": surface, "arguments": list(arguments)}
    if not script.exists() or not os.access(script, os.X_OK):
        record["status"] = "skipped"
        record["detail"] = "the entry point is not executable"
        return record
    with tempfile.TemporaryDirectory(prefix="worktree-language-runtime-") as directory:
        try:
            completed = _run([str(script), *arguments], Path(directory))
        except (OSError, subprocess.SubprocessError) as exc:
            record["status"] = "skipped"
            record["detail"] = f"the entry point could not be executed: {exc}"
            return record
    record["exit_code"] = completed.returncode
    if completed.returncode == 127 and "requires Python 3" in completed.stderr:
        record["status"] = "skipped"
        record["detail"] = "Python 3 is unavailable"
        return record
    if completed.returncode != expected_exit:
        record["status"] = "failed"
        record["detail"] = f"the expected exit code is {expected_exit}"
        return record
    if not _language_is_clean(completed.stdout, allowlist):
        record["status"] = "failed"
        record["detail"] = "the published text is not English"
        return record
    if completed.stderr.strip() and not _language_is_clean(completed.stderr, allowlist):
        record["status"] = "failed"
        record["detail"] = "the published diagnostic is not English"
        return record
    record["status"] = "english"
    return record


def _usage_error_check(allowlist: Allowlist, script: Path) -> dict:
    record: dict = {"surface": "consumer-entrypoint", "arguments": ["--json", "--wat"]}
    if not script.exists() or not os.access(script, os.X_OK):
        record["status"] = "skipped"
        record["detail"] = "the entry point is not executable"
        return record
    with tempfile.TemporaryDirectory(prefix="worktree-language-runtime-") as directory:
        try:
            completed = _run([str(script), "--json", "--wat"], Path(directory))
        except (OSError, subprocess.SubprocessError) as exc:
            record["status"] = "skipped"
            record["detail"] = f"the entry point could not be executed: {exc}"
            return record
    record["exit_code"] = completed.returncode
    if completed.returncode == 127 and "requires Python 3" in completed.stderr:
        record["status"] = "skipped"
        record["detail"] = "Python 3 is unavailable"
        return record
    if completed.returncode != 2:
        record["status"] = "failed"
        record["detail"] = "the expected exit code is 2"
        return record
    if completed.stderr.strip():
        record["status"] = "failed"
        record["detail"] = "the usage error must not write to stderr"
        return record
    try:
        document = json.loads(completed.stdout)
    except ValueError:
        record["status"] = "failed"
        record["detail"] = "the usage error must publish one JSON document"
        return record
    expected_keys = {
        "contract_version",
        "tool_version",
        "operation",
        "result",
        "data",
        "warnings",
        "error",
    }
    if set(document) != expected_keys:
        record["status"] = "failed"
        record["detail"] = "the usage error changed the published envelope"
        return record
    error = document.get("error") or {}
    if error.get("code") != "usage_error" or error.get("exit_code") != 2:
        record["status"] = "failed"
        record["detail"] = "the usage error changed its public code"
        return record
    if not _language_is_clean(str(error.get("message", "")), allowlist):
        record["status"] = "failed"
        record["detail"] = "the usage error message is not English"
        return record
    record["status"] = "english"
    return record


def _mcp_check(manager: Path) -> dict:
    package = manager / "worktree_manager"
    contract = package / "mcp_contract.py"
    record: dict = {"surface": "python-package"}
    if not contract.is_file():
        record["status"] = "failed"
        record["detail"] = "the MCP contract module is missing"
        return record
    code = (
        "import json,sys;"
        "sys.path.insert(0, sys.argv[1]);"
        "from worktree_manager.mcp_contract import TOOL_NAMES;"
        "print(json.dumps(list(TOOL_NAMES)))"
    )
    try:
        completed = _run([sys.executable, "-B", "-c", code, str(manager)], manager)
    except (OSError, subprocess.SubprocessError) as exc:
        record["status"] = "failed"
        record["detail"] = f"the MCP contract module could not be imported: {exc}"
        return record
    if completed.returncode != 0:
        record["status"] = "failed"
        record["detail"] = "the MCP contract module could not be imported"
        return record
    try:
        tools = json.loads(completed.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        record["status"] = "failed"
        record["detail"] = "the MCP contract module did not publish its tools"
        return record
    if not isinstance(tools, list) or len(tools) != 7:
        published = len(tools) if isinstance(tools, list) else 0
        record["status"] = "failed"
        record["detail"] = f"the MCP contract publishes {published} tools instead of 7"
        return record
    sources = sorted(item.name for item in package.glob("mcp_*.py"))
    record["status"] = "implemented"
    record["tools"] = len(tools)
    record["sources"] = [f"worktree_manager/{name}" for name in sources]
    return record


# ------------------------------------------------------------------------- gate


def discover_surfaces(root: Path, manager: Path) -> dict[str, list[tuple[Path, str]]]:
    """The files of every surface with the path used to display them."""
    package = manager / "worktree_manager"
    scripts = root / ".flowtask" / "scripts"

    def existing(path: Path, display: str) -> list[tuple[Path, str]]:
        return [(path, display)] if path.is_file() else []

    return {
        "python-package": [
            (item, f"worktree_manager/{item.name}") for item in sorted(package.glob("*.py"))
        ],
        "standalone-entrypoint": existing(manager / "worktree.sh", "worktree.sh"),
        "consumer-entrypoint": existing(scripts / "worktree.sh", "worktree.sh"),
        "consumer-adapter": existing(scripts / "worktree-adapter.sh", "worktree-adapter.sh"),
    }


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return "unknown"


def build_inventory(
    root: Path,
    manager: Path,
    allowlist: Allowlist,
    base: str,
    runtime: dict,
) -> tuple[dict, list[dict]]:
    """Collect every entry, classify it and assemble the inventory."""
    surfaces = discover_surfaces(root, manager)
    entries: list[dict] = []
    violations: list[dict] = []
    for surface in SURFACES:
        files = surfaces.get(surface, [])
        if not files:
            violations.append(
                GateError("missing_surface", f"the surface {surface} has no file").as_dict()
            )
            continue
        for path, display in files:
            if surface == "python-package":
                collected = extract_python(path, display, surface)
            else:
                collected = extract_shell(path, display, surface)
            for entry in collected:
                if is_machine_value(entry["text"]):
                    continue
                entries.append(entry)
    entries.sort(
        key=lambda item: (SURFACES.index(item["surface"]), item["path"], item["line"], item["text"])
    )
    for number, entry in enumerate(entries, start=1):
        entry["id"] = f"E-{number:04d}"
        try:
            status, applied, signals, reason = evaluate_entry(entry, allowlist)
        except GateError as exc:
            violations.append(exc.as_dict())
            status, applied, signals, reason = "pending", [], [exc.code], exc.code
        entry["status"] = status
        entry["allowlist_ids"] = applied
        entry["reason"] = reason
        if status == "pending":
            violations.append(
                GateError(
                    signals[0] if signals else "spanish_signal",
                    "the text is not English and is not explicitly allowed",
                    entry["path"],
                    entry["line"],
                ).as_dict()
            )
    used_exceptions = {
        exception_id for entry in entries for exception_id in entry.get("allowlist_ids", [])
    }
    for exception in allowlist.exceptions:
        if exception["id"] not in used_exceptions:
            violations.append(
                GateError(
                    "stale_allowlist_entry",
                    f"the exception {exception['id']} does not match any entry of its scope",
                ).as_dict()
            )
    counted: dict[tuple[str, str], int] = {}
    for entry in entries:
        key = (entry["surface"], entry["path"])
        counted[key] = counted.get(key, 0) + 1
    files: list[dict] = []
    without_text: list[str] = []
    for surface in SURFACES:
        for path, display in surfaces.get(surface, []):
            count = counted.get((surface, display), 0)
            if count:
                files.append({"path": display, "surface": surface, "entries_count": count})
            else:
                files.append({"path": display, "surface": surface, "no_human_text": True})
                without_text.append(display)
    summary = {
        "files": len(files),
        "python_files": len(surfaces.get("python-package", [])),
        "shell_files": sum(
            len(surfaces.get(surface, [])) for surface in SURFACES if surface != "python-package"
        ),
        "entries": len(entries),
        "english": sum(1 for entry in entries if entry["status"] == "english"),
        "allowlisted": sum(1 for entry in entries if entry["status"] == "allowlisted"),
        "pending": sum(1 for entry in entries if entry["status"] == "pending"),
        "mcp_sources": len(runtime.get("mcp_tools", {}).get("sources", [])),
        "mcp_tools": runtime.get("mcp_tools", {}).get("tools", 0),
        "unresolved_markers": sum(
            1 for entry in entries if "unresolved_marker" in entry.get("reason", "")
        ),
    }
    inventory = {
        "schema": SCHEMA_INVENTORY,
        "root": ".",
        "manager": _relative(manager, root),
        "base": base or "unknown",
        "surfaces": list(SURFACES),
        "files": files,
        "entries": [
            {
                "id": entry["id"],
                "surface": entry["surface"],
                "path": entry["path"],
                "line": entry["line"],
                "kind": entry["kind"],
                "type": entry["type"],
                "text": entry["text"],
                "status": entry["status"],
                "allowlist_ids": entry["allowlist_ids"],
                "reason": entry["reason"],
            }
            for entry in entries
        ],
        "files_without_human_text": without_text,
        "runtime_checks": runtime,
        "summary": summary,
    }
    return inventory, violations


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="worktree-language-gate.py",
        description="Inventory the human-readable texts and fail on untranslated ones.",
        add_help=True,
    )
    parser.add_argument("--root", default=".", help="the repository root that holds the consumer scripts")
    parser.add_argument("--manager", default=None, help="the materialized manager package")
    parser.add_argument("--allowlist", default=None, help="the allowlist document")
    parser.add_argument("--inventory", default=None, help="where the inventory is written")
    parser.add_argument("--base", default="", help="the base revision the inventory describes")
    parser.add_argument("--check", action="store_true", help="fail when the inventory is not clean")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        arguments = _parse_arguments(argv)
    except SystemExit as exc:
        return 2 if exc.code not in (0, None) else 0
    root = Path(arguments.root).expanduser().resolve()
    manager = (
        Path(arguments.manager).expanduser().resolve()
        if arguments.manager
        else (root / ".flowtask" / "scripts" / "worktree-manager")
    )
    allowlist_path = (
        Path(arguments.allowlist).expanduser().resolve()
        if arguments.allowlist
        else (root / ".flowtask" / "bin" / "lib" / "worktree-language-allowlist.json")
    )
    inventory_path = (
        Path(arguments.inventory).expanduser().resolve()
        if arguments.inventory
        else (root / ".temp" / "worktree-language-inventory.json")
    )
    if not root.is_dir():
        print(f"the root directory does not exist: {arguments.root}", file=sys.stderr)
        return 2
    violations: list[dict] = []
    try:
        allowlist = Allowlist(load_allowlist(allowlist_path))
    except GateError as exc:
        violations.append(exc.as_dict())
        allowlist = Allowlist(
            {
                "schema": SCHEMA_ALLOWLIST,
                "policy": "literal-level",
                "categories": {},
                "exceptions": [],
            }
        )
    runtime: dict = {}
    if violations:
        runtime = {
            name: {"status": "skipped", "detail": "the allowlist is invalid"}
            for name in (
                "standalone_help",
                "standalone_version",
                "consumer_help",
                "usage_error",
                "mcp_tools",
            )
        }
    else:
        runtime["standalone_help"] = _runtime_check(
            allowlist, "standalone-entrypoint", ["--help"], manager / "worktree.sh", 0
        )
        runtime["standalone_version"] = _runtime_check(
            allowlist, "standalone-entrypoint", ["--version"], manager / "worktree.sh", 0
        )
        consumer_help = _runtime_check(
            allowlist,
            "consumer-entrypoint",
            ["--help"],
            root / ".flowtask" / "scripts" / "worktree.sh",
            0,
        )
        target_help = _runtime_check(
            allowlist,
            "consumer-entrypoint",
            ["target-direct", "--help"],
            root / ".flowtask" / "scripts" / "worktree.sh",
            0,
        )
        if consumer_help.get("status") == "failed" or target_help.get("status") == "failed":
            runtime["consumer_help"] = consumer_help
            runtime["consumer_help_target"] = target_help
        elif consumer_help.get("status") == "english" and target_help.get("status") == "english":
            runtime["consumer_help"] = consumer_help
            runtime["consumer_help_target"] = target_help
        else:
            runtime["consumer_help"] = {
                "surface": "consumer-entrypoint",
                "arguments": ["--help", "target-direct", "--help"],
                "status": "skipped",
                "detail": "the consumer entry point could not be inspected",
            }
            runtime["consumer_help_target"] = target_help
        runtime["usage_error"] = _usage_error_check(
            allowlist, root / ".flowtask" / "scripts" / "worktree.sh"
        )
        runtime["mcp_tools"] = _mcp_check(manager)
    for name, record in runtime.items():
        if record.get("status") == "failed":
            code = "mcp_integration_unverified" if name == "mcp_tools" else "invalid_allowlist"
            violations.append(
                GateError(code, f"the runtime check {name} failed: {record.get('detail', '')}").as_dict()
            )
    inventory, discovered = build_inventory(root, manager, allowlist, arguments.base, runtime)
    violations.extend(discovered)
    inventory_path.parent.mkdir(parents=True, exist_ok=True)
    inventory_path.write_text(
        json.dumps(inventory, ensure_ascii=False, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    summary = inventory["summary"]
    print(
        "surfaces={surfaces} files={files} python_files={python_files} shell_files={shell_files} "
        "entries={entries} english={english} allowlisted={allowlisted} pending={pending} "
        "mcp_sources={mcp_sources} mcp_tools={mcp_tools} unresolved_markers={unresolved_markers}".format(
            surfaces=len(inventory["surfaces"]), **summary
        )
    )
    if violations:
        for violation in violations:
            location = violation["path"]
            if violation.get("line"):
                location = f"{location}:{violation['line']}"
            print(
                f"{violation['code']}: {violation['detail']}"
                + (f" ({location})" if location else ""),
                file=sys.stderr,
            )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
