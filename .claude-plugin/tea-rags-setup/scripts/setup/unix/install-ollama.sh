#!/usr/bin/env bash
set -euo pipefail

# ─── install-ollama.sh ───────────────────────────────────────────────────────
# Input:  $1 = platform (darwin|linux|windows)
#         $2 = GPU JSON (optional)
# Output: JSON → stdout   errors → stderr
# Exit:   0=success  1=error  2=manual_required

platform="${1:-darwin}"
# $2 (gpu_json) accepted and intentionally ignored on unix
MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"

# ─── Helpers ─────────────────────────────────────────────────────────────────

ollama_running() {
  ollama list &>/dev/null
}

ensure_ollama_running() {
  if ! ollama_running; then
    if [ "$platform" = "windows" ]; then
      # On Windows, Ollama runs as a tray app / service.
      # Try to start it via the app shortcut; if that fails, ask user.
      echo "Ollama is installed but not running. Attempting to start..." >&2
      # Try starting via powershell (launches the tray app)
      if command -v powershell.exe &>/dev/null; then
        powershell.exe -NoProfile -Command \
          "Start-Process 'ollama' -ArgumentList 'serve' -WindowStyle Hidden" \
          &>/dev/null || true
      fi
    else
      echo "Starting ollama server in background..." >&2
      ollama serve &>/dev/null &
    fi
    local retries=15
    while [[ $retries -gt 0 ]]; do
      sleep 1
      ollama_running && return 0
      retries=$((retries - 1))
    done
    echo "ollama server did not start in time" >&2
    return 1
  fi
}

model_present() {
  ollama list 2>/dev/null | grep -qF "$MODEL"
}

pull_model() {
  echo "Pulling model $MODEL ..." >&2
  ollama pull "$MODEL" >&2
}

emit_result() {
  local status="$1"
  local method="$2"
  jq -n \
    --arg status "$status" \
    --arg method "$method" \
    '{ status: $status, method: $method }'
}

# ─── Main logic ──────────────────────────────────────────────────────────────

if command -v ollama &>/dev/null; then
  # ollama already installed — ensure server is up, then check model
  ensure_ollama_running

  if model_present; then
    emit_result "already_done" "existing"
    exit 0
  else
    pull_model
    emit_result "already_done" "existing"
    exit 0
  fi
fi

# ollama not installed
case "$platform" in

  darwin|linux)
    echo "Installing ollama via official install script..." >&2
    curl -fsSL https://ollama.com/install.sh | sh >&2

    if ! command -v ollama &>/dev/null; then
      echo "ollama binary not found after install" >&2
      exit 1
    fi

    ensure_ollama_running
    pull_model
    emit_result "installed" "curl"
    ;;

  windows)
    jq -n '{
      status: "manual_required",
      method: "app"
    }'
    exit 2
    ;;

  *)
    echo "Unsupported platform: $platform" >&2
    exit 1
    ;;
esac
