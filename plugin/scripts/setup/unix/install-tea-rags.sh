#!/usr/bin/env bash
set -euo pipefail

# ─── install-tea-rags.sh ─────────────────────────────────────────────────────
# Input:  $1 = package manager (npm|yarn|pnpm|bun)
#         $2 = path to the package manager binary
# Output: JSON → stdout   errors → stderr
# Exit:   0=success  1=error

pm="${1:-npm}"
pm_bin="${2:-}"

# If caller gave us a binary path, put it on PATH first
if [[ -n "$pm_bin" && -x "$pm_bin" ]]; then
  export PATH="$(dirname "$pm_bin"):$PATH"
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

tea_rags_bin() {
  command -v tea-rags 2>/dev/null || true
}

tea_rags_version() {
  local bin
  bin="$(tea_rags_bin)"
  [[ -z "$bin" ]] && echo "" && return
  "$bin" --version 2>/dev/null | sed 's/^[^0-9]*//' | tr -d '[:space:]' || true
}

latest_npm_version() {
  npm view tea-rags version 2>/dev/null | tr -d '[:space:]' || true
}

emit_result() {
  local status="$1"
  local bin_path="$2"
  local version="$3"
  jq -n \
    --arg status  "$status" \
    --arg binPath "$bin_path" \
    --arg version "$version" \
    '{ status: $status, binPath: $binPath, version: $version }'
}

# ─── npm prefix permission check ─────────────────────────────────────────────

check_npm_prefix_writable() {
  if [[ "$pm" == "npm" ]] && command -v npm &>/dev/null; then
    local prefix
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [[ -n "$prefix" && ! -w "$prefix" ]]; then
      echo "WARNING: npm global prefix $prefix is not writable. You may need sudo or to fix npm permissions." >&2
    fi
  fi
}

# ─── Install commands ─────────────────────────────────────────────────────────

do_install() {
  case "$pm" in
    npm)  npm  install -g tea-rags >&2 ;;
    yarn) yarn global add tea-rags >&2 ;;
    pnpm) pnpm add    -g tea-rags >&2 ;;
    bun)  bun  add    -g tea-rags >&2 ;;
    *)
      echo "Unknown package manager: $pm" >&2
      exit 1
      ;;
  esac
}

do_update() {
  case "$pm" in
    npm)  npm  install -g tea-rags@latest >&2 ;;
    yarn) yarn global upgrade tea-rags     >&2 ;;
    pnpm) pnpm update  -g tea-rags         >&2 ;;
    bun)  bun  add     -g tea-rags@latest  >&2 ;;
    *)
      echo "Unknown package manager: $pm" >&2
      exit 1
      ;;
  esac
}

# ─── Main logic ──────────────────────────────────────────────────────────────

current_bin="$(tea_rags_bin)"

if [[ -n "$current_bin" ]]; then
  current_ver="$(tea_rags_version)"
  latest_ver="$(latest_npm_version)"

  if [[ -n "$latest_ver" && "$current_ver" == "$latest_ver" ]]; then
    emit_result "already_done" "$current_bin" "$current_ver"
    exit 0
  else
    # Outdated — update
    check_npm_prefix_writable
    do_update
  fi
else
  # Not installed — install
  check_npm_prefix_writable
  do_install
fi

# ─── Verify ──────────────────────────────────────────────────────────────────

final_bin="$(tea_rags_bin)"
if [[ -z "$final_bin" ]]; then
  echo "tea-rags not found after install" >&2
  exit 1
fi

final_ver="$(tea_rags_version)"
emit_result "installed" "$final_bin" "$final_ver"
