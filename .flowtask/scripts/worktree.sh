#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/worktree-locate.sh"

MANAGER="$(resolve_worktree_manager)"
if [[ -z "$MANAGER" ]]; then
  printf '%s\n' "Worktree Manager is not installed. Run 'flowtask install' to install the global dependency." >&2
  exit 1
fi

exec "$SCRIPT_DIR/worktree-adapter.sh" "$@"
