#!/usr/bin/env bash
set -euo pipefail

# ─── install-node.sh ─────────────────────────────────────────────────────────
# Input:  $1 = version manager (asdf|nvm|fnm|volta|mise|nodenv|n|nvm-windows|none)
# Output: JSON → stdout   errors → stderr
# Exit:   0=success  1=error  2=manual_required

vm="${1:-none}"
MIN_MAJOR=22

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
    # Find latest 22.x available
    latest22="$(asdf list-all nodejs 2>/dev/null \
      | grep -E '^22\.' \
      | grep -v '[a-zA-Z]' \
      | sort -t. -k1,1n -k2,2n -k3,3n \
      | tail -1)"
    if [[ -z "$latest22" ]]; then
      echo "asdf: could not find a nodejs 22.x version to install" >&2
      exit 1
    fi
    asdf install nodejs "$latest22" >&2
    asdf global  nodejs "$latest22" >&2
    ;;

  nvm)
    nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [[ ! -f "$nvm_script" ]]; then
      echo "nvm.sh not found at $nvm_script" >&2
      exit 1
    fi
    # shellcheck source=/dev/null
    source "$nvm_script"
    nvm install 22 >&2
    nvm alias default 22 >&2
    ;;

  fnm)
    fnm install 22 >&2
    fnm default 22 >&2
    # Reload shell env so `node` resolves in this process
    eval "$(fnm env --shell bash 2>/dev/null)" || true
    ;;

  volta)
    volta install node@22 >&2
    ;;

  mise)
    mise install node@22 >&2
    mise use -g node@22 >&2
    ;;

  nodenv)
    # Find latest 22.x
    latest22="$(nodenv install -l 2>/dev/null \
      | grep -E '^\s*22\.' \
      | grep -v '[a-zA-Z]' \
      | sort -t. -k1,1n -k2,2n -k3,3n \
      | tail -1 \
      | xargs)"
    if [[ -z "$latest22" ]]; then
      echo "nodenv: could not find a nodejs 22.x version to install" >&2
      exit 1
    fi
    nodenv install "$latest22" >&2
    nodenv global  "$latest22" >&2
    ;;

  n)
    n 22 >&2
    ;;

  nvm-windows)
    nvm install 22 >&2
    nvm use 22 >&2
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
