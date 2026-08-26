#!/usr/bin/env bash

set -euo pipefail

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

WORKTREES_DIR=".worktrees"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

ensure_git() {
  command -v git >/dev/null 2>&1 || die "Se requiere Git 2.5 o superior"

  local version_output major minor
  version_output="$(git version)"
  if [[ "$version_output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    if (( major < 2 || (major == 2 && minor < 5) )); then
      die "Se requiere Git 2.5 o superior"
    fi
    return 0
  fi

  die "No pude verificar la versión de Git. Se requiere Git 2.5 o superior"
}

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || die "No estás dentro de un repositorio Git válido"
}

normalize_base_branch() {
  local base_branch="$1"
  [[ -n "$base_branch" ]] || die "La rama base no puede estar vacía"
  git rev-parse --verify --quiet "${base_branch}^{commit}" >/dev/null || die "La rama base '$base_branch' no existe"
}

worktree_path_for() {
  local ca_name="$1"
  printf '%s/%s' "$WORKTREES_DIR" "$ca_name"
}

worktree_path_abs_for() {
  local ca_name="$1"
  local root
  root="$(repo_root)"
  printf '%s/%s/%s' "$root" "$WORKTREES_DIR" "$ca_name"
}

worktree_branch_for() {
  local ca_name="$1"
  printf 'worktree/%s' "$ca_name"
}

branch_exists() {
  local branch_ref="refs/heads/$1"
  git show-ref --verify --quiet "$branch_ref"
}

worktree_registered_for_path() {
  local target_path="$1"
  local current_path=""
  local line

  case "$target_path" in
    /*) ;;
    *) target_path="$(worktree_path_abs_for "${target_path#./}")" ;;
  esac

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        current_path="${line#worktree }"
        ;;
      "")
        if [[ "$current_path" == "$target_path" ]]; then
          return 0
        fi
        current_path=""
        ;;
    esac
  done < <(git worktree list --porcelain)

  [[ "$current_path" == "$target_path" ]]
}

worktree_registered_for_branch() {
  local target_branch_ref="refs/heads/$1"
  local current_path=""
  local current_branch=""
  local line

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        current_path="${line#worktree }"
        ;;
      branch\ *)
        current_branch="${line#branch }"
        ;;
      "")
        if [[ "$current_branch" == "$target_branch_ref" ]]; then
          printf '%s\n' "$current_path"
          return 0
        fi
        current_path=""
        current_branch=""
        ;;
    esac
  done < <(git worktree list --porcelain)

  if [[ -n "$current_branch" && "$current_branch" == "$target_branch_ref" ]]; then
    printf '%s\n' "$current_path"
    return 0
  fi

  return 1
}

ensure_clean_base() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "La rama base tiene cambios locales; limpiá el estado antes de completar la ejecución"
  fi
}

# ─── Transacción de preservación (opt-in --preserve-dirty) ──────────────────
# Backups en refs privadas refs/flowtask/backups/<tx-id>; JAMÁS refs/stash.
# Journal por fases: captured → merge_started → merged → restored|pending_manual.
BACKUPS_DIR=".flowtask/backups"
TMP_STATE_DIR=""

cleanup_tmp_state() {
  if [[ -n "$TMP_STATE_DIR" && -d "$TMP_STATE_DIR" ]]; then
    rm -rf "$TMP_STATE_DIR"
  fi
  return 0
}

tx_id_generate() {
  printf '%s-%s' "$(date -u +%Y%m%dT%H%M%SZ)" "$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
}

tx_dir_for() {
  printf '%s/%s' "$BACKUPS_DIR" "$1"
}

# Escritura atómica del journal (tmp + mv). Seam determinista de tests (D-N):
# con FLOWTASK_TEST_MODE=1 y FLOWTASK_TEST_CRASH_AFTER=<fase>, sale 99 justo
# después de persistir esa fase. Jamás activo sin las dos variables.
journal_write() {
  local tx_dir="$1" phase="$2" tmp
  tmp="$tx_dir/.journal.tmp"
  printf '%s\n' "$phase" > "$tmp"
  mv -f "$tmp" "$tx_dir/journal"
  if [[ "${FLOWTASK_TEST_MODE:-0}" == "1" && "${FLOWTASK_TEST_CRASH_AFTER:-}" == "$phase" ]]; then
    exit 99
  fi
}

journal_read() {
  local tx_dir="$1"
  if [[ -f "$tx_dir/journal" ]]; then
    cat "$tx_dir/journal"
  fi
}

# Consentimiento D-C: flag CLI > config persistida > OFF (fail-safe default-off).
# El script JAMÁS escribe worktree.json; el archivo lo crea el desarrollador.
consent_preserve_dirty() {
  if [[ "${1:-0}" == "1" ]]; then
    return 0
  fi
  local cfg=".flowtask/config/worktree.json"
  [[ -f "$cfg" ]] || return 1
  grep -Eq '"preserveDirty"[[:space:]]*:[[:space:]]*true' "$cfg"
}

# D-K: bloquea el re-cierre mientras exista una transacción no terminada.
# Solo interpola tx-ids (generados por el sistema) y fases (enum propio).
assert_no_pending_transaction() {
  local j dir tx_id phase
  [[ -d "$BACKUPS_DIR" ]] || return 0
  while IFS= read -r -d '' j; do
    dir="$(dirname "$j")"
    tx_id="$(basename "$dir")"
    phase="$(cat "$j")"
    case "$phase" in
      restored|pending_manual|"") continue ;;
      *)
        die "Existe una transacción de preservación pendiente ($tx_id, fase $phase).
Ejecutá 'worktree.sh recover $tx_id' antes de reintentar el cierre."
        ;;
    esac
  done < <(find "$BACKUPS_DIR" -mindepth 2 -maxdepth 2 -name journal -print0)
}

# D-M (Opción B cerrada): no-soporte duro = submodules / sparse-checkout / filters.
# La categoría ignored NUNCA bloquea: queda fuera de captura por construcción,
# jamás es tocada (no hay git clean en ningún camino) y solo recibe aviso fijo.
detect_unsupported() {
  local tracked_list="$1" path fields value unsupported="" ignored_out

  if [[ -n "$(git submodule status --recursive 2>/dev/null)" ]]; then
    unsupported+="submodules "
  fi

  if [[ "$(git config --bool core.sparsecheckout 2>/dev/null || true)" == "true" ]] \
     || git sparse-checkout list >/dev/null 2>&1; then
    unsupported+="sparse-checkout "
  fi

  if [[ -s "$tracked_list" ]]; then
    while IFS= read -r -d '' path; do
      fields=()
      while IFS= read -r -d '' field; do
        fields+=("$field")
      done < <(git check-attr -z filter -- "./$path")
      value="${fields[2]:-}"
      if [[ -n "$value" && "$value" != "unspecified" ]]; then
        unsupported+="filters "
        break
      fi
    done < <(cat "$tracked_list")
  fi

  if [[ -n "$unsupported" ]]; then
    printf 'Aviso: setup no soportado para preservar cambios: %s\n' "${unsupported% }" >&2
    return 1
  fi

  ignored_out="$(git ls-files --others --ignored --exclude-standard --directory \
    | grep -v -e '^\.flowtask/backups/\?$' || true)"
  if [[ -n "$ignored_out" ]]; then
    printf '%s\n' "Aviso: hay archivos ignorados en el destino; quedan fuera de la captura y no serán tocados." >&2
  fi
  return 0
}

write_meta() {
  local tx_dir="$1" ca_name="$2" base_branch="$3" tmp
  tmp="$tx_dir/.meta.tmp"
  {
    printf 'ca_name: %s\n' "$ca_name"
    printf 'base_branch: %s\n' "$base_branch"
    printf 'head_destino: %s\n' "$(git rev-parse HEAD)"
    printf 'created_at: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  mv -f "$tmp" "$tx_dir/meta"
}

# Remueve refs y dir recién creados tras un fallo de captura; destino intocado.
abort_capture_cleanup() {
  local tx_id="$1"
  git update-ref -d "refs/flowtask/backups/$tx_id" >/dev/null 2>&1 || true
  git update-ref -d "refs/flowtask/backups/$tx_id-untracked" >/dev/null 2>&1 || true
  rm -rf "$BACKUPS_DIR/$tx_id"
}

# D-E/D-F: crea las refs privadas y verifica que cada path elegible existe en
# su árbol ANTES de mutar nada. Setea TX_TRACKED_SHA / TX_UNTRACKED_SHA.
capture_transaction() {
  local tx_id="$1" tx_dir="$2" path tree_sha tmp_index
  TX_TRACKED_SHA=""
  TX_UNTRACKED_SHA=""

  if [[ -s "$tx_dir/tracked.paths" ]]; then
    TX_TRACKED_SHA="$(git stash create "flowtask-backup $tx_id")"
    if [[ -z "$TX_TRACKED_SHA" ]]; then
      abort_capture_cleanup "$tx_id"
      die "La captura del estado del destino falló; el cierre fue cancelado y no se modificó nada."
    fi
    git update-ref "refs/flowtask/backups/$tx_id" "$TX_TRACKED_SHA"
  fi

  if [[ -s "$tx_dir/untracked.paths" ]]; then
    tmp_index="$(mktemp "${TMPDIR:-/tmp}/flowtask-index.XXXXXX")"
    GIT_INDEX_FILE="$tmp_index" git read-tree --empty
    GIT_INDEX_FILE="$tmp_index" git update-index --add -z --stdin < "$tx_dir/untracked.paths"
    tree_sha="$(GIT_INDEX_FILE="$tmp_index" git write-tree)"
    rm -f "$tmp_index"
    TX_UNTRACKED_SHA="$(git commit-tree "$tree_sha" -m "flowtask-backup-untracked $tx_id")"
    git update-ref "refs/flowtask/backups/$tx_id-untracked" "$TX_UNTRACKED_SHA"
  fi

  if [[ -n "$TX_TRACKED_SHA" ]]; then
    while IFS= read -r -d '' path; do
      if ! git cat-file -e "$TX_TRACKED_SHA:$path" >/dev/null 2>&1; then
        abort_capture_cleanup "$tx_id"
        die "La verificación de la captura falló; el cierre fue cancelado y no se modificó nada."
      fi
    done < <(cat "$tx_dir/tracked.paths")
  fi

  if [[ -n "$TX_UNTRACKED_SHA" ]]; then
    while IFS= read -r -d '' path; do
      if ! git cat-file -e "$TX_UNTRACKED_SHA:$path" >/dev/null 2>&1; then
        abort_capture_cleanup "$tx_id"
        die "La verificación de la captura falló; el cierre fue cancelado y no se modificó nada."
      fi
    done < <(cat "$tx_dir/untracked.paths")
  fi
}

# D-G: limpieza idempotente del destino dentro de la ventana captured.
clean_destination() {
  local tx_id="$1" tx_dir="$2" path
  if [[ -s "$tx_dir/tracked.paths" ]]; then
    if ! git restore --source=HEAD --staged --worktree -- ./ >/dev/null 2>&1; then
      journal_write "$tx_dir" captured
      die "La limpieza del destino falló; la transacción $tx_id quedó en fase captured. Ejecutá 'worktree.sh recover $tx_id'."
    fi
  fi
  if [[ -s "$tx_dir/untracked.paths" ]]; then
    while IFS= read -r -d '' path; do
      if [[ -e "$path" || -L "$path" ]]; then
        rm -- "$path"
      fi
    done < <(cat "$tx_dir/untracked.paths")
  fi
}

merge_squash_branch() {
  local base_branch="$1" branch="$2"
  git switch "$base_branch"
  if git merge --squash "$branch"; then
    if ! git diff --cached --quiet; then
      git commit -m "squash merge $branch into $base_branch"
    fi
    return 0
  fi
  return 1
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

mark_pending_manual() {
  local tx_dir="$1" tx_id="$2"
  journal_write "$tx_dir" pending_manual
  print_pending_manual_instructions "$tx_id"
}

# D-J: restauración con estado fino. Conflicto → pending_manual conservador:
# fusión conservada, backup intacto, exit 1. Untracked all-or-nothing.
restore_transaction() {
  local tx_id="$1" tx_dir="$2" path collision=0

  if [[ -n "$TX_TRACKED_SHA" ]]; then
    if ! git stash apply --index "refs/flowtask/backups/$tx_id" >/dev/null 2>&1; then
      mark_pending_manual "$tx_dir" "$tx_id"
      return 1
    fi
  fi

  if [[ -n "$TX_UNTRACKED_SHA" ]]; then
    while IFS= read -r -d '' path; do
      if [[ -e "$path" || -L "$path" ]]; then
        collision=1
        break
      fi
    done < <(git ls-tree -r -z --name-only "refs/flowtask/backups/$tx_id-untracked")
    if [[ "$collision" -eq 1 ]]; then
      mark_pending_manual "$tx_dir" "$tx_id"
      return 1
    fi
    while IFS= read -r -d '' path; do
      if ! git restore --source="refs/flowtask/backups/$tx_id-untracked" --worktree -- "./$path" >/dev/null 2>&1; then
        mark_pending_manual "$tx_dir" "$tx_id"
        return 1
      fi
    done < <(git ls-tree -r -z --name-only "refs/flowtask/backups/$tx_id-untracked")
  fi

  return 0
}

# Transacción pendiente más reciente (el tx-id ordena cronológico lexicográfico);
# fase ∉ {restored, ""}. Devuelve 1 si no hay ninguna.
latest_pending_tx_id() {
  local d base phase found=()
  [[ -d "$BACKUPS_DIR" ]] || return 1
  for d in "$BACKUPS_DIR"/*/; do
    [[ -d "$d" ]] && found+=("$d")
  done
  local i
  for ((i=${#found[@]}-1; i>=0; i--)); do
    d="${found[i]}"
    base="$(basename "$d")"
    phase="$(cat "$d/journal" 2>/dev/null || true)"
    case "$phase" in
      restored|"") continue ;;
      *) printf '%s' "$base"; return 0 ;;
    esac
  done
  return 1
}

# D-L: recuperación idempotente desde la última fase anotada.
recover_transaction() {
  local tx_id_arg="${1:-}" tx_dir phase ca_name base_branch branch

  if [[ -z "$tx_id_arg" ]]; then
    tx_id_arg="$(latest_pending_tx_id)" || {
      printf '%s\n' "No hay transacciones de preservación pendientes."
      exit 0
    }
  fi

  case "$tx_id_arg" in
    ""|*/*|.*|..*) die "Identificador de transacción inválido" ;;
  esac
  tx_dir="$BACKUPS_DIR/$tx_id_arg"
  [[ -d "$tx_dir" ]] || die "No existe la transacción '$tx_id_arg'"
  phase="$(journal_read "$tx_dir")"
  case "$phase" in
    captured|merge_started|merged|pending_manual|restored) ;;
    *) die "La transacción '$tx_id_arg' no tiene un journal válido" ;;
  esac

  ca_name="$(sed -n 's/^ca_name: //p' "$tx_dir/meta")"
  base_branch="$(sed -n 's/^base_branch: //p' "$tx_dir/meta")"
  [[ -n "$ca_name" && -n "$base_branch" ]] || die "La transacción '$tx_id_arg' tiene meta incompleto"

  if [[ "$phase" == "pending_manual" ]]; then
    print_pending_manual_instructions "$tx_id_arg"
    exit 1
  fi

  if [[ "$phase" == "restored" ]]; then
    printf 'La transacción %s ya fue restaurada; no hay nada pendiente.\n' "$tx_id_arg"
    exit 0
  fi

  normalize_base_branch "$base_branch"
  TX_TRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id_arg" || true)"
  TX_UNTRACKED_SHA="$(git rev-parse --verify --quiet "refs/flowtask/backups/$tx_id_arg-untracked" || true)"

  if [[ "$phase" == "merge_started" ]]; then
    git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true
  fi

  if [[ "$phase" == "captured" ]]; then
    clean_destination "$tx_id_arg" "$tx_dir"
  fi

  if [[ "$phase" == "captured" || "$phase" == "merge_started" ]]; then
    branch="$(worktree_branch_for "$ca_name")"
    if ! branch_exists "$branch"; then
      die "La rama '$branch' ya no existe; no puedo completar la recuperación de '$tx_id_arg'"
    fi
    if ! merge_squash_branch "$base_branch" "$branch"; then
      git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true
      journal_write "$tx_dir" merge_started
      die "Conflicto al reintentar la fusión para '$tx_id_arg'; la transacción sigue en fase merge_started."
    fi
    journal_write "$tx_dir" merged
  fi

  if restore_transaction "$tx_id_arg" "$tx_dir"; then
    journal_write "$tx_dir" restored
    printf 'recovered: %s\n' "$tx_id_arg"
  else
    exit 1
  fi
}

create_worktree() {
  local ca_name="$1"
  local base_branch="${2:-$(detect_base_branch)}"
  local branch path path_abs root

  root="$(repo_root)"
  cd "$root"
  normalize_base_branch "$base_branch"

  branch="$(worktree_branch_for "$ca_name")"
  path="$(worktree_path_for "$ca_name")"
  path_abs="$(worktree_path_abs_for "$ca_name")"

  if branch_exists "$branch"; then
    die "La rama '$branch' ya existe; resolvé el duplicado antes de crear un worktree nuevo"
  fi

  if [[ -e "$path_abs" ]]; then
    die "La ruta '$path' ya existe; limpiá el directorio antes de crear el worktree"
  fi

  mkdir -p "$(dirname "$path_abs")"
  git worktree add -b "$branch" "$path_abs" "$base_branch"

  printf 'path: %s\n' "$path/"
  printf 'branch: %s\n' "$branch"
  printf 'base_branch: %s\n' "$base_branch"
}

complete_worktree() {
  local ca_name="$1"
  local base_branch="${2:-$(detect_base_branch)}"
  local preserve_flag="${3:-0}"
  local branch path path_abs root status_line worktree_status
  local problems="" staged_files="" unstaged_files="" untracked_files=""
  local dest_staged=0 dest_unstaged=0 dest_untracked=0 dest_rec dest_code dest_path
  local own_commits stash_entries

  root="$(repo_root)"
  cd "$root"
  normalize_base_branch "$base_branch"

  branch="$(worktree_branch_for "$ca_name")"
  path="$(worktree_path_for "$ca_name")"
  path_abs="$(worktree_path_abs_for "$ca_name")"

  if ! branch_exists "$branch"; then
    die "No encontré la rama '$branch' para completar"
  fi

  # D-K: jamás mutar con una transacción de preservación sin terminar.
  assert_no_pending_transaction

  worktree_status="$(git -C "$path_abs" status --porcelain --untracked-files=all)"
  while IFS= read -r status_line; do
    [[ -n "$status_line" ]] || continue
    if [[ "${status_line:0:2}" == "??" ]]; then
      untracked_files+="${status_line:3}"$'\n'
    else
      [[ "${status_line:0:1}" != " " ]] && staged_files+="${status_line:3}"$'\n'
      [[ "${status_line:1:1}" != " " ]] && unstaged_files+="${status_line:3}"$'\n'
    fi
  done <<< "$worktree_status"

  if [[ -n "$staged_files" ]]; then
    problems+=$'\n- Worktree: cambios staged:\n'
    problems+="$staged_files"
    problems+=$'  Acción: crear el commit del worktree antes de reintentar.\n'
  fi
  if [[ -n "$unstaged_files" ]]; then
    problems+=$'\n- Worktree: cambios unstaged:\n'
    problems+="$unstaged_files"
    problems+=$'  Acción: crear el commit del worktree antes de reintentar.\n'
  fi
  if [[ -n "$untracked_files" ]]; then
    problems+=$'\n- Worktree: archivos untracked:\n'
    problems+="$untracked_files"
    problems+=$'  Acción: agregar y crear el commit del worktree antes de reintentar.\n'
  fi

  own_commits="$(git rev-list --count "$base_branch..$branch")"
  if [[ "$own_commits" -eq 0 ]]; then
    problems+=$'\n- Worktree: falta crear el commit propio antes de completar.\n'
  fi

  stash_entries="$(git stash list)"
  if [[ -n "$stash_entries" ]]; then
    problems+=$'\n- Repositorio: hay stash pendiente:\n'
    problems+="$stash_entries"$'\n'
    problems+=$'  Acción: resolver o restaurar los stashes de forma segura antes de reintentar.\n'
  fi

  # Estado del destino: parser NUL-delimitado (a prueba de nombres hostiles).
  # Registros "XY <path>NUL"; renames/copies emiten un segundo campo NUL (origen).
  # Paths bajo .flowtask/backups/ son infraestructura propia, no suciedad (D-H).
  # Las listas elegibles quedan en $TMP_STATE_DIR (NUL) para la transacción.
  : > "$TMP_STATE_DIR/dest.tracked"
  : > "$TMP_STATE_DIR/dest.untracked"
  while IFS= read -r -d '' dest_rec; do
    dest_code="${dest_rec:0:2}"
    dest_path="${dest_rec:3}"
    case "$dest_code" in
      R?|C?)
        IFS= read -r -d '' dest_rec || true
        ;;
    esac
    case "$dest_path" in
      .flowtask/backups/*) continue ;;
    esac
    case "$dest_code" in
      '??')
        dest_untracked=1
        printf '%s\0' "$dest_path" >> "$TMP_STATE_DIR/dest.untracked"
        ;;
      *)
        [[ "${dest_code:0:1}" != " " ]] && dest_staged=1
        [[ "${dest_code:1:1}" != " " ]] && dest_unstaged=1
        printf '%s\0' "$dest_path" >> "$TMP_STATE_DIR/dest.tracked"
        ;;
    esac
  done < <(git -C "$root" status --porcelain -z --untracked-files=all)

  if (( dest_staged || dest_unstaged || dest_untracked )); then
    if ! consent_preserve_dirty "${preserve_flag:-0}"; then
      die "No se puede completar '$ca_name': el destino tiene cambios sin commitear.
Inspeccionalo vos mismo con 'git status' antes de reintentar.
El cierre fue cancelado; no se modificó nada."
    fi

    # Camino transaccional opt-in: no-soporte → rechazo; problems → die;
    # captura verificada ANTES de mutar; journal por fases.
    if ! detect_unsupported "$TMP_STATE_DIR/dest.tracked"; then
      die "No se puede completar '$ca_name': el destino tiene cambios sin commitear.
Inspeccionalo vos mismo con 'git status' antes de reintentar.
El cierre fue cancelado; no se modificó nada."
    fi

    if [[ -n "$problems" ]]; then
      die "No se puede completar '$ca_name'; se detectaron problemas antes de integrar o limpiar:$problems"
    fi

    local tx_id tx_dir
    tx_id="$(tx_id_generate)"
    tx_dir="$(tx_dir_for "$tx_id")"
    mkdir -p "$tx_dir"
    cp "$TMP_STATE_DIR/dest.tracked" "$tx_dir/tracked.paths"
    cp "$TMP_STATE_DIR/dest.untracked" "$tx_dir/untracked.paths"
    write_meta "$tx_dir" "$ca_name" "$base_branch"

    capture_transaction "$tx_id" "$tx_dir"

    journal_write "$tx_dir" captured
    clean_destination "$tx_id" "$tx_dir"

    journal_write "$tx_dir" merge_started
    if ! merge_squash_branch "$base_branch" "$branch"; then
      git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true
      die "Conflicto al hacer squash-merge de '$branch' en '$base_branch'; el worktree se conserva.
La transacción $tx_id quedó en fase merge_started; ejecutá 'worktree.sh recover $tx_id'."
    fi
    journal_write "$tx_dir" merged

    if ! restore_transaction "$tx_id" "$tx_dir"; then
      exit 1
    fi
    journal_write "$tx_dir" restored

    printf 'preserve: %s\n' "$tx_id"
    printf 'merge: success\n'
    cleanup_worktree "$ca_name" "$base_branch"
    git worktree prune >/dev/null 2>&1 || true
    printf 'completed: %s\n' "$ca_name"
    printf 'branch: %s\n' "$branch"
    printf 'base_branch: %s\n' "$base_branch"
    printf 'worktree: %s\n' "$path/"
    return 0
  fi

  if [[ -n "$problems" ]]; then
    die "No se puede completar '$ca_name'; se detectaron problemas antes de integrar o limpiar:$problems"
  fi

  if ! merge_squash_branch "$base_branch" "$branch"; then
    git merge --abort >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1 || true
    die "Conflicto al hacer squash-merge de '$branch' en '$base_branch'; el worktree se conserva"
  fi

  printf 'merge: success\n'
  cleanup_worktree "$ca_name" "$base_branch"
  git worktree prune >/dev/null 2>&1 || true
  printf 'completed: %s\n' "$ca_name"
  printf 'branch: %s\n' "$branch"
  printf 'base_branch: %s\n' "$base_branch"
  printf 'worktree: %s\n' "$path/"
}

cleanup_worktree() {
  local ca_name="$1"
  local base_branch="${2:-$(detect_base_branch)}"
  local branch path path_abs root removed_worktree=0 removed_branch=0

  root="$(repo_root)"
  cd "$root"
  normalize_base_branch "$base_branch" >/dev/null

  branch="$(worktree_branch_for "$ca_name")"
  path="$(worktree_path_for "$ca_name")"
  path_abs="$(worktree_path_abs_for "$ca_name")"

  if [[ -d "$path_abs" ]]; then
    if git worktree remove --force "$path_abs" >/dev/null 2>&1; then
      removed_worktree=1
    else
      rm -rf "$path_abs"
      removed_worktree=1
      git worktree prune >/dev/null 2>&1 || true
    fi
  fi

  if branch_exists "$branch"; then
    git branch -D "$branch"
    removed_branch=1
  fi

  printf 'cleanup: success\n'
  printf 'removed_worktree: %s\n' "$removed_worktree"
  printf 'removed_branch: %s\n' "$removed_branch"
  printf 'cleaned: %s\n' "$ca_name"
  printf 'branch: %s\n' "$branch"
  printf 'worktree: %s\n' "$path/"
}

list_worktrees() {
  local root
  root="$(repo_root)"
  cd "$root"
  git worktree list --porcelain
}

prune_worktrees() {
  local root existing_paths=() line current_path="" orphan_count=0 candidate registered existing
  root="$(repo_root)"
  cd "$root"

  git worktree prune

  while IFS= read -r line; do
    case "$line" in
      worktree\ *)
        current_path="${line#worktree }"
        existing_paths+=("$current_path")
        ;;
      "")
        current_path=""
        ;;
    esac
  done < <(git worktree list --porcelain)

  if [[ -d "$WORKTREES_DIR" ]]; then
    while IFS= read -r -d '' git_file; do
      candidate="$(dirname "$(cd "$root" && pwd)/$git_file")"
      local registered=0 existing
      for existing in "${existing_paths[@]}"; do
        if [[ "$candidate" == "$existing" ]]; then
          registered=1
          break
        fi
      done

      if [[ "$registered" -eq 0 ]]; then
        orphan_count=$((orphan_count + 1))
        printf 'orphan: %s\n' "$candidate"
      fi
    done < <(find "$WORKTREES_DIR" -type f -name .git -print0)
  fi

  printf 'pruned: %s\n' "$orphan_count"
}

usage() {
  cat <<'EOF'
Uso:
  worktree.sh create <execution-name> [--base <branch>]
  worktree.sh complete <execution-name> [--base <branch>] [--preserve-dirty]
  worktree.sh cleanup <execution-name> [--base <branch>]
  worktree.sh recover [<transaction-id>]
  worktree.sh prune
  worktree.sh list

--preserve-dirty: preservación transaccional opt-in de los cambios sin
  commitear del destino; requiere consentimiento explícito (flag o la clave
  "preserveDirty": true en .flowtask/config/worktree.json).
recover: reanuda una transacción interrumpida desde su última fase; sin
  argumento elige la pendiente más reciente.
EOF
}

main() {
  ensure_git

  local command="${1:-}"
  shift || true

  if [[ "$command" == "complete" ]]; then
    TMP_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flowtask-wt.XXXXXX")"
    trap cleanup_tmp_state EXIT
  fi

  case "$command" in
    create)
      local ca_name="${1:-}"
      shift || true
      local base_branch="$(detect_base_branch)"
      if [[ "${1:-}" == "--base" ]]; then
        base_branch="${2:-}"
      fi
      [[ -n "$ca_name" ]] || die "Falta el nombre del CA"
      create_worktree "$ca_name" "$base_branch"
      ;;
    complete)
      local ca_name="${1:-}"
      shift || true
      local base_branch="$(detect_base_branch)"
      local preserve_flag=0
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --base)
            [[ $# -ge 2 ]] || die "Falta la rama después de --base"
            base_branch="${2:-}"
            shift 2
            ;;
          --preserve-dirty)
            preserve_flag=1
            shift
            ;;
          *)
            die "Opción o argumento desconocido para complete: ${1}"
            ;;
        esac
      done
      [[ -n "$ca_name" ]] || die "Falta el nombre del CA"
      complete_worktree "$ca_name" "$base_branch" "$preserve_flag"
      ;;
    recover)
      local tx_id="${1:-}"
      if [[ $# -gt 1 ]]; then
        die "Argumentos desconocidos para recover: ${*:2}"
      fi
      recover_transaction "$tx_id"
      ;;
    cleanup)
      local ca_name="${1:-}"
      shift || true
      local base_branch="$(detect_base_branch)"
      if [[ "${1:-}" == "--base" ]]; then
        base_branch="${2:-}"
      fi
      [[ -n "$ca_name" ]] || die "Falta el nombre del CA"
      cleanup_worktree "$ca_name" "$base_branch"
      ;;
    prune)
      prune_worktrees
      ;;
    list)
      list_worktrees
      ;;
    ""|-h|--help|help)
      usage
      ;;
    *)
      die "Comando desconocido: $command"
      ;;
  esac
}

main "$@"
