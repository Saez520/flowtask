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
    die "La rama base tiene cambios locales; limpiá el estado antes de completar el CA"
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

  mkdir -p "$WORKTREES_DIR"
  git worktree add -b "$branch" "$path_abs" "$base_branch"

  printf 'path: %s\n' "$path/"
  printf 'branch: %s\n' "$branch"
  printf 'base_branch: %s\n' "$base_branch"
}

complete_worktree() {
  local ca_name="$1"
  local base_branch="${2:-$(detect_base_branch)}"
  local branch path path_abs root

  root="$(repo_root)"
  cd "$root"
  normalize_base_branch "$base_branch"

  branch="$(worktree_branch_for "$ca_name")"
  path="$(worktree_path_for "$ca_name")"
  path_abs="$(worktree_path_abs_for "$ca_name")"

  if ! branch_exists "$branch" && ! worktree_registered_for_branch "$branch" >/dev/null 2>&1; then
    die "No encontré la rama '$branch' ni un worktree registrado para completar"
  fi

  ensure_clean_base
  git switch "$base_branch"

  if git merge --squash "$branch"; then
    if ! git diff --cached --quiet; then
      git commit -m "squash merge $branch into $base_branch"
    fi
  else
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
    while IFS= read -r -d '' candidate; do
      candidate="$(cd "$root" && pwd)/$candidate"
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
    done < <(find "$WORKTREES_DIR" -mindepth 1 -maxdepth 1 -type d -print0)
  fi

  printf 'pruned: %s\n' "$orphan_count"
}

usage() {
  cat <<'EOF'
Uso:
  worktree.sh create <ca-name> [--base <branch>]
  worktree.sh complete <ca-name> [--base <branch>]
  worktree.sh cleanup <ca-name> [--base <branch>]
  worktree.sh prune
  worktree.sh list
EOF
}

main() {
  ensure_git

  local command="${1:-}"
  shift || true

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
      if [[ "${1:-}" == "--base" ]]; then
        base_branch="${2:-}"
      fi
      [[ -n "$ca_name" ]] || die "Falta el nombre del CA"
      complete_worktree "$ca_name" "$base_branch"
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
