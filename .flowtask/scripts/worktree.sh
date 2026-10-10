#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Keep the public entrypoint intentionally small: distributions copy scripts/
# recursively, so the portable implementation travels with this wrapper.
# shellcheck source=/dev/null
source "$SCRIPT_DIR/lib/worktree-manager-core.sh"

worktree_manager_main "$@"
