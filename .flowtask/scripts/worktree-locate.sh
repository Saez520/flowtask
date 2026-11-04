#!/usr/bin/env bash
# Shared resolution rule for the Worktree Manager runtime. Sourced by
# worktree.sh and worktree-adapter.sh. Only the global installation is a
# valid source.

resolve_worktree_manager() {
  local global_candidate
  if [[ -n "${APPDATA:-}" ]]; then
    global_candidate="${APPDATA}/FlowTask/worktree-manager/worktree.sh"
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    global_candidate="${XDG_CONFIG_HOME}/flowtask/worktree-manager/worktree.sh"
  else
    global_candidate="${HOME}/.config/flowtask/worktree-manager/worktree.sh"
  fi

  if [[ -x "$global_candidate" ]]; then
    printf '%s' "$global_candidate"
    return 0
  fi
  printf ''
  return 0
}
