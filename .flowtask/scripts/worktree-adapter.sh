#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/worktree-locate.sh"

MANAGER="$(resolve_worktree_manager)"
if [[ -z "$MANAGER" || ! -x "$MANAGER" ]]; then
  printf '%s\n' "Worktree Manager is not installed. Run 'flowtask install' to install the global dependency." >&2
  exit 1
fi

# The adapter is the compatibility boundary of the consumer. It translates a
# legacy setting or a legacy transaction only when the request asks for it
# explicitly, it declares the compatibility it applies and it never writes a
# legacy artifact. The output of the manager is published unchanged.
args=("$@")

notice() { printf '%s\n' "$1" >&2; }
reject() { printf '%s\n' "$1" >&2; exit "$2"; }

# ---------------------------------------------------------------- arguments
config_present=0
config_path=""
repo_argument=""
operation=""
index=0
while [[ $index -lt ${#args[@]} ]]; do
  token="${args[$index]}"
  case "$token" in
    --repo) repo_argument="${args[$((index + 1))]:-}"; index=$((index + 2));;
    --repo=*) repo_argument="${token#--repo=}"; index=$((index + 1));;
    --config) config_present=1; config_path="${args[$((index + 1))]:-}"; index=$((index + 2));;
    --config=*) config_present=1; config_path="${token#--config=}"; index=$((index + 1));;
    --parent-repo|--submodule-path|--base|--link-parent|--descriptor)
      index=$((index + 2));;
    --target) index=$((index + 2));;
    --*) index=$((index + 1));;
    *) operation="$token"; work_id_index=$((index + 1)); work_id="${args[$work_id_index]:-}"; break;;
  esac
done

target_direct=0
for token in "${args[@]}"; do
  case "$token" in
    --target|--parent-repo|--submodule-path) target_direct=1;;
  esac
done

preserve_dirty=0
for token in "${args[@]}"; do
  case "$token" in
    --preserve-dirty) preserve_dirty=1;;
  esac
done

# -------------------------------------------------------------- repository
repo=""
if [[ -n "$repo_argument" ]]; then
  repo="$(git -C "$repo_argument" rev-parse --show-toplevel 2>/dev/null || true)"
else
  repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi

# ------------------------------------------------- generic configuration
# The value of a setting is read from the explicit configuration file or from
# the repository configuration. The default applies only when the key is
# absent; a present but unusable value is rejected before the manager runs.
read_setting() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 1
  grep -q "^${key}=" "$file" || return 1
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

config_file=""
if [[ $config_present -eq 1 ]]; then
  [[ -n "$config_path" ]] || reject "The explicit configuration path is empty; no operation was started." 3
  config_file="$config_path"
elif [[ -n "$repo" ]]; then
  config_file="$repo/.worktree-manager.conf"
fi

state_dir="worktree-manager"
backup_ref_prefix="worktree-manager/backups"
if [[ -n "$config_file" && -f "$config_file" ]]; then
  if value="$(read_setting state_dir "$config_file")"; then
    if [[ -z "$value" || "$value" == /* || "$value" == *..* ]]; then
      reject "The configured state_dir is not a safe relative path; no operation was started." 3
    fi
    state_dir="$value"
  fi
  if value="$(read_setting backup_ref_prefix "$config_file")"; then
    if [[ -z "$value" || "$value" == /* || "$value" == *..* ]]; then
      reject "The configured backup_ref_prefix is not a safe relative path; no operation was started." 3
    fi
    backup_ref_prefix="$value"
  fi
fi

# --------------------------------------------- legacy configuration reading
legacy_config=""
[[ -n "$repo" ]] && legacy_config="$repo/.flowtask/config/worktree.json"

if [[ "$operation" == "complete" && $preserve_dirty -eq 1 && -n "$legacy_config" && -f "$legacy_config" ]]; then
  if [[ $config_present -eq 1 ]]; then
    notice "Compatibility: legacy FlowTask configuration ignored because --config was provided."
  else
    command -v node >/dev/null 2>&1 \
      || reject "The legacy configuration cannot be read without node; no operation was started." 3
    if ! consent="$(node -e '
      const fs = require("fs");
      const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (typeof document.preserveDirty !== "boolean") process.exit(1);
      process.stdout.write(document.preserveDirty ? "true" : "false");
    ' "$legacy_config" 2>/dev/null)"; then
      reject "The legacy configuration is invalid; no operation was started." 3
    fi
    if [[ "$consent" == "true" ]]; then
      adapter_config="$(mktemp "${TMPDIR:-/tmp}/worktree-adapter.XXXXXX")"
      printf 'preserve_dirty=true\n' > "$adapter_config"
      trap 'rm -f -- "$adapter_config"' EXIT
      args=(--config "$adapter_config" "${args[@]}")
      notice "Compatibility: legacy FlowTask preserveDirty setting applied."
    fi
  fi
fi

# ------------------------------------------------- legacy transaction import
work_id_of() {
  local directory="$1" value=""
  for document in "$directory/binding.json" "$directory/meta.json"; do
    [[ -f "$document" ]] || continue
    value="$(sed -n 's/.*"work_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$document" | head -n 1)"
    [[ -n "$value" ]] && break
  done
  if [[ -z "$value" && -f "$directory/meta" ]]; then
    value="$(sed -n 's/^work_id: //p' "$directory/meta" | head -n 1)"
    [[ -n "$value" ]] || value="$(sed -n 's/^ca_name: //p' "$directory/meta" | head -n 1)"
  fi
  [[ -n "$value" && "$value" != *$'\n'* ]] || return 1
  printf '%s' "$value"
}

recover_id=""
recover_id_index=-1
if [[ "$operation" == "recover" ]]; then
  recover_id_index=$((index + 1))
  recover_id="${args[$recover_id_index]:-}"
elif [[ "$operation" == "target-direct" && "${args[$((index + 1))]:-}" == "recover" ]]; then
  recover_id_index=$((index + 2))
  recover_id="${args[$recover_id_index]:-}"
fi

if [[ -n "$recover_id" && "$recover_id" == td-* ]]; then
  recover_id="wt-${recover_id#td-}"
  args[$recover_id_index]="$recover_id"
fi

if [[ "$operation" == "recover" && $target_direct -eq 0 && -n "$repo" && -n "$recover_id" \
      && "$recover_id" != */* && "$recover_id" != .* && "$recover_id" != -* ]]; then
  transaction="$recover_id"
  legacy_transaction="$repo/.flowtask/backups/$transaction"
  git_dir="$(git -C "$repo" rev-parse --git-dir 2>/dev/null || true)"
  if [[ -n "$git_dir" ]]; then
    [[ "$git_dir" = /* ]] || git_dir="$repo/$git_dir"
    git_dir="$(cd -- "$git_dir" && pwd -P)"
    canonical_transaction="$git_dir/$state_dir/transactions/$transaction"
    if [[ -d "$canonical_transaction" ]]; then
      canonical_work_id="$(work_id_of "$canonical_transaction" || true)"
      [[ -n "$canonical_work_id" ]] \
        || reject "The canonical transaction record is invalid; nothing was changed." 5
      if [[ -d "$legacy_transaction" ]]; then
        legacy_work_id="$(work_id_of "$legacy_transaction" || true)"
        [[ -n "$legacy_work_id" ]] \
          || reject "The legacy transaction record is invalid; nothing was changed." 5
        [[ "$legacy_work_id" == "$canonical_work_id" ]] \
          || reject "The canonical and the legacy transaction belong to different works; nothing was changed." 5
        notice "Compatibility: canonical transaction $transaction is authoritative; legacy copy left unchanged."
      fi
    elif [[ -d "$legacy_transaction" ]]; then
      legacy_work_id="$(work_id_of "$legacy_transaction" || true)"
      [[ -n "$legacy_work_id" ]] \
        || reject "The legacy transaction record is invalid; nothing was changed." 5
      for suffix in '' '-untracked'; do
        legacy_ref="refs/flowtask/backups/$transaction$suffix"
        canonical_ref="refs/$backup_ref_prefix/$transaction$suffix"
        legacy_sha="$(git -C "$repo" rev-parse --verify --quiet "$legacy_ref" 2>/dev/null || true)"
        [[ -n "$legacy_sha" ]] || continue
        canonical_sha="$(git -C "$repo" rev-parse --verify --quiet "$canonical_ref" 2>/dev/null || true)"
        if [[ -n "$canonical_sha" && "$canonical_sha" != "$legacy_sha" ]]; then
          reject "The canonical and the legacy backup reference differ; nothing was changed." 5
        fi
      done
      mkdir -p -- "$(dirname -- "$canonical_transaction")"
      cp -R -- "$legacy_transaction" "$canonical_transaction"
      if [[ -f "$canonical_transaction/meta" ]] && ! grep -q '^work_id: ' "$canonical_transaction/meta"; then
        printf 'work_id: %s\n' "$legacy_work_id" >> "$canonical_transaction/meta"
      fi
      for suffix in '' '-untracked'; do
        legacy_ref="refs/flowtask/backups/$transaction$suffix"
        canonical_ref="refs/$backup_ref_prefix/$transaction$suffix"
        legacy_sha="$(git -C "$repo" rev-parse --verify --quiet "$legacy_ref" 2>/dev/null || true)"
        [[ -n "$legacy_sha" ]] || continue
        canonical_sha="$(git -C "$repo" rev-parse --verify --quiet "$canonical_ref" 2>/dev/null || true)"
        [[ -z "$canonical_sha" ]] || continue
        git -C "$repo" update-ref "$canonical_ref" "$legacy_sha"
      done
      notice "Compatibility: legacy FlowTask transaction $transaction imported for recovery."
    fi
  fi
fi

# The consumer supplies the Spanish fallback when complete has no title flag.
if [[ "$operation" == "complete" ]]; then
  has_title=0
  for token in "${args[@]}"; do
    case "$token" in
      --title|--title=*) has_title=1;;
    esac
  done
  if [[ $has_title -eq 0 && -n "${work_id:-}" && "${work_id}" != -* ]]; then
    args+=(--title "Cierre generico de ${work_id}" --body "No habia una descripcion de la entrega disponible al momento del cierre.")
  fi
fi

set +e
"$MANAGER" "${args[@]}"
status=$?
set -e
exit "$status"
