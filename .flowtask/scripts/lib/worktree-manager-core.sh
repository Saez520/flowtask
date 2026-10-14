#!/usr/bin/env bash

# Portable worktree manager implementation.  The public wrapper only sources
# this file; keeping all state in this process also makes the close capability
# impossible to request through the public CLI.
set -euo pipefail

WORKTREES_DIR=".worktrees"
BRANCH_PREFIX="worktree/"
STATE_DIR="worktree-manager"
PREPARE_COMMAND=""
VERIFY_COMMAND=""
PREPARE_ENABLED=0
VERIFY_ENABLED=0
PRESERVE_DIRTY=0
CONFIG_PATH=""
REPO_ROOT=""
GIT_COMMON_DIR=""
STATE_ROOT=""
TRANSACTIONS_DIR=""
LOCKS_DIR=""
WORKTREES_ROOT=""
TMP_STATE_DIR=""
close_dir=""
CLOSE_VERSION=1
CLOSE_WORK_ID=""
CLOSE_BASE_BRANCH=""
CLOSE_BRANCH=""
CLOSE_PATH=""
CLOSE_COMMON_DIR=""
CLOSE_ORIGIN_SHA=""
CLOSE_BEFORE_HEAD=""
CLOSE_SQUASH_SHA=""
CLOSE_INIT_REQUESTED="false"
CLOSE_INIT_RESULT="not_requested"
CLOSE_PARENT_RESTORE="not_restored"
CLOSE_PHASE=""
LOCK_NAMES=()
LOCK_HELD=0
CURRENT_OPERATION=""
# Ephemeral, in-memory only.  Minted exclusively by the verified squash-close
# path and consumed (cleared) by the first retirement it authorizes.
CLOSE_CAPABILITY=""

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

cleanup_tmp_state() {
  [[ -n "$TMP_STATE_DIR" && -d "$TMP_STATE_DIR" ]] && rm -rf -- "$TMP_STATE_DIR"
  return 0
}

release_locks() {
  local lock
  for ((lock=${#LOCK_NAMES[@]}-1; lock>=0; lock--)); do
    rm -rf -- "$LOCKS_DIR/${LOCK_NAMES[lock]}"
  done
  LOCK_NAMES=()
  LOCK_HELD=0
  return 0
}

die_with_unlock() {
  release_locks
  die "$@"
}

ensure_git() {
  command -v git >/dev/null 2>&1 || die "Se requiere Git 2.5 o superior"
  local version_output major minor
  version_output="$(git version)"
  if [[ "$version_output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    (( major > 2 || (major == 2 && minor >= 5) )) || die "Se requiere Git 2.5 o superior"
  else
    die "No pude verificar la versión de Git. Se requiere Git 2.5 o superior"
  fi
}

absolute_existing_dir() {
  [[ "$1" = /* && -d "$1" ]] || die "El repositorio debe ser un directorio absoluto existente"
}

absolute_existing_file() {
  [[ "$1" = /* && -f "$1" ]] || die "La configuración debe ser un archivo absoluto existente"
}

repo_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null || die "No estás dentro de un repositorio Git válido"
}

resolve_repo() {
  local requested_repo="${1:-}"
  if [[ -n "$requested_repo" ]]; then
    absolute_existing_dir "$requested_repo"
    REPO_ROOT="$(repo_root "$requested_repo")"
  else
    REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [[ -n "$REPO_ROOT" ]] || die "No estás dentro de un repositorio Git válido"
  fi
  cd -- "$REPO_ROOT"
  GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
  [[ "$GIT_COMMON_DIR" = /* ]] || GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR"
  GIT_COMMON_DIR="$(cd -- "$GIT_COMMON_DIR" && pwd -P)"
}

valid_bool() { [[ "$1" == true || "$1" == false ]]; }

valid_relative_state_dir() {
  [[ -n "$1" && "$1" != /* && "$1" != . && "$1" != */*//* && "$1" != ../* && "$1" != */../* && "$1" != .. ]]
}

parse_config() {
  local path="$1" line key value
  [[ -f "$path" ]] || return 0
  local -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || die "Configuración inválida: cada línea debe usar key=value"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[a-z_]+$ ]] || die "Clave de configuración inválida: $key"
    [[ -z "${seen[$key]+x}" ]] || die "Clave de configuración repetida: $key"
    seen["$key"]=1
    case "$key" in
      worktrees_dir)
        [[ -n "$value" && "$value" != -* ]] || die "worktrees_dir inválido"
        WORKTREES_DIR="$value" ;;
      branch_prefix)
        [[ -n "$value" && "$value" != -* && "$value" != *$'\n'* ]] || die "branch_prefix inválido"
        BRANCH_PREFIX="$value" ;;
      state_dir)
        valid_relative_state_dir "$value" || die "state_dir inválido"
        STATE_DIR="$value" ;;
      prepare_command) PREPARE_COMMAND="$value" ;;
      prepare_enabled)
        valid_bool "$value" || die "prepare_enabled debe ser true o false"
        [[ "$value" == true ]] && PREPARE_ENABLED=1 || PREPARE_ENABLED=0 ;;
      verify_command) VERIFY_COMMAND="$value" ;;
      verify_enabled)
        valid_bool "$value" || die "verify_enabled debe ser true o false"
        [[ "$value" == true ]] && VERIFY_ENABLED=1 || VERIFY_ENABLED=0 ;;
      preserve_dirty)
        valid_bool "$value" || die "preserve_dirty debe ser true o false"
        [[ "$value" == true ]] && PRESERVE_DIRTY=1 || PRESERVE_DIRTY=0 ;;
      *) die "Clave de configuración desconocida: $key" ;;
    esac
  done < "$path"
  if (( PREPARE_ENABLED == 1 )) && [[ -z "$PREPARE_COMMAND" ]]; then die "prepare_enabled requiere prepare_command"; fi
  if (( VERIFY_ENABLED == 1 )) && [[ -z "$VERIFY_COMMAND" ]]; then die "verify_enabled requiere verify_command"; fi
}

resolve_paths() {
  if [[ "$WORKTREES_DIR" = /* ]]; then
    WORKTREES_ROOT="$(cd -- "$WORKTREES_DIR" 2>/dev/null && pwd -P || printf '%s' "$WORKTREES_DIR")"
  else
    [[ "$WORKTREES_DIR" != . && "$WORKTREES_DIR" != ../* && "$WORKTREES_DIR" != */../* ]] || die "worktrees_dir no puede salir del repositorio"
    WORKTREES_ROOT="$REPO_ROOT/$WORKTREES_DIR"
  fi
  STATE_ROOT="$GIT_COMMON_DIR/$STATE_DIR"
  TRANSACTIONS_DIR="$STATE_ROOT/transactions"
  LOCKS_DIR="$STATE_ROOT/locks"
}

load_configuration() {
  local requested_config="${1:-}"
  if [[ -n "$requested_config" ]]; then
    absolute_existing_file "$requested_config"
    CONFIG_PATH="$requested_config"
  elif [[ -f "$REPO_ROOT/.worktree-manager.conf" ]]; then
    CONFIG_PATH="$REPO_ROOT/.worktree-manager.conf"
  else
    CONFIG_PATH=""
  fi
  [[ -z "$CONFIG_PATH" ]] || parse_config "$CONFIG_PATH"
  resolve_paths
}

detect_base_branch() {
  local branch
  for branch in development main trunk; do
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      printf '%s' "$branch"
      return 0
    fi
  done
  printf '%s' "main"
}

normalize_base_branch() {
  local base_branch="$1"
  [[ -n "$base_branch" && "$base_branch" != -* ]] || die "La rama base no puede estar vacía"
  git check-ref-format --branch "$base_branch" >/dev/null 2>&1 || die "La rama base '$base_branch' es inválida"
  git rev-parse --verify --quiet "refs/heads/$base_branch^{commit}" >/dev/null || die "La rama base '$base_branch' no existe"
}

validate_work_id() {
  local work_id="$1" segment
  local -a segments=()
  [[ -n "$work_id" && "$work_id" != /* && "$work_id" != -* && "$work_id" != *$'\n'* ]] || die "Identificador de trabajo inválido"
  IFS=/ read -r -a segments <<< "$work_id"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" && "$segment" != . && "$segment" != .. && "$segment" != --* && "$segment" =~ ^[A-Za-z0-9._-]+$ ]] || die "Identificador de trabajo inválido"
  done
}

worktree_branch_for() { printf '%s%s' "$BRANCH_PREFIX" "$1"; }
worktree_path_for() { printf '%s/%s' "$WORKTREES_DIR" "$1"; }
worktree_path_abs_for() {
  if [[ "$WORKTREES_DIR" = /* ]]; then printf '%s/%s' "$WORKTREES_ROOT" "$1"; else printf '%s/%s' "$REPO_ROOT/$WORKTREES_DIR" "$1"; fi
}
branch_exists() { git show-ref --verify --quiet "refs/heads/$1"; }

worktree_registered_for_path() {
  local target="$1" line current=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) current="${line#worktree }" ;;
      "") [[ "$current" == "$target" ]] && return 0; current="" ;;
    esac
  done < <(git worktree list --porcelain)
  [[ "$current" == "$target" ]]
}

worktree_registered_for_branch() {
  local target="refs/heads/$1" line current_path="" current_branch=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) current_path="${line#worktree }" ;;
      branch\ *) current_branch="${line#branch }" ;;
      "")
        if [[ "$current_branch" == "$target" ]]; then printf '%s\n' "$current_path"; return 0; fi
        current_path=""; current_branch="" ;;
    esac
  done < <(git worktree list --porcelain)
  [[ "$current_branch" == "$target" ]] && printf '%s\n' "$current_path"
}

ensure_ignored_local_path() {
  local path="$1" rel
  if [[ "$WORKTREES_DIR" != /* ]]; then
    rel="${path#"$REPO_ROOT/"}"
    git check-ignore -q -- "$rel" || die "La ruta '$rel' no está excluida por Git; corregí la exclusión antes de crear"
  fi
}

validate_identity() {
  local work_id="$1" branch path_abs registered_path
  close_test_counter validate_identity
  validate_work_id "$work_id"
  branch="$(worktree_branch_for "$work_id")"
  path_abs="$(worktree_path_abs_for "$work_id")"
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "La rama de trabajo '$branch' es inválida"
  branch_exists "$branch" || die "No encontré la rama '$branch'"
  [[ -e "$path_abs" ]] || die "No encontré la ruta del trabajo '$path_abs'"
  registered_path="$(worktree_registered_for_branch "$branch" || true)"
  [[ "$registered_path" == "$path_abs" ]] || die "La rama y la ruta no corresponden al trabajo solicitado"
  worktree_registered_for_path "$path_abs" || die "La ruta no está registrada como worktree"
}

encode_work_id() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

acquire_locks() {
  local operation="$1"; shift
  local names=() name sorted lock
  for name in "$@"; do names+=("$name"); done
  mapfile -t sorted < <(printf '%s\n' "${names[@]}" | sort -u)
  mkdir -p -- "$LOCKS_DIR"
  for name in "${sorted[@]}"; do
    lock="$LOCKS_DIR/$name"
    mkdir -p -- "$(dirname -- "$lock")"
    if ! mkdir -- "$lock" 2>/dev/null; then
      die "Operación rechazada: el recurso '$name' está bloqueado; reintentá luego"
    fi
    printf '%s\n' "$$" > "$lock/pid"
    printf '%s\n' "$operation" > "$lock/operation"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$lock/created_at"
    LOCK_NAMES+=("$name")
  done
  LOCK_HELD=1
  CURRENT_OPERATION="$operation"
  if [[ "${FLOWTASK_TEST_MODE:-0}" == 1 && -n "${FLOWTASK_TEST_LOCK_BARRIER_DIR:-}" && -n "${FLOWTASK_TEST_HOLD_AFTER_LOCK:-}" && "${FLOWTASK_TEST_HOLD_AFTER_LOCK}" == "$operation" ]]; then
    local barrier="${FLOWTASK_TEST_LOCK_BARRIER_DIR}"
    [[ "$barrier" = /* ]] || die_with_unlock "La barrera de tests debe ser absoluta"
    mkdir -p -- "$barrier"
    : > "$barrier/$operation.ready"
    while [[ ! -e "$barrier/release" ]]; do sleep 0.01; done
  fi
}

tx_dir_for() { printf '%s/%s' "$TRANSACTIONS_DIR" "$1"; }
legacy_tx_dir_for() { printf '%s/.flowtask/backups/%s' "$REPO_ROOT" "$1"; }
tx_dir_read() {
  local tx_id="$1" new legacy
  new="$(tx_dir_for "$tx_id")"; legacy="$(legacy_tx_dir_for "$tx_id")"
  if [[ -d "$new" ]]; then printf '%s' "$new"; elif [[ -d "$legacy" ]]; then printf '%s' "$legacy"; else return 1; fi
}
legacy_mirror_dir() { printf '%s' "$(legacy_tx_dir_for "$1")"; }

# A new transaction keeps its payload under <git-common-dir>/<state_dir>, and
# mirrors a *complete* copy into the legacy location that existing FlowTask
# readers already know about.  The mirror must carry tracked/untracked path
# lists too: `tx_dir_read` falls back to legacy, and a meta+journal-only mirror
# would make recovery skip the destination cleanup it depends on.
mirror_tx_payload() {
  local tx_dir="$1" legacy payload
  legacy="$(legacy_mirror_dir "$(basename "$tx_dir")")"
  [[ "$tx_dir" != "$legacy" ]] || return 0
  for payload in tracked.paths untracked.paths; do
    [[ -f "$tx_dir/$payload" ]] || continue
    mkdir -p -- "$legacy"
    cp -- "$tx_dir/$payload" "$legacy/$payload"
  done
  return 0
}

journal_write() {
  local tx_dir="$1" phase="$2" tx_id legacy tmp
  tx_id="$(basename "$tx_dir")"
  tmp="$tx_dir/.journal.tmp"
  printf '%s\n' "$phase" > "$tmp"
  mv -f -- "$tmp" "$tx_dir/journal"
  legacy="$(legacy_mirror_dir "$tx_id")"
  if [[ "$tx_dir" != "$legacy" && -d "$legacy" ]]; then printf '%s\n' "$phase" > "$legacy/.journal.tmp"; mv -f -- "$legacy/.journal.tmp" "$legacy/journal"; fi
  if [[ "${FLOWTASK_TEST_MODE:-0}" == 1 && "${FLOWTASK_TEST_CRASH_AFTER:-}" == "$phase" ]]; then exit 99; fi
}

journal_read() { [[ -f "$1/journal" ]] && tr -d '\n' < "$1/journal"; }

write_meta() {
  local tx_dir="$1" work_id="$2" base="$3" branch="$4" path_abs="$5" origin_sha="$6" tmp
  tmp="$tx_dir/.meta.tmp"
  {
    printf 'work_id: %s\n' "$work_id"
    printf 'ca_name: %s\n' "$work_id"
    printf 'base_branch: %s\n' "$base"
    printf 'branch: %s\n' "$branch"
    printf 'path: %s\n' "$path_abs"
    printf 'origin_sha: %s\n' "$origin_sha"
    printf 'head_destino: %s\n' "$(git rev-parse HEAD)"
    printf 'created_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  mv -f -- "$tmp" "$tx_dir/meta"
  local legacy="$(legacy_mirror_dir "$(basename "$tx_dir")")"
  if [[ "$tx_dir" != "$legacy" ]]; then mkdir -p -- "$legacy"; cp -- "$tx_dir/meta" "$legacy/meta"; fi
}

meta_value() { sed -n "s/^$2: //p" "$1/meta" | head -n 1; }

# Complete has a separate, deliberately small journal.  It is not a cleanup
# receipt: only create and complete write it, while cleanup/recover never read
# it.  Values are validated before they reach this file and every write is an
# atomic replace in the same directory.
close_dir_for() { printf '%s/close/%s' "$STATE_ROOT" "$(encode_work_id "$1")"; }

close_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$close_dir/meta" | head -n 1
}

close_write_meta() {
  local tmp="$close_dir/.meta.tmp"
  mkdir -p -- "$close_dir"
  {
    printf 'version=%s\n' "$CLOSE_VERSION"
    printf 'work_id=%s\n' "$CLOSE_WORK_ID"
    printf 'base_branch=%s\n' "$CLOSE_BASE_BRANCH"
    printf 'branch=%s\n' "$CLOSE_BRANCH"
    printf 'path=%s\n' "$CLOSE_PATH"
    printf 'common_dir=%s\n' "$CLOSE_COMMON_DIR"
    printf 'origin_sha=%s\n' "$CLOSE_ORIGIN_SHA"
    printf 'before_head=%s\n' "$CLOSE_BEFORE_HEAD"
    printf 'squash_sha=%s\n' "$CLOSE_SQUASH_SHA"
    printf 'init_requested=%s\n' "$CLOSE_INIT_REQUESTED"
    printf 'init_result=%s\n' "$CLOSE_INIT_RESULT"
    printf 'parent_restore=%s\n' "$CLOSE_PARENT_RESTORE"
    printf 'phase=%s\n' "$CLOSE_PHASE"
  } > "$tmp"
  mv -f -- "$tmp" "$close_dir/meta"
}

close_write_phase() {
  local phase="$1" tmp
  case "$phase" in
    created|init_started|initialized|merge_started|merged|deinit_started|deinitialized|remove_started|removed|branch_cleanup_started|closed) ;;
    *) die "Fase de cierre inválida: $phase" ;;
  esac
  case "$phase" in
    merged|deinit_started|deinitialized|remove_started|removed|branch_cleanup_started|closed) close_validate_squash ;;
  esac
  CLOSE_PHASE="$phase"
  close_write_meta
  tmp="$close_dir/.journal.tmp"
  printf '%s\n' "$phase" > "$tmp"
  mv -f -- "$tmp" "$close_dir/journal"
}

close_crash_hook() {
  # This hook models crash points in the internal `complete` close protocol.
  # `create --init-submodules` shares the initialization helper, but must not
  # inherit complete-only crash injection.
  [[ "${CLOSE_OPERATION:-}" == complete ]] || return 0
  [[ "${FLOWTASK_TEST_MODE:-0}" == 1 ]] || return 0
  [[ "${FLOWTASK_TEST_CLOSE_CRASH_AFTER:-}" == "$1" ]] || return 0
  exit 99
}

close_test_counter() {
  [[ "${FLOWTASK_TEST_MODE:-0}" == 1 && -n "${FLOWTASK_TEST_COUNTER_FILE:-}" ]] || return 0
  printf '%s\n' "$1" >> "$FLOWTASK_TEST_COUNTER_FILE"
}

valid_object_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ || "$1" =~ ^[0-9a-fA-F]{64}$ ]]
}

close_validate_commit_sha() {
  local label="$1" sha="$2" resolved
  valid_object_sha "$sha" || die "El journal de cierre tiene un $label con formato SHA inválido"
  resolved="$(git rev-parse --verify --quiet "$sha^{commit}" 2>/dev/null || true)"
  [[ "$resolved" == "$sha" ]] || die "El journal de cierre tiene un $label que no apunta a un commit verificable"
}

close_validate_squash() {
  local base_head parents parent_count
  [[ -n "$CLOSE_SQUASH_SHA" ]] || die "El journal de cierre requiere squash_sha antes de retirar recursos"
  close_validate_commit_sha squash_sha "$CLOSE_SQUASH_SHA"
  base_head="$(git rev-parse --verify --quiet "refs/heads/$CLOSE_BASE_BRANCH^{commit}" 2>/dev/null || true)"
  [[ "$base_head" == "$CLOSE_SQUASH_SHA" ]] || die "El squash registrado no coincide con la base; no se modifica nada"
  parents="$(git rev-list --parents -n 1 "$CLOSE_SQUASH_SHA" 2>/dev/null || true)"
  parent_count="$(wc -w <<< "$parents" | tr -d ' ')"
  [[ "$parent_count" == 2 && "${parents#* }" == "$CLOSE_BEFORE_HEAD" ]] || die "El squash registrado no coincide con before_head"
  [[ "$(git rev-list --count "$CLOSE_BEFORE_HEAD..$CLOSE_SQUASH_SHA" 2>/dev/null || true)" == 1 ]] || die "El squash registrado no es único"
}

close_validate_live_worktree() {
  local require_origin="${1:-true}" worktree_head branch_head
  [[ -e "$CLOSE_PATH" ]] || die "El journal de cierre perdió el worktree antes de una fase que lo requiere"
  worktree_registered_for_path "$CLOSE_PATH" || die "El journal de cierre perdió el registro del worktree"
  branch_exists "$CLOSE_BRANCH" || die "El journal de cierre perdió la rama antes de una fase que la requiere"
  branch_head="$(git rev-parse "refs/heads/$CLOSE_BRANCH")"
  [[ "$(git -C "$CLOSE_PATH" symbolic-ref -q HEAD 2>/dev/null || true)" == "refs/heads/$CLOSE_BRANCH" ]] || die "El HEAD del worktree no coincide con la rama del journal"
  worktree_head="$(git -C "$CLOSE_PATH" rev-parse HEAD 2>/dev/null || true)"
  [[ "$worktree_head" == "$branch_head" ]] || die "El HEAD del worktree no coincide con la rama; no se modifica nada"
  if [[ "$require_origin" == true ]]; then [[ "$branch_head" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama del journal de cierre cambió; no se modifica nada"; fi
}

close_validate_phase_resources() {
  case "$CLOSE_PHASE" in
    created|init_started|initialized)
      close_validate_live_worktree false
      ;;
    merge_started|merged|deinit_started|deinitialized)
      close_validate_live_worktree true
      ;;
    remove_started)
      branch_exists "$CLOSE_BRANCH" || die "La fase remove_started perdió la rama; no se modifica nada"
      [[ "$(git rev-parse "refs/heads/$CLOSE_BRANCH")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de remove_started; no se modifica nada"
      if [[ -e "$CLOSE_PATH" ]]; then close_validate_live_worktree; else worktree_registered_for_path "$CLOSE_PATH" && die "La fase remove_started tiene un worktree registrado sin ruta"; fi
      ;;
    removed)
      [[ ! -e "$CLOSE_PATH" ]] || die "La fase removed conserva el worktree; no se modifica nada"
      worktree_registered_for_path "$CLOSE_PATH" && die "La fase removed conserva el registro del worktree"
      branch_exists "$CLOSE_BRANCH" || die "La fase removed perdió la rama; no se modifica nada"
      [[ "$(git rev-parse "refs/heads/$CLOSE_BRANCH")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de branch cleanup; no se modifica nada"
      ;;
    branch_cleanup_started)
      [[ ! -e "$CLOSE_PATH" ]] || die "La fase branch_cleanup_started conserva el worktree; no se modifica nada"
      worktree_registered_for_path "$CLOSE_PATH" && die "La fase branch_cleanup_started conserva el registro del worktree"
      if branch_exists "$CLOSE_BRANCH"; then [[ "$(git rev-parse "refs/heads/$CLOSE_BRANCH")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de branch cleanup; no se modifica nada"; fi
      ;;
    closed)
      [[ ! -e "$CLOSE_PATH" ]] || die "El journal cerrado tiene el worktree reintroducido"
      worktree_registered_for_path "$CLOSE_PATH" && die "El journal cerrado tiene el worktree registrado"
      branch_exists "$CLOSE_BRANCH" && die "El journal cerrado tiene la rama reintroducida"
      ;;
  esac
  return 0
}

close_validate_record() {
  close_validate_commit_sha origin_sha "$CLOSE_ORIGIN_SHA"
  close_validate_commit_sha before_head "$CLOSE_BEFORE_HEAD"
  normalize_base_branch "$CLOSE_BASE_BRANCH"
  case "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" in
    false:not_requested|true:pending|true:initialized) ;;
    *) die "La combinación init_requested/init_result del journal de cierre es imposible" ;;
  esac
  case "$CLOSE_PHASE" in
    created)
      [[ "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == false:not_requested ]] || die "created requiere init_requested=false e init_result=not_requested"
      [[ "$CLOSE_PARENT_RESTORE" == not_restored ]] || die "created no puede tener restauración del destino"
      ;;
    init_started)
      [[ "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == true:pending ]] || die "init_started requiere inicialización pendiente"
      [[ "$CLOSE_PARENT_RESTORE" == not_restored ]] || die "init_started no puede tener restauración del destino"
      ;;
    initialized)
      [[ "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == true:initialized ]] || die "initialized requiere inicialización completada"
      [[ "$CLOSE_PARENT_RESTORE" == not_restored ]] || die "initialized no puede tener restauración del destino"
      ;;
    merge_started)
      [[ "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == false:not_requested || "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == true:initialized ]] || die "merge_started requiere inicialización estable"
      [[ "$CLOSE_PARENT_RESTORE" == not_restored ]] || die "merge_started no puede tener restauración del destino"
      if [[ -n "$CLOSE_SQUASH_SHA" ]]; then close_validate_squash; fi
      ;;
    merged|deinit_started|deinitialized|remove_started|removed|branch_cleanup_started|closed)
      [[ "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == false:not_requested || "$CLOSE_INIT_REQUESTED:$CLOSE_INIT_RESULT" == true:initialized ]] || die "La fase $CLOSE_PHASE requiere inicialización estable"
      case "$CLOSE_PARENT_RESTORE" in
        not_restored|restored_clean|restored_dirty) ;;
        pending_manual) [[ "$CLOSE_PHASE" == merged ]] || die "pending_manual sólo puede quedar en fase merged" ;;
        *) die "parent_restore inválido para la fase $CLOSE_PHASE" ;;
      esac
      close_validate_squash
      ;;
  esac
  if [[ "$CLOSE_PHASE" == created || "$CLOSE_PHASE" == init_started || "$CLOSE_PHASE" == initialized ]]; then
    [[ -z "$CLOSE_SQUASH_SHA" ]] || die "squash_sha no puede existir antes de merge_started"
  fi
  close_validate_phase_resources
}

close_load() {
  local work_id="$1" key value journal_phase line_count
  close_dir="$(close_dir_for "$work_id")"
  if [[ ! -d "$close_dir" ]]; then return 1; fi
  [[ -f "$close_dir/meta" && -f "$close_dir/journal" ]] || die "El journal de cierre de '$work_id' está incompleto"
  line_count="$(wc -l < "$close_dir/meta" | tr -d ' ')"
  [[ "$line_count" == 13 ]] || die "El journal de cierre de '$work_id' está truncado o corrupto"
  while IFS= read -r line; do
    case "$line" in
      version=*|work_id=*|base_branch=*|branch=*|path=*|common_dir=*|origin_sha=*|before_head=*|squash_sha=*|init_requested=*|init_result=*|parent_restore=*|phase=*) ;;
      *) die "El journal de cierre de '$work_id' está corrupto" ;;
    esac
  done < "$close_dir/meta"
  for key in version work_id base_branch branch path common_dir origin_sha before_head squash_sha init_requested init_result parent_restore phase; do
    value="$(close_value "$key")"
    [[ -n "$value" || "$key" == squash_sha ]] || die "El journal de cierre de '$work_id' está incompleto ($key)"
    [[ "$(grep -c "^${key}=" "$close_dir/meta")" == 1 ]] || die "El journal de cierre de '$work_id' tiene una clave duplicada o ausente ($key)"
    case "$key" in
      version) [[ "$value" == 1 ]] || die "Versión de journal de cierre no soportada"; CLOSE_VERSION="$value" ;;
      work_id) CLOSE_WORK_ID="$value" ;;
      base_branch) CLOSE_BASE_BRANCH="$value" ;;
      branch) CLOSE_BRANCH="$value" ;;
      path) CLOSE_PATH="$value" ;;
      common_dir) CLOSE_COMMON_DIR="$value" ;;
      origin_sha) CLOSE_ORIGIN_SHA="$value" ;;
      before_head) CLOSE_BEFORE_HEAD="$value" ;;
      squash_sha) CLOSE_SQUASH_SHA="$value" ;;
      init_requested) CLOSE_INIT_REQUESTED="$value" ;;
      init_result) CLOSE_INIT_RESULT="$value" ;;
      parent_restore) CLOSE_PARENT_RESTORE="$value" ;;
      phase) CLOSE_PHASE="$value" ;;
    esac
  done
  line_count="$(wc -l < "$close_dir/journal" | tr -d ' ')"
  [[ "$line_count" == 1 ]] || die "El journal de cierre de '$work_id' está truncado o corrupto"
  [[ "$(tail -c 1 "$close_dir/journal" | od -An -t x1 | tr -d '[:space:]')" == 0a ]] || die "El journal de cierre de '$work_id' está truncado o corrupto"
  journal_phase="$(cat "$close_dir/journal")"
  case "$journal_phase" in
    created|init_started|initialized|merge_started|merged|deinit_started|deinitialized|remove_started|removed|branch_cleanup_started|closed) ;;
    *) die "El journal de cierre de '$work_id' está corrupto" ;;
  esac
  [[ "$journal_phase" == "$CLOSE_PHASE" ]] || die "El journal de cierre de '$work_id' no coincide con meta.phase"
  [[ "$CLOSE_WORK_ID" == "$work_id" ]] || die "El journal de cierre no coincide con el trabajo solicitado"
  [[ "$CLOSE_BRANCH" == "$(worktree_branch_for "$work_id")" ]] || die "El journal de cierre no coincide con la rama"
  [[ "$CLOSE_PATH" == "$(worktree_path_abs_for "$work_id")" ]] || die "El journal de cierre no coincide con la ruta"
  [[ "$CLOSE_COMMON_DIR" == "$GIT_COMMON_DIR" ]] || die "El journal de cierre no coincide con el repositorio"
  valid_bool "$CLOSE_INIT_REQUESTED" || die "init_requested inválido en el journal de cierre"
  case "$CLOSE_INIT_RESULT" in not_requested|pending|initialized) ;; *) die "init_result inválido en el journal de cierre" ;; esac
  case "$CLOSE_PARENT_RESTORE" in not_restored|restored_clean|restored_dirty|pending_manual) ;; *) die "parent_restore inválido en el journal de cierre" ;; esac
  case "$CLOSE_PHASE" in created|init_started|initialized|merge_started|merged|deinit_started|deinitialized|remove_started|removed|branch_cleanup_started|closed) ;; *) die "Fase de cierre desconocida" ;; esac
  close_validate_record
  return 0
}

close_bootstrap() {
  local work_id="$1" base="$2" branch path_abs
  branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"
  close_dir="$(close_dir_for "$work_id")"
  CLOSE_VERSION=1; CLOSE_WORK_ID="$work_id"; CLOSE_BASE_BRANCH="$base"
  CLOSE_BRANCH="$branch"; CLOSE_PATH="$path_abs"; CLOSE_COMMON_DIR="$GIT_COMMON_DIR"
  CLOSE_ORIGIN_SHA="$(git rev-parse "refs/heads/$branch")"; CLOSE_BEFORE_HEAD="$(git rev-parse "refs/heads/$base")"
  CLOSE_SQUASH_SHA=""; CLOSE_INIT_REQUESTED="false"; CLOSE_INIT_RESULT="not_requested"
  CLOSE_PARENT_RESTORE="not_restored"; CLOSE_PHASE="created"
  close_write_phase created
}

close_init_from_record() {
  local requested="$1" path_abs="$CLOSE_PATH"
  if [[ "$requested" == true ]]; then
    if [[ "$CLOSE_INIT_REQUESTED" == false ]]; then
      CLOSE_INIT_REQUESTED=true; CLOSE_INIT_RESULT=pending; close_write_meta
    fi
  fi
  [[ "$CLOSE_INIT_REQUESTED" == true ]] || return 0
  [[ "$CLOSE_INIT_RESULT" == initialized && "$CLOSE_PHASE" != init_started ]] && return 0
  if [[ "$CLOSE_PHASE" == created ]]; then close_write_phase init_started; else CLOSE_PHASE=init_started; close_write_meta; printf 'init_started\n' > "$close_dir/.journal.tmp"; mv -f "$close_dir/.journal.tmp" "$close_dir/journal"; fi
  close_crash_hook init_started
  close_test_counter init
  if ! git -C "$path_abs" submodule update --init --recursive >/dev/null; then
    CLOSE_INIT_RESULT=pending; close_write_meta
    return 1
  fi
  close_verify_initialized "$path_abs" || { CLOSE_INIT_RESULT=pending; close_write_meta; return 1; }
  CLOSE_INIT_RESULT=initialized; close_write_phase initialized
  return 0
}

submodule_gitlinks() {
  git -C "$1" ls-files -s | awk '$1 == "160000" { print $2 " " $4 }'
}

submodule_status_lines() {
  git -C "$1" submodule status --recursive 2>/dev/null
}

close_verify_initialized() {
  local root="$1" line marker rest expected actual sm_path status_lines
  if ! status_lines="$(submodule_status_lines "$root")"; then
    die "No se pudo verificar el estado de los submodules"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    marker="${line:0:1}"; rest="${line:1}"
    expected="${rest%% *}"; sm_path="${rest#* }"; sm_path="${sm_path%% *}"
    [[ "$marker" != "-" && "$marker" != "U" ]] || { printf '%s\n' "No se pudo inicializar el submodule '$sm_path'" >&2; return 1; }
    actual="$(git -C "$root/$sm_path" rev-parse HEAD 2>/dev/null || true)"
    [[ "$actual" == "$expected" ]] || { printf '%s\n' "El submodule '$sm_path' no coincide con su gitlink" >&2; return 1; }
  done <<< "$status_lines"
}

capture_transaction() {
  local tx_id="$1" tx_dir="$2" path tree_sha tmp_index
  TX_TRACKED_SHA=""; TX_UNTRACKED_SHA=""
  if [[ -s "$tx_dir/tracked.paths" ]]; then
    TX_TRACKED_SHA="$(git stash create "worktree-manager-backup $tx_id")"
    [[ -n "$TX_TRACKED_SHA" ]] || { abort_capture_cleanup "$tx_id"; die "La captura del estado del destino falló; el cierre fue cancelado y no se modificó nada."; }
    git update-ref "refs/flowtask/backups/$tx_id" "$TX_TRACKED_SHA"
  fi
  if [[ -s "$tx_dir/untracked.paths" ]]; then
    tmp_index="$(mktemp "${TMPDIR:-/tmp}/worktree-manager-index.XXXXXX")"
    GIT_INDEX_FILE="$tmp_index" git read-tree --empty
    GIT_INDEX_FILE="$tmp_index" git update-index --add -z --stdin < "$tx_dir/untracked.paths"
    tree_sha="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
    rm -f -- "$tmp_index"
    TX_UNTRACKED_SHA="$(git commit-tree "$tree_sha" -m "worktree-manager-backup-untracked $tx_id")"
    git update-ref "refs/flowtask/backups/$tx_id-untracked" "$TX_UNTRACKED_SHA"
  fi
  if [[ -n "$TX_TRACKED_SHA" ]]; then while IFS= read -r -d '' path; do git cat-file -e "$TX_TRACKED_SHA:$path" >/dev/null 2>&1 || { abort_capture_cleanup "$tx_id"; die "La verificación de la captura falló; el cierre fue cancelado y no se modificó nada."; }; done < "$tx_dir/tracked.paths"; fi
  if [[ -n "$TX_UNTRACKED_SHA" ]]; then while IFS= read -r -d '' path; do git cat-file -e "$TX_UNTRACKED_SHA:$path" >/dev/null 2>&1 || { abort_capture_cleanup "$tx_id"; die "La verificación de la captura falló; el cierre fue cancelado y no se modificó nada."; }; done < "$tx_dir/untracked.paths"; fi
}

abort_capture_cleanup() {
  local tx_id="$1"
  git update-ref -d "refs/flowtask/backups/$tx_id" >/dev/null 2>&1 || true
  git update-ref -d "refs/flowtask/backups/$tx_id-untracked" >/dev/null 2>&1 || true
  rm -rf -- "$(tx_dir_for "$tx_id")" "$(legacy_tx_dir_for "$tx_id")"
}

clean_destination() {
  local tx_dir="$1" path
  if [[ -s "$tx_dir/tracked.paths" ]]; then git restore --source=HEAD --staged --worktree -- ./ >/dev/null 2>&1 || { journal_write "$tx_dir" captured; die "La limpieza del destino falló; la transacción quedó en fase captured. Ejecutá 'worktree.sh recover'."; }; fi
  if [[ -s "$tx_dir/untracked.paths" ]]; then while IFS= read -r -d '' path; do [[ -e "$path" || -L "$path" ]] && rm -f -- "$path"; done < "$tx_dir/untracked.paths"; fi
}

merge_squash_branch() {
  local base="$1" branch="$2" before="$3" after parents
  git switch "$base" >/dev/null
  git merge --squash "$branch" >/dev/null || return 1
  git diff --cached --quiet && return 1
  git commit -m "squash merge $branch into $base" >/dev/null
  after="$(git rev-parse HEAD)"
  [[ "$after" != "$before" ]] || return 1
  parents="$(git rev-list --parents -n 1 HEAD)"
  [[ "$(wc -w <<< "$parents" | tr -d ' ')" == 2 && "${parents#* }" == "$before" ]] || return 1
  SQUASH_SHA="$after"
  return 0
}

restore_transaction() {
  local tx_id="$1" tx_dir="$2" path collision=0
  if [[ -n "${TX_TRACKED_SHA:-}" ]]; then
    git stash apply --index "refs/flowtask/backups/$tx_id" >/dev/null 2>&1 || { mark_pending_manual "$tx_dir" "$tx_id"; return 1; }
  fi
  if [[ -n "${TX_UNTRACKED_SHA:-}" ]]; then
    while IFS= read -r -d '' path; do if [[ -e "$path" || -L "$path" ]]; then collision=1; break; fi; done < <(git ls-tree -r -z --name-only "refs/flowtask/backups/$tx_id-untracked")
    if (( collision )); then mark_pending_manual "$tx_dir" "$tx_id"; return 1; fi
    while IFS= read -r -d '' path; do git restore --source="refs/flowtask/backups/$tx_id-untracked" --worktree -- "./$path" >/dev/null 2>&1 || { mark_pending_manual "$tx_dir" "$tx_id"; return 1; }; done < <(git ls-tree -r -z --name-only "refs/flowtask/backups/$tx_id-untracked")
  fi
}

print_pending_manual_instructions() {
  local tx_id="$1"
  cat >&2 <<EOF
La restauración automática falló; la transacción $tx_id quedó pendiente-manual.
La fusión quedó aplicada y el backup permanece intacto; nada fue descartado.
Pasos seguros para resolverlo vos mismo (reemplazá solo el identificador):
  git stash apply --index refs/flowtask/backups/$tx_id
  git restore --source=refs/flowtask/backups/$tx_id-untracked --worktree -- .
Inspeccioná el resultado con 'git status' antes de seguir.
EOF
}
mark_pending_manual() { journal_write "$1" pending_manual; print_pending_manual_instructions "$2"; }

latest_pending_tx_id() {
  local d phase found=() i
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    [[ "$phase" != restored && -n "$phase" ]] && found+=("$d")
  done
  for ((i=${#found[@]}-1; i>=0; i--)); do printf '%s' "$(basename "${found[i]}")"; return 0; done
  return 1
}

run_action() {
  local action="$1" command="$2" path_abs="$3"
  (cd -- "$path_abs" && bash -c "$command")
}

parse_destination_status() {
  local root="$1" rec code path
  DEST_STAGED=0; DEST_UNSTAGED=0; DEST_UNTRACKED=0
  : > "$TMP_STATE_DIR/dest.tracked"; : > "$TMP_STATE_DIR/dest.untracked"
  while IFS= read -r -d '' rec; do
    code="${rec:0:2}"; path="${rec:3}"
    case "$code" in R?|C?) IFS= read -r -d '' rec || true ;; esac
    [[ "$path" == .flowtask/backups/* ]] && continue
    if [[ "$code" == '??' ]]; then DEST_UNTRACKED=1; printf '%s\0' "$path" >> "$TMP_STATE_DIR/dest.untracked"; else
      [[ "${code:0:1}" != " " ]] && DEST_STAGED=1
      [[ "${code:1:1}" != " " ]] && DEST_UNSTAGED=1
      printf '%s\0' "$path" >> "$TMP_STATE_DIR/dest.tracked"
    fi
  done < <(git -C "$root" status --porcelain -z --untracked-files=all)
}

detect_unsupported() {
  local tracked_list="$1" path fields value unsupported=""
  preserve_submodules_clean "$REPO_ROOT" || return 1
  if [[ "$(git config --bool core.sparsecheckout 2>/dev/null || true)" == true ]] || git sparse-checkout list >/dev/null 2>&1; then unsupported+="sparse-checkout "; fi
  while IFS= read -r -d '' path; do
    fields=(); while IFS= read -r -d '' value; do fields+=("$value"); done < <(git check-attr -z filter -- "./$path")
    [[ -z "${fields[2]:-}" || "${fields[2]}" == unspecified ]] || { unsupported+="filters "; break; }
  done < "$tracked_list"
  [[ -z "$unsupported" ]] || { printf 'Aviso: setup no soportado para preservar cambios: %s\n' "${unsupported% }" >&2; return 1; }
  if [[ -n "$(git ls-files --others --ignored --exclude-standard --directory | grep -v '^\.flowtask/backups/\?$' || true)" ]]; then printf '%s\n' "Aviso: hay archivos ignorados en el destino; quedan fuera de la captura y no serán tocados." >&2; fi
}

# A declared submodule is not part of the parent's dirty payload when it is
# uninitialized.  Once active, however, preservation must be able to prove
# that its checkout is clean and exactly at the recorded gitlink.  Keep this
# check separate from close_worktree_gitlinks_clean because it must not use the
# close journal's init intent and must report verification failures to the
# caller rather than exiting the process.
preserve_submodules_clean() {
  local root="$1" line marker rest expected sm_path child child_status status_lines
  if ! status_lines="$(git -C "$root" submodule status --recursive 2>/dev/null)"; then
    printf '%s\n' "Aviso: no se pudo verificar el estado de los submodules; se bloquea la preservación." >&2
    return 1
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    marker="${line:0:1}"
    rest="${line:1}"
    expected="${rest%% *}"
    sm_path="${rest#* }"
    sm_path="${sm_path%% *}"
    case "$marker" in
      -) continue ;;
      +) printf '%s\n' "Aviso: el submodule '$sm_path' diverge de su gitlink; se bloquea la preservación." >&2; return 1 ;;
      U) printf '%s\n' "Aviso: el submodule '$sm_path' tiene un conflicto; se bloquea la preservación." >&2; return 1 ;;
      ' ') ;;
      *) printf '%s\n' "Aviso: no se pudo interpretar el estado del submodule '$sm_path'; se bloquea la preservación." >&2; return 1 ;;
    esac
    child="$root/$sm_path"
    if ! child_status="$(git -C "$child" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
      printf '%s\n' "Aviso: no se pudo verificar el submodule '$sm_path'; se bloquea la preservación." >&2
      return 1
    fi
    [[ -z "$child_status" ]] || { printf '%s\n' "Aviso: el submodule '$sm_path' tiene cambios locales; se bloquea la preservación." >&2; return 1; }
    if [[ "$(git -C "$child" rev-parse HEAD 2>/dev/null || true)" != "$expected" ]]; then
      printf '%s\n' "Aviso: el submodule '$sm_path' diverge de su gitlink; se bloquea la preservación." >&2
      return 1
    fi
  done <<< "$status_lines"
}

consent_preserve_dirty() {
  [[ "${1:-0}" == 1 || "$PRESERVE_DIRTY" == 1 ]] && return 0
  [[ -f "$REPO_ROOT/.flowtask/config/worktree.json" ]] && grep -Eq '"preserveDirty"[[:space:]]*:[[:space:]]*true' "$REPO_ROOT/.flowtask/config/worktree.json"
}

complete_has_other_pending_transaction() {
  local expected_work_id="$1" d phase tx_work
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    case "$phase" in restored|pending_manual|"") continue ;; esac
    tx_work="$(meta_value "$d" work_id)"; [[ -n "$tx_work" ]] || tx_work="$(meta_value "$d" ca_name)"
    [[ "$tx_work" == "$expected_work_id" ]] || die "Existe una transacción de preservación pendiente ($(basename "$d"), fase $phase). Ejecutá 'worktree.sh recover $(basename "$d")' antes de reintentar el cierre."
  done
}

complete_blocks_pending_manual() {
  local expected_work_id="$1" expected_branch="$2" expected_path="$3"
  local d phase tx_id tx_work tx_branch tx_path
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    [[ "$phase" == pending_manual ]] || continue
    tx_id="$(basename "$d")"
    tx_work="$(meta_value "$d" work_id)"; [[ -n "$tx_work" ]] || tx_work="$(meta_value "$d" ca_name)"
    tx_branch="$(meta_value "$d" branch)"
    tx_path="$(meta_value "$d" path)"
    if [[ "$tx_work" == "$expected_work_id" || ( "$tx_branch" == "$expected_branch" && "$tx_path" == "$expected_path" ) ]]; then
      die "La transacción de preservación '$tx_id' está en pending_manual para '$expected_work_id'; resolvé la restauración manual y ejecutá 'worktree.sh recover $tx_id' antes de reintentar complete. Se conservan el worktree, la rama y la base."
    fi
  done
}

close_pending_transaction_for() {
  local work_id="$1" d phase tx_work
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    case "$phase" in restored|pending_manual|"") continue ;; esac
    tx_work="$(meta_value "$d" work_id)"; [[ -n "$tx_work" ]] || tx_work="$(meta_value "$d" ca_name)"
    [[ "$tx_work" == "$work_id" ]] && { printf '%s\n' "$(basename "$d")"; return 0; }
  done
  return 1
}

close_restored_transaction_for() {
  local work_id="$1" d phase tx_work
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    [[ "$phase" == restored ]] || continue
    tx_work="$(meta_value "$d" work_id)"; [[ -n "$tx_work" ]] || tx_work="$(meta_value "$d" ca_name)"
    [[ "$tx_work" == "$work_id" ]] && { printf '%s\n' "$(basename "$d")"; return 0; }
  done
  return 1
}

close_worktree_gitlinks_clean() {
  local root="$1" line marker rest expected sm_path child status status_lines
  if ! status_lines="$(submodule_status_lines "$root")"; then
    die "No se pudo verificar el estado de los submodules"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    marker="${line:0:1}"; rest="${line:1}"; expected="${rest%% *}"; sm_path="${rest#* }"; sm_path="${sm_path%% *}"
    case "$marker" in
      +|U) die "Submodule '$sm_path' tiene cambios o conflicto" ;;
      -) [[ "$CLOSE_INIT_REQUESTED" == false ]] || die "Submodule '$sm_path' no está inicializado aunque fue solicitado"; continue ;;
    esac
    child="$root/$sm_path"
    status="$(git -C "$child" status --porcelain=v1 --untracked-files=all --ignored 2>/dev/null || true)"
    [[ -z "$status" ]] || die "Submodule '$sm_path' tiene cambios locales"
    [[ "$(git -C "$child" rev-parse HEAD 2>/dev/null || true)" == "$expected" ]] || die "Submodule '$sm_path' diverge de su gitlink"
  done <<< "$status_lines"
}

close_verify_deinitialized() {
  local root="$1" expected_gitdir line marker rest sm_path child status_lines
  expected_gitdir="$(git rev-parse --path-format=absolute --git-path modules 2>/dev/null || true)"
  [[ "$expected_gitdir" == "$GIT_COMMON_DIR/modules" ]] || die "El almacenamiento de módulos no coincide con el repositorio común"
  if ! status_lines="$(submodule_status_lines "$root")"; then
    die "No se pudo verificar el estado de los submodules"
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    marker="${line:0:1}"; rest="${line:1}"; sm_path="${rest#* }"; sm_path="${sm_path%% *}"
    [[ "$marker" == "-" ]] || die "El submodule '$sm_path' sigue inicializado después de deinit"
    child="$root/$sm_path"
    [[ ! -e "$child/.git" && ! -d "$child/.git" ]] || die "El checkout del submodule '$sm_path' sigue activo"
    [[ -z "$(find "$child" -mindepth 1 -name .git -print -quit 2>/dev/null)" ]] || die "Un checkout nested de '$sm_path' sigue activo"
  done <<< "$status_lines"
  while read -r _ sm_path; do
    [[ -n "$sm_path" ]] || continue
    [[ ! -e "$root/$sm_path/.git" && ! -d "$root/$sm_path/.git" ]] || die "El checkout nested '$sm_path' sigue activo"
  done < <(submodule_gitlinks "$root")
}

close_preflight() {
  local work_id="$1" base="$2" preserve_flag="$3" branch="$CLOSE_BRANCH" path_abs="$CLOSE_PATH"
  local problems="" staged_files="" unstaged_files="" untracked_files="" status_line line own_commits stash_entries worktree_common
  validate_identity "$work_id"
  [[ "$(git -C "$path_abs" rev-parse --show-toplevel 2>/dev/null)" == "$path_abs" ]] || die "El worktree no coincide con su raíz"
  worktree_common="$(git -C "$path_abs" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ "$worktree_common" = /* ]] || worktree_common="$path_abs/$worktree_common"
  worktree_common="$(cd -- "$worktree_common" 2>/dev/null && pwd -P || true)"
  [[ "$worktree_common" == "$GIT_COMMON_DIR" ]] || die "El worktree no coincide con git-common-dir"
  [[ "$(git -C "$path_abs" symbolic-ref -q HEAD)" == "refs/heads/$branch" ]] || die "La rama simbólica del worktree no coincide"
  [[ "$(git -C "$path_abs" rev-parse HEAD)" == "$(git rev-parse "refs/heads/$branch")" ]] || die "HEAD del worktree no coincide con su rama"
  [[ "$(git rev-parse "refs/heads/$branch")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de completar"
  status_line="$(git -C "$path_abs" status --porcelain --untracked-files=all)"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if [[ "${line:0:2}" == '??' ]]; then untracked_files+="${line:3}"$'\n'; else [[ "${line:0:1}" != " " ]] && staged_files+="${line:3}"$'\n'; [[ "${line:1:1}" != " " ]] && unstaged_files+="${line:3}"$'\n'; fi
  done <<< "$status_line"
  [[ -z "$staged_files" ]] || problems+=$'\n- Worktree: cambios staged:\n'"$staged_files"$'  Acción: crear el commit del worktree antes de reintentar.\n'
  [[ -z "$unstaged_files" ]] || problems+=$'\n- Worktree: cambios unstaged:\n'"$unstaged_files"$'  Acción: crear el commit del worktree antes de reintentar.\n'
  [[ -z "$untracked_files" ]] || problems+=$'\n- Worktree: archivos untracked:\n'"$untracked_files"$'  Acción: agregar y crear el commit del worktree antes de reintentar.\n'
  close_worktree_gitlinks_clean "$path_abs"
  own_commits="$(git rev-list --count "$base..$branch")"; (( own_commits > 0 )) || problems+=$'\n- Worktree: falta crear el commit propio antes de completar.\n'
  stash_entries="$(git stash list)"; [[ -z "$stash_entries" ]] || problems+=$'\n- Repositorio: hay stash pendiente.\n  Acción: resolver o restaurar los stashes de forma segura antes de reintentar.\n'
  parse_destination_status "$REPO_ROOT"
  if (( DEST_STAGED || DEST_UNSTAGED || DEST_UNTRACKED )); then
    consent_preserve_dirty "$preserve_flag" || dirty_destination_rejection "$work_id" "$base"
    detect_unsupported "$TMP_STATE_DIR/dest.tracked" || dirty_destination_rejection "$work_id" "$base"
  fi
  [[ -z "$problems" ]] || die "No se puede completar '$work_id'; se detectaron problemas antes de integrar o limpiar:$problems"
}

close_merge_verified() {
  local base="$CLOSE_BASE_BRANCH" branch="$CLOSE_BRANCH" before="$CLOSE_BEFORE_HEAD" parents registered_path worktree_common worktree_head
  [[ -d "$CLOSE_PATH" ]] || die "La fase merge_started perdió el worktree; no se modifica la base"
  worktree_registered_for_path "$CLOSE_PATH" || die "La fase merge_started perdió el registro del worktree; no se modifica la base"
  registered_path="$(worktree_registered_for_branch "$branch" || true)"
  [[ "$registered_path" == "$CLOSE_PATH" ]] || die "La fase merge_started no coincide con la rama registrada; no se modifica la base"
  branch_exists "$branch" || die "La fase merge_started perdió la rama; no se modifica la base"
  [[ "$(git -C "$CLOSE_PATH" rev-parse --show-toplevel 2>/dev/null || true)" == "$CLOSE_PATH" ]] || die "La fase merge_started tiene una raíz de worktree ambigua; no se modifica la base"
  worktree_common="$(git -C "$CLOSE_PATH" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ "$worktree_common" = /* ]] || worktree_common="$CLOSE_PATH/$worktree_common"
  worktree_common="$(cd -- "$worktree_common" 2>/dev/null && pwd -P || true)"
  [[ "$worktree_common" == "$CLOSE_COMMON_DIR" && "$worktree_common" == "$GIT_COMMON_DIR" ]] || die "La fase merge_started no coincide con git-common-dir; no se modifica la base"
  [[ "$(git -C "$CLOSE_PATH" symbolic-ref -q HEAD 2>/dev/null || true)" == "refs/heads/$branch" ]] || die "La fase merge_started no coincide con HEAD; no se modifica la base"
  worktree_head="$(git -C "$CLOSE_PATH" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$worktree_head" && "$worktree_head" == "$(git rev-parse "refs/heads/$branch")" ]] || die "La fase merge_started no coincide con la rama; no se modifica la base"
  [[ "$(git rev-parse "refs/heads/$branch")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de reanudar el squash; no se modifica la base"
  if [[ -n "$CLOSE_SQUASH_SHA" ]]; then
    [[ "$(git rev-parse "refs/heads/$base")" == "$CLOSE_SQUASH_SHA" ]] || die "El squash registrado no coincide con la base; estado ambiguo, no repito la integración"
    parents="$(git rev-list --parents -n 1 "$CLOSE_SQUASH_SHA")"
    [[ "$(wc -w <<< "$parents" | tr -d ' ')" == 2 && "${parents#* }" == "$before" ]] || die "El squash registrado no coincide con el parent esperado"
    [[ "$(git rev-list --count "$before..$CLOSE_SQUASH_SHA")" == 1 ]] || die "El squash registrado no es único"
    return 0
  fi
  [[ "$(git rev-parse "refs/heads/$base")" == "$before" ]] || die "El estado del squash es ambiguo; no repito la integración"
  close_test_counter squash
  if ! merge_squash_branch "$base" "$branch" "$before"; then
    git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true
    die "Conflicto al hacer squash-merge de '$branch' en '$base'; el worktree se conserva"
  fi
  CLOSE_SQUASH_SHA="$SQUASH_SHA"; close_write_meta
}

complete_worktree() {
  local work_id="$1" base="$2" preserve_flag="$3" init_flag="$4"
  local tx_id="" tx_dir="" path="$(worktree_path_for "$work_id")" status_after
  CLOSE_OPERATION=complete
  validate_work_id "$work_id"; normalize_base_branch "$base"
  if [[ -d "$(close_dir_for "$work_id")" ]]; then
    close_load "$work_id"
  elif [[ -e "$(close_dir_for "$work_id")" ]]; then
    die "El journal de cierre de '$work_id' está corrupto"
  else
    validate_identity "$work_id"; close_bootstrap "$work_id" "$base"
  fi
  [[ "$CLOSE_BASE_BRANCH" == "$base" ]] || die "El journal de cierre usa otra rama base"
  complete_blocks_pending_manual "$work_id" "$CLOSE_BRANCH" "$CLOSE_PATH"
  if [[ "$CLOSE_PHASE" == closed ]]; then
    [[ ! -e "$CLOSE_PATH" ]] || die "El journal cerrado tiene recursos reintroducidos"
    worktree_registered_for_path "$CLOSE_PATH" && die "El journal cerrado tiene recursos reintroducidos"
    branch_exists "$CLOSE_BRANCH" && die "El journal cerrado tiene una rama reintroducida"
    printf 'operation: complete\nresult: success\ncompleted: %s\nphase: closed\n' "$work_id"
    return 0
  fi
  complete_has_other_pending_transaction "$work_id"
  if [[ "$CLOSE_PHASE" == created ]]; then
    tx_id="$(close_restored_transaction_for "$work_id" || true)"
    if [[ -n "$tx_id" ]]; then
      tx_dir="$(tx_dir_read "$tx_id")"
      CLOSE_SQUASH_SHA="$(meta_value "$tx_dir" squash_commit)"
      [[ -n "$CLOSE_SQUASH_SHA" && "$(git rev-parse "refs/heads/$base")" == "$CLOSE_SQUASH_SHA" ]] || die "La transacción restaurada no coincide con el cierre"
      CLOSE_PARENT_RESTORE=restored_dirty
      [[ -z "$(git status --porcelain --untracked-files=all)" ]] && CLOSE_PARENT_RESTORE=restored_clean
      close_write_phase merged
    fi
  fi
  if [[ "$CLOSE_PHASE" == created || "$CLOSE_PHASE" == init_started ]]; then
    close_init_from_record "$init_flag" || die "No se pudo inicializar los submodules; se conserva el worktree y el journal"
  fi
  if [[ "$CLOSE_PHASE" == initialized || "$CLOSE_PHASE" == created ]]; then
    # create records the initial branch tip, but complete must capture the
    # immutable branch SHA immediately before the squash (the worktree commit
    # is expected to have advanced it).
    CLOSE_ORIGIN_SHA="$(git rev-parse "refs/heads/$CLOSE_BRANCH")"
    CLOSE_BEFORE_HEAD="$(git rev-parse "refs/heads/$base")"
    close_write_meta
    close_preflight "$work_id" "$base" "$preserve_flag"
    if (( DEST_STAGED || DEST_UNSTAGED || DEST_UNTRACKED )); then
      tx_id="$(close_pending_transaction_for "$work_id" || true)"
      if [[ -z "$tx_id" ]]; then
        tx_id="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
        tx_dir="$(tx_dir_for "$tx_id")"; mkdir -p -- "$tx_dir" "$(legacy_mirror_dir "$tx_id")"
        cp -- "$TMP_STATE_DIR/dest.tracked" "$tx_dir/tracked.paths"; cp -- "$TMP_STATE_DIR/dest.untracked" "$tx_dir/untracked.paths"
        mirror_tx_payload "$tx_dir"
        write_meta "$tx_dir" "$work_id" "$base" "$CLOSE_BRANCH" "$CLOSE_PATH" "$CLOSE_ORIGIN_SHA"
        capture_transaction "$tx_id" "$tx_dir"; journal_write "$tx_dir" captured
      else tx_dir="$(tx_dir_read "$tx_id")"; fi
      [[ "$(journal_read "$tx_dir")" != captured ]] || clean_destination "$tx_dir"
      journal_write "$tx_dir" merge_started
    fi
    close_write_phase merge_started; close_crash_hook merge_started
  fi
  if [[ "$CLOSE_PHASE" == merge_started ]]; then
    close_merge_verified
    tx_id="$(close_pending_transaction_for "$work_id" || true)"
    if [[ -n "$tx_id" ]]; then
      tx_dir="$(tx_dir_read "$tx_id")"; journal_write "$tx_dir" merged
    fi
    close_crash_hook merged_after; close_write_phase merged
  fi
  if [[ "$CLOSE_PHASE" == merged ]]; then
    tx_id="$(close_pending_transaction_for "$work_id" || true)"
    if [[ -n "$tx_id" ]]; then
      tx_dir="$(tx_dir_read "$tx_id")"
      TX_TRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id" || true)"; TX_UNTRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id-untracked" || true)"
      restore_transaction "$tx_id" "$tx_dir" || { CLOSE_PARENT_RESTORE=pending_manual; close_write_meta; return 1; }
      journal_write "$tx_dir" restored
      status_after="$(git status --porcelain --untracked-files=all)"
      [[ -n "$status_after" ]] && CLOSE_PARENT_RESTORE=restored_dirty || CLOSE_PARENT_RESTORE=restored_clean
      close_write_meta
    fi
    close_worktree_gitlinks_clean "$CLOSE_PATH"
    close_write_phase deinit_started; close_crash_hook deinit_started
    close_test_counter deinit
    git -C "$CLOSE_PATH" submodule deinit --all >/dev/null
    close_verify_deinitialized "$CLOSE_PATH"; close_crash_hook deinitialized_after; close_write_phase deinitialized
  fi
  if [[ "$CLOSE_PHASE" == deinit_started ]]; then
    [[ -e "$CLOSE_PATH" ]] || die "La fase deinit_started perdió el worktree de forma ambigua"
    worktree_registered_for_path "$CLOSE_PATH" || die "La fase deinit_started perdió el registro del worktree"
    close_verify_deinitialized "$CLOSE_PATH"; close_crash_hook deinitialized_after; close_write_phase deinitialized
  fi
  if [[ "$CLOSE_PHASE" == deinitialized ]]; then
    close_write_phase remove_started; close_crash_hook remove_started
    close_test_counter remove
    git worktree remove --force -- "$CLOSE_PATH" >/dev/null 2>&1 || die "No pude retirar el worktree cerrado; se conserva la rama"
    [[ ! -e "$CLOSE_PATH" ]] || die "El worktree sigue existiendo después de remove"
    worktree_registered_for_path "$CLOSE_PATH" && die "Git todavía registra el worktree retirado"
    close_crash_hook removed_after; close_write_phase removed
  fi
  if [[ "$CLOSE_PHASE" == remove_started ]]; then
    if [[ -e "$CLOSE_PATH" ]] && worktree_registered_for_path "$CLOSE_PATH"; then
      close_verify_deinitialized "$CLOSE_PATH"; close_test_counter remove; git worktree remove --force -- "$CLOSE_PATH" >/dev/null 2>&1 || die "No pude reanudar el retiro del worktree"
      [[ ! -e "$CLOSE_PATH" ]] || die "El worktree sigue existiendo después de remove"
      worktree_registered_for_path "$CLOSE_PATH" && die "Git todavía registra el worktree retirado"
    elif [[ -e "$CLOSE_PATH" ]] || worktree_registered_for_path "$CLOSE_PATH"; then
      die "La fase remove_started tiene un efecto ambiguo; se conserva la rama"
    fi
    branch_exists "$CLOSE_BRANCH" || die "La fase remove_started perdió la rama de forma ambigua"
    [[ "$(git rev-parse "refs/heads/$CLOSE_BRANCH")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió después del retiro; no avanzo el journal"
    close_crash_hook removed_after; close_write_phase removed
  fi
  if [[ "$CLOSE_PHASE" == removed || "$CLOSE_PHASE" == branch_cleanup_started ]]; then
    [[ ! -e "$CLOSE_PATH" ]] || die "La rama no puede limpiarse mientras exista el worktree"
    worktree_registered_for_path "$CLOSE_PATH" && die "Git todavía registra el worktree retirado"
    [[ "$CLOSE_PHASE" == branch_cleanup_started ]] || { close_write_phase branch_cleanup_started; close_crash_hook branch_cleanup_started; }
    if branch_exists "$CLOSE_BRANCH"; then
      [[ "$(git rev-parse "refs/heads/$CLOSE_BRANCH")" == "$CLOSE_ORIGIN_SHA" ]] || die "La rama cambió antes de la limpieza del cierre"
      close_test_counter branch_cleanup
      git update-ref -d "refs/heads/$CLOSE_BRANCH" "$CLOSE_ORIGIN_SHA" || die "No pude retirar la rama cerrada"
    fi
    branch_exists "$CLOSE_BRANCH" && die "La rama cerrada todavía existe"
    close_crash_hook branch_cleanup_after; close_write_phase closed
  fi
  printf 'operation: complete\nresult: success\n%smerge: success\ncompleted: %s\nbranch: %s\nbase_branch: %s\nworktree: %s/\n' "${tx_id:+preserve: $tx_id\n}" "$work_id" "$CLOSE_BRANCH" "$base" "$path"
}

dirty_destination_rejection() {
  local work_id="$1" base="$2"
  printf '%s\n' "Advertencia: no se puede completar '$work_id': el destino tiene cambios sin commitear." >&2
  printf '%s\n' "El cierre fue cancelado; no se modificó nada." >&2
  printf '%s\n' "Para reintentar con un merge seguro preservando cambios locales, ejecutá:" >&2
  printf '%s\n' "  worktree.sh complete '$work_id' --base '$base' --preserve-dirty" >&2
  printf '%s\n' "--preserve-dirty respalda temporalmente los cambios staged, unstaged y untracked, ejecuta el merge y los restaura; no crea un commit." >&2
  exit 1
}

complete_worktree_clean() { complete_worktree "$1" "$2" 0 "${4:-false}"; }

recover_transaction() {
  # B2: this runs while the caller holds destination+work locks.  It re-reads the
  # journal and the metadata and compares them against the candidate values read
  # *before* the locks were taken, so a concurrent mutation is rejected instead
  # of merged or restored.
  local tx_id="$1" expected_work_id="$2"
  local tx_dir phase work_id base branch path_abs origin_sha squash before
  tx_dir="$(tx_dir_read "$tx_id")" || die "No existe la transacción '$tx_id'"
  phase="$(journal_read "$tx_dir" || true)"; case "$phase" in captured|merge_started|merged|pending_manual|restored) ;; *) die "La transacción '$tx_id' no tiene un journal válido" ;; esac
  work_id="$(meta_value "$tx_dir" work_id)"; [[ -n "$work_id" ]] || work_id="$(meta_value "$tx_dir" ca_name)"; base="$(meta_value "$tx_dir" base_branch)"; branch="$(meta_value "$tx_dir" branch)"; path_abs="$(meta_value "$tx_dir" path)"; origin_sha="$(meta_value "$tx_dir" origin_sha)"; squash="$(meta_value "$tx_dir" squash_commit)"
  validate_work_id "$work_id"
  # Discrepancia bajo lock: el candidato cambió mientras esperábamos el recurso.
  [[ "$work_id" == "$expected_work_id" ]] || die "La transacción '$tx_id' cambió de identidad mientras se tomaban los locks; no toco nada"
  [[ -n "$branch" ]] || branch="$(worktree_branch_for "$work_id")"; [[ -n "$path_abs" ]] || path_abs="$(worktree_path_abs_for "$work_id")"; [[ -n "$base" ]] || die "La transacción '$tx_id' tiene meta incompleto"; normalize_base_branch "$base"
  [[ "$branch" == "$(worktree_branch_for "$work_id")" && "$path_abs" == "$(worktree_path_abs_for "$work_id")" ]] || die "La transacción '$tx_id' no coincide con su identidad"
  [[ "$phase" != pending_manual ]] || { print_pending_manual_instructions "$tx_id"; return 1; }
  [[ "$phase" != restored ]] || { printf 'La transacción %s ya fue restaurada; no hay nada pendiente.\n' "$tx_id"; return 0; }
  if [[ "$phase" == captured ]]; then clean_destination "$tx_dir"; fi
  if [[ "$phase" == captured || "$phase" == merge_started ]]; then
    branch_exists "$branch" || die "La rama '$branch' ya no existe; no puedo completar la recuperación de '$tx_id'"
    before="$(git rev-parse HEAD)"; merge_squash_branch "$base" "$branch" "$before" || { git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true; journal_write "$tx_dir" merge_started; die "Conflicto al reintentar la fusión para '$tx_id'; la transacción sigue en fase merge_started."; }
    squash="$SQUASH_SHA"; printf 'squash_commit: %s\n' "$squash" >> "$tx_dir/meta"; journal_write "$tx_dir" merged
  fi
  TX_TRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id" || true)"; TX_UNTRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id-untracked" || true)"
  restore_transaction "$tx_id" "$tx_dir" || return 1
  journal_write "$tx_dir" restored
  # B1: the verified squash-close capability is deliberately NOT reachable from
  # recover.  It exists only inside `complete`, so a recovery can never retire a
  # worktree or branch through the internal path; use the public cleanup instead.
  printf 'operation: recover\nresult: success\nrecovered: %s\n' "$tx_id"
  [[ -n "$squash" ]] && printf 'recursos: intactos; retiralos con cleanup %s --discard si ya no los necesitás.\n' "$work_id"
  return 0
}

create_worktree() {
  local work_id="$1" base="$2" init_submodules="$3" branch path_abs path rel prepare verify
  CLOSE_OPERATION=create
  validate_work_id "$work_id"; normalize_base_branch "$base"; branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; path="$(worktree_path_for "$work_id")"
  if (( CREATE_PREPARE == 1 )) && [[ -z "$PREPARE_COMMAND" ]]; then die "--prepare requiere prepare_command en la configuración"; fi
  if (( CREATE_VERIFY == 1 )) && [[ -z "$VERIFY_COMMAND" ]]; then die "--verify requiere verify_command en la configuración"; fi
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "La rama de trabajo '$branch' es inválida"
  branch_exists "$branch" && die "La rama '$branch' ya existe; resolvé el duplicado antes de crear un worktree nuevo"
  [[ ! -e "$path_abs" ]] || die "La ruta '$path' ya existe; limpiá el directorio antes de crear el worktree"
  ensure_ignored_local_path "$path_abs"; mkdir -p -- "$(dirname -- "$path_abs")"; git worktree add -b "$branch" "$path_abs" "$base" >/dev/null
  validate_identity "$work_id"
  close_bootstrap "$work_id" "$base"
  if [[ "$init_submodules" == true ]]; then
    close_init_from_record true || { printf 'operation: create\nresult: failed\ninit_submodules: failed\npath: %s/\nbranch: %s\n' "$path" "$branch"; return 1; }
  fi
  prepare="skipped"; verify="skipped"
  if (( PREPARE_ENABLED || CREATE_PREPARE )); then prepare="failed"; run_action prepare "$PREPARE_COMMAND" "$path_abs" && prepare="passed" || { printf 'operation: create\nresult: failed\nprepare: failed\nverify: %s\n' "$verify"; return 1; }; fi
  if (( VERIFY_ENABLED || CREATE_VERIFY )); then verify="failed"; run_action verify "$VERIFY_COMMAND" "$path_abs" && verify="passed" || { printf 'operation: create\nresult: failed\nprepare: %s\nverify: failed\n' "$prepare"; return 1; }; fi
  printf 'operation: create\nresult: success\npath: %s/\nbranch: %s\nbase_branch: %s\ninit_submodules: %s\ninit_submodules_result: %s\nprepare: %s\nverify: %s\n' "$path" "$branch" "$base" "$init_submodules" "$CLOSE_INIT_RESULT" "$prepare" "$verify"
}

cleanup_worktree() {
  local work_id="$1" discard="$2" base="$3" branch path path_abs own_commits status
  validate_work_id "$work_id"; branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; validate_identity "$work_id"; path="$(worktree_path_for "$work_id")"
  status="$(git -C "$path_abs" status --porcelain --untracked-files=all)"; own_commits="$(git rev-list --count "$base..$branch" 2>/dev/null || printf 0)"
  if [[ -n "$status" || "$own_commits" -gt 0 ]]; then
    (( discard )) || die "No se puede limpiar '$work_id': conserva cambios o commits propios; usá --discard con autorización explícita"
  fi
  if (( discard )); then git worktree remove --force -- "$path_abs" || die "No pude retirar el worktree para '$work_id'"; git branch -D -- "$branch" || die "No pude retirar la rama '$branch'"; else git worktree remove -- "$path_abs" || die "No pude retirar el worktree para '$work_id'"; git branch -d -- "$branch" || die "No pude retirar la rama '$branch'"; fi
  printf 'operation: cleanup\nresult: success\ncleanup: success\nremoved_worktree: 1\nremoved_branch: 1\ncleaned: %s\nbranch: %s\nworktree: %s/\n' "$work_id" "$branch" "$path"
}

list_worktrees() { git worktree list --porcelain; }

prune_worktrees() {
  local line current="" orphan_count=0 candidate registered existing ancestor nested
  git worktree prune
  local existing_paths=()
  while IFS= read -r line; do case "$line" in worktree\ *) current="${line#worktree }"; existing_paths+=("$current") ;; "") current="" ;; esac; done < <(git worktree list --porcelain)
  [[ -d "$WORKTREES_ROOT" ]] && while IFS= read -r -d '' candidate; do
    candidate="$(dirname -- "$candidate")"; nested=0; ancestor="$(dirname -- "$candidate")"
    while [[ "$ancestor" != "$WORKTREES_ROOT" && "$ancestor" != / ]]; do
      if [[ -e "$ancestor/.git" ]]; then nested=1; break; fi
      ancestor="$(dirname -- "$ancestor")"
    done
    (( nested )) && continue
    registered=0; for existing in "${existing_paths[@]}"; do [[ "$candidate" == "$existing" ]] && registered=1; done
    (( registered )) || { orphan_count=$((orphan_count+1)); printf 'orphan: %s\n' "$candidate"; }
  done < <(find "$WORKTREES_ROOT" -type f -name .git -print0)
  printf 'operation: prune\nresult: success\npruned: %s\n' "$orphan_count"
}

# CA2 target-direct implementation is isolated from the parent-only lifecycle.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/worktree-manager-target-direct.sh"

usage() {
  cat <<'EOF'
Uso:
  worktree.sh [--repo <directorio-absoluto>] [--config <archivo-absoluto>] create <work-id> [--base <branch>] [--init-submodules] [--prepare] [--verify]
  worktree.sh [globales] complete <work-id> [--base <branch>] [--init-submodules] [--preserve-dirty]
  worktree.sh [globales] cleanup <work-id> [--base <branch>] [--discard]
  worktree.sh [globales] recover [<transaction-id>]
  worktree.sh [globales] prune | list

  target-direct:
  worktree.sh --repo <submodule> --parent-repo <parent> create <CA_ID> --target submodule --submodule-path <REL> --base <branch> --link-parent staged-only
  worktree.sh --repo <submodule> --parent-repo <parent> link-parent <CA_ID> --target submodule --submodule-path <REL> --link-parent staged-only
  worktree.sh --repo <submodule> --parent-repo <parent> abort <CA_ID> --target submodule --submodule-path <REL> --link-parent staged-only [--tx <TX_ID>]

La configuración es un archivo de datos key=value; nunca se ejecuta como shell.
EOF
}

worktree_manager_main() {
  local target_status
  target_direct_main "$@" || target_status=$?
  if [[ -n "${target_status:-}" && "$target_status" -ne 10 ]]; then exit "$target_status"; fi
  [[ -n "${target_status:-}" ]] && unset target_status || return 0
  local requested_repo="" requested_config="" command arg base
  CREATE_PREPARE=0; CREATE_VERIFY=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repo) [[ $# -ge 2 ]] || die "Falta el valor de --repo"; requested_repo="$2"; shift 2 ;;
      --config) [[ $# -ge 2 ]] || die "Falta el valor de --config"; requested_config="$2"; shift 2 ;;
      -*) break ;;
      *) break ;;
    esac
  done
  resolve_repo "$requested_repo"; load_configuration "$requested_config"
  command="${1:-}"; shift || true
  case "$command" in
    create)
      local work_id="${1:-}"; shift || true; base="$(detect_base_branch)"; init_submodules=false
      while [[ $# -gt 0 ]]; do case "$1" in --base) [[ $# -ge 2 ]] || die "Falta la rama después de --base"; base="$2"; shift 2 ;; --init-submodules) init_submodules=true; shift ;; --prepare) CREATE_PREPARE=1; shift ;; --verify) CREATE_VERIFY=1; shift ;; *) die "Opción o argumento desconocido para create: $1" ;; esac; done
      [[ -n "$work_id" ]] || die "Falta el identificador de trabajo"; acquire_locks create "work/$(encode_work_id "$work_id")"; trap release_locks EXIT; create_worktree "$work_id" "$base" "$init_submodules" ;;
    complete)
      local work_id="${1:-}" preserve=0 init_submodules=false; shift || true; base="$(detect_base_branch)"
      while [[ $# -gt 0 ]]; do case "$1" in --base) [[ $# -ge 2 ]] || die "Falta la rama después de --base"; base="$2"; shift 2 ;; --init-submodules) init_submodules=true; shift ;; --preserve-dirty) preserve=1; shift ;; *) die "Opción o argumento desconocido para complete: $1" ;; esac; done
      [[ -n "$work_id" ]] || die "Falta el identificador de trabajo"; TMP_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worktree-manager.XXXXXX")"; trap 'cleanup_tmp_state; release_locks' EXIT; acquire_locks complete destination "work/$(encode_work_id "$work_id")"
      complete_worktree "$work_id" "$base" "$preserve" "$init_submodules" ;;
    cleanup)
      local work_id="${1:-}" discard=0; shift || true; base="$(detect_base_branch)"
      while [[ $# -gt 0 ]]; do case "$1" in --base) [[ $# -ge 2 ]] || die "Falta la rama después de --base"; base="$2"; shift 2 ;; --discard) discard=1; shift ;; *) die "Opción o argumento desconocido para cleanup: $1" ;; esac; done
      [[ -n "$work_id" ]] || die "Falta el identificador de trabajo"; normalize_base_branch "$base"; acquire_locks cleanup "work/$(encode_work_id "$work_id")"; trap release_locks EXIT; cleanup_worktree "$work_id" "$discard" "$base" ;;
    recover)
      local tx_id="${1:-}" tx_dir work_id
      [[ $# -le 1 ]] || die "Argumentos desconocidos para recover"
      [[ -n "$tx_id" ]] || tx_id="$(latest_pending_tx_id || true)"
      [[ -n "$tx_id" ]] || { printf '%s\n' "No hay transacciones de preservación pendientes."; return 0; }
      [[ "$tx_id" != */* && "$tx_id" != .* && "$tx_id" != -* ]] || die "Identificador de transacción inválido"
      tx_dir="$(tx_dir_read "$tx_id")" || die "No existe la transacción '$tx_id'"
      # B2: resolve and validate the candidate work id BEFORE locking so the same
      # locks as `complete`/`cleanup --discard` can be taken lexicographically.
      work_id="$(meta_value "$tx_dir" work_id)"; [[ -n "$work_id" ]] || work_id="$(meta_value "$tx_dir" ca_name)"
      validate_work_id "$work_id"
      acquire_locks recover destination "work/$(encode_work_id "$work_id")"
      trap release_locks EXIT
      recover_transaction "$tx_id" "$work_id" ;;
    prune) acquire_locks prune registry; trap release_locks EXIT; prune_worktrees ;;
    list) list_worktrees ;;
    ""|-h|--help|help) usage ;;
    *) die "Comando desconocido: $command" ;;
  esac
}
