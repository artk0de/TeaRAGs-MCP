#!/usr/bin/env bash
set -euo pipefail

# ─── install-node.sh ─────────────────────────────────────────────────────────
# Input:  $1 = version manager (asdf|nvm|fnm|volta|mise|nodenv|n|nvm-windows|none)
# Output: JSON → stdout   errors → stderr
# Exit:   0=success  1=error  2=manual_required

vm="${1:-none}"
MIN_MAJOR=24
REQUIRED_VERSION="24.14.1"

# ─── Helpers ─────────────────────────────────────────────────────────────────

node_real_path() {
  local p
  p="$(command -v node 2>/dev/null || true)"
  [[ -z "$p" ]] && echo "" && return
  if command -v realpath &>/dev/null; then
    realpath "$p" 2>/dev/null || echo "$p"
  elif command -v readlink &>/dev/null; then
    readlink -f "$p" 2>/dev/null || echo "$p"
  else
    echo "$p"
  fi
}

node_major() {
  node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

emit_result() {
  local status="$1"
  local node_path="$2"
  local node_version="$3"
  jq -n \
    --arg status       "$status" \
    --arg nodePath     "$node_path" \
    --arg nodeVersion  "$node_version" \
    '{ status: $status, nodePath: $nodePath, nodeVersion: $nodeVersion }'
}

# ─── Check if already satisfied ──────────────────────────────────────────────

if command -v node &>/dev/null; then
  major="$(node_major)"
  if [[ "$major" -ge "$MIN_MAJOR" ]]; then
    version="$(node --version | sed 's/^v//')"
    path="$(node_real_path)"
    emit_result "already_done" "$path" "$version"
    exit 0
  fi
fi

# ─── Install via version manager ─────────────────────────────────────────────

case "$vm" in

  asdf)
    asdf plugin add nodejs 2>/dev/null || true
    asdf install nodejs "$REQUIRED_VERSION" >&2
    asdf global  nodejs "$REQUIRED_VERSION" >&2
    ;;

  nvm)
    nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [[ ! -f "$nvm_script" ]]; then
      echo "nvm.sh not found at $nvm_script" >&2
      exit 1
    fi
    # shellcheck source=/dev/null
    source "$nvm_script"
    nvm install "$REQUIRED_VERSION" >&2
    nvm alias default "$REQUIRED_VERSION" >&2
    ;;

  fnm)
    fnm install "$REQUIRED_VERSION" >&2
    fnm default "$REQUIRED_VERSION" >&2
    # Reload shell env so `node` resolves in this process
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    ;;

  volta)
    volta install "node@$REQUIRED_VERSION" >&2
    ;;

  mise)
    mise install "node@$REQUIRED_VERSION" >&2
    mise use -g "node@$REQUIRED_VERSION" >&2
    ;;

  nodenv)
    nodenv install "$REQUIRED_VERSION" >&2
    nodenv global  "$REQUIRED_VERSION" >&2
    ;;

  n)
    n "$REQUIRED_VERSION" >&2
    ;;

  nvm-windows)
    nvm install "$REQUIRED_VERSION" >&2
    nvm use "$REQUIRED_VERSION" >&2
    ;;

  none)
    # Include current version info so the wizard can tell the user what's wrong
    current_version="null"
    current_path="null"
    if command -v node &>/dev/null; then
      current_version="\"$(node --version 2>/dev/null | sed 's/^v//' || true)\""
      current_path="\"$(node_real_path)\""
    fi
    jq -n \
      --argjson currentVersion "$current_version" \
      --argjson currentPath "$current_path" \
      '{
        status:         "manual_required",
        nodePath:       null,
        nodeVersion:    null,
        currentVersion: $currentVersion,
        currentPath:    $currentPath
      }'
    exit 2
    ;;

  *)
    echo "Unknown version manager: $vm" >&2
    exit 1
    ;;
esac

# ─── Verify installation ──────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "node not found after install" >&2
  exit 1
fi

version="$(node --version | sed 's/^v//')"
major="$(echo "$version" | cut -d. -f1)"
if [[ "$major" -lt "$MIN_MAJOR" ]]; then
  echo "installed node $version is below required $MIN_MAJOR" >&2
  exit 1
fi

path="$(node_real_path)"
emit_result "installed" "$path" "$version"
