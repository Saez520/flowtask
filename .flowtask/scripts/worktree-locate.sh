#!/usr/bin/env bash
# Shared resolution rule for the Worktree Manager runtime. Sourced by
# worktree.sh and worktree-adapter.sh.

resolve_worktree_manager() {
  local global_candidate local_candidate
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    global_candidate="${XDG_CONFIG_HOME}/flowtask/worktree-manager/worktree.sh"
  else
    global_candidate="${HOME}/.config/flowtask/worktree-manager/worktree.sh"
  fi
  local_candidate="${SCRIPT_DIR}/worktree-manager/worktree.sh"

  if [[ -x "$global_candidate" ]]; then
    printf '%s' "$global_candidate"
    return 0
  fi
  if [[ -x "$local_candidate" ]]; then
    printf '%s' "$local_candidate"
    return 0
  fi
  printf ''
  return 0
}
