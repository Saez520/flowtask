#!/usr/bin/env bash
# CA2 only: explicit submodule target lifecycle.  This file deliberately does
# not call the parent-only cleanup/complete implementation.

target_direct_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

target_direct_ensure_git() {
  command -v git >/dev/null 2>&1 || { printf '%s\n' "Git 2.54.0 es obligatorio" >&2; return 7; }
  local version_output; version_output="$(git --version 2>/dev/null || true)"
  [[ "$version_output" == "git version 2.54.0" ]] || { printf '%s\n' "Se requiere exactamente Git 2.54.0 (se obtuvo: ${version_output:-ausente})" >&2; return 7; }
}

target_direct_encode() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

target_direct_abs() {
  local p="$1"
  [[ "$p" = /* && -d "$p" ]] || return 1
  (cd -- "$p" && pwd -P)
}

target_direct_git_common() {
  local root="$1" value
  value="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [[ "$value" = /* ]] || value="$root/$value"
  (cd -- "$value" && pwd -P)
}

target_direct_valid_rel() {
  [[ -n "$1" && "$1" != /* && "$1" != . && "$1" != .. && "$1" != ../* && "$1" != */../* && "$1" != *$'\n'* && "$1" != *$'\t'* ]]
}

target_direct_lock_release() {
  local i
  for ((i=${#TD_LOCKS[@]}-1; i>=0; i--)); do rm -rf -- "${TD_LOCKS[i]}"; done
  TD_LOCKS=()
}

target_direct_lock_one() {
  local path="$1" operation="$2" now pid
  mkdir -p -- "$(dirname -- "$path")"
  if [[ -d "$path" ]]; then
    pid="$(cat "$path/owner_pid" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      return 5
    fi
    rm -rf -- "$path"
  fi
  mkdir -- "$path" 2>/dev/null || return 5
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "$$" > "$path/owner_pid"
  printf '%s\n' "$operation" > "$path/operation"
  printf '%s\n' "$now" > "$path/created_at"
  printf '%s\n' "${TD_TX:-td-unknown}" > "$path/tx_id"
  TD_LOCKS+=("$path")
}

target_direct_acquire_locks() {
  local target_common="$1" parent_common="$2" operation="$3" state_root="$4"
  TD_LOCKS=()
  # The ownership order is part of the CA2 contract: target then parent.
  target_direct_lock_one "$state_root/locks/target-$(target_direct_encode "$target_common")" "$operation" || return $?
  if [[ -n "$parent_common" ]]; then
    target_direct_lock_one "$state_root/locks/parent-$(target_direct_encode "$parent_common")" "$operation" || { target_direct_lock_release; return 5; }
  fi
}

target_direct_write_descriptor() {
  local phase="$1" file="$TD_DIR/descriptor.tmp"; shift || true
  {
    printf 'descriptor_version=1\noperation=%s\ntarget_kind=submodule\ntarget_repo=%s\ntarget_common_dir=%s\nparent_repo=%s\nparent_common_dir=%s\nsubmodule_path=%s\ngitlink_sha=%s\ntarget_head=%s\nbase=%s\nbase_sha=%s\nbranch=%s\nworktree_path=%s\nlink_parent=staged-only\nnamespace=CA-worktree-submodule-target-direct\nowner=%s\nphase=%s\ntx_id=%s\nindex_snapshot_ref=%s\n' \
      "$TD_OPERATION" "$TD_TARGET" "$TD_TARGET_COMMON" "$TD_PARENT" "$TD_PARENT_COMMON" "$TD_SUBPATH" "$TD_GITLINK" "$TD_HEAD" "$TD_BASE" "$TD_BASE_SHA" "$TD_BRANCH" "$TD_WORKTREE" "$$" "$phase" "$TD_TX" "$TD_DIR/snapshot"
  } > "$file"
  mv -f -- "$file" "$TD_DIR/descriptor"
}

# Executable Runner -> Constructor boundary. The record is the only payload;
# the Node transport validates, serializes and rehydrates it before returning
# it to this shell Constructor. Never pass the in-memory shell state instead.
target_direct_transport_constructor() {
  local file="$1" tmp
  tmp="${file}.transport.tmp"
  node "$TD_TRANSPORT_MODULE" "$file" > "$tmp" || { rm -f -- "$tmp"; return 4; }
  mv -f -- "$tmp" "$file"
}

target_direct_write_meta() {
  local phase="$1" now tmp="$TD_DIR/meta.tmp"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ -f "$TD_DIR/created_at" ]] || printf '%s\n' "$now" > "$TD_DIR/created_at"
  {
    printf 'meta_version=1\noperation_id=%s\ntx_id=%s\ncreated_at=%s\nupdated_at=%s\nowner=%s\nexpected_effect=%s\nobserved_effect=%s\nabort_status=%s\nindex_snapshot_ref=%s\nphase=%s\n' \
      "$TD_OPERATION_ID" "$TD_TX" "$(cat "$TD_DIR/created_at")" "$now" "$$" "${TD_EXPECTED_EFFECT:-none}" "${TD_OBSERVED_EFFECT:-none}" "${TD_ABORT_STATUS:-active}" "$TD_DIR/snapshot" "$phase"
  } > "$tmp"
  mv -f -- "$tmp" "$TD_DIR/meta"
}

target_direct_journal() {
  local before="$TD_PHASE" after="$1" exit_code="${2:-0}" now tmp="$TD_DIR/journal.tmp"; TD_PHASE="$after"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  target_direct_write_descriptor "$after"; target_direct_write_meta "$after"
  {
    printf 'journal_version=1\nargv=%s\nphase_before=%s\nphase_after=%s\nexpected_effect=%s\nobserved_effect=%s\nexit=%s\ntimestamp=%s\npre_state=%s\npost_state=%s\n' \
      "$TD_ARGV" "$before" "$after" "${TD_EXPECTED_EFFECT:-none}" "${TD_OBSERVED_EFFECT:-none}" "$exit_code" "$now" "${TD_PRE_STATE:-unknown}" "${TD_POST_STATE:-unknown}"
  } > "$tmp"
  mv -f -- "$tmp" "$TD_DIR/journal"
  if [[ "${FLOWTASK_TEST_MODE:-0}" == 1 && "${FLOWTASK_TEST_TARGET_CRASH_AFTER:-}" == "$after" ]]; then exit 99; fi
}

target_direct_snapshot() {
  local s="$TD_DIR/snapshot" index
  mkdir -p -- "$s"
  index="$(git -C "$TD_PARENT" rev-parse --git-path index)"; [[ "$index" = /* ]] || index="$TD_PARENT/$index"
  git -C "$TD_PARENT" rev-parse HEAD > "$s/head.sha"
  git -C "$TD_PARENT" diff --cached --binary > "$s/diff.cached"
  git -C "$TD_PARENT" ls-files --stage -- "$TD_SUBPATH" > "$s/cached.entry"
  cp -- "$index" "$s/index.bytes"
  target_direct_sha256 "$s/index.bytes" > "$s/index.sha256"
  target_direct_sha256 "$s/diff.cached" > "$s/diff.sha256"
  target_direct_sha256 "$s/cached.entry" > "$s/entry.sha256"
  (stat -f '%z:%m:%i' "$index" 2>/dev/null || stat -c '%s:%Y:%i' "$index" 2>/dev/null || true) > "$s/index.stat"
  {
    printf 'snapshot_version=1\nparent_repo=%s\nparent_common_dir=%s\nsubmodule_path=%s\nhead_sha=%s\nindex_sha256=%s\nindex_bytes_ref=%s\ncached_entry_ref=%s\ncached_entry_sha256=%s\nindex_stat_signature=%s\ncaptured_at=%s\n' \
      "$TD_PARENT" "$TD_PARENT_COMMON" "$TD_SUBPATH" "$(cat "$s/head.sha")" "$(cat "$s/index.sha256")" "$s/index.bytes" "$s/cached.entry" "$(cat "$s/entry.sha256")" "$(cat "$s/index.stat" 2>/dev/null || true)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$s/record"
}

target_direct_hash_file() { target_direct_sha256 "$1"; }

target_direct_classify() {
  local s="$TD_DIR/snapshot" index nowdiff nowentry nowhead nowindex
  [[ -d "$s" && -f "$s/record" ]] || { printf C; return; }
  index="$(git -C "$TD_PARENT" rev-parse --git-path index)"; [[ "$index" = /* ]] || index="$TD_PARENT/$index"
  nowhead="$(git -C "$TD_PARENT" rev-parse HEAD 2>/dev/null || true)"
  nowindex="$(target_direct_hash_file "$index" 2>/dev/null || true)"
  nowdiff="$(mktemp "${TMPDIR:-/tmp}/td-diff.XXXXXX")"; git -C "$TD_PARENT" diff --cached --binary > "$nowdiff"
  nowentry="$(mktemp "${TMPDIR:-/tmp}/td-entry.XXXXXX")"; git -C "$TD_PARENT" ls-files --stage -- "$TD_SUBPATH" > "$nowentry"
  if [[ "$nowhead" == "$(cat "$s/head.sha")" && "$nowindex" == "$(cat "$s/index.sha256")" && "$(target_direct_hash_file "$nowdiff")" == "$(cat "$s/diff.sha256")" && "$(target_direct_hash_file "$nowentry")" == "$(cat "$s/entry.sha256")" ]]; then printf A;
  elif [[ "$nowhead" == "$(cat "$s/head.sha")" && "$(cat "$nowentry")" == "160000 $TD_HEAD"$' 0\t'"$TD_SUBPATH" && "$(git -C "$TD_PARENT" diff --cached --name-only)" == "$TD_SUBPATH" ]]; then printf B;
  else printf C; fi
  rm -f -- "$nowdiff" "$nowentry"
}

target_direct_restore_index() {
  local index tmp="$TD_DIR/index.restore.tmp"
  index="$(git -C "$TD_PARENT" rev-parse --git-path index)"; [[ "$index" = /* ]] || index="$TD_PARENT/$index"
  cp -- "$TD_DIR/snapshot/index.bytes" "$tmp" && target_direct_hash_file "$tmp" | grep -Fx "$(cat "$TD_DIR/snapshot/index.sha256")" >/dev/null && mv -f -- "$tmp" "$index"
}

target_direct_validate_descriptor() {
  local file="$1" key line value
  [[ -f "$file" ]] || return 4
  declare -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* && "$line" != *$'\n'* && "$line" != *$'\r'* ]] || return 4
    key="${line%%=*}"; value="${line#*=}"
    [[ -n "$key" && -z "${seen[$key]+x}" && -n "$value" ]] || return 4
    case "$key" in
      descriptor_version|operation|target_kind|target_repo|target_common_dir|parent_repo|parent_common_dir|submodule_path|gitlink_sha|target_head|base|base_sha|branch|worktree_path|link_parent|namespace|owner|phase|tx_id|index_snapshot_ref) ;;
      *) return 4 ;;
    esac
    seen["$key"]=1
  done < "$file"
  local required
  for required in descriptor_version operation target_kind target_repo target_common_dir parent_repo parent_common_dir submodule_path gitlink_sha target_head base base_sha branch worktree_path link_parent namespace owner phase tx_id index_snapshot_ref; do
    [[ -n "${seen[$required]+x}" ]] || return 4
  done
  [[ "$(sed -n 's/^descriptor_version=//p' "$file")" == 1 && "$(sed -n 's/^target_kind=//p' "$file")" == submodule && "$(sed -n 's/^link_parent=//p' "$file")" == staged-only ]] || return 4
  [[ "$(sed -n 's/^operation=//p' "$file")" =~ ^(create|link-parent|abort|complete)$ ]] || return 4
  [[ "$(sed -n 's/^phase=//p' "$file")" =~ ^(initial|descriptor_written|validated|worktree_created|ready|snapshot_captured|staged_started|staged|verified|complete_validated|remove_started|removed|closed|reconciled|index_reconcile_started|index_restored|recovered|aborted|blocked)$ ]] || return 4
  [[ "$(sed -n 's/^target_repo=//p' "$file")" = /* && "$(sed -n 's/^target_common_dir=//p' "$file")" = /* && "$(sed -n 's/^parent_repo=//p' "$file")" = /* && "$(sed -n 's/^parent_common_dir=//p' "$file")" = /* && "$(sed -n 's/^worktree_path=//p' "$file")" = /* && "$(sed -n 's/^index_snapshot_ref=//p' "$file")" = /* ]] || return 4
  target_direct_valid_rel "$(sed -n 's/^submodule_path=//p' "$file")" || return 4
  [[ "$(sed -n 's/^gitlink_sha=//p' "$file")" =~ ^[0-9a-fA-F]{40}$ && "$(sed -n 's/^target_head=//p' "$file")" =~ ^[0-9a-fA-F]{40}$ && "$(sed -n 's/^base_sha=//p' "$file")" =~ ^[0-9a-fA-F]{40}$ ]] || return 4
  [[ "$(sed -n 's/^tx_id=//p' "$file")" == td-* && "$(sed -n 's/^namespace=//p' "$file")" == CA-worktree-submodule-target-direct ]] || return 4
}

target_direct_load_descriptor() {
  local file="$1" key value
  target_direct_validate_descriptor "$file" || return 4
  while IFS='=' read -r key value; do
    case "$key" in
      operation) TD_OPERATION="$value";; target_repo) TD_TARGET="$value";; target_common_dir) TD_TARGET_COMMON="$value";;
      parent_repo) TD_PARENT="$value";; parent_common_dir) TD_PARENT_COMMON="$value";; submodule_path) TD_SUBPATH="$value";;
      gitlink_sha) TD_GITLINK="$value";; target_head) TD_HEAD="$value";; base) TD_BASE="$value";; base_sha) TD_BASE_SHA="$value";;
      branch) TD_BRANCH="$value";; worktree_path) TD_WORKTREE="$value";; phase) TD_PHASE="$value";; tx_id) TD_TX="$value";;
    esac
  done < "$file"
  [[ "$TD_TARGET" == "$(target_direct_abs "$TD_TARGET")" && "$TD_PARENT" == "$(target_direct_abs "$TD_PARENT")" ]] || return 4
  [[ "$TD_TARGET_COMMON" == "$(target_direct_git_common "$TD_TARGET")" && "$TD_PARENT_COMMON" == "$(target_direct_git_common "$TD_PARENT")" ]] || return 4
  [[ "$TD_WORKTREE" == "$TD_TARGET/.worktrees/${TD_TX#td-}" && "$TD_BRANCH" == "worktree/${TD_TX#td-}" ]] || return 4
  TD_DESC_TARGET="$TD_TARGET"; TD_DESC_TARGET_COMMON="$TD_TARGET_COMMON"; TD_DESC_PARENT="$TD_PARENT"; TD_DESC_PARENT_COMMON="$TD_PARENT_COMMON"
  TD_DESC_SUBPATH="$TD_SUBPATH"; TD_DESC_GITLINK="$TD_GITLINK"; TD_DESC_HEAD="$TD_HEAD"; TD_DESC_BASE_SHA="$TD_BASE_SHA"
  return 0
}

target_direct_validate_repo() {
  TD_TARGET="$(target_direct_abs "$1")" || return 3; TD_PARENT="$(target_direct_abs "$2")" || return 3
  TD_TARGET_COMMON="$(target_direct_git_common "$TD_TARGET")" || return 3; TD_PARENT_COMMON="$(target_direct_git_common "$TD_PARENT")" || return 3
  [[ -f "$TD_PARENT/.gitmodules" ]] || return 4
  TD_GITLINK="$(git -C "$TD_PARENT" ls-files --stage -- "$TD_SUBPATH" | awk '$1 == 160000 {print $2; exit}')"
  [[ "$TD_GITLINK" =~ ^[0-9a-fA-F]{40}$ ]] || return 4
  [[ "$(git -C "$TD_PARENT" config -f .gitmodules --get-regexp '^submodule\..*\.path$' | awk -v p="$TD_SUBPATH" '$2 == p {print $2; exit}')" == "$TD_SUBPATH" ]] || return 4
  [[ "$(cd "$TD_PARENT/$TD_SUBPATH" 2>/dev/null && pwd -P)" == "$TD_TARGET" ]] || return 4
  local repo_head
  local complete_without_link=0
  [[ "${TD_OPERATION:-create}" == complete && -n "${TD_DIR:-}" && ! -d "$TD_DIR/snapshot" ]] && complete_without_link=1
  repo_head="$(git -C "$TD_TARGET" rev-parse HEAD 2>/dev/null)" || return 4
  TD_HEAD="$repo_head"
  if [[ "${TD_OPERATION:-create}" != create && -n "${TD_BRANCH:-}" ]] && git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH"; then
    TD_HEAD="$(git -C "$TD_TARGET" rev-parse "refs/heads/$TD_BRANCH")"
  elif [[ "${TD_OPERATION:-create}" != create && -d "$TD_TARGET/.worktrees/${ca:-}" ]]; then
    TD_HEAD="$(git -C "$TD_TARGET/.worktrees/${ca:-}" rev-parse HEAD 2>/dev/null || printf '%s' "$repo_head")"
  fi
  if [[ "${TD_OPERATION:-create}" == complete && -d "${TD_DIR:-}/snapshot" ]]; then
    [[ "$TD_GITLINK" == "$TD_HEAD" ]] || return 4
  fi
  if [[ "${TD_OPERATION:-create}" == create ]]; then
    [[ "$repo_head" == "$TD_GITLINK" ]] || return 4
  elif (( ! complete_without_link )); then
    [[ "$TD_GITLINK" == "$repo_head" || "$TD_GITLINK" == "$TD_HEAD" ]] || return 4
  fi
  if [[ "${TD_OPERATION:-create}" == complete && -n "${TD_DIR:-}" && -d "$TD_DIR/snapshot" ]]; then
    [[ "$(git -C "$TD_PARENT" rev-parse HEAD 2>/dev/null)" == "$(cat "$TD_DIR/snapshot/head.sha" 2>/dev/null)" ]] || return 6
    [[ "$(git -C "$TD_PARENT" ls-files --stage -- "$TD_SUBPATH")" == "160000 $TD_HEAD"$' 0\t'"$TD_SUBPATH" ]] || return 6
    [[ "$(git -C "$TD_PARENT" diff --cached --name-only)" == "$TD_SUBPATH" ]] || return 6
  fi
  TD_BASE_SHA="$(git -C "$TD_TARGET" rev-parse "$TD_BASE^{commit}" 2>/dev/null)" || return 3
  if [[ -n "${TD_DESC_TARGET:-}" ]]; then
    if [[ "$TD_PHASE" == closed ]] && ! git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH"; then
      TD_HEAD="$TD_DESC_HEAD"
    fi
    [[ "$TD_TARGET" == "$TD_DESC_TARGET" && "$TD_TARGET_COMMON" == "$TD_DESC_TARGET_COMMON" && "$TD_PARENT" == "$TD_DESC_PARENT" && "$TD_PARENT_COMMON" == "$TD_DESC_PARENT_COMMON" ]] || return 4
    [[ "$TD_SUBPATH" == "$TD_DESC_SUBPATH" && "$TD_GITLINK" == "$TD_DESC_GITLINK" ]] || return 4
    if (( ! complete_without_link )); then
      [[ "$TD_HEAD" == "$TD_DESC_HEAD" && "$TD_BASE_SHA" == "$TD_DESC_BASE_SHA" ]] || return 4
    fi
  fi
}

target_direct_complete() {
  [[ -f "$TD_DIR/meta" ]] || return 4
  target_direct_load_descriptor "$TD_DIR/descriptor" || return 4
  [[ "$TD_OPERATION" == create || "$TD_OPERATION" == link-parent || "$TD_OPERATION" == complete ]] || return 4
  # Refresh the persisted target head from the observed worktree/branch. The
  # create descriptor initially contains the base tip; recover must later
  # compare against the commit that complete actually intends to retire.
  if [[ -d "$TD_WORKTREE" ]]; then
    TD_HEAD="$(git -C "$TD_WORKTREE" rev-parse HEAD 2>/dev/null)" || return 4
  elif git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH"; then
    TD_HEAD="$(git -C "$TD_TARGET" rev-parse "refs/heads/$TD_BRANCH")" || return 4
  fi
  TD_EXPECTED_EFFECT="target worktree removed"; TD_OBSERVED_EFFECT=none; target_direct_journal complete_validated
  if [[ ! -e "$TD_WORKTREE" ]]; then
    git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH" && git -C "$TD_TARGET" update-ref -d "refs/heads/$TD_BRANCH" "$(git -C "$TD_TARGET" rev-parse "refs/heads/$TD_BRANCH")" || true
    TD_OBSERVED_EFFECT="target worktree already removed"; TD_POST_STATE=closed; TD_ABORT_STATUS=closed; target_direct_journal closed
    printf 'operation: complete\nresult: success\nidempotent: true\nparent_worktree: none\n'; return 0
  fi
  [[ -z "$(git -C "$TD_WORKTREE" status --porcelain 2>/dev/null)" ]] || { TD_POST_STATE=dirty; target_direct_journal blocked 6; return 6; }
  target_direct_journal remove_started
  git -C "$TD_TARGET" worktree remove "$TD_WORKTREE" >/dev/null || { TD_POST_STATE=remove_failed; target_direct_journal blocked 6; return 6; }
  target_direct_journal removed
  git -C "$TD_TARGET" update-ref -d "refs/heads/$TD_BRANCH" "$TD_HEAD" || true
  TD_OBSERVED_EFFECT="target worktree removed and branch retired"; TD_POST_STATE=closed; TD_ABORT_STATUS=closed; target_direct_journal closed
  printf 'operation: complete\nresult: success\nparent_worktree: none\n'
}

target_direct_recover() {
  [[ -f "$TD_DIR/meta" ]] || return 4
  local phase c
  phase="$(sed -n 's/^phase=//p' "$TD_DIR/meta")"
  target_direct_load_descriptor "$TD_DIR/descriptor" || { TD_POST_STATE=descriptor_invalid; target_direct_journal blocked 4; return 4; }
  case "$phase" in aborted|blocked|closed)
    printf 'operation: recover\nresult: success\nclassification: A\n'; return 0;;
    verified|staged|staged_started|snapshot_captured)
    if [[ -d "$TD_DIR/snapshot" ]]; then c="$(target_direct_classify)"; [[ "$c" == A || "$c" == B ]] || { TD_POST_STATE=drift; target_direct_journal blocked 6; return 6; };
      target_direct_journal reconciled
      if [[ "$c" == B ]]; then target_direct_journal index_reconcile_started; target_direct_restore_index || { TD_POST_STATE=restore_failed; target_direct_journal blocked 6; return 6; }; target_direct_journal index_restored; fi
      TD_POST_STATE=restored; target_direct_journal recovered
    fi
    printf 'operation: recover\nresult: success\nclassification: %s\n' "${c:-A}"; return 0;;
    complete_validated|remove_started|removed)
      # Reconcile from observed resources, not from the last intended effect.
      # A missing worktree means remove already happened (or completed before
      # the journal write); never invoke `git worktree remove` a second time.
      local registered=0
      worktree_registered_for_path() { git -C "$TD_TARGET" worktree list --porcelain | grep -Fx "worktree $TD_WORKTREE" >/dev/null 2>&1; }
      [[ -e "$TD_WORKTREE" ]] && registered=1
      if [[ "$registered" == 1 ]]; then
        [[ "$phase" == complete_validated || "$phase" == remove_started ]] || { TD_POST_STATE=drift; target_direct_journal blocked 6; return 6; }
        [[ -z "$(git -C "$TD_WORKTREE" status --porcelain 2>/dev/null)" ]] || { TD_POST_STATE=dirty; target_direct_journal blocked 6; return 6; }
        [[ "$phase" == complete_validated ]] && target_direct_journal remove_started
        git -C "$TD_TARGET" worktree remove "$TD_WORKTREE" >/dev/null || { TD_POST_STATE=remove_failed; target_direct_journal blocked 6; return 6; }
      fi
      [[ ! -e "$TD_WORKTREE" ]] || { TD_POST_STATE=remove_failed; target_direct_journal blocked 6; return 6; }
      target_direct_journal removed
      if git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH"; then
        [[ "$(git -C "$TD_TARGET" rev-parse "refs/heads/$TD_BRANCH")" == "$TD_HEAD" ]] || { TD_POST_STATE=branch_drift; target_direct_journal blocked 6; return 6; }
        git -C "$TD_TARGET" update-ref -d "refs/heads/$TD_BRANCH" "$TD_HEAD" || { TD_POST_STATE=branch_failed; target_direct_journal blocked 6; return 6; }
      fi
      TD_OBSERVED_EFFECT="target worktree removed and branch retired"; TD_POST_STATE=closed; TD_ABORT_STATUS=closed; target_direct_journal closed
      printf 'operation: recover\nresult: success\nclassification: A\n'; return 0;;
    *) TD_POST_STATE=reconciliation_required; target_direct_journal blocked 6; return 6;;
  esac
}

target_direct_main() {
  [[ "${1:-}" == --repo || "${1:-}" == --parent-repo ]] || return 10
  # `--repo` is also part of the parent-only public contract.  Do not claim
  # that invocation unless it carries an explicit target-direct descriptor;
  # otherwise the core parent-only lifecycle must parse and handle it.
  local explicit_target=0 arg
  for arg in "$@"; do
    case "$arg" in
      --parent-repo|--target|--submodule-path|--link-parent|--tx) explicit_target=1 ;;
    esac
  done
  (( explicit_target )) || return 10
  local target_repo="" parent_repo="" command ca tx="" target_kind="" subpath="" link="" base="main" base_seen=0 tx_seen=0 arg
  while [[ $# -gt 0 ]]; do case "$1" in --repo) [[ $# -ge 2 ]] || return 2; target_repo="$2"; shift 2;; --parent-repo) [[ $# -ge 2 ]] || return 2; parent_repo="$2"; shift 2;; *) break;; esac; done
  [[ -n "$target_repo" && -n "$parent_repo" ]] || return 2; command="${1:-}"; shift || true
  target_direct_ensure_git || return $?
  local script_dir; script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  TD_TRANSPORT_MODULE="$script_dir/../../bin/lib/runner-constructor-target-direct.js"
  case "$command" in create|link-parent|abort|complete) ca="${1:-}"; shift || true;; recover) tx="${1:-}"; shift || true;; *) return 10;; esac
  [[ -n "${ca:-$tx}" ]] || return 2
  while [[ $# -gt 0 ]]; do arg="$1"; case "$arg" in --target) target_kind="${2:-}"; shift 2;; --submodule-path) subpath="${2:-}"; shift 2;; --base) base="${2:-}"; base_seen=1; shift 2;; --link-parent) link="${2:-}"; shift 2;; --tx) tx="${2:-}"; tx_seen=1; shift 2;; *) printf '%s\n' "Opción o argumento desconocido: $arg" >&2; return 2;; esac; done
  if [[ "$command" == recover ]]; then target_kind=submodule; fi
  [[ "$command" == create || "$base_seen" == 0 ]] || { [[ "$command" == complete ]] || return 2; }
  [[ "$command" == abort || "$tx_seen" == 0 ]] || return 2
  if [[ "$command" != recover ]]; then [[ "$target_kind" == submodule && -n "$subpath" && "$link" == staged-only ]] || return 2; target_direct_valid_rel "$subpath" || return 3; fi
  [[ "${ca:-}" != */* && "${ca:-}" != .* && "${ca:-}" != -* ]] || { [[ "$command" == recover ]] || return 3; }
  local state_root descriptor_path
  TD_BASE="$base"; TD_SUBPATH="$subpath"
  if [[ "$command" == recover ]]; then
    local recover_target recover_common recover_dir recover_ca
    recover_target="$(target_direct_abs "$target_repo")" || return 3
    recover_common="$(target_direct_git_common "$recover_target")" || return 3
    recover_ca="${tx#td-}"
    recover_dir="$recover_common/worktree-manager/target-direct/$(target_direct_encode "$recover_ca")"
    descriptor_path="$recover_dir/descriptor"
    [[ -f "$descriptor_path" ]] || return 4
    target_direct_transport_constructor "$descriptor_path" || return 4
    target_direct_load_descriptor "$descriptor_path" || return 4
    [[ "$TD_TARGET" == "$recover_target" ]] || return 4
    [[ "$TD_PARENT" == "$(target_direct_abs "$parent_repo")" ]] || return 4
    [[ "$TD_TX" == "$tx" ]] || return 4
    TD_SUBPATH="$(sed -n 's/^submodule_path=//p' "$descriptor_path")"
    [[ -n "$TD_SUBPATH" ]] || return 4
    ca="$(sed -n 's/^tx_id=td-//p' "$descriptor_path")"
    [[ -n "$ca" ]] || ca="$(sed -n 's/^tx_id=td-//p' "$recover_dir/meta")"
    [[ -n "$ca" ]] || return 4
    base="$(sed -n 's/^base=//p' "$descriptor_path")"
  fi
  TD_OPERATION="$command"
  TD_TARGET="$(target_direct_abs "$target_repo")" || return 3
  TD_TARGET_COMMON="$(target_direct_git_common "$TD_TARGET")" || return 3
  state_root="$TD_TARGET_COMMON/worktree-manager/target-direct"
  TD_DIR="$state_root/$(target_direct_encode "${ca:-$tx}")"
  TD_TX="${tx:-td-$ca}"
  [[ "$TD_TX" == td-* ]] || TD_TX="td-$TD_TX"
  TD_BRANCH="worktree/$ca"
  TD_WORKTREE="$TD_TARGET/.worktrees/$ca"
  # complete must validate the staged-only result recorded by link-parent,
  # rather than comparing the parent gitlink with the target repository's
  # unrelated current branch tip.
  if [[ "$command" == complete ]]; then
    [[ -f "$TD_DIR/meta" ]] || return 4
    target_direct_transport_constructor "$TD_DIR/descriptor" || return 4
    target_direct_load_descriptor "$TD_DIR/descriptor" || return 4
    TD_OPERATION="$command"
  fi
  target_direct_validate_repo "$target_repo" "$parent_repo" || return $?
  TD_OPERATION="$command"; TD_OPERATION_ID="$TD_TX"; TD_ARGV="$command ${ca:-$tx} --target submodule --submodule-path $TD_SUBPATH --link-parent staged-only"; [[ "$base_seen" == 1 ]] && TD_ARGV="$TD_ARGV --base $base"; [[ "$tx_seen" == 1 ]] && TD_ARGV="$TD_ARGV --tx $tx"; TD_ABORT_STATUS=active; TD_PHASE=initial; TD_PRE_STATE=validated; TD_POST_STATE=validated
  if [[ "$command" != create && -d "$TD_WORKTREE" ]]; then
    TD_HEAD="$(git -C "$TD_WORKTREE" rev-parse HEAD 2>/dev/null)" || return 4
  fi
  mkdir -p -- "$TD_DIR"
  target_direct_acquire_locks "$TD_TARGET_COMMON" "$TD_PARENT_COMMON" "$command" "$state_root" || { target_direct_lock_release; return 5; }
  trap target_direct_lock_release EXIT
  case "$command" in
    create)
      [[ -n "$base" ]] || return 3; git -C "$TD_TARGET" check-ref-format --branch "$TD_BRANCH" >/dev/null 2>&1 || return 3; git -C "$TD_TARGET" show-ref --verify --quiet "refs/heads/$TD_BRANCH" && return 4; [[ ! -e "$TD_WORKTREE" ]] || return 4
      TD_EXPECTED_EFFECT="target worktree created"; target_direct_write_descriptor validated; target_direct_transport_constructor "$TD_DIR/descriptor" || return 4; target_direct_write_meta validated; target_direct_journal descriptor_written
      git -C "$TD_TARGET" worktree add -b "$TD_BRANCH" "$TD_WORKTREE" "$TD_BASE" >/dev/null || { TD_POST_STATE=create_failed; target_direct_journal blocked 6; return 6; }
      TD_OBSERVED_EFFECT="target worktree created"; target_direct_journal worktree_created; target_direct_journal ready
      printf 'operation: create\nresult: success\nparent_worktree: none\nworktree: %s\nbranch: %s\n' "$TD_WORKTREE" "$TD_BRANCH";;
    link-parent)
      [[ -f "$TD_DIR/meta" ]] || return 4; target_direct_transport_constructor "$TD_DIR/descriptor" || return 4; target_direct_validate_repo "$target_repo" "$parent_repo" || return 4; target_direct_snapshot; TD_EXPECTED_EFFECT="parent gitlink staged-only"; target_direct_journal snapshot_captured
      git -C "$TD_PARENT" update-index --add --cacheinfo "160000,$TD_HEAD,$TD_SUBPATH" || { TD_POST_STATE=stage_failed; target_direct_journal blocked 6; return 6; }; TD_GITLINK="$TD_HEAD"; TD_OBSERVED_EFFECT="gitlink staged"; target_direct_journal staged_started; target_direct_journal staged; TD_POST_STATE=verified; target_direct_journal verified
      printf 'operation: link-parent\nresult: success\nlink_parent: staged-only\ngitlink_sha: %s\n' "$TD_HEAD";;
    abort)
      [[ -f "$TD_DIR/meta" ]] || return 4; target_direct_transport_constructor "$TD_DIR/descriptor" || return 4; [[ -z "$tx" || "$tx" == "$TD_TX" ]] || return 4
      if [[ ! -d "$TD_DIR/snapshot" ]]; then TD_ABORT_STATUS=aborted; target_direct_journal aborted; printf 'operation: abort\nresult: success\nclassification: A\n'; else local c="$(target_direct_classify)"; [[ "$c" == A || "$c" == B ]] || { TD_POST_STATE=drift; target_direct_journal blocked 6; return 6; }; target_direct_journal index_reconcile_started; target_direct_restore_index || { TD_POST_STATE=restore_failed; target_direct_journal blocked 6; return 6; }; TD_ABORT_STATUS=aborted; TD_OBSERVED_EFFECT="parent index restored"; target_direct_journal index_restored; target_direct_journal aborted; printf 'operation: abort\nresult: success\nclassification: %s\n' "$c"; fi;;
    complete) target_direct_transport_constructor "$TD_DIR/descriptor" || return 4; target_direct_complete;;
    recover) target_direct_recover;;
  esac
}
