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

assert_no_pending_transaction() {
  local tx phase d
  for d in "$TRANSACTIONS_DIR"/*/ "$REPO_ROOT/.flowtask/backups"/*/; do
    [[ -d "$d" ]] || continue
    phase="$(journal_read "$d" || true)"
    case "$phase" in restored|pending_manual|"") ;; *) tx="$(basename "$d")"; die "Existe una transacción de preservación pendiente ($tx, fase $phase). Ejecutá 'worktree.sh recover $tx' antes de reintentar el cierre." ;; esac
  done
}

cleanup_completed_resources() {
  # B1: internal, ephemeral squash-close capability.  It is not reachable from the
  # CLI, from the configuration file, nor from `cleanup`/`recover`; the caller
  # must present the capability minted in-process by the `complete` path *after*
  # the squash commit and any restore were verified.  It never accepts
  # `--discard`, never uses `--force` and never calls `git branch -D`.
  local capability="$1" work_id="$2" branch="$3" path_abs="$4" expected_sha="$5"
  [[ "$capability" == "$CLOSE_CAPABILITY" && -n "$CLOSE_CAPABILITY" ]] || die "La capacidad de cierre squash no fue concedida"
  validate_identity "$work_id"
  [[ "$branch" == "$(worktree_branch_for "$work_id")" ]] || die "La capacidad de cierre no coincide con la rama"
  [[ "$path_abs" == "$(worktree_path_abs_for "$work_id")" ]] || die "La capacidad de cierre no coincide con la ruta"
  [[ "$(git rev-parse "refs/heads/$branch")" == "$expected_sha" ]] || die "La rama cambió antes de la limpieza del cierre"
  git worktree remove -- "$path_abs" >/dev/null 2>&1 || die "No pude retirar el worktree cerrado; se conserva la rama"
  git update-ref -d "refs/heads/$branch" "$expected_sha" || die "No pude retirar la rama cerrada; el worktree ya fue retirado"
  CLOSE_CAPABILITY=""
}

mint_close_capability() {
  CLOSE_CAPABILITY="squash-close:$(od -An -N8 -tx8 /dev/urandom | tr -d ' '):$$"
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
  [[ -z "$(git submodule status --recursive 2>/dev/null)" ]] || unsupported+="submodules "
  if [[ "$(git config --bool core.sparsecheckout 2>/dev/null || true)" == true ]] || git sparse-checkout list >/dev/null 2>&1; then unsupported+="sparse-checkout "; fi
  while IFS= read -r -d '' path; do
    fields=(); while IFS= read -r -d '' value; do fields+=("$value"); done < <(git check-attr -z filter -- "./$path")
    [[ -z "${fields[2]:-}" || "${fields[2]}" == unspecified ]] || { unsupported+="filters "; break; }
  done < "$tracked_list"
  [[ -z "$unsupported" ]] || { printf 'Aviso: setup no soportado para preservar cambios: %s\n' "${unsupported% }" >&2; return 1; }
  if [[ -n "$(git ls-files --others --ignored --exclude-standard --directory | grep -v '^\.flowtask/backups/\?$' || true)" ]]; then printf '%s\n' "Aviso: hay archivos ignorados en el destino; quedan fuera de la captura y no serán tocados." >&2; fi
}

consent_preserve_dirty() {
  [[ "${1:-0}" == 1 || "$PRESERVE_DIRTY" == 1 ]] && return 0
  [[ -f "$REPO_ROOT/.flowtask/config/worktree.json" ]] && grep -Eq '"preserveDirty"[[:space:]]*:[[:space:]]*true' "$REPO_ROOT/.flowtask/config/worktree.json"
}

complete_worktree() {
  local work_id="$1" base="$2" preserve_flag="$3" branch path path_abs worktree_status status_line
  local problems="" staged_files="" unstaged_files="" untracked_files="" own_commits stash_entries
  local tx_id tx_dir before
  validate_work_id "$work_id"; normalize_base_branch "$base"; validate_identity "$work_id"
  branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; path="$(worktree_path_for "$work_id")"
  assert_no_pending_transaction
  worktree_status="$(git -C "$path_abs" status --porcelain --untracked-files=all)"
  while IFS= read -r status_line; do
    [[ -n "$status_line" ]] || continue
    if [[ "${status_line:0:2}" == '??' ]]; then untracked_files+="${status_line:3}"$'\n'; else [[ "${status_line:0:1}" != " " ]] && staged_files+="${status_line:3}"$'\n'; [[ "${status_line:1:1}" != " " ]] && unstaged_files+="${status_line:3}"$'\n'; fi
  done <<< "$worktree_status"
  [[ -z "$staged_files" ]] || problems+=$'\n- Worktree: cambios staged:\n'"$staged_files"$'  Acción: crear el commit del worktree antes de reintentar.\n'
  [[ -z "$unstaged_files" ]] || problems+=$'\n- Worktree: cambios unstaged:\n'"$unstaged_files"$'  Acción: crear el commit del worktree antes de reintentar.\n'
  [[ -z "$untracked_files" ]] || problems+=$'\n- Worktree: archivos untracked:\n'"$untracked_files"$'  Acción: agregar y crear el commit del worktree antes de reintentar.\n'
  own_commits="$(git rev-list --count "$base..$branch")"; (( own_commits > 0 )) || problems+=$'\n- Worktree: falta crear el commit propio antes de completar.\n'
  stash_entries="$(git stash list)"; [[ -z "$stash_entries" ]] || problems+=$'\n- Repositorio: hay stash pendiente.\n  Acción: resolver o restaurar los stashes de forma segura antes de reintentar.\n'
  parse_destination_status "$REPO_ROOT"
  if (( DEST_STAGED || DEST_UNSTAGED || DEST_UNTRACKED )); then
    consent_preserve_dirty "$preserve_flag" || dirty_destination_rejection "$work_id"
    detect_unsupported "$TMP_STATE_DIR/dest.tracked" || dirty_destination_rejection "$work_id"
    [[ -z "$problems" ]] || die "No se puede completar '$work_id'; se detectaron problemas antes de integrar o limpiar:$problems"
    tx_id="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
    tx_dir="$(tx_dir_for "$tx_id")"; mkdir -p -- "$tx_dir" "$(legacy_mirror_dir "$tx_id")"
    cp -- "$TMP_STATE_DIR/dest.tracked" "$tx_dir/tracked.paths"; cp -- "$TMP_STATE_DIR/dest.untracked" "$tx_dir/untracked.paths"
    mirror_tx_payload "$tx_dir"
    before="$(git rev-parse HEAD)"; write_meta "$tx_dir" "$work_id" "$base" "$branch" "$path_abs" "$(git rev-parse "refs/heads/$branch")"
    capture_transaction "$tx_id" "$tx_dir"; journal_write "$tx_dir" captured; clean_destination "$tx_dir"
    journal_write "$tx_dir" merge_started
    if ! merge_squash_branch "$base" "$branch" "$before"; then git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true; journal_write "$tx_dir" merge_started; die "Conflicto al hacer squash-merge de '$branch' en '$base'; el worktree se conserva.\nLa transacción $tx_id quedó en fase merge_started; ejecutá 'worktree.sh recover $tx_id'."; fi
    printf 'squash_commit: %s\n' "$SQUASH_SHA" >> "$tx_dir/meta"
    cp -- "$tx_dir/meta" "$(legacy_mirror_dir "$tx_id")/meta"
    journal_write "$tx_dir" merged
    TX_TRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id" || true)"; TX_UNTRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id-untracked" || true)"
    restore_transaction "$tx_id" "$tx_dir" || exit 1
    journal_write "$tx_dir" restored
    # (d) restore returned success and the journal reached `restored`: only now
    # may the verified squash close mint its one-shot retirement capability.
    [[ "$(journal_read "$tx_dir")" == restored ]] || die "La restauración no quedó registrada; conservo los recursos"
    mint_close_capability
    cleanup_completed_resources "$CLOSE_CAPABILITY" "$work_id" "$branch" "$path_abs" "$(meta_value "$tx_dir" origin_sha)"
    printf 'operation: complete\nresult: success\npreserve: %s\nmerge: success\ncompleted: %s\nbranch: %s\nbase_branch: %s\nworktree: %s/\n' "$tx_id" "$work_id" "$branch" "$base" "$path"
    return 0
  fi
  [[ -z "$problems" ]] || die "No se puede completar '$work_id'; se detectaron problemas antes de integrar o limpiar:$problems"
  before="$(git rev-parse HEAD)"
  if ! merge_squash_branch "$base" "$branch" "$before"; then git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true; die "Conflicto al hacer squash-merge de '$branch' en '$base'; el worktree se conserva"; fi
}

dirty_destination_rejection() {
  local work_id="$1"
  printf '%s\n' "No se puede completar '$work_id': el destino tiene cambios sin commitear." >&2
  printf '%s\n' "Inspeccionalo vos mismo con 'git status' antes de reintentar." >&2
  printf '%s\n' "El cierre fue cancelado; no se modificó nada." >&2
  exit 1
}

complete_worktree_clean() {
  local work_id="$1" base="$2" branch path path_abs before origin_sha own_commits stash_entries
  validate_work_id "$work_id"; normalize_base_branch "$base"; validate_identity "$work_id"; branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; path="$(worktree_path_for "$work_id")"
  own_commits="$(git rev-list --count "$base..$branch")"
  (( own_commits > 0 )) || die "No se puede completar '$work_id'; falta crear el commit propio antes de completar."
  stash_entries="$(git stash list)"
  [[ -z "$stash_entries" ]] || die "No se puede completar '$work_id'; el repositorio tiene un stash pendiente. Acción: resolver o restaurar los stashes antes de reintentar."
  before="$(git rev-parse HEAD)"; origin_sha="$(git rev-parse "refs/heads/$branch")"
  merge_squash_branch "$base" "$branch" "$before" || { git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true; die "Conflicto al hacer squash-merge de '$branch' en '$base'; el worktree se conserva"; }
  # No preservation happened here, so the squash verification inside
  # merge_squash_branch (new commit, single parent equal to the pre-merge HEAD)
  # is the whole precondition for the one-shot retirement capability.
  mint_close_capability
  cleanup_completed_resources "$CLOSE_CAPABILITY" "$work_id" "$branch" "$path_abs" "$origin_sha"
  printf 'operation: complete\nresult: success\nmerge: success\ncompleted: %s\nbranch: %s\nbase_branch: %s\nworktree: %s/\n' "$work_id" "$branch" "$base" "$path"
}

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
  local work_id="$1" base="$2" branch path_abs path rel prepare verify
  validate_work_id "$work_id"; normalize_base_branch "$base"; branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; path="$(worktree_path_for "$work_id")"
  if (( CREATE_PREPARE == 1 )) && [[ -z "$PREPARE_COMMAND" ]]; then die "--prepare requiere prepare_command en la configuración"; fi
  if (( CREATE_VERIFY == 1 )) && [[ -z "$VERIFY_COMMAND" ]]; then die "--verify requiere verify_command en la configuración"; fi
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "La rama de trabajo '$branch' es inválida"
  branch_exists "$branch" && die "La rama '$branch' ya existe; resolvé el duplicado antes de crear un worktree nuevo"
  [[ ! -e "$path_abs" ]] || die "La ruta '$path' ya existe; limpiá el directorio antes de crear el worktree"
  ensure_ignored_local_path "$path_abs"; mkdir -p -- "$(dirname -- "$path_abs")"; git worktree add -b "$branch" "$path_abs" "$base" >/dev/null
  prepare="skipped"; verify="skipped"
  if (( PREPARE_ENABLED || CREATE_PREPARE )); then prepare="failed"; run_action prepare "$PREPARE_COMMAND" "$path_abs" && prepare="passed" || { printf 'operation: create\nresult: failed\nprepare: failed\nverify: %s\n' "$verify"; return 1; }; fi
  if (( VERIFY_ENABLED || CREATE_VERIFY )); then verify="failed"; run_action verify "$VERIFY_COMMAND" "$path_abs" && verify="passed" || { printf 'operation: create\nresult: failed\nprepare: %s\nverify: failed\n' "$prepare"; return 1; }; fi
  printf 'operation: create\nresult: success\npath: %s/\nbranch: %s\nbase_branch: %s\nprepare: %s\nverify: %s\n' "$path" "$branch" "$base" "$prepare" "$verify"
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
  local line current="" orphan_count=0 candidate registered existing
  git worktree prune
  local existing_paths=()
  while IFS= read -r line; do case "$line" in worktree\ *) current="${line#worktree }"; existing_paths+=("$current") ;; "") current="" ;; esac; done < <(git worktree list --porcelain)
  [[ -d "$WORKTREES_ROOT" ]] && while IFS= read -r -d '' candidate; do candidate="$(dirname -- "$candidate")"; registered=0; for existing in "${existing_paths[@]}"; do [[ "$candidate" == "$existing" ]] && registered=1; done; (( registered )) || { orphan_count=$((orphan_count+1)); printf 'orphan: %s\n' "$candidate"; }; done < <(find "$WORKTREES_ROOT" -type f -name .git -print0)
  printf 'operation: prune\nresult: success\npruned: %s\n' "$orphan_count"
}

usage() {
  cat <<'EOF'
Uso:
  worktree.sh [--repo <directorio-absoluto>] [--config <archivo-absoluto>] create <work-id> [--base <branch>] [--prepare] [--verify]
  worktree.sh [globales] complete <work-id> [--base <branch>] [--preserve-dirty]
  worktree.sh [globales] cleanup <work-id> [--base <branch>] [--discard]
  worktree.sh [globales] recover [<transaction-id>]
  worktree.sh [globales] prune | list

La configuración es un archivo de datos key=value; nunca se ejecuta como shell.
EOF
}

worktree_manager_main() {
  ensure_git
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
      local work_id="${1:-}"; shift || true; base="$(detect_base_branch)"
      while [[ $# -gt 0 ]]; do case "$1" in --base) [[ $# -ge 2 ]] || die "Falta la rama después de --base"; base="$2"; shift 2 ;; --prepare) CREATE_PREPARE=1; shift ;; --verify) CREATE_VERIFY=1; shift ;; *) die "Opción o argumento desconocido para create: $1" ;; esac; done
      [[ -n "$work_id" ]] || die "Falta el identificador de trabajo"; acquire_locks create "work/$(encode_work_id "$work_id")"; trap release_locks EXIT; create_worktree "$work_id" "$base" ;;
    complete)
      local work_id="${1:-}" preserve=0; shift || true; base="$(detect_base_branch)"
      while [[ $# -gt 0 ]]; do case "$1" in --base) [[ $# -ge 2 ]] || die "Falta la rama después de --base"; base="$2"; shift 2 ;; --preserve-dirty) preserve=1; shift ;; *) die "Opción o argumento desconocido para complete: $1" ;; esac; done
      [[ -n "$work_id" ]] || die "Falta el identificador de trabajo"; TMP_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/worktree-manager.XXXXXX")"; trap 'cleanup_tmp_state; release_locks' EXIT; acquire_locks complete destination "work/$(encode_work_id "$work_id")"
      # Complete with dirty destination and clean destination share the same
      # preflight; the preserving path is selected inside the implementation.
      validate_work_id "$work_id"; normalize_base_branch "$base"; validate_identity "$work_id"; branch="$(worktree_branch_for "$work_id")"; path_abs="$(worktree_path_abs_for "$work_id")"; assert_no_pending_transaction
      # Keep the implementation split so the internal cleanup always receives
      # the exact origin SHA captured before the squash.
      if [[ -n "$(git -C "$path_abs" status --porcelain --untracked-files=all)" || -n "$(git status --porcelain --untracked-files=all)" ]]; then
        complete_worktree "$work_id" "$base" "$preserve"
      else
        complete_worktree_clean "$work_id" "$base"
      fi ;;
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
