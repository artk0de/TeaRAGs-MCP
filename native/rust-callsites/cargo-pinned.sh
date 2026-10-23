#!/usr/bin/env sh
# cargo-pinned.sh <cargo args...> — run cargo from the toolchain rust-toolchain.toml pins,
# with that toolchain's bin/ first on PATH and RUSTC forced. A Homebrew cargo/rustc
# shadowing the rustup proxies would otherwise ignore the pin (and has no rustc-dev).
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
pin=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$here/rust-toolchain.toml")
rustc=$(rustup which --toolchain "$pin" rustc) || {
  echo "cargo-pinned: toolchain $pin missing - rustup toolchain install $pin -c rustc-dev,rust-src" >&2
  exit 1
}
bin=$(dirname "$rustc")
cd "$here"
PATH="$bin:$PATH" RUSTC="$rustc" RUSTUP_TOOLCHAIN="$pin" exec "$bin/cargo" "$@"
