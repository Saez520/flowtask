#!/usr/bin/env bash
# Aggregate gate of the worktree manager language phase.
#
# The gate runs the language inventory, the language gate tests, the consumer
# suites, the standalone suites and the scope and protection guards in a fixed
# order. It fails closed: any failing section stops the gate and names the
# section that failed. It never publishes, merges, tags, cleans up or writes
# outside the temporary directories it creates.
#
# Environment overrides:
#   WORKTREE_MANAGER_SUBMODULE  path of the materialized manager package
#   WORKTREE_PHASE11_BASE       base revision used by the scope guard
#   WORKTREE_LANGUAGE_INVENTORY where the inventory is written
#   WORKTREE_PHASE11_SCOPE_ONLY run only the scope and protection guards

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
MANAGER="${WORKTREE_MANAGER_SUBMODULE:-$ROOT/.flowtask/scripts/worktree-manager}"
BASE="${WORKTREE_PHASE11_BASE:-166fc9961576fd313681d683d33dde92fb4c5f65}"
INVENTORY="${WORKTREE_LANGUAGE_INVENTORY:-$ROOT/.temp/worktree-language-inventory.json}"
SUBMODULE_HEAD="a4b4782236407d4c6067344218f7b3e43c9b4ecf"

export PYTHONDONTWRITEBYTECODE=1

ALLOWED_PATHS=(
  ".flowtask/bin/lib/worktree-language-allowlist.json"
  ".flowtask/bin/lib/worktree-language-gate.py"
  ".flowtask/scripts/worktree.sh"
  ".flowtask/scripts/worktree-adapter.sh"
  ".flowtask/bin/test/worktree-language-gate.test.js"
  ".flowtask/bin/test/worktree-phase11-gate.sh"
)

SCOPE_TEMPORARY=""

# Failures that the base already carries. They are inherited, not introduced by
# this phase, and they are listed here so the gate stays explicit about them:
# the suite still runs and any other failure still stops the gate.
INHERITED_FAILURES=(
  "phase 9 evidence|the previous phases are unchanged"
)

section() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

run_section() {
  local name="$1"
  shift
  section "$name"
  if ! "$@"; then
    printf 'phase 11 gate failed in section: %s\n' "$name" >&2
    exit 1
  fi
}

scope_guard() {
  section "scope"
  local changed untracked unexpected protected gitlink
  SCOPE_TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/worktree-phase11-scope.XXXXXX")"
  trap '[[ -n "${SCOPE_TEMPORARY:-}" ]] && rm -rf -- "$SCOPE_TEMPORARY"' EXIT
  local allowed="$SCOPE_TEMPORARY/allowed.txt"
  printf '%s\n' "${ALLOWED_PATHS[@]}" > "$allowed"

  if ! git -C "$ROOT" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
    fail "scope: the base revision is not available in this repository"
  fi
  changed="$(git -C "$ROOT" diff --name-only "$BASE" || true)"
  untracked="$(git -C "$ROOT" ls-files --others --exclude-standard || true)"
  unexpected="$(printf '%s\n%s\n' "$changed" "$untracked" | grep -v '^$' | grep -v -x -F -f "$allowed" || true)"
  if [[ -n "$unexpected" ]]; then
    printf 'scope: the following paths are not allowed in this phase:\n%s\n' "$unexpected" >&2
    exit 1
  fi

  local protected
  protected="$(git -C "$ROOT" diff --name-only "$BASE" -- docs/ .gitmodules .flowtask/package.json || true)"
  if [[ -n "$protected" ]]; then
    printf 'scope: protected paths changed:\n%s\n' "$protected" >&2
    exit 1
  fi

  local gitlink
  gitlink="$(git -C "$ROOT" ls-tree HEAD -- .flowtask/scripts/worktree-manager | awk '{print $3}')"
  if [[ "$gitlink" != "$SUBMODULE_HEAD" ]]; then
    printf 'scope: submodule_gitlink_mismatch: %s\n' "$gitlink" >&2
    exit 1
  fi
  if [[ -d "$MANAGER/.git" || -f "$MANAGER/.git" ]]; then
    local head tracked
    head="$(git -C "$MANAGER" rev-parse HEAD)"
    if [[ "$head" != "$SUBMODULE_HEAD" ]]; then
      printf 'scope: submodule_head_mismatch: %s\n' "$head" >&2
      exit 1
    fi
    tracked="$(git -C "$MANAGER" status --porcelain --untracked-files=no || true)"
    if [[ -n "$tracked" ]]; then
      printf 'scope: the manager package has tracked changes:\n%s\n' "$tracked" >&2
      exit 1
    fi
  fi
  for retired in "worktree-manager-core.sh" "worktree-manager-target-direct.sh"; do
    if [[ -e "$MANAGER/lib/$retired" ]]; then
      printf 'scope: retired_engine_present: %s\n' "$MANAGER/lib/$retired" >&2
      exit 1
    fi
  done
  printf 'scope: the phase touches only the allowed paths\n'
}

if [[ "${1:-}" == "--scope-only" ]]; then
  scope_guard
  printf 'phase 11 scope guard passed\n'
  exit 0
fi

run_section "language inventory" python3 -B "$ROOT/.flowtask/bin/lib/worktree-language-gate.py" \
  --root "$ROOT" \
  --manager "$MANAGER" \
  --allowlist "$ROOT/.flowtask/bin/lib/worktree-language-allowlist.json" \
  --inventory "$INVENTORY" \
  --base "$BASE" \
  --check

run_section "language gate tests" node --test "$ROOT/.flowtask/bin/test/worktree-language-gate.test.js"
run_section "adapter compatibility" node --test "$ROOT/.flowtask/bin/test/worktree-adapter-compat.test.js"
run_section "consumer adapter" node --test "$ROOT/.flowtask/bin/lib/worktree-consumer-adapter.test.js"
run_section "consumer matrix" node --test "$ROOT/.flowtask/bin/test/worktree-consumer-matrix.test.js"
run_section "hotfix regression" node --test "$ROOT/.flowtask/bin/test/worktree-hotfix.test.js"

phase9_evidence_section() {
  section "phase 9 evidence"
  local output status=0
  output="$(node --test "$ROOT/.flowtask/bin/test/worktree-phase9-evidence.test.js" 2>&1)" || status=$?
  printf '%s\n' "$output"
  if [[ $status -eq 0 ]]; then
    printf 'phase 9 evidence: the suite passes; the inherited failure registration is obsolete\n'
    return 0
  fi
  local failing registered unexpected
  failing="$(printf '%s\n' "$output" | grep -E '^✖ ' | sed -e 's/^✖ failing tests:$//' -e 's/^✖ //' -e 's/ ([0-9.]*ms)$//' | grep -v '^$' | sort -u || true)"
  registered="$(printf '%s\n' "${INHERITED_FAILURES[@]}" | sed -n 's/^phase 9 evidence|//p' | sort -u)"
  unexpected="$(printf '%s\n' "$failing" | grep -v -x -F -e "$registered" || true)"
  if [[ -n "$unexpected" ]]; then
    printf 'phase 9 evidence: unexpected failures:\n%s\n' "$unexpected" >&2
    exit 1
  fi
  if [[ "$failing" != "$registered" ]]; then
    printf 'phase 9 evidence: the inherited failure is no longer the only failure:\n%s\n' "$failing" >&2
    exit 1
  fi
  printf 'phase 9 evidence: the only failure is the one inherited from the base\n'
}

phase9_evidence_section

run_section "standalone unittest" env PYTHONPATH="$MANAGER" bash -c \
  'cd "$1" && python3 -B -m unittest discover -s tests -p "test_*.py"' _ "$MANAGER"

run_section "cli usage" bash "$MANAGER/tests/cli-usage.sh"
run_section "cli json" bash "$MANAGER/tests/cli-json.sh"
run_section "compatibility" sh "$MANAGER/tests/compatibility.sh"
run_section "smoke" bash "$MANAGER/tests/smoke.sh"
run_section "parity" bash "$MANAGER/tests/parity.sh"

scope_guard

printf '\nphase 11 gate passed\n'
