# Step 7R: Rust compiler driver (Rust projects only)

Skip when progress `hasRust` is `false` (set `steps.rustDriver` to
`{"status":"skipped","at":"<now>"}`).

Rust call-graph quality depends on an optional rustc driver that ships inside
the tea-rags package and needs a pinned nightly toolchain with `rustc-dev`.
Measured call-resolution rate without vs with the driver:

| Corpus  | Without | With  |
| ------- | ------- | ----- |
| tikv    | 0.545   | 0.987 |
| servo   | 0.542   | 0.985 |
| ripgrep | 0.712   | 0.995 |

Without it, Rust call edges are static-only: a lower bound, so "no callers"
answers are unreliable.

## 7Ra: Read the pin

The pin has one source of truth: the `channel` in
`native/tea-rags-rustc-driver/rust-toolchain.toml` inside the installed package
(Step 3). Read it, never hardcode it:

```bash
grep '^channel' "$(npm root -g)/tea-rags/native/tea-rags-rustc-driver/rust-toolchain.toml"
```

Fallback when the package path is not readable: the install command printed in
the `rustc driver: unavailable` line of `tea-rags prime` after indexing.

## 7Rb: Check rustup and the toolchain

```bash
rustup --version
rustup toolchain list
```

- `rustup` missing → tell the user to install it from https://rustup.rs.
  Homebrew's `rust` package cannot build the driver. Record
  `rustDriver: "no-rustup"` and continue; the driver stays off until rustup and
  the toolchain exist.
- Pinned toolchain listed with `rustc-dev` already installed → record
  `rustDriver: "ready"`, nothing to ask.

## 7Rc: Ask

AskUserQuestion:

```
question: "Install the Rust compiler driver toolchain? Raises Rust call-resolution from ~0.55-0.71 to ~0.99 (tikv 0.545 -> 0.987, servo 0.542 -> 0.985, ripgrep 0.712 -> 0.995). Cost: ~1.5 GB download and a few minutes."
options: [
  { label: "Yes", description: "Recommended — run: rustup toolchain install <pin> -c rustc-dev,rust-src" },
  { label: "No", description: "Skip — Rust call edges stay static-only; install later" }
]
```

- **Yes** → run `rustup toolchain install <pin> -c rustc-dev,rust-src` yourself
  with `<pin>` from 7Ra. On failure show stderr and offer retry or skip. On
  success save `rustDriver: "ready"`.
- **No** → save `rustDriver: "off"` and tell the user the driver stays unused
  and the same command installs it later; `tea-rags prime` keeps printing it.

```
$SCRIPTS/progress.sh set rustDriver "<ready|off|no-rustup>"
$SCRIPTS/progress.sh set steps.rustDriver '{"status":"completed","at":"<now>"}'
```
