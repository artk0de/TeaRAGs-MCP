#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-embedded}"
PLATFORM="${2:-darwin}"

# Binary name depends on platform
if [ "$PLATFORM" = "windows" ]; then
  BINARY_PATH="$HOME/.tea-rags/qdrant/bin/qdrant.exe"
else
  BINARY_PATH="$HOME/.tea-rags/qdrant/bin/qdrant"
fi
HEALTHZ_URL="http://localhost:6333/healthz"

wait_for_healthz() {
  local url="$1"
  local max_seconds=30
  local elapsed=0
  while [ "$elapsed" -lt "$max_seconds" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

output_json() {
  local status="$1"
  local mode="$2"
  local url="$3"
  printf '{"status":"%s","mode":"%s","url":"%s"}\n' "$status" "$mode" "$url"
}

case "$MODE" in
  embedded)
    if [ -f "$BINARY_PATH" ]; then
      output_json "already_done" "embedded" "embedded"
      exit 0
    fi
    # Ensure npx is available (may not be in PATH after fresh Node install)
    if ! command -v npx &>/dev/null; then
      echo "npx not found in PATH. Restart your terminal or source your shell profile, then retry." >&2
      output_json "error" "embedded" "embedded"
      exit 1
    fi
    # Trigger postinstall download
    npx tea-rags --version >/dev/null 2>&1 || true
    if [ -f "$BINARY_PATH" ]; then
      output_json "installed" "embedded" "embedded"
      exit 0
    fi
    echo "Embedded Qdrant binary not found after postinstall trigger" >&2
    output_json "error" "embedded" "embedded"
    exit 1
    ;;

  docker)
    if ! docker --version >/dev/null 2>&1; then
      echo "Docker is not installed or not in PATH" >&2
      exit 2
    fi

    # Check if Docker daemon is actually running (not just installed)
    if ! docker info >/dev/null 2>&1; then
      echo "Docker is installed but the daemon is not running. Start Docker Desktop and try again." >&2
      output_json "error" "docker" "http://localhost:6333"
      exit 1
    fi

    RUNNING=$(docker ps --filter "name=qdrant" --filter "status=running" --format "{{.Names}}" 2>/dev/null || true)
    if [ -n "$RUNNING" ]; then
      output_json "already_done" "docker" "http://localhost:6333"
      exit 0
    fi

    # Check if port 6333 is already in use by something else
    if curl -sf "$HEALTHZ_URL" >/dev/null 2>&1; then
      echo "Port 6333 is already in use (possibly by another Qdrant instance or service)" >&2
      echo "If this is your Qdrant, the setup will use it." >&2
      output_json "already_done" "docker" "http://localhost:6333"
      exit 0
    fi

    STOPPED=$(docker ps -a --filter "name=qdrant" --filter "status=exited" --format "{{.Names}}" 2>/dev/null || true)
    if [ -n "$STOPPED" ]; then
      docker start qdrant >/dev/null 2>&1
    else
      if ! docker run -d \
        --name qdrant \
        -p 6333:6333 \
        -v qdrant_storage:/qdrant/storage \
        qdrant/qdrant:latest >/dev/null 2>&1; then
        echo "Failed to start Qdrant container. Port 6333 may be in use by another process." >&2
        output_json "error" "docker" "http://localhost:6333"
        exit 1
      fi
    fi

    if wait_for_healthz "$HEALTHZ_URL"; then
      output_json "installed" "docker" "http://localhost:6333"
      exit 0
    else
      echo "Qdrant did not become healthy within 30 seconds" >&2
      output_json "error" "docker" "http://localhost:6333"
      exit 1
    fi
    ;;

  native)
    case "$PLATFORM" in
      darwin)
        if ! command -v brew &>/dev/null; then
          echo "Homebrew is required for native install on macOS" >&2
          output_json "error" "native" "http://localhost:6333"
          exit 1
        fi
        brew tap qdrant/tap >/dev/null 2>&1 || true
        brew install qdrant/tap/qdrant >/dev/null 2>&1
        brew services start qdrant >/dev/null 2>&1
        ;;
      linux)
        ARCH=$(uname -m)
        case "$ARCH" in
          x86_64)  QDRANT_ARCH="x86_64-unknown-linux-musl" ;;
          aarch64) QDRANT_ARCH="aarch64-unknown-linux-musl" ;;
          *)
            echo "Unsupported architecture: $ARCH" >&2
            output_json "error" "native" "http://localhost:6333"
            exit 1
            ;;
        esac

        LATEST_VERSION=$(curl -sf "https://api.github.com/repos/qdrant/qdrant/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
        if [ -z "$LATEST_VERSION" ]; then
          echo "Failed to fetch latest Qdrant version from GitHub" >&2
          output_json "error" "native" "http://localhost:6333"
          exit 1
        fi

        DOWNLOAD_URL="https://github.com/qdrant/qdrant/releases/download/${LATEST_VERSION}/qdrant-${QDRANT_ARCH}.tar.gz"
        INSTALL_DIR="$HOME/.local/bin"
        mkdir -p "$INSTALL_DIR"

        TMP_DIR=$(mktemp -d)
        trap 'rm -rf "$TMP_DIR"' EXIT

        curl -sfL "$DOWNLOAD_URL" | tar -xz -C "$TMP_DIR"
        mv "$TMP_DIR/qdrant" "$INSTALL_DIR/qdrant"
        chmod +x "$INSTALL_DIR/qdrant"

        STORAGE_PATH="$HOME/.tea-rags/qdrant-native-storage"
        mkdir -p "$STORAGE_PATH"
        nohup "$INSTALL_DIR/qdrant" --storage-path "$STORAGE_PATH" >/dev/null 2>&1 &
        ;;
      windows)
        WIN_ARCH=$(uname -m)
        case "$WIN_ARCH" in
          x86_64|amd64) QDRANT_ARCH="x86_64-pc-windows-msvc" ;;
          arm64|aarch64) QDRANT_ARCH="aarch64-pc-windows-msvc" ;;
          *)
            echo "Unsupported Windows architecture: $WIN_ARCH" >&2
            output_json "error" "native" "http://localhost:6333"
            exit 1
            ;;
        esac

        LATEST_VERSION=$(curl -sf "https://api.github.com/repos/qdrant/qdrant/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
        if [ -z "$LATEST_VERSION" ]; then
          echo "Failed to fetch latest Qdrant version from GitHub" >&2
          output_json "error" "native" "http://localhost:6333"
          exit 1
        fi

        DOWNLOAD_URL="https://github.com/qdrant/qdrant/releases/download/${LATEST_VERSION}/qdrant-${QDRANT_ARCH}.zip"
        INSTALL_DIR="$HOME/.tea-rags/qdrant/bin"
        mkdir -p "$INSTALL_DIR"

        TMP_DIR=$(mktemp -d)
        trap 'rm -rf "$TMP_DIR"' EXIT

        curl -sfL "$DOWNLOAD_URL" -o "$TMP_DIR/qdrant.zip"
        # unzip may not be available in Git Bash; fall back to powershell
        if command -v unzip &>/dev/null; then
          unzip -o "$TMP_DIR/qdrant.zip" -d "$TMP_DIR" >/dev/null 2>&1
        elif command -v powershell.exe &>/dev/null; then
          powershell.exe -NoProfile -Command \
            "Expand-Archive -Force -Path '$TMP_DIR/qdrant.zip' -DestinationPath '$TMP_DIR'" \
            2>/dev/null
        else
          echo "Neither unzip nor powershell available to extract archive" >&2
          output_json "error" "native" "http://localhost:6333"
          exit 1
        fi
        mv "$TMP_DIR/qdrant.exe" "$INSTALL_DIR/qdrant.exe"

        STORAGE_PATH="$HOME/.tea-rags/qdrant-native-storage"
        mkdir -p "$STORAGE_PATH"
        "$INSTALL_DIR/qdrant.exe" --storage-path "$STORAGE_PATH" &>/dev/null &
        ;;
      *)
        echo "Unsupported platform: $PLATFORM" >&2
        output_json "error" "native" "http://localhost:6333"
        exit 1
        ;;
    esac

    if wait_for_healthz "$HEALTHZ_URL"; then
      output_json "installed" "native" "http://localhost:6333"
      exit 0
    else
      echo "Qdrant did not become healthy within 30 seconds" >&2
      output_json "error" "native" "http://localhost:6333"
      exit 1
    fi
    ;;

  *)
    echo "Unknown mode: $MODE. Expected: embedded|docker|native" >&2
    exit 1
    ;;
esac
