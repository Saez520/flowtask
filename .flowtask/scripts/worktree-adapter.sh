#!/usr/bin/env bash

set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="$SCRIPT_DIR/worktree-manager/worktree.sh"
if [[ ! -x "$MANAGER" ]]; then
  printf '%s\n' "Worktree Manager standalone ausente o no inicializado: $MANAGER" >&2
  exit 1
fi

# Legacy records are imported only for an explicit recovery request. The
# standalone manager never probes FlowTask paths or legacy ref namespaces.
args=("$@")
adapter_config=""
if [[ -n "${args[0]:-}" && -n "$PWD" && -f "$PWD/.flowtask/config/worktree.json" ]] && command -v node >/dev/null 2>&1; then
  consent="$(node -e 'try { const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(c.preserveDirty === true ? "true" : "false"); } catch { process.exit(1); }' "$PWD/.flowtask/config/worktree.json" 2>/dev/null || true)"
  if [[ "$consent" == true ]]; then
    adapter_config="$(mktemp "${TMPDIR:-/tmp}/worktree-adapter.XXXXXX")"
    printf 'preserve_dirty=true\n' > "$adapter_config"
    trap 'rm -f -- "$adapter_config"' EXIT
    args=(--config "$adapter_config" "${args[@]}")
  fi
fi
[[ -z "${FLOWTASK_TEST_MODE:-}" ]] || export WORKTREE_MANAGER_TEST_MODE="$FLOWTASK_TEST_MODE"
[[ -z "${FLOWTASK_TEST_CRASH_AFTER:-}" ]] || export WORKTREE_MANAGER_TEST_CRASH_AFTER="$FLOWTASK_TEST_CRASH_AFTER"
[[ -z "${FLOWTASK_TEST_CLOSE_CRASH_AFTER:-}" ]] || export WORKTREE_MANAGER_TEST_CLOSE_CRASH_AFTER="$FLOWTASK_TEST_CLOSE_CRASH_AFTER"
[[ -z "${FLOWTASK_TEST_TARGET_CRASH_AFTER:-}" ]] || export WORKTREE_MANAGER_TEST_TARGET_CRASH_AFTER="$FLOWTASK_TEST_TARGET_CRASH_AFTER"
[[ -z "${FLOWTASK_TEST_COUNTER_FILE:-}" ]] || export WORKTREE_MANAGER_TEST_COUNTER_FILE="$FLOWTASK_TEST_COUNTER_FILE"
[[ -z "${FLOWTASK_TEST_LOCK_BARRIER_DIR:-}" ]] || export WORKTREE_MANAGER_TEST_LOCK_BARRIER_DIR="$FLOWTASK_TEST_LOCK_BARRIER_DIR"
[[ -z "${FLOWTASK_TEST_HOLD_AFTER_LOCK:-}" ]] || export WORKTREE_MANAGER_TEST_HOLD_AFTER_LOCK="$FLOWTASK_TEST_HOLD_AFTER_LOCK"
repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ "${args[0]:-}" == --repo && ${#args[@]} -ge 2 ]]; then
  repo="$(git -C "${args[1]}" rev-parse --show-toplevel 2>/dev/null || true)"
fi
command_index=0
while [[ $command_index -lt ${#args[@]} && "${args[$command_index]}" == --* ]]; do
  case "${args[$command_index]}" in
    --repo|--parent-repo|--config) command_index=$((command_index + 2));;
    *) break;;
  esac
done
if [[ "${args[$command_index]:-}" == recover && -n "$repo" ]]; then
  tx="${args[$((command_index + 1))]:-}"
  if [[ "$tx" == td-* ]]; then args[$((command_index + 1))]="wt-${tx#td-}"; tx="wt-${tx#td-}"; fi
  if [[ -n "$tx" && "$tx" != */* && "$tx" != .* && "$tx" != -* ]]; then
    legacy="$repo/.flowtask/backups/$tx"
    common="$(git -C "$repo" rev-parse --git-common-dir)"
    [[ "$common" = /* ]] || common="$repo/$common"
    common="$(cd -- "$common" && pwd -P)"
      state_dir="$(sed -n 's/^state_dir=//p' "$repo/.worktree-manager.conf" 2>/dev/null | head -n 1 || true)"
    [[ -n "$state_dir" && "$state_dir" != /* && "$state_dir" != *..* ]] || state_dir=worktree-manager
    target="$common/$state_dir/transactions/$tx"
    if [[ -d "$legacy" && ! -e "$target" ]]; then
      work_id="$(sed -n 's/^work_id: //p' "$legacy/meta" | head -n 1)"
      [[ -n "$work_id" ]] || work_id="$(sed -n 's/^ca_name: //p' "$legacy/meta" | head -n 1)"
      [[ -n "$work_id" && "$work_id" != *$'\n'* ]] || { printf '%s\n' "Registro legacy inválido; se conserva intacto." >&2; exit 4; }
      mkdir -p -- "$(dirname -- "$target")"
      cp -R -- "$legacy" "$target"
      if ! grep -q '^work_id: ' "$target/meta"; then
        printf 'work_id: %s\n' "$work_id" >> "$target/meta"
      fi
      backup_ref_prefix="$(sed -n 's/^backup_ref_prefix=//p' "$repo/.worktree-manager.conf" 2>/dev/null | head -n 1 || true)"
      [[ -n "$backup_ref_prefix" && "$backup_ref_prefix" != *..* ]] || backup_ref_prefix=worktree-manager/backups
      for suffix in '' '-untracked'; do
        old="refs/flowtask/backups/$tx$suffix"
        new="refs/$backup_ref_prefix/$tx$suffix"
        sha="$(git -C "$repo" rev-parse --verify --quiet "$old" || true)"
        [[ -z "$sha" ]] || git -C "$repo" update-ref "$new" "$sha"
      done
      "$MANAGER" "${args[@]}" || exit $?
      if [[ -d "$target" ]]; then cp -R -- "$target/" "$legacy/"; fi
      exit 0
    fi
  fi
fi
set +e
"$MANAGER" "${args[@]}"
status=$?
set -e
if [[ -n "$repo" ]]; then
  common="$(git -C "$repo" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ "$common" = /* ]] || common="$repo/$common"
  state_dir="$(sed -n 's/^state_dir=//p' "$repo/.worktree-manager.conf" 2>/dev/null | head -n 1 || true)"
  [[ -n "$state_dir" && "$state_dir" != /* && "$state_dir" != *..* ]] || state_dir=worktree-manager
  backup_ref_prefix="$(sed -n 's/^backup_ref_prefix=//p' "$repo/.worktree-manager.conf" 2>/dev/null | head -n 1 || true)"
  [[ -n "$backup_ref_prefix" && "$backup_ref_prefix" != *..* ]] || backup_ref_prefix=worktree-manager/backups
  if [[ -n "$common" && -d "$common/$state_dir/transactions" ]]; then
    mkdir -p -- "$repo/.flowtask/backups"
    for tx_dir in "$common/$state_dir/transactions"/*; do
      [[ -d "$tx_dir" ]] || continue
      legacy_dir="$repo/.flowtask/backups/$(basename "$tx_dir")"
      mkdir -p -- "$legacy_dir"
      cp -R -- "$tx_dir/" "$legacy_dir/"
    done
    while IFS= read -r ref; do
      [[ "$ref" == "refs/$backup_ref_prefix/"* ]] || continue
      suffix="${ref#refs/$backup_ref_prefix/}"
      sha="$(git -C "$repo" rev-parse --verify "$ref")"
      git -C "$repo" update-ref "refs/flowtask/backups/$suffix" "$sha"
    done < <(git -C "$repo" for-each-ref --format='%(refname)' refs/worktree-manager/backups)
  fi
fi
exit "$status"
