#!/usr/bin/env bash
set -euo pipefail

# ─── Platform ───────────────────────────────────────────────────────────────

raw_os="$(uname -s)"
case "$raw_os" in
  Darwin)  platform="darwin" ;;
  Linux)   platform="linux"  ;;
  MINGW*|MSYS*|CYGWIN*) platform="windows" ;;
  *)       platform="unknown" ;;
esac

# ─── Architecture ────────────────────────────────────────────────────────────

raw_arch="$(uname -m)"
case "$raw_arch" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) arch="$raw_arch" ;;
esac

# ─── Version manager inventory ───────────────────────────────────────────────

available_managers="[]"

add_manager() {
  available_managers="$(echo "$available_managers" | jq --arg m "$1" '. + [$m]')"
}

command -v volta   &>/dev/null && add_manager "volta"
command -v asdf    &>/dev/null && add_manager "asdf"
command -v mise    &>/dev/null && add_manager "mise"
command -v fnm     &>/dev/null && add_manager "fnm"
command -v nodenv  &>/dev/null && add_manager "nodenv"
command -v n       &>/dev/null && add_manager "n"
# nvm is a shell function — not a binary; check for the loader script
if [ -n "${NVM_DIR:-}" ] && [ -f "${NVM_DIR}/nvm.sh" ]; then
  add_manager "nvm"
fi

# ─── Active manager (via resolved node path) ─────────────────────────────────

active_manager="none"

if command -v node &>/dev/null; then
  node_real="$(command -v node)"
  # Try realpath / readlink -f depending on platform
  if command -v realpath &>/dev/null; then
    node_real="$(realpath "$node_real" 2>/dev/null || echo "$node_real")"
  elif command -v readlink &>/dev/null; then
    node_real="$(readlink -f "$node_real" 2>/dev/null || echo "$node_real")"
  fi

  case "$node_real" in
    *"/.volta/tools/image/node/"*)               active_manager="volta"  ;;
    *"/.asdf/installs/nodejs/"*)                 active_manager="asdf"   ;;
    *"/.local/share/mise/installs/node/"*)       active_manager="mise"   ;;
    *"/.fnm/node-versions/"*)                    active_manager="fnm"    ;;
    *"/.nvm/versions/node/"*)                    active_manager="nvm"    ;;
    *"/.nodenv/versions/"*)                      active_manager="nodenv" ;;
    *"/n/versions/node/"*)                       active_manager="n"      ;;
  esac
fi

# ─── Node info ───────────────────────────────────────────────────────────────

node_version="null"
node_path="null"
npm_path="null"

if command -v node &>/dev/null; then
  node_version="\"$(node --version | sed 's/^v//')\""
  node_path="\"$(command -v node)\""
  if command -v npm &>/dev/null; then
    npm_path="\"$(command -v npm)\""
  fi
fi

# ─── Package manager ─────────────────────────────────────────────────────────

# Prefer npm; also detect yarn, pnpm, bun
package_manager="npm"
if ! command -v npm &>/dev/null; then
  if   command -v pnpm &>/dev/null; then package_manager="pnpm"
  elif command -v yarn &>/dev/null; then package_manager="yarn"
  elif command -v bun  &>/dev/null; then package_manager="bun"
  else package_manager="none"
  fi
fi

# ─── Tool checks ─────────────────────────────────────────────────────────────

has_git=false;    command -v git    &>/dev/null && has_git=true
has_docker=false; command -v docker &>/dev/null && has_docker=true
has_ollama=false; command -v ollama &>/dev/null && has_ollama=true
has_brew=false;   command -v brew   &>/dev/null && has_brew=true

# ─── GPU detection ───────────────────────────────────────────────────────────

gpu_vendor="none"
gpu_model="null"
gpu_arch="null"

if [ "$platform" = "darwin" ]; then
  if command -v system_profiler &>/dev/null; then
    gpu_info="$(system_profiler SPDisplaysDataType 2>/dev/null || true)"
    # Look for Chipset Model line
    chipset="$(echo "$gpu_info" | grep -i "Chipset Model" | head -1 | sed 's/.*Chipset Model: *//' | xargs || true)"
    if [ -n "$chipset" ]; then
      gpu_model="\"$chipset\""
      case "$chipset" in
        Apple*) gpu_vendor="apple" ;;
        *NVIDIA*|*Nvidia*) gpu_vendor="nvidia" ;;
        *AMD*|*Radeon*) gpu_vendor="amd" ;;
        *Intel*) gpu_vendor="intel" ;;
      esac
    fi
  fi
elif [ "$platform" = "linux" ]; then
  if command -v lspci &>/dev/null; then
    vga_line="$(lspci 2>/dev/null | grep -i vga | head -1 || true)"
    if [ -n "$vga_line" ]; then
      case "$vga_line" in
        *NVIDIA*|*Nvidia*)
          gpu_vendor="nvidia"
          gpu_model="\"$(echo "$vga_line" | sed 's/.*: //' | xargs)\""
          ;;
        *AMD*|*Radeon*|*ATI*)
          gpu_vendor="amd"
          gpu_model="\"$(echo "$vga_line" | sed 's/.*: //' | xargs)\""
          # RDNA generation from model number
          case "$vga_line" in
            *"RX 7"*) gpu_arch="\"RDNA3\"" ;;
            *"RX 6"*) gpu_arch="\"RDNA2\"" ;;
          esac
          ;;
        *Intel*)
          gpu_vendor="intel"
          gpu_model="\"$(echo "$vga_line" | sed 's/.*: //' | xargs)\""
          ;;
      esac
    fi
  fi
fi

# ─── Emit JSON ───────────────────────────────────────────────────────────────

jq -n \
  --arg     platform        "$platform" \
  --arg     arch            "$arch" \
  --argjson availableManagers "$available_managers" \
  --arg     activeManager   "$active_manager" \
  --arg     packageManager  "$package_manager" \
  --argjson nodeVersion     "$node_version" \
  --argjson nodePath        "$node_path" \
  --argjson npmPath         "$npm_path" \
  --argjson hasGit          "$has_git" \
  --argjson hasDocker       "$has_docker" \
  --argjson hasOllama       "$has_ollama" \
  --argjson hasBrew         "$has_brew" \
  --arg     gpuVendor       "$gpu_vendor" \
  --argjson gpuModel        "$gpu_model" \
  --argjson gpuArch         "$gpu_arch" \
  '{
    platform:          $platform,
    arch:              $arch,
    availableManagers: $availableManagers,
    activeManager:     $activeManager,
    packageManager:    $packageManager,
    nodeVersion:       $nodeVersion,
    nodePath:          $nodePath,
    npmPath:           $npmPath,
    hasGit:            $hasGit,
    hasDocker:         $hasDocker,
    hasOllama:         $hasOllama,
    hasBrew:           $hasBrew,
    gpu: {
      vendor:       $gpuVendor,
      model:        $gpuModel,
      architecture: $gpuArch
    }
  }'
