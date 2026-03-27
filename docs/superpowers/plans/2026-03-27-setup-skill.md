# Setup Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `/tea-rags:setup` skill that automates TeaRAGs installation
across macOS, Linux, and Windows.

**Architecture:** Modular bash/PowerShell scripts orchestrated by SKILL.md agent
prompt. Each script is idempotent, outputs JSON to stdout, errors to stderr.
Progress persists in `~/.tea-rags/setup-progress.json` for resumable
installation. Unix scripts (.sh) for macOS/Linux, PowerShell scripts (.ps1) for
Windows.

**Tech Stack:** Bash, PowerShell, jq (unix), ConvertTo-Json/ConvertFrom-Json
(windows), Claude Code SKILL.md prompt format

**Spec:** `docs/superpowers/specs/2026-03-26-setup-skill-design.md`

---

## File Structure

```
plugin/
  skills/
    setup/
      SKILL.md                              # Agent orchestrator prompt
  scripts/
    setup/
      unix/
        progress.sh                         # Progress file CRUD (~/.tea-rags/setup-progress.json)
        detect-environment.sh               # Platform, arch, version managers, GPU
        install-node.sh                     # Node.js 22+ installation via version manager
        install-tea-rags.sh                 # npm/yarn/pnpm/bun install -g tea-rags
        install-ollama.sh                   # Ollama install (app checkpoint or curl)
        setup-qdrant.sh                     # Qdrant by mode: embedded/docker/native
        tune.sh                             # Run npx tea-rags tune, parse results
        analyze-project.sh                  # Git analysis, LOC estimate, env recommendations
        configure-mcp.sh                    # claude mcp add with env vars
      windows/
        progress.ps1                        # Same contract as unix, PowerShell
        detect-environment.ps1
        install-node.ps1
        install-tea-rags.ps1
        install-ollama.ps1
        setup-qdrant.ps1
        tune.ps1
        analyze-project.ps1
        configure-mcp.ps1
  .claude-plugin/
    plugin.json                             # Version bump
```

---

### Task 1: progress.sh — Progress File CRUD

**Files:**

- Create: `plugin/scripts/setup/unix/progress.sh`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p plugin/scripts/setup/unix plugin/scripts/setup/windows
```

- [ ] **Step 2: Write progress.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

PROGRESS_DIR="$HOME/.tea-rags"
PROGRESS_FILE="$PROGRESS_DIR/setup-progress.json"

usage() {
  echo "Usage: progress.sh <init|get|set> [dotpath] [value]" >&2
  exit 1
}

ensure_dir() {
  mkdir -p "$PROGRESS_DIR"
}

cmd_init() {
  ensure_dir
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  cat > "$PROGRESS_FILE" <<EOF
{
  "version": 1,
  "startedAt": "$now",
  "platform": null,
  "arch": null,
  "versionManager": null,
  "packageManager": null,
  "nodePath": null,
  "npmPath": null,
  "embeddingProvider": null,
  "qdrantMode": null,
  "projectPath": null,
  "projectLocEstimate": null,
  "gpu": null,
  "steps": {
    "detect": { "status": "pending" },
    "node": { "status": "pending" },
    "tea-rags": { "status": "pending" },
    "embedding": { "status": "pending" },
    "qdrant": { "status": "pending" },
    "tune": { "status": "pending" },
    "analyze": { "status": "pending" },
    "configure": { "status": "pending" },
    "verify": { "status": "pending" }
  }
}
EOF
  cat "$PROGRESS_FILE"
}

cmd_get() {
  if [ ! -f "$PROGRESS_FILE" ]; then
    echo '{"error": "no progress file"}' >&2
    exit 1
  fi
  if [ $# -eq 0 ]; then
    cat "$PROGRESS_FILE"
  else
    jq -r ".$1" "$PROGRESS_FILE"
  fi
}

cmd_set() {
  if [ $# -lt 2 ]; then
    usage
  fi
  local dotpath="$1"
  local value="$2"
  ensure_dir

  if [ ! -f "$PROGRESS_FILE" ]; then
    echo '{"error": "no progress file, run init first"}' >&2
    exit 1
  fi

  # Determine if value is JSON (starts with { or [ or ") or scalar
  if echo "$value" | jq -e . >/dev/null 2>&1; then
    jq ".$dotpath = $value" "$PROGRESS_FILE" > "${PROGRESS_FILE}.tmp" \
      && mv "${PROGRESS_FILE}.tmp" "$PROGRESS_FILE"
  else
    jq ".$dotpath = \"$value\"" "$PROGRESS_FILE" > "${PROGRESS_FILE}.tmp" \
      && mv "${PROGRESS_FILE}.tmp" "$PROGRESS_FILE"
  fi

  echo '{"status": "ok"}'
}

case "${1:-}" in
  init) cmd_init ;;
  get)  shift; cmd_get "$@" ;;
  set)  shift; cmd_set "$@" ;;
  *)    usage ;;
esac
```

- [ ] **Step 3: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/progress.sh
```

Run:

```bash
plugin/scripts/setup/unix/progress.sh init
plugin/scripts/setup/unix/progress.sh get steps.detect.status
# Expected: "pending"
plugin/scripts/setup/unix/progress.sh set platform '"darwin"'
plugin/scripts/setup/unix/progress.sh get platform
# Expected: "darwin"
```

Clean up:

```bash
rm -f ~/.tea-rags/setup-progress.json
```

- [ ] **Step 4: Commit**

```bash
git add plugin/scripts/setup/unix/progress.sh
git commit -m "feat(dx): add setup progress CRUD script (unix)"
```

---

### Task 2: detect-environment.sh — Platform & Environment Detection

**Files:**

- Create: `plugin/scripts/setup/unix/detect-environment.sh`

- [ ] **Step 1: Write detect-environment.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Platform detection ---
detect_platform() {
  local os
  os=$(uname -s)
  case "$os" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)      echo "unknown" ;;
  esac
}

detect_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) echo "x86_64" ;;
    arm64|aarch64) echo "arm64" ;;
    *)             echo "$arch" ;;
  esac
}

# --- Version manager inventory ---
detect_available_managers() {
  local managers=()

  command -v volta  >/dev/null 2>&1 && managers+=("volta")
  command -v asdf   >/dev/null 2>&1 && managers+=("asdf")
  command -v mise   >/dev/null 2>&1 && managers+=("mise")
  command -v fnm    >/dev/null 2>&1 && managers+=("fnm")
  command -v nodenv >/dev/null 2>&1 && managers+=("nodenv")
  command -v n      >/dev/null 2>&1 && managers+=("n")

  # nvm is a shell function, not a binary
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    managers+=("nvm")
  fi

  # Output as JSON array
  printf '%s\n' "${managers[@]}" | jq -R . | jq -s .
}

# --- Active version manager detection ---
detect_active_manager() {
  local node_path
  node_path=$(command -v node 2>/dev/null || true)

  if [ -z "$node_path" ]; then
    echo "none"
    return
  fi

  # Resolve symlinks to get real path
  local real_path
  if command -v realpath >/dev/null 2>&1; then
    real_path=$(realpath "$node_path")
  elif command -v readlink >/dev/null 2>&1; then
    real_path=$(readlink -f "$node_path" 2>/dev/null || echo "$node_path")
  else
    real_path="$node_path"
  fi

  case "$real_path" in
    */.volta/tools/image/node/*)          echo "volta" ;;
    */.asdf/installs/nodejs/*)            echo "asdf" ;;
    */.local/share/mise/installs/node/*)  echo "mise" ;;
    */.fnm/node-versions/*)               echo "fnm" ;;
    */.nvm/versions/node/*)               echo "nvm" ;;
    */.nodenv/versions/*)                 echo "nodenv" ;;
    */n/versions/node/*)                  echo "n" ;;
    *)                                    echo "none" ;;
  esac
}

# --- Package manager detection ---
detect_package_manager() {
  local node_path="$1"

  if [ -z "$node_path" ] || [ "$node_path" = "null" ]; then
    echo "npm"
    return
  fi

  # Get the bin directory of the active node
  local bin_dir
  bin_dir=$(dirname "$node_path")

  # npm is always present with node, but check for others in same prefix
  # Prefer npm for global installs (most universal)
  echo "npm"
}

# --- Node info ---
detect_node() {
  local node_path node_version npm_path

  node_path=$(command -v node 2>/dev/null || true)
  if [ -z "$node_path" ]; then
    echo "null" "null" "null"
    return
  fi

  # Resolve to real path
  if command -v realpath >/dev/null 2>&1; then
    node_path=$(realpath "$node_path")
  fi

  node_version=$(node --version 2>/dev/null | sed 's/^v//' || echo "null")

  npm_path=$(command -v npm 2>/dev/null || true)
  if [ -n "$npm_path" ] && command -v realpath >/dev/null 2>&1; then
    npm_path=$(realpath "$npm_path")
  fi

  echo "$node_path" "$node_version" "$npm_path"
}

# --- Tool checks ---
has_command() {
  command -v "$1" >/dev/null 2>&1 && echo "true" || echo "false"
}

# --- GPU detection ---
detect_gpu() {
  local platform="$1"
  local vendor="none"
  local model="unknown"
  local architecture="null"

  case "$platform" in
    darwin)
      local gpu_info
      gpu_info=$(system_profiler SPDisplaysDataType 2>/dev/null || true)
      if echo "$gpu_info" | grep -qi "apple"; then
        vendor="apple"
        model=$(echo "$gpu_info" | grep "Chipset Model:" | head -1 | sed 's/.*: //' | xargs)
      fi
      ;;
    linux)
      local lspci_out
      lspci_out=$(lspci 2>/dev/null | grep -i vga || true)
      if echo "$lspci_out" | grep -qi "nvidia"; then
        vendor="nvidia"
        model=$(echo "$lspci_out" | grep -oi "NVIDIA.*" | head -1 | xargs)
      elif echo "$lspci_out" | grep -qi "amd\|radeon"; then
        vendor="amd"
        model=$(echo "$lspci_out" | grep -oi "AMD.*\|Radeon.*" | head -1 | xargs)
        # Detect RDNA generation
        if echo "$model" | grep -qiE "RX\s*7[0-9]{3}"; then
          architecture="RDNA3"
        elif echo "$model" | grep -qiE "RX\s*6[0-9]{3}"; then
          architecture="RDNA2"
        fi
      elif echo "$lspci_out" | grep -qi "intel"; then
        vendor="intel"
        model=$(echo "$lspci_out" | grep -oi "Intel.*" | head -1 | xargs)
      fi
      ;;
  esac

  # Output as JSON
  if [ "$architecture" = "null" ]; then
    printf '{"vendor":"%s","model":"%s","architecture":null}' "$vendor" "$model"
  else
    printf '{"vendor":"%s","model":"%s","architecture":"%s"}' "$vendor" "$model" "$architecture"
  fi
}

# --- Main ---
main() {
  local platform arch
  platform=$(detect_platform)
  arch=$(detect_arch)

  local available_managers
  available_managers=$(detect_available_managers)

  local active_manager
  active_manager=$(detect_active_manager)

  read -r node_path node_version npm_path <<< "$(detect_node)"

  local package_manager
  package_manager=$(detect_package_manager "$node_path")

  local gpu_json
  gpu_json=$(detect_gpu "$platform")

  # Build final JSON
  jq -n \
    --arg platform "$platform" \
    --arg arch "$arch" \
    --argjson availableManagers "$available_managers" \
    --arg activeManager "$active_manager" \
    --arg packageManager "$package_manager" \
    --arg nodeVersion "${node_version}" \
    --arg nodePath "${node_path}" \
    --arg npmPath "${npm_path}" \
    --argjson hasGit "$(has_command git)" \
    --argjson hasDocker "$(has_command docker)" \
    --argjson hasOllama "$(has_command ollama)" \
    --argjson hasBrew "$(has_command brew)" \
    --argjson gpu "$gpu_json" \
    '{
      platform: $platform,
      arch: $arch,
      availableManagers: $availableManagers,
      activeManager: $activeManager,
      packageManager: $packageManager,
      nodeVersion: (if $nodeVersion == "null" then null else $nodeVersion end),
      nodePath: (if $nodePath == "null" then null else $nodePath end),
      npmPath: (if $npmPath == "null" then null else $npmPath end),
      hasGit: $hasGit,
      hasDocker: $hasDocker,
      hasOllama: $hasOllama,
      hasBrew: $hasBrew,
      gpu: $gpu
    }'
}

main
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/detect-environment.sh
plugin/scripts/setup/unix/detect-environment.sh | jq .
```

Expected: JSON with current machine info (platform, arch, managers, node path,
gpu). Verify `activeManager` matches your actual version manager and `nodePath`
resolves to the correct binary.

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/detect-environment.sh
git commit -m "feat(dx): add environment detection script (unix)"
```

---

### Task 3: install-node.sh — Node.js Installation

**Files:**

- Create: `plugin/scripts/setup/unix/install-node.sh`

- [ ] **Step 1: Write install-node.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION_MANAGER="${1:-none}"
REQUIRED_MAJOR=22

json_result() {
  local status="$1" node_path="${2:-null}" node_version="${3:-null}"
  if [ "$node_path" = "null" ]; then
    printf '{"status":"%s","nodePath":null,"nodeVersion":null}\n' "$status"
  else
    printf '{"status":"%s","nodePath":"%s","nodeVersion":"%s"}\n' "$status" "$node_path" "$node_version"
  fi
}

# Check current node
current_node_path=$(command -v node 2>/dev/null || true)
if [ -n "$current_node_path" ]; then
  current_version=$(node --version 2>/dev/null | sed 's/^v//')
  current_major=$(echo "$current_version" | cut -d. -f1)

  if [ "$current_major" -ge "$REQUIRED_MAJOR" ] 2>/dev/null; then
    # Resolve real path
    if command -v realpath >/dev/null 2>&1; then
      current_node_path=$(realpath "$current_node_path")
    fi
    json_result "already_done" "$current_node_path" "$current_version"
    exit 0
  fi

  echo "Node.js $current_version found but >= $REQUIRED_MAJOR required" >&2
fi

# Attempt install via version manager
case "$VERSION_MANAGER" in
  asdf)
    echo "Installing Node.js $REQUIRED_MAJOR via asdf..." >&2
    asdf plugin add nodejs 2>/dev/null || true
    local_latest=$(asdf list all nodejs | grep "^${REQUIRED_MAJOR}\." | tail -1)
    asdf install nodejs "$local_latest" && asdf global nodejs "$local_latest"
    ;;
  nvm)
    # Source nvm
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    echo "Installing Node.js $REQUIRED_MAJOR via nvm..." >&2
    nvm install "$REQUIRED_MAJOR" && nvm alias default "$REQUIRED_MAJOR"
    ;;
  fnm)
    echo "Installing Node.js $REQUIRED_MAJOR via fnm..." >&2
    fnm install "$REQUIRED_MAJOR" && fnm default "$REQUIRED_MAJOR"
    ;;
  volta)
    echo "Installing Node.js $REQUIRED_MAJOR via volta..." >&2
    volta install "node@$REQUIRED_MAJOR"
    ;;
  mise)
    echo "Installing Node.js $REQUIRED_MAJOR via mise..." >&2
    mise install "node@$REQUIRED_MAJOR" && mise use -g "node@$REQUIRED_MAJOR"
    ;;
  nodenv)
    echo "Installing Node.js $REQUIRED_MAJOR via nodenv..." >&2
    local_latest=$(nodenv install --list | grep "^${REQUIRED_MAJOR}\." | tail -1)
    nodenv install "$local_latest" && nodenv global "$local_latest"
    ;;
  n)
    echo "Installing Node.js $REQUIRED_MAJOR via n..." >&2
    n "$REQUIRED_MAJOR"
    ;;
  none|*)
    json_result "manual_required"
    exit 2
    ;;
esac

# Verify installation
new_node_path=$(command -v node 2>/dev/null || true)
if [ -n "$new_node_path" ]; then
  if command -v realpath >/dev/null 2>&1; then
    new_node_path=$(realpath "$new_node_path")
  fi
  new_version=$(node --version | sed 's/^v//')
  json_result "installed" "$new_node_path" "$new_version"
else
  echo "Node.js installation failed" >&2
  json_result "manual_required"
  exit 2
fi
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/install-node.sh
# Test with your current version manager (should return already_done)
plugin/scripts/setup/unix/install-node.sh asdf | jq .
```

Expected:
`{"status": "already_done", "nodePath": "...", "nodeVersion": "22.x.x"}`

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/install-node.sh
git commit -m "feat(dx): add Node.js installation script (unix)"
```

---

### Task 4: install-tea-rags.sh — Package Installation

**Files:**

- Create: `plugin/scripts/setup/unix/install-tea-rags.sh`

- [ ] **Step 1: Write install-tea-rags.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

PACKAGE_MANAGER="${1:-npm}"
BIN_PATH="${2:-$(command -v "$PACKAGE_MANAGER" 2>/dev/null || echo "$PACKAGE_MANAGER")}"

json_result() {
  local status="$1" bin_path="${2:-null}" version="${3:-null}"
  if [ "$bin_path" = "null" ]; then
    printf '{"status":"%s","binPath":null,"version":null}\n' "$status"
  else
    printf '{"status":"%s","binPath":"%s","version":"%s"}\n' "$status" "$bin_path" "$version"
  fi
}

# Check if already installed
tea_rags_bin=$(command -v tea-rags 2>/dev/null || true)
if [ -n "$tea_rags_bin" ]; then
  installed_version=$(tea-rags --version 2>/dev/null || echo "unknown")
  # Check latest version on npm
  latest_version=$(npm view tea-rags version 2>/dev/null || echo "unknown")

  if [ "$installed_version" = "$latest_version" ]; then
    json_result "already_done" "$tea_rags_bin" "$installed_version"
    exit 0
  fi

  echo "tea-rags $installed_version installed, latest is $latest_version" >&2

  # Update
  case "$PACKAGE_MANAGER" in
    npm)  "$BIN_PATH" update -g tea-rags 2>&1 >&2 ;;
    yarn) "$BIN_PATH" global upgrade tea-rags 2>&1 >&2 ;;
    pnpm) "$BIN_PATH" update -g tea-rags 2>&1 >&2 ;;
    bun)  "$BIN_PATH" update -g tea-rags 2>&1 >&2 ;;
  esac
else
  # Check permissions for npm
  if [ "$PACKAGE_MANAGER" = "npm" ]; then
    global_prefix=$("$BIN_PATH" prefix -g 2>/dev/null || true)
    if [ -n "$global_prefix" ] && [ ! -w "$global_prefix" ]; then
      echo "WARNING: No write access to $global_prefix" >&2
      echo "Run with sudo or: npm config set prefix ~/.npm-global" >&2
    fi
  fi

  # Install
  echo "Installing tea-rags via $PACKAGE_MANAGER..." >&2
  case "$PACKAGE_MANAGER" in
    npm)  "$BIN_PATH" install -g tea-rags 2>&1 >&2 ;;
    yarn) "$BIN_PATH" global add tea-rags 2>&1 >&2 ;;
    pnpm) "$BIN_PATH" add -g tea-rags 2>&1 >&2 ;;
    bun)  "$BIN_PATH" add -g tea-rags 2>&1 >&2 ;;
  esac
fi

# Verify
tea_rags_bin=$(command -v tea-rags 2>/dev/null || true)
if [ -n "$tea_rags_bin" ]; then
  final_version=$(tea-rags --version 2>/dev/null || echo "unknown")
  json_result "installed" "$tea_rags_bin" "$final_version"
else
  echo "tea-rags installation failed" >&2
  json_result "error"
  exit 1
fi
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/install-tea-rags.sh
# Dry-run: since tea-rags is likely installed, should return already_done
plugin/scripts/setup/unix/install-tea-rags.sh npm | jq .
```

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/install-tea-rags.sh
git commit -m "feat(dx): add tea-rags installation script (unix)"
```

---

### Task 5: install-ollama.sh — Ollama Installation

**Files:**

- Create: `plugin/scripts/setup/unix/install-ollama.sh`

- [ ] **Step 1: Write install-ollama.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

PLATFORM="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
GPU_JSON="${2:-'{}'}"
MODEL="unclemusclez/jina-embeddings-v2-base-code:latest"

json_result() {
  local status="$1" method="${2:-null}"
  printf '{"status":"%s","method":"%s"}\n' "$status" "$method"
}

# Check if already installed
if command -v ollama >/dev/null 2>&1; then
  ollama_version=$(ollama --version 2>/dev/null || echo "unknown")
  echo "Ollama already installed: $ollama_version" >&2

  # Check if model is pulled
  if ollama list 2>/dev/null | grep -q "$(echo "$MODEL" | sed 's/:latest$//')"; then
    echo "Model $MODEL already available" >&2
    json_result "already_done" "existing"
    exit 0
  fi

  # Pull model
  echo "Pulling model $MODEL..." >&2
  ollama pull "$MODEL" 2>&1 >&2
  json_result "already_done" "existing"
  exit 0
fi

# Platform-specific install
case "$PLATFORM" in
  darwin)
    # macOS: require app download (Metal GPU)
    json_result "manual_required" "app"
    exit 2
    ;;
  linux)
    # Linux: auto-install via curl script
    echo "Installing Ollama via official script..." >&2
    curl -fsSL https://ollama.com/install.sh | sh 2>&1 >&2

    # Verify
    if ! command -v ollama >/dev/null 2>&1; then
      echo "Ollama installation failed" >&2
      json_result "error" "curl"
      exit 1
    fi

    # Pull model
    echo "Pulling model $MODEL..." >&2
    ollama pull "$MODEL" 2>&1 >&2

    json_result "installed" "curl"
    ;;
  *)
    echo "Unsupported platform: $PLATFORM" >&2
    json_result "error" "null"
    exit 1
    ;;
esac
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/install-ollama.sh
# On macOS: should return manual_required + method app
plugin/scripts/setup/unix/install-ollama.sh darwin '{}' | jq .
```

Expected (if ollama already installed):
`{"status": "already_done", "method": "existing"}` Expected (if not installed on
macOS): `{"status": "manual_required", "method": "app"}`

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/install-ollama.sh
git commit -m "feat(dx): add Ollama installation script (unix)"
```

---

### Task 6: setup-qdrant.sh — Qdrant Setup

**Files:**

- Create: `plugin/scripts/setup/unix/setup-qdrant.sh`

- [ ] **Step 1: Write setup-qdrant.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-embedded}"
PLATFORM="${2:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
QDRANT_BIN_DIR="$HOME/.tea-rags/qdrant/bin"

json_result() {
  local status="$1" mode="$2" url="$3"
  printf '{"status":"%s","mode":"%s","url":"%s"}\n' "$status" "$mode" "$url"
}

case "$MODE" in
  embedded)
    # Check if binary exists (downloaded by npm postinstall)
    if [ -f "$QDRANT_BIN_DIR/qdrant" ]; then
      json_result "already_done" "embedded" "embedded"
    else
      echo "Embedded Qdrant binary not found. Downloading..." >&2
      # Use the same download logic as postinstall
      # npx tea-rags will trigger postinstall download
      npx tea-rags --version >/dev/null 2>&1 || true

      if [ -f "$QDRANT_BIN_DIR/qdrant" ]; then
        json_result "installed" "embedded" "embedded"
      else
        echo "Failed to download Qdrant binary" >&2
        json_result "error" "embedded" "embedded"
        exit 1
      fi
    fi
    ;;

  docker)
    # Check Docker
    if ! command -v docker >/dev/null 2>&1; then
      echo "Docker not found" >&2
      json_result "error" "docker" "http://localhost:6333"
      exit 2
    fi

    # Check if qdrant container already running
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^qdrant$'; then
      echo "Qdrant container already running" >&2
      json_result "already_done" "docker" "http://localhost:6333"
      exit 0
    fi

    # Check if container exists but stopped
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^qdrant$'; then
      echo "Starting existing Qdrant container..." >&2
      docker start qdrant >&2
    else
      echo "Creating Qdrant container..." >&2
      docker run -d \
        --name qdrant \
        -p 6333:6333 \
        -v qdrant_storage:/qdrant/storage \
        qdrant/qdrant:latest 2>&1 >&2
    fi

    # Wait for healthz
    echo "Waiting for Qdrant to be ready..." >&2
    for i in $(seq 1 30); do
      if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
        json_result "installed" "docker" "http://localhost:6333"
        exit 0
      fi
      sleep 1
    done

    echo "Qdrant failed to start within 30s" >&2
    json_result "error" "docker" "http://localhost:6333"
    exit 1
    ;;

  native)
    case "$PLATFORM" in
      darwin)
        if ! command -v brew >/dev/null 2>&1; then
          echo "Homebrew not found, required for native Qdrant on macOS" >&2
          json_result "error" "native" "http://localhost:6333"
          exit 2
        fi

        if brew list qdrant >/dev/null 2>&1; then
          echo "Qdrant already installed via Homebrew" >&2
        else
          echo "Installing Qdrant via Homebrew..." >&2
          brew install qdrant 2>&1 >&2
        fi

        echo "Starting Qdrant service..." >&2
        brew services start qdrant 2>&1 >&2

        # Wait for healthz
        for i in $(seq 1 30); do
          if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
            json_result "installed" "native" "http://localhost:6333"
            exit 0
          fi
          sleep 1
        done

        echo "Qdrant failed to start" >&2
        json_result "error" "native" "http://localhost:6333"
        exit 1
        ;;

      linux)
        local arch
        arch=$(uname -m)
        local asset_name

        case "$arch" in
          x86_64)  asset_name="qdrant-x86_64-unknown-linux-gnu.tar.gz" ;;
          aarch64) asset_name="qdrant-aarch64-unknown-linux-gnu.tar.gz" ;;
          *)
            echo "Unsupported architecture: $arch" >&2
            json_result "error" "native" "http://localhost:6333"
            exit 1
            ;;
        esac

        local install_dir="$HOME/.local/bin"
        mkdir -p "$install_dir"

        if [ -f "$install_dir/qdrant" ]; then
          echo "Qdrant binary already exists at $install_dir/qdrant" >&2
        else
          echo "Downloading Qdrant for $arch..." >&2
          local latest_url="https://github.com/qdrant/qdrant/releases/latest/download/$asset_name"
          curl -fsSL "$latest_url" | tar -xz -C "$install_dir" 2>&1 >&2
          chmod +x "$install_dir/qdrant"
        fi

        # Start in background
        echo "Starting Qdrant..." >&2
        nohup "$install_dir/qdrant" --storage-path "$HOME/.tea-rags/qdrant-native-storage" \
          > /dev/null 2>&1 &

        # Wait for healthz
        for i in $(seq 1 30); do
          if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
            json_result "installed" "native" "http://localhost:6333"
            exit 0
          fi
          sleep 1
        done

        echo "Qdrant failed to start" >&2
        json_result "error" "native" "http://localhost:6333"
        exit 1
        ;;

      *)
        echo "Native install not supported for $PLATFORM via unix scripts" >&2
        json_result "error" "native" "http://localhost:6333"
        exit 1
        ;;
    esac
    ;;

  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/setup-qdrant.sh
# Test embedded mode (should find binary from postinstall)
plugin/scripts/setup/unix/setup-qdrant.sh embedded | jq .
```

Expected: `{"status": "already_done", "mode": "embedded", "url": "embedded"}`

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/setup-qdrant.sh
git commit -m "feat(dx): add Qdrant setup script (unix)"
```

---

### Task 7: tune.sh — Performance Benchmark

**Files:**

- Create: `plugin/scripts/setup/unix/tune.sh`

- [ ] **Step 1: Write tune.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

EMBEDDING_PROVIDER="${1:-ollama}"
ENV_FILE="tuned_environment_variables.env"

json_result() {
  local status="$1"
  shift
  if [ "$status" = "skipped" ] || [ "$status" = "error" ]; then
    printf '{"status":"%s","values":{"EMBEDDING_BATCH_SIZE":"256","QDRANT_UPSERT_BATCH_SIZE":"100","INGEST_PIPELINE_CONCURRENCY":"1"}}\n' "$status"
    return
  fi
  # Parse env file for values
  local batch_size concurrency upsert_batch
  batch_size=$(grep "^EMBEDDING_BATCH_SIZE=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "256")
  upsert_batch=$(grep "^QDRANT_UPSERT_BATCH_SIZE=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "100")
  concurrency=$(grep "^INGEST_PIPELINE_CONCURRENCY=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 || echo "1")

  printf '{"status":"completed","values":{"EMBEDDING_BATCH_SIZE":"%s","QDRANT_UPSERT_BATCH_SIZE":"%s","INGEST_PIPELINE_CONCURRENCY":"%s"}}\n' \
    "$batch_size" "$upsert_batch" "$concurrency"
}

# ONNX tune support not yet implemented
if [ "$EMBEDDING_PROVIDER" = "onnx" ]; then
  echo "ONNX tune support not yet implemented (beta). Using defaults." >&2
  json_result "skipped"
  exit 0
fi

# Run tune
echo "Running performance benchmark for $EMBEDDING_PROVIDER..." >&2
echo "This may take 2-3 minutes..." >&2

if EMBEDDING_PROVIDER="$EMBEDDING_PROVIDER" npx tea-rags tune 2>&1 >&2; then
  if [ -f "$ENV_FILE" ]; then
    json_result "completed"
    # Clean up env file
    rm -f "$ENV_FILE"
  else
    echo "Tune completed but env file not found" >&2
    json_result "error"
    exit 1
  fi
else
  echo "Tune failed, using defaults" >&2
  json_result "error"
  exit 0  # Non-critical, continue with defaults
fi
```

- [ ] **Step 2: Make executable**

```bash
chmod +x plugin/scripts/setup/unix/tune.sh
```

Note: actual verification requires running the full benchmark (~2-3 min). Skip
for now, will be tested during integration.

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/tune.sh
git commit -m "feat(dx): add tune benchmark script (unix)"
```

---

### Task 8: analyze-project.sh — Project Analysis

**Files:**

- Create: `plugin/scripts/setup/unix/analyze-project.sh`

- [ ] **Step 1: Write analyze-project.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_PATH="${1:-.}"

# Resolve to absolute path
PROJECT_PATH=$(cd "$PROJECT_PATH" && pwd)

# --- File count ---
file_count=$(find "$PROJECT_PATH" -type f \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/vendor/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  2>/dev/null | wc -l | tr -d ' ')

# --- LOC estimate ---
loc_estimate=0
if command -v cloc >/dev/null 2>&1; then
  loc_estimate=$(cloc --quiet --sum-one "$PROJECT_PATH" 2>/dev/null \
    | tail -1 | awk '{print $NF}' || echo "0")
else
  # Fallback: count lines in source files
  loc_estimate=$(find "$PROJECT_PATH" -type f \
    \( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.rb' \
       -o -name '*.java' -o -name '*.go' -o -name '*.rs' -o -name '*.cs' \
       -o -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \
       -o -name '*.swift' -o -name '*.kt' -o -name '*.scala' \
       -o -name '*.php' -o -name '*.ex' -o -name '*.exs' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/vendor/*' \
    2>/dev/null | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}' || echo "0")
fi

# --- Git analysis ---
is_git_repo="false"
top_author="null"
author_commit_count=0
has_frequent_commits="false"
avg_gap_minutes=0
recommended_git_enabled="false"
recommended_squash_aware="false"

if [ -d "$PROJECT_PATH/.git" ] || git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  is_git_repo="true"
  recommended_git_enabled="true"

  # Get last 200 commits with author and timestamp
  git_log=$(git -C "$PROJECT_PATH" log --format='%an|%at' -200 2>/dev/null || true)

  if [ -n "$git_log" ]; then
    # Find dominant author
    top_author=$(echo "$git_log" | cut -d'|' -f1 | sort | uniq -c | sort -rn | head -1 | sed 's/^ *[0-9]* *//')
    author_commit_count=$(echo "$git_log" | cut -d'|' -f1 | grep -c "^${top_author}$" || echo "0")

    # Calculate gaps for dominant author
    author_timestamps=$(echo "$git_log" | grep "^${top_author}|" | cut -d'|' -f2 | sort -n)
    timestamp_count=$(echo "$author_timestamps" | wc -l | tr -d ' ')

    if [ "$timestamp_count" -gt 1 ]; then
      # Calculate gaps in minutes
      gaps=()
      prev=""
      while IFS= read -r ts; do
        if [ -n "$prev" ]; then
          gap_sec=$((prev - ts))  # descending order, so prev > ts
          if [ "$gap_sec" -lt 0 ]; then
            gap_sec=$((-gap_sec))
          fi
          gap_min=$((gap_sec / 60))
          gaps+=("$gap_min")
        fi
        prev="$ts"
      done <<< "$author_timestamps"

      if [ ${#gaps[@]} -gt 0 ]; then
        # Sort gaps and find median
        sorted_gaps=($(printf '%s\n' "${gaps[@]}" | sort -n))
        median_idx=$(( ${#sorted_gaps[@]} / 2 ))
        avg_gap_minutes=${sorted_gaps[$median_idx]}

        if [ "$avg_gap_minutes" -lt 30 ]; then
          has_frequent_commits="true"
          recommended_squash_aware="true"
        fi
      fi
    fi
  fi
fi

# Build JSON
jq -n \
  --argjson isGitRepo "$is_git_repo" \
  --argjson fileCount "$file_count" \
  --argjson locEstimate "$loc_estimate" \
  --arg topAuthor "$top_author" \
  --argjson authorCommitCount "$author_commit_count" \
  --argjson hasFrequentCommits "$has_frequent_commits" \
  --argjson avgGapMinutes "$avg_gap_minutes" \
  --arg gitEnabled "$recommended_git_enabled" \
  --arg squashAware "$recommended_squash_aware" \
  '{
    isGitRepo: $isGitRepo,
    fileCount: $fileCount,
    locEstimate: $locEstimate,
    topAuthor: (if $topAuthor == "null" then null else $topAuthor end),
    authorCommitCount: $authorCommitCount,
    hasFrequentCommits: $hasFrequentCommits,
    avgGapMinutes: $avgGapMinutes,
    recommendedEnv: {
      TRAJECTORY_GIT_ENABLED: $gitEnabled,
      TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS: $squashAware
    }
  }'
```

- [ ] **Step 2: Make executable and verify**

```bash
chmod +x plugin/scripts/setup/unix/analyze-project.sh
plugin/scripts/setup/unix/analyze-project.sh /Users/artk0re/Dev/Tools/tea-rags-mcp | jq .
```

Expected: JSON with isGitRepo=true, file/LOC counts, author info, gap analysis.

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/analyze-project.sh
git commit -m "feat(dx): add project analysis script (unix)"
```

---

### Task 9: configure-mcp.sh — MCP Configuration

**Files:**

- Create: `plugin/scripts/setup/unix/configure-mcp.sh`

- [ ] **Step 1: Write configure-mcp.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Input: JSON with env vars on stdin or as argument
ENV_JSON="${1:-$(cat)}"

json_result() {
  local status="$1" command="$2"
  # Escape double quotes in command for JSON
  command=$(echo "$command" | sed 's/"/\\"/g')
  printf '{"status":"%s","command":"%s"}\n' "$status" "$command"
}

# Build claude mcp add command
build_command() {
  local cmd="claude mcp add tea-rags -s user -- npx tea-rags server"

  # Extract each key-value pair from JSON
  while IFS='=' read -r key value; do
    if [ -n "$key" ] && [ -n "$value" ] && [ "$value" != "null" ] && [ "$value" != "false" ]; then
      cmd="$cmd -e $key=$value"
    fi
  done <<< "$(echo "$ENV_JSON" | jq -r 'to_entries[] | "\(.key)=\(.value)"')"

  echo "$cmd"
}

mcp_command=$(build_command)

echo "Executing: $mcp_command" >&2

# Remove existing tea-rags config first (ignore errors if not exists)
claude mcp remove tea-rags 2>/dev/null || true

# Execute the command
if eval "$mcp_command" 2>&1 >&2; then
  json_result "configured" "$mcp_command"
else
  echo "claude mcp add failed" >&2
  json_result "error" "$mcp_command"
  exit 1
fi
```

- [ ] **Step 2: Make executable**

```bash
chmod +x plugin/scripts/setup/unix/configure-mcp.sh
```

Note: actual verification requires running `claude mcp add` which modifies user
config. Will be tested during integration.

- [ ] **Step 3: Commit**

```bash
git add plugin/scripts/setup/unix/configure-mcp.sh
git commit -m "feat(dx): add MCP configuration script (unix)"
```

---

### Task 10: SKILL.md — Agent Orchestrator

**Files:**

- Create: `plugin/skills/setup/SKILL.md`

- [ ] **Step 1: Create directory**

```bash
mkdir -p plugin/skills/setup
```

- [ ] **Step 2: Write SKILL.md**

```markdown
---
name: setup
description:
  Automated TeaRAGs installation wizard. Detects environment, installs
  dependencies (Node.js, tea-rags, Ollama/ONNX, Qdrant), tunes performance,
  configures MCP server. Progress saves to ~/.tea-rags/setup-progress.json for
  resumable installation.
argument-hint: [project path]
---

# TeaRAGs Setup Wizard

Automated installation and configuration of TeaRAGs MCP server.

## Script Location

All scripts are in `${CLAUDE_PLUGIN_ROOT}/scripts/setup/`.

**First: determine OS to select script set.**

Run: `uname -s` (or check via Bash tool)

- Output contains "Darwin" or "Linux" → use `unix/` scripts (`.sh`)
- Output contains "MINGW", "MSYS", "CYGWIN" → use `unix/` scripts (running in
  Git Bash)
- If PowerShell detected (Windows native) → use `windows/` scripts (`.ps1`)

Store the chosen prefix (e.g.,
`SCRIPTS="${CLAUDE_PLUGIN_ROOT}/scripts/setup/unix"`) and use it for all
subsequent script calls.

## Step 0: Check Progress

Run: `$SCRIPTS/progress.sh get`

- If progress file exists → find first step with `status != "completed"` →
  resume from there
- If no progress file → run `$SCRIPTS/progress.sh init` → start from Step 1

## Step 1: Detect Environment

Run: `$SCRIPTS/detect-environment.sh`

Parse JSON result. Save all fields to progress:
```

$SCRIPTS/progress.sh set platform "<platform>"
$SCRIPTS/progress.sh set arch
"<arch>"
$SCRIPTS/progress.sh set versionManager "<activeManager>"
$SCRIPTS/progress.sh
set packageManager "<packageManager>"
$SCRIPTS/progress.sh set nodePath "<nodePath>"
$SCRIPTS/progress.sh set npmPath
"<npmPath>" $SCRIPTS/progress.sh set gpu '<gpu json>'
$SCRIPTS/progress.sh set
steps.detect '{"status":"completed","at":"<now>"}'

```

If `nodePath` is null → Node.js is not installed, Step 2 will handle it.

## Step 2: Install Node.js

Run: `$SCRIPTS/install-node.sh <versionManager>`

**Interpret result:**
- `already_done` → update progress, move to Step 3
- `installed` → update nodePath in progress, move to Step 3
- `manual_required` (exit code 2) → use AskUserQuestion:
```

question: "Node.js 22+ is required but not installed. Please install it and
respond when done." options: [ { label: "Installed", description: "I've
installed Node.js 22+" }, { label: "Help", description: "Show me how to install
Node.js" } ]

```
If "Help" → show platform-specific instructions. If "Installed" → re-run
detect-environment.sh to get new paths, verify version >= 22.

## Step 3: Install tea-rags

Run: `$SCRIPTS/install-tea-rags.sh <packageManager> <npmPath>`

**Interpret result:**
- `already_done` → show version, ask if update wanted via AskUserQuestion
- `installed` → update progress
- `error` → show stderr, suggest permissions fix, retry

## Step 4: Choose & Install Embedding Provider

**4a: Determine project path.** If argument was provided, use it. Otherwise
check if cwd looks like a project (has package.json, .git, src/, etc.).
If not → AskUserQuestion:
```

question: "Specify the project directory you are configuring tea-rags for"

```
Save projectPath to progress.

**4b: Estimate project size.** Run `$SCRIPTS/analyze-project.sh <projectPath>`
and extract `locEstimate`. Save to progress as `projectLocEstimate`.

**4c: Build recommendation.** Use the GPU info from progress and locEstimate:

| Platform | GPU vendor | LOC | Recommend |
|---|---|---|---|
| darwin | apple | any | Ollama app (Metal GPU) |
| linux | nvidia | any | Ollama (CUDA) |
| linux | amd | any | Ollama (ROCm) |
| linux | none/intel | ≤100k | ONNX (beta, zero-setup) |
| linux | none/intel | >100k | Ollama (CPU faster for large projects) |
| windows | nvidia | any | Ollama app (CUDA) |
| windows | amd (RDNA2/3) | any | Ollama + PRO driver |
| windows | amd (pre-RDNA2) | ≤100k | ONNX (beta, DirectML) |
| windows | intel | ≤100k | ONNX (beta, DirectML) |
| windows | none/intel/old amd | >100k | Ollama app |

**4d: Ask user.** AskUserQuestion with recommendation:
```

question: "Choose embedding provider. {recommendation_reason}" options: [ {
label: "Ollama", description: "Recommended for {reason}" }, { label: "ONNX
(beta)", description: "Built-in, zero-setup, ≤100k LOC. {onnx_reason}" } ]

```

If project > 100k LOC and user picks ONNX → warn:
"Project is ~{N}k LOC. ONNX recommended up to ~100k LOC. Continue anyway?"

**4e: Install.**
- If Ollama chosen → run `$SCRIPTS/install-ollama.sh <platform> '<gpu_json>'`
  - If `manual_required` with method `app` → AskUserQuestion checkpoint:
    "Download Ollama from https://ollama.com/download, install, and launch.
    Respond when done."
  - If method `pro_driver` (Windows + AMD RDNA2/3) → AskUserQuestion:
    "For GPU acceleration, install AMD Radeon PRO driver first:
    https://www.amd.com/en/support/professional-graphics
    Then install Ollama app. Respond when done."
  - After user confirms → verify: `ollama --version`. If fails → repeat checkpoint.
  - After Ollama verified → model pull happens inside the script.
- If ONNX chosen → nothing to install. Save `embeddingProvider: "onnx"` to
  progress.

Save `embeddingProvider` and mark step completed.

## Step 5: Choose & Setup Qdrant

AskUserQuestion:
```

question: "Choose Qdrant deployment mode" options: [ { label: "Embedded",
description: "Recommended. Built-in, zero configuration. Starts automatically
with tea-rags." }, { label: "Docker", description: "Separate container. Requires
Docker." }, { label: "Native", description: "System install via
{brew|apt|binary}." } ]

```

Run: `$SCRIPTS/setup-qdrant.sh <mode> <platform>`

**Interpret result:**
- `already_done` or `installed` → save qdrantMode and url to progress
- `error` with exit code 2 (Docker not found) → AskUserQuestion checkpoint:
  "Docker is required but not installed. Install Docker Desktop and respond
  when done." After confirm → re-run.
- `error` → show stderr, suggest alternative mode

## Step 6: Tune Performance

Run: `$SCRIPTS/tune.sh <embeddingProvider>`

**Interpret result:**
- `completed` → save tuned values to progress
- `skipped` (ONNX beta) → save default values, inform user
- `error` → save defaults, warn user, continue (non-critical)

## Step 7: Analyze Project

Note: analyze-project.sh was already run in Step 4b for LOC. Now use its full
output for git recommendations.

If `isGitRepo` is true → AskUserQuestion:
```

question: "Enable git analytics? Provides authorship, churn, and bug-fix rate
signals for code search." options: [ { label: "Yes", description: "Recommended —
git repository detected" }, { label: "No", description: "Skip git enrichment" }
]

```

If git enabled AND `hasFrequentCommits` is true → AskUserQuestion:
```

question: "Enable squash-aware sessions? Detected frequent commits from
{topAuthor} (median {avgGapMinutes}min gap). Groups rapid commits into logical
sessions for cleaner analytics." options: [ { label: "Yes", description:
"Recommended for this commit pattern" }, { label: "No", description: "Keep
individual commit granularity" } ]

````

Save choices to progress.

## Step 8: Configure MCP

**8a: Assemble env vars JSON** from progress:

```json
{
  "EMBEDDING_PROVIDER": "<from step 4>",
  "QDRANT_URL": "<from step 5, omit if embedded>",
  "EMBEDDING_BATCH_SIZE": "<from step 6>",
  "QDRANT_UPSERT_BATCH_SIZE": "<from step 6>",
  "INGEST_PIPELINE_CONCURRENCY": "<from step 6>",
  "TRAJECTORY_GIT_ENABLED": "<from step 7>",
  "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS": "<from step 7, if applicable>"
}
````

**8b: Show to user for confirmation.** AskUserQuestion:

```
question: "Confirm MCP configuration:\n\n<show full claude mcp add command>\n\nProceed?"
options: [
  { label: "Confirm", description: "Apply this configuration" },
  { label: "Modify", description: "I want to change something" }
]
```

If "Modify" → ask what to change, adjust, re-show.

**8c: Execute.** Run: `$SCRIPTS/configure-mcp.sh '<env_json>'`

## Step 9: Verify

Run: `claude mcp get tea-rags`

Check output for "connected" status.

- If connected → SUCCESS. Show summary: "TeaRAGs setup complete! Configuration:
  - Embedding: {provider}
  - Qdrant: {mode}
  - Git analytics: {enabled/disabled}

  Restart your Claude Code session to activate the MCP server. After restart,
  run `/tea-rags:index` to index your codebase."

- If not connected → AskUserQuestion: "MCP server not yet connected. This
  usually resolves after restarting the session. Restart Claude Code and run
  `/tea-rags:setup` again to verify."

Mark all steps completed in progress.

## Error Recovery

At any point if a script fails (exit code 1):

1. Show the error from stderr to the user
2. The progress file retains the last successful state
3. Suggest re-running `/tea-rags:setup` — it will resume from the failed step

## Do NOT

- Run scripts without checking progress first
- Skip AskUserQuestion for user choices (embedding, qdrant)
- Proceed past a checkpoint without verification
- Modify MCP config for other servers
- Run indexing — that is `/tea-rags:index` after restart

````

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/setup/SKILL.md
git commit -m "feat(dx): add setup skill orchestrator (SKILL.md)"
````

---

### Task 11: Windows PowerShell Scripts

**Files:**

- Create: `plugin/scripts/setup/windows/progress.ps1`
- Create: `plugin/scripts/setup/windows/detect-environment.ps1`
- Create: `plugin/scripts/setup/windows/install-node.ps1`
- Create: `plugin/scripts/setup/windows/install-tea-rags.ps1`
- Create: `plugin/scripts/setup/windows/install-ollama.ps1`
- Create: `plugin/scripts/setup/windows/setup-qdrant.ps1`
- Create: `plugin/scripts/setup/windows/tune.ps1`
- Create: `plugin/scripts/setup/windows/analyze-project.ps1`
- Create: `plugin/scripts/setup/windows/configure-mcp.ps1`

Each PowerShell script mirrors its unix counterpart with identical JSON
contract. Key differences:

- `jq` → `ConvertTo-Json` / `ConvertFrom-Json`
- `command -v` → `Get-Command`
- `uname` → `[System.Runtime.InteropServices.RuntimeInformation]` or `$env:OS`
- GPU: `Get-CimInstance Win32_VideoController`
- Version manager paths: `$env:USERPROFILE\.volta\`, `$env:USERPROFILE\.nvm\`,
  etc.
- AMD RDNA detection: parse GPU name for "RX 6xxx" / "RX 7xxx" patterns
- install-ollama: `manual_required` with method `pro_driver` for AMD RDNA2/3

- [ ] **Step 1: Write progress.ps1**

```powershell
#Requires -Version 5.1
param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet("init", "get", "set")]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$DotPath,

    [Parameter(Position=2)]
    [string]$Value
)

$ProgressDir = Join-Path $env:USERPROFILE ".tea-rags"
$ProgressFile = Join-Path $ProgressDir "setup-progress.json"

function Ensure-Dir {
    if (-not (Test-Path $ProgressDir)) {
        New-Item -ItemType Directory -Path $ProgressDir -Force | Out-Null
    }
}

function Cmd-Init {
    Ensure-Dir
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $progress = @{
        version = 1
        startedAt = $now
        platform = $null
        arch = $null
        versionManager = $null
        packageManager = $null
        nodePath = $null
        npmPath = $null
        embeddingProvider = $null
        qdrantMode = $null
        projectPath = $null
        projectLocEstimate = $null
        gpu = $null
        steps = @{
            detect = @{ status = "pending" }
            node = @{ status = "pending" }
            "tea-rags" = @{ status = "pending" }
            embedding = @{ status = "pending" }
            qdrant = @{ status = "pending" }
            tune = @{ status = "pending" }
            analyze = @{ status = "pending" }
            configure = @{ status = "pending" }
            verify = @{ status = "pending" }
        }
    }
    $json = $progress | ConvertTo-Json -Depth 10
    Set-Content -Path $ProgressFile -Value $json -Encoding UTF8
    Write-Output $json
}

function Cmd-Get {
    if (-not (Test-Path $ProgressFile)) {
        Write-Error "No progress file"
        exit 1
    }
    $data = Get-Content $ProgressFile -Raw | ConvertFrom-Json
    if ([string]::IsNullOrEmpty($DotPath)) {
        Write-Output ($data | ConvertTo-Json -Depth 10)
    } else {
        $parts = $DotPath -split '\.'
        $current = $data
        foreach ($part in $parts) {
            $current = $current.$part
        }
        Write-Output ($current | ConvertTo-Json -Depth 10)
    }
}

function Cmd-Set {
    if ([string]::IsNullOrEmpty($DotPath) -or [string]::IsNullOrEmpty($Value)) {
        Write-Error "Usage: progress.ps1 set <dotpath> <value>"
        exit 1
    }
    Ensure-Dir
    if (-not (Test-Path $ProgressFile)) {
        Write-Error "No progress file, run init first"
        exit 1
    }

    $data = Get-Content $ProgressFile -Raw | ConvertFrom-Json
    $parts = $DotPath -split '\.'

    # Try to parse value as JSON, fallback to string
    try {
        $parsedValue = $Value | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $parsedValue = $Value
    }

    # Navigate and set
    $current = $data
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        $current = $current.($parts[$i])
    }
    $lastPart = $parts[-1]
    $current | Add-Member -NotePropertyName $lastPart -NotePropertyValue $parsedValue -Force

    $json = $data | ConvertTo-Json -Depth 10
    Set-Content -Path $ProgressFile -Value $json -Encoding UTF8
    Write-Output '{"status":"ok"}'
}

switch ($Action) {
    "init" { Cmd-Init }
    "get"  { Cmd-Get }
    "set"  { Cmd-Set }
}
```

- [ ] **Step 2: Write detect-environment.ps1**

```powershell
#Requires -Version 5.1

function Detect-Platform { return "windows" }

function Detect-Arch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        "X64"   { return "x86_64" }
        "Arm64" { return "arm64" }
        default { return $arch.ToString().ToLower() }
    }
}

function Detect-AvailableManagers {
    $managers = @()
    if (Get-Command volta -ErrorAction SilentlyContinue) { $managers += "volta" }
    if (Get-Command fnm -ErrorAction SilentlyContinue) { $managers += "fnm" }
    if (Get-Command nvm -ErrorAction SilentlyContinue) { $managers += "nvm" }
    if (Get-Command nodenv -ErrorAction SilentlyContinue) { $managers += "nodenv" }
    # Check for nvm-windows
    if (Test-Path "$env:NVM_HOME\nvm.exe") { if ("nvm" -notin $managers) { $managers += "nvm" } }
    return $managers
}

function Detect-ActiveManager {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
    if (-not $nodePath) { return "none" }

    $resolved = (Get-Item $nodePath -ErrorAction SilentlyContinue)?.Target
    if (-not $resolved) { $resolved = $nodePath }

    switch -Regex ($resolved) {
        '\.volta\\tools\\image\\node\\' { return "volta" }
        '\.fnm\\node-versions\\'        { return "fnm" }
        '\.nvm\\versions\\'             { return "nvm" }
        '\.nodenv\\versions\\'          { return "nodenv" }
        default                          { return "none" }
    }
}

function Detect-GPU {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $vendor = "none"
    $model = "unknown"
    $architecture = $null

    foreach ($gpu in $gpus) {
        $name = $gpu.Name
        if ($name -match "NVIDIA") {
            $vendor = "nvidia"; $model = $name; break
        } elseif ($name -match "AMD|Radeon") {
            $vendor = "amd"; $model = $name
            if ($name -match "RX\s*7\d{3}") { $architecture = "RDNA3" }
            elseif ($name -match "RX\s*6\d{3}") { $architecture = "RDNA2" }
            break
        } elseif ($name -match "Intel.*Arc|Intel.*Iris|Intel.*UHD") {
            $vendor = "intel"; $model = $name; break
        }
    }

    return @{ vendor = $vendor; model = $model; architecture = $architecture }
}

# Main
$platform = Detect-Platform
$arch = Detect-Arch
$managers = Detect-AvailableManagers
$activeManager = Detect-ActiveManager

$nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
$nodeVersion = if ($nodePath) { (node --version 2>$null) -replace '^v' } else { $null }
$npmPath = (Get-Command npm -ErrorAction SilentlyContinue)?.Source

$result = @{
    platform = $platform
    arch = $arch
    availableManagers = $managers
    activeManager = $activeManager
    packageManager = "npm"
    nodeVersion = $nodeVersion
    nodePath = $nodePath
    npmPath = $npmPath
    hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
    hasDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
    hasOllama = [bool](Get-Command ollama -ErrorAction SilentlyContinue)
    hasBrew = $false
    gpu = Detect-GPU
}

Write-Output ($result | ConvertTo-Json -Depth 5)
```

- [ ] **Step 3: Write remaining Windows scripts**

Write each remaining .ps1 script following the same contract as its unix
counterpart. Key adaptations:

**install-node.ps1**: Use `fnm install`, `volta install`, `nvm install` for
Windows version managers. For `none` → `manual_required`.

**install-tea-rags.ps1**: Same PM commands work on Windows (`npm install -g`).
Permissions: check if global prefix is writable.

**install-ollama.ps1**: Always `manual_required` with method `app` or
`pro_driver` (if AMD RDNA2/3 detected). Include model pull after checkpoint.

**setup-qdrant.ps1**: Embedded → check `~/.tea-rags/qdrant/bin/qdrant.exe`.
Docker → same docker commands. Native → download .exe from GitHub releases.

**tune.ps1**: Run `npx tea-rags tune`, parse env file. ONNX → `skipped`.

**analyze-project.ps1**: Use `git log`, `Get-ChildItem -Recurse` for file count,
`(Get-Content <files> | Measure-Object -Line).Lines` for LOC.

**configure-mcp.ps1**: Build and run `claude mcp add` command.

- [ ] **Step 4: Commit**

```bash
git add plugin/scripts/setup/windows/
git commit -m "feat(dx): add setup scripts (windows)"
```

---

### Task 12: Plugin Version Bump

**Files:**

- Modify: `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Bump version**

In `plugin/.claude-plugin/plugin.json`, change version from `0.10.1` to `0.11.0`
(minor bump — new skill added).

- [ ] **Step 2: Commit**

```bash
git add plugin/.claude-plugin/plugin.json
git commit -m "chore(dx): bump plugin version to 0.11.0 (setup skill)"
```

---

## Summary

| Task | What                  | Files                |
| ---- | --------------------- | -------------------- |
| 1    | progress.sh           | 1 unix script        |
| 2    | detect-environment.sh | 1 unix script        |
| 3    | install-node.sh       | 1 unix script        |
| 4    | install-tea-rags.sh   | 1 unix script        |
| 5    | install-ollama.sh     | 1 unix script        |
| 6    | setup-qdrant.sh       | 1 unix script        |
| 7    | tune.sh               | 1 unix script        |
| 8    | analyze-project.sh    | 1 unix script        |
| 9    | configure-mcp.sh      | 1 unix script        |
| 10   | SKILL.md              | 1 skill file         |
| 11   | Windows scripts       | 9 PowerShell scripts |
| 12   | Plugin version bump   | 1 file               |

**Total**: 21 new files, 1 modified file, 12 commits.

**Not in this plan** (separate task): Extend `npx tea-rags tune` to support ONNX
provider. Tracked separately.
