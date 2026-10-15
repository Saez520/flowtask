#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The checkout is a required runtime dependency; there is no local lifecycle
# implementation to fall back to.
MANAGER="$SCRIPT_DIR/worktree-manager/worktree.sh"
if [[ ! -x "$MANAGER" ]]; then
  printf '%s\n' "Worktree Manager standalone ausente o no inicializado: $MANAGER" >&2
  exit 1
fi

exec "$SCRIPT_DIR/worktree-adapter.sh" "$@"
