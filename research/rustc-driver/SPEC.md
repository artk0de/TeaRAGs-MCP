# Rust call-site resolution via a rustc driver (spike s3i8m.6 follow-up)

Status: research spike, prototype working. Nothing under `src/` is touched.

Prototype (outside the repo):
`/Users/artk0re/.claude/jobs/101d63dd/tmp/rustc-driver/`

| Path                                                 | What                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `callresolve/`                                       | the driver crate (`rustc_plugin = "=0.15.2-nightly-2026-05-01"`, ~330 LOC `src/lib.rs`)                                |
| `fixture/`                                           | 2-crate workspace: trait static/dyn/generic dispatch, UFCS, derive, `macro_rules!`, non-ASCII columns                  |
| `run-driver-corpus.sh <corpus> <out.ndjson>`         | owner-run script: cold `cargo check` baseline vs cold driver vs warm reruns, wall + peak process-tree RSS              |
| `join-residual.py <residual.ndjson> <driver.ndjson>` | classifies chain-tally `missWithInProjectDef` rows by driver verdict                                                   |
| `build-for.sh <toolchain>`                           | builds the driver against another toolchain (`RUSTC_BOOTSTRAP=1` for stable)                                           |
| `incr.sh`                                            | which crates re-run after which edit (fixture)                                                                         |
| `tc.sh <toolchain> cmd…`                             | runs a command with a rustup toolchain first on PATH (Homebrew `cargo`/`rustc` shadow the rustup proxies on this host) |

`research/rust-resolve-landscape.md`, named in the spike brief as the input
notes, does not exist in this worktree or anywhere under the main checkout. This
spec stands on the measurements below, not on that note.

## 1. Why a driver

On tikv, rust-analyzer emits 321 SCIP references for 24,860 `.unwrap()` source
lines and none for `Result::map_err`. RA's inference degrades at workspace
scale, and the SCIP slot moved tikv only 0.62 → 0.673 (exec mode 0.676 in 726
s). A rustc driver reads `TypeckResults` after `analysis`. That is the
resolution the compiler itself used to type-check the call, so it cannot be
"less inferred" than the build.

## 2. Toolchain coupling: findings

A `rustc_private` driver dynamically links one `librustc_driver-<hash>.dylib`
(binary: 294 KB, `@rpath/librustc_driver-16d1e96e5b674978.dylib`). Measured:

| Experiment                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver (nightly-2026-05-01) where the workspace crates are fed a sysroot or dep rmeta from another rustc (nightly-2026-01-30 cargo/rustc on PATH) | **fatal**: `E0514 found crate std compiled by an incompatible version of rustc`, prelude unresolvable. Every crate in the graph, std included, must come from the driver's own rustc.                                                                                                                                        |
| Same driver with `RUSTC`, `RUSTUP_TOOLCHAIN`, `SYSROOT` forced to its own toolchain, corpus `rust-toolchain.toml` pinning nightly-2026-01-30      | works: the corpus pin is simply overridden                                                                                                                                                                                                                                                                                   |
| Build the SAME driver source against stable **1.97.1** (servo's pin) with `RUSTC_BOOTSTRAP=1` + `rustc-dev` for 1.97.1                            | builds clean (22 s) and produces identical rows on the fixture. nightly-2026-05-01 is `1.97.0-nightly`, so 1.97.x shares its internal API.                                                                                                                                                                                   |
| Build against **nightly-2026-01-30** (tikv's pin)                                                                                                 | **fails inside rustc_plugin itself** (`catch_with_exit_code` return type changed). The spike's own code also needed a fix for an API added after January (`EarlyBinder::instantiate_identity()` now returns `Unnormalized<_>`, needs `.skip_normalization()`). Two breaks in ~400 LOC of compiler-facing code over 3 months. |
| tikv's 26 `#![feature]` gates compiled under nightly-2026-05-01                                                                                   | all 26 still exist; gate-level compatible. Unstable _library API_ drift inside those features is unmeasured; it would surface only on a real tikv run.                                                                                                                                                                       |

What this means:

- A driver built for nightly X can analyse a crate only by compiling the whole
  graph with rustc X. "Analyse a crate pinned to Y with a driver built for X"
  really means "compile the corpus with X instead of Y". For a stable Y ≤ X that
  is the normal Rust compatibility promise. For a nightly Y it holds as long as
  Y's feature gates and unstable APIs survive to X.
- Building the driver per corpus toolchain does not scale. rustc internals break
  the driver source across nightlies, and `rustc_plugin` publishes one version
  per pinned nightly roughly every 4–8 months. It only works when Y has the same
  rustc minor version as a published plugin pin (servo 1.97.1 ↔ 1.97.0-nightly).
- The corpus's own `target/` gives no artifact sharing either way. The driver
  must use its own target dir (owner rule), so the first run re-checks every
  dependency once, whichever toolchain it uses. Matching the corpus toolchain
  would remove a compile risk, not a cost.

**Recommendation: ship one pinned toolchain and override the corpus pin.**

1. The driver ships for exactly one channel, the `rustc_plugin` pin (now
   `nightly-2026-05-01`). It is bumped with the plugin version, at most once per
   tea-rags minor release (same cadence rule as the walker bump).
2. Every spawn forces `RUSTUP_TOOLCHAIN=<pin>`, `RUSTC=<pin rustc>`,
   `SYSROOT=<pin sysroot>` and the pin's `bin/` first on `PATH`. The corpus
   `rust-toolchain.toml` is ignored. This also defeats Homebrew `cargo`/`rustc`
   shadowing the rustup proxies, which was the case on this host.
3. `cargo check --keep-going`: a crate that fails under the pin (a nightly
   corpus whose unstable API drifted) produces no rows. Every other crate still
   produces rows, and the failed crate's sites fall through to the SCIP slot.
   The failure is recorded per envKey (`latch.json`, same lattice as the SCIP
   runner) with the first rustc error line, and `prime` shows it.
4. Opportunistic same-version build (corpus pin has the same `major.minor` as
   the plugin channel and rustup has its `rustc-dev`) is optional and buys
   nothing measurable. Not in v1.

## 3. Output contract (NDJSON, one object per call site)

The driver emits one file per compilation unit:
`<outDir>/<crateName>-<stableCrateId:016x>.ndjson` plus `<same>.stats.json`.
Units overlap: lib, bin and test harness of one package re-emit the same sites.
The reader dedupes on `(relPath, line, col, callee)`.

| Field                   | Type                                                                       | Meaning                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relPath`               | string                                                                     | caller file, relative to the workspace root (canonicalised; sites outside the root are dropped)                                                                                                                                                                                                                                                                        |
| `line`                  | int                                                                        | **1-based** line of the callee NAME token                                                                                                                                                                                                                                                                                                                              |
| `col`                   | int                                                                        | **0-based UTF-16** column of the start of the callee NAME token: the method segment of `recv.name(..)`, the last path segment of `a::b::name(..)` / `Type::name(..)` / `<T as Trait>::name(..)`. Computed from the on-disk line text, so it matches `CallRef.memberStartColumn` and `RustAnalyzerScipIndex.definitionAt`. Verified with `"é→x".len()` / `"é".chars()`. |
| `origin`                | `"source"` \| `"macro"`                                                    | `source`: the name token is in user text, including macro ARGUMENTS such as `println!("{}", x.foo())`. `macro`: the macro body produced the token; position is `span.source_callsite()` (the macro name token)                                                                                                                                                         |
| `macro`                 | string\|null                                                               | macro name when `origin = "macro"`                                                                                                                                                                                                                                                                                                                                     |
| `callKind`              | `"method"` \| `"path"`                                                     | `ExprKind::MethodCall` (via `type_dependent_def_id`) or `ExprKind::Call` of a path (via `qpath_res`)                                                                                                                                                                                                                                                                   |
| `callee`                | string                                                                     | `def_path_str` (no trimmed paths) of the callee as type-checked, e.g. `std::result::Result::<T, E>::map_err`, `fx_core::Store::get`                                                                                                                                                                                                                                    |
| `calleeCrate`           | string                                                                     | crate name of the callee (`core`, `std`, `alloc`, dep or workspace crate)                                                                                                                                                                                                                                                                                              |
| `defKind`               | `fn` \| `assocFn` \| `ctor` \| `closure` \| `static` \| `const` \| `other` |                                                                                                                                                                                                                                                                                                                                                                        |
| `traitPath`             | string\|null                                                               | the trait when the callee is a trait item                                                                                                                                                                                                                                                                                                                              |
| `implSelfType`          | string\|null                                                               | self type of the inherent impl the callee lives in                                                                                                                                                                                                                                                                                                                     |
| `resolvedImpl`          | string\|null                                                               | the impl item `Instance::try_resolve(post_analysis typing env)` dispatches to, when the call is monomorphic: `<fx_core::MemStore as fx_core::Store>::get`. Null for generic-bound (`S: Store`), `dyn`, and default-method calls                                                                                                                                        |
| `implIsDerived`         | bool                                                                       | `resolvedImpl`'s impl is `#[automatically_derived]` (its def span is the `#[derive]` attribute; treat as derive-generated, never as a table symbol)                                                                                                                                                                                                                    |
| `inProject`             | bool                                                                       | the definition of `resolvedImpl ?? callee` lies under the workspace root                                                                                                                                                                                                                                                                                               |
| `defRelPath`, `defLine` | string, int \| null                                                        | that definition's ident span (`def_ident_span`, else `def_span`), 1-based line; present iff `inProject`                                                                                                                                                                                                                                                                |

Dropped (counted in `.stats.json`): desugarings (`?`, `for`, `.await`;
`ExpnKind::Desugaring`), bodies of `#[automatically_derived]` impls (derive
output carries user spans, not an expansion context, so `from_expansion()`
misses it: fixture `#[derive(Debug, Clone)]` produced phantom `source` rows on
the field lines until filtered by the impl marker), non-path callees other than
a field, and a local / field callee whose type is none of the R4 kinds below
(`drop.indirectCalleeType`). Calls of locals/closures (`Res::Local`) were
dropped until format 3.

Macro-invocation rows (format 2, RESIDUAL.md R3): one row per user-written
bang-macro invocation, at the macro NAME token (the last path segment before
`!`, UTF-16 column as above), with only the fields `relPath`, `line`, `col`,
`origin: "macroInvocation"`, `macro` (the name), `macroDefPath` (`def_path_str`
of `ExpnData::macro_def_id`: `std::write` for core's macro re-exported by std,
unprefixed for the local crate), `calleeCrate` (the defining crate),
`inProject`, `defRelPath`, `defLine`. Each expression's context is walked to its
outermost expansion whose call site is user text, so invocations nested inside
an expansion (`write!` → `format_args!`) emit nothing. The decoder serves these
rows as `kind: "macro"` definitions; `origin: "macro"` rows stay unserved.

Local and indirect callee rows (format 3, RESIDUAL.md R4): a call whose callee
is a local binding (`Res::Local`) or a field (`(self.f)(x)`) emits a row at that
name token (the binding or the field name), with `callKind: "local"` and the
callee's TYPE, references and `Box` peeled, deciding the rest. A fn item
(`let ts = TimeStamp::new; ts(42)`) is a real definition: the row is a normal
row for that item (`callee`, `calleeCrate`, `defKind` `fn` / `assocFn`,
`inProject`, `defRelPath`, `defLine`). A closure, a fn pointer or an Fn-bound
param / trait object / opaque type has no definition: `callee` is the binding or
field name, `calleeCrate: null`, `defKind` `closure` / `fnPointer` / `fnParam`,
`inProject: false`, every def field null. Other non-path callees (`make()(x)`,
`fs[i](x)`) still emit nothing. The decoder serves the indirect rows as
`kind: "local"` definitions carrying `indirectCallee`; the driver slot DROPs
them and the Rust facade's `targetsUndecidable` classifies the miss as
`unresolvable`.

### Mapping to `RustScipDefinition` (adapter, no strategy change needed)

| `RustScipDefinition`           | from the driver row                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `symbol`                       | `rustc ${calleeCrate} ${resolvedImpl ?? callee}` (stable, diagnostic only)                                                        |
| `package`                      | `calleeCrate`                                                                                                                     |
| `inProject`, `relPath`, `line` | `inProject && !implIsDerived`, `defRelPath`, `defLine`                                                                            |
| `name`                         | last `::` segment of `callee` with generic args stripped                                                                          |
| `kind`                         | `fn`/`assocFn` → `callable`; `ctor` → `type` (SCIP's enum-variant convention); else `other`                                       |
| `implTrait`                    | last segment of `traitPath` when `resolvedImpl` is set (trait impl dispatch)                                                      |
| `declaringTrait`               | last segment of `traitPath` when `resolvedImpl` is null (proves the trait, not the impl; the R3c external gate applies unchanged) |
| `packageInProject`             | `calleeCrate` ∈ crate names the driver ran on (workspace members)                                                                 |

`mapScipDefinitionToSymbol` already turns `(relPath, line, name)` into a table
symbol. The in-project symbolId is the chunk symbol whose definition span starts
at `defLine` in `defRelPath` with member name `name`. Derived impls answer
`inProject: false, packageInProject: true` and hit the existing
`RUST_DERIVABLE_TRAITS` external rule.

## 4. Macro-expanded spans

- Macro arguments are user tokens: their spans keep the root context, so
  `from_expansion()` is false and the row is exact (`origin: "source"`). This
  covers the `println!`/`assert!`/`format!` argument calls tree-sitter sees.
- Body-generated tokens (`format_args!` internals, `vec!` → `box_new`,
  `macro_rules!` bodies) are mapped with `source_callsite()` onto the outermost
  macro invocation's name token and tagged `origin: "macro"`. On ripgrep these
  are 11,010 of 29,002 rows. 3,732 of them reach in-project definitions (local
  `macro_rules!` calling project fns).
- The adapter must NOT serve `origin: "macro"` rows through `definitionAt`.
  Their position is the macro name token, which the macro-invocation strategy
  resolves, and serving them would bind a call edge to the wrong token. v1 drops
  them. A later epic can turn them into "macro invocation → callee" edges.
- Desugarings are dropped. They have no source token a walker records.

## 5. Cost

All numbers on this host (M-series, `caffeinate -s -i`), pinned toolchain,
`--all-targets`, separate cold target dirs:

| Corpus                        | cold `cargo check` | cold driver                      | warm no-op | warm, 1 file touched                                                         | rows   | visitor CPU                 | peak tree RSS check / driver     |
| ----------------------------- | ------------------ | -------------------------------- | ---------- | ---------------------------------------------------------------------------- | ------ | --------------------------- | -------------------------------- |
| fixture (2 crates)            | 1.2 s              | 1.0 s                            | 0.06 s     | –                                                                            | 53     | 0.1 s                       | 100 MB / 109 MB (single process) |
| ripgrep (10 crates, 29 units) | 5–9 s (2 runs)     | 7–13 s (3 runs on a loaded host) | 1 s        | 1 s (`crates/core/flags/hiargs.rs` → `rg` bin + test + `integration` re-run) | 29,002 | 0.9–1.2 s summed over units | 1.1 GB / 1.1–1.4 GB              |

- The driver's own work (HIR walk + `try_resolve` + `def_path_str` + JSON) is
  1.2 s of CPU summed over 29 units, ~40 µs per row. The first prototype spent
  45 s here: unbuffered `writeln!` of `serde_json::Value` issues one `write(2)`
  per fragment. Keep the `BufWriter`; `with_no_trimmed_paths!` is also on.
- Cold driver ≈ cold `cargo check` + a few seconds. The cold cost is the
  dependency check under the pinned toolchain, paid once per envKey.
- tikv/servo: not run here (they execute untrusted build scripts at scale). The
  owner runs `run-driver-corpus.sh`. Reference point: RA exec SCIP on tikv = 726
  s for +0.003. Expect the driver to cost ≈ tikv `cargo check --all-targets`
  cold, and seconds warm.
- Owner run (the work dir defaults to `~/.tea-rags/rustc-driver-spike/<name>`,
  never the corpus `target/`; `SKIP_BASELINE=1` skips the plain-check baseline;
  `TOUCH_FILE=<rel>` adds the warm one-file rerun):

  ```bash
  S=/Users/artk0re/.claude/jobs/101d63dd/tmp/rustc-driver
  caffeinate -s -i env TOUCH_FILE=components/tikv_util/src/lib.rs $S/run-driver-corpus.sh /Users/artk0re/Dev/OpenSource/codegraph-validation/tikv /tmp/tikv-driver.ndjson
  caffeinate -s -i env TOUCH_FILE=components/script/lib.rs $S/run-driver-corpus.sh /Users/artk0re/Dev/OpenSource/codegraph-validation/servo /tmp/servo-driver.ndjson
  python3 -I $S/join-residual.py <tally residual-rows.ndjson> /tmp/tikv-driver.ndjson
  ```

- Disk: pinned toolchain incl. `rustc-dev` 1.5 GB (one-time); ripgrep driver
  target dir 204 MB (check: 167 MB); NDJSON 9.4 MB for 29k rows (~320 B/row, so
  tikv's ~0.5–1 M rows ≈ 0.2–0.3 GB uncompressed; the adapter should keep only
  the decoded map, see §8).

## 6. Incremental story (measured on the fixture, `incr.sh`)

cargo decides, rustc's query cache helps underneath:

| Edit                                     | Units the driver re-runs                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| none                                     | none (0.06 s)                                                                                                    |
| body of a leaf crate (`app/src/main.rs`) | that crate only                                                                                                  |
| private fn body in a dependency (`core`) | `core` and every dependent (`app`). cargo propagates by fingerprint, with no early cut-off on an unchanged rmeta |
| comment-only / touch in `core`           | same as above: cargo fingerprints by mtime                                                                       |

A re-run unit re-emits its whole NDJSON file, because the visitor walks every
body. The compiler-side cost is the incremental re-check: `typeck` of unchanged
bodies comes from the incremental cache, and the visitor is ~40 µs per row. The
per-unit file replaces its predecessor, and stale units are garbage-collected
against the run's unit list (§8). This is the same granularity as the SCIP
runner's per-file partial serve, only cheaper: a warm run on ripgrep is 1 s, so
the adapter can afford to run the driver on every index run and needs no "reuse
only" admission mode.

## 7. Coverage against the chain-tally residual (ripgrep)

Chain tally run (heavy-measure lock held, 7 s; SCIP slot not acquired):
`TOTAL 0.713 5323/7467 · residual miss 2144`. The residual rows
(`/tmp/rg-residual.ndjson`) were joined against the driver output by
`join-residual.py`: same file, member name equal to the callee's last segment,
driver line in `[startLine, startLine+15]`, `source` origin preferred.

| Driver verdict on a `missWithInProjectDef` row      | Rows      | Share |
| --------------------------------------------------- | --------- | ----- |
| resolves to an in-project definition                | **1,120** | 52.2% |
| proves external (std/core/alloc/dep)                | **863**   | 40.3% |
| derived impl (`implIsDerived`, external-equivalent) | 37        | 1.7%  |
| no driver row                                       | 124       | 5.8%  |

- The 124 rows without a driver row are 85 macro invocations (`write!(…)` as a
  `bareCall`: a macro, not a call; the macro strategy owns these) and ~39 sites
  in cfg-disabled code: `#[cfg(feature = "pcre2")]` in
  `crates/core/flags/hiargs.rs`, `cfg(target_arch = "x86_64")` in
  `crates/core/flags/doc/version.rs` on an aarch64 host.
- Per receiver kind (inProject / external): dynamic 525/240, localVar 225/276,
  chain 170/238, constant 177/87, bareCall 51/2, index 4/23.
- Definition accuracy: of 10,893 source-origin in-project rows, every one of the
  10,771 non-derived rows has the callee name on its `defLine`. The other 122
  are derived impls whose def line is the `#[derive]` attribute, now flagged by
  `implIsDerived`.
- Rate projection for ripgrep, statically resolved 0.713: in-project resolutions
  alone give (5,323 + 1,120) / 7,467 = **0.863**. If the 900 proven-external
  sites leave the denominator the way a SCIP DROP does, the ceiling is ≈ 0.98.
  Which one is right depends on how the tally scores a DROP (not checked here).
  The owner's tikv/servo runs decide the real numbers.

## 8. Architecture for implementation

### 8.1 Where the driver lives and how it is built

- Source: `native/rust-callsites/` in the npm package (the crate from the spike,
  renamed), with dependencies **vendored** (`cargo vendor`) so the build is
  offline. The crate's `rust-toolchain.toml` names the pin, and
  `src/core/adapters/rustc-driver/pin.ts` holds the same string; a unit test
  asserts they match.
- Binaries: `tearags-rust-callsites` (cargo-side CLI, from `cli_main`) and
  `tearags-rust-callsites-driver` (`RUSTC_WORKSPACE_WRAPPER`).
- Built on first use, not at `npm install`: `cargo build --release --offline`
  with the pinned toolchain into
  `~/.tea-rags/rustc-driver/bin/<pin>-<sourceHash>/`. 22 s measured. The rpath
  bakes the pin's `target-libdir`; the spawn also sets
  `DYLD_LIBRARY_PATH`/`LD_LIBRARY_PATH` to `<sysroot>/lib` so a relocated rustup
  home still loads.

### 8.2 Discovery (mirrors `rust-analyzer-executable.ts`; never fails indexing)

1. `CODEGRAPH_RUST_DRIVER_PATH`: a prebuilt `tearags-rust-callsites`, probed
   with `-V` (prints `<version> <pin>`), rejected when the pin differs.
2. `tearags-rust-callsites` on `PATH`, same probe.
3. The data-dir build cache `~/.tea-rags/rustc-driver/bin/<pin>-<sourceHash>/`.
4. Build from the bundled source when the pinned toolchain is available with
   `rustc-dev`. Locate it with `rustup which --toolchain <pin> rustc`, then
   `${RUSTUP_HOME:-~/.rustup}/toolchains/<pin>-<host>/`, then asdf
   (`${ASDF_DATA_DIR:-~/.asdf}/installs/rust/*`, rustup-managed). Homebrew rust
   has no `rustc-dev` and can never satisfy the pin. The rustc-dev probe is
   `<sysroot>/lib/rustlib/<host>/lib/librustc_driver-*` plus
   `rustc_middle-*.rlib`.
5. Nothing found → slot absent, one install-hint line (as
   `RUST_ANALYZER_INSTALL_HINT`):
   `rustc call-site driver unavailable — install with 'rustup toolchain install nightly-2026-05-01 -c rustc-dev,rust-src' (≈1.5 GB), or set CODEGRAPH_RUST_DRIVER_PATH`.

### 8.3 Safety and budgets

- The driver IS `cargo check`, so build scripts and proc macros RUN, and it has
  no no-exec mode: unexpanded proc macros give no typeck results. Owner decision
  2026-10-23: ON BY DEFAULT whenever discovery (§8.2) finds the driver or the
  pinned toolchain with `rustc-dev` — a Rust developer's workspace builds
  anyway. `CODEGRAPH_RUST_DRIVER=off` disables it. The index output (MCP + CLI)
  states that the driver ran `cargo check` (build scripts and proc macros
  executed), and prints the install hint when no toolchain was found.
- `CMAKE_POLICY_VERSION_MINIMUM=3.5` in the child env: CMake ≥4 refuses
  `cmake_minimum_required` < 3.5, which killed tikv's grpcio-sys / snappy-sys
  build scripts on this host (measured 2026-10-23).
- `CARGO_NET_OFFLINE=true`, and
  `CARGO_TARGET_DIR=~/.tea-rags/rustc-driver/target/<envKey>`. The user's
  `target/` is never read or written.
- Wall + process-tree RSS budget with tree kill (reuse the SCIP runner's
  supervisor). `-j` defaults to `CODEGRAPH_RUST_DRIVER_JOBS` or
  `max(1, cores/2)`, because cold RSS scales with parallel rustc processes
  (ripgrep: 1.1–1.4 GB tree peak).
- Only host-target, default-feature code is type-checked. `cfg(windows)`,
  `cfg(feature = "x")` off, and `#[cfg(test)]` without `--all-targets` produce
  NO rows, so those sites stay with the static chain / SCIP. The default cargo
  args are `--workspace --all-targets --keep-going`.

### 8.4 Cache keying (same lattice as `scip-runner.ts`)

- `envKey = sha256([CALLSITES_FORMAT, driver -V (version + pin + sourceHash), rustc -vV of the pin, Cargo.lock, every Cargo.toml (sorted), cargo args, jobs-independent settings])`.
  The directory `~/.tea-rags/rustc-driver/<envKey>/` holds `target/`,
  `units/*.ndjson`, `latch.json`, `run.json`.
- There is no contentKey blob. cargo's fingerprints are the content cache. Every
  index run spawns the driver (warm ≈ seconds) and then reads `units/`.
  `run.json` lists the units of the last run, taken from cargo
  `--message-format=json` `compiler-artifact` messages, fresh ones included.
  Unit files not listed are deleted, which is GC for renamed or removed targets
  and feature flips.
- `identity = envKey + sha256(sorted unit file names + sizes + mtimes)`. It is
  exposed like `RustAnalyzerScipIndex.identity` so downstream caches key on it.
- Latch: environment failures (pin missing rustc-dev, build of the driver fails,
  every unit fails) are persisted per envKey. A budget breach is not persisted,
  and a per-crate compile failure is recorded in `run.json`, not latched.

### 8.5 Adapter + strategy integration: REPLACE the SCIP slot (owner decision 2026-10-23)

Owner decision: one engine. The rustc driver replaces rust-analyzer SCIP; the
SCIP adapter, strategy, discovery and hints are removed (T11). Evidence (tikv,
strict same-line join over the 56,013 `missWithInProjectDef` rows): driver and
SCIP both 16,489, driver only 31,164, SCIP only 104 (0.19%), neither 8,256.
Driver-only projection: tikv 0.579 → ≥0.916, ripgrep 0.713 → ≥0.959
(proven-external rows leave the denominator as `externalSkipped`, per
`contracts/resolve-rate.ts#resolveRateMiss`). Where the driver has no rows (not
opted in, toolchain missing, crate fails to build, cfg-disabled code) the chain
ends at the static strategies and the user gets the install / build hint.

#### Superseded design notes ("beside SCIP") — kept for the port shape only

- New port in `contracts/types/language.ts`: `RustCallSiteSource` →
  `RustCallSiteAcquisition` with an index exposing the SAME
  `definitionAt(relPath, line, utf16Col) → RustScipDefinition | null`. The
  driver rows map onto the existing `RustScipDefinition` (table in §3), so
  `mapScipDefinitionToSymbol` and `rustScipDefinitionIsExternal` are reused
  unchanged.
- New strategy `RustcCallSiteSymbolResolutionStrategy`, appended to the chain
  directly BEFORE `RustAnalyzerScipSymbolResolutionStrategy`. Same contract:
  in-project callable → edge; provably external → DROP; anything else →
  CONTINUE, then SCIP gets the site.
- Why beside and not replace:
  1. The driver has no rows for cfg-disabled code, for crates that fail under
     the pin, or when the user has not opted in. SCIP covers some of those sites
     (RA analyses all cfgs only partially, but it does not fail per crate).
  2. Where both answer, the driver is compiler truth and must win, so it goes
     first.
  3. Removing SCIP is a separate, measured decision. Once the driver's residual
     rate is known on tikv/servo, drop SCIP if it resolves < ~0.5% of the
     post-driver residual. RA's tikv yield is already +0.003 at 726 s.
- The miss classifier's external gate (`rustScipDefinitionIsExternal` consumer)
  should consult the driver first, then SCIP. Same function, two sources.
- The driver can also serve as an ORACLE. Running the static chain and recording
  where its edge disagrees with the driver's `inProject` definition gives the
  first precision measurement of the static Rust resolver. It belongs in the
  chain tally as `--rustc-oracle`, not in production. Production must not let
  the driver override earlier strategies until that disagreement rate is
  measured ("lost correct edge = regression").

### 8.6 Task split (each TDD: failing test first, then code)

| #   | Task                                                                                                                                                                                                                                                                  | Class                                                     | Tests first                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | Port the spike crate to `native/rust-callsites/` (rename, vendor deps, `-V` banner with pin + source hash, `--message-format=json` unit list → `run.json`, unit-file GC, `implIsDerived`, drop rules)                                                                 | design-bound (opus)                                       | a Rust integration test over a fixture workspace (the spike fixture): exact rows for UFCS, `dyn`, generic-bound, derived `Clone`, `macro_rules!`, non-ASCII column, `?` dropped                        |
| T2  | `adapters/rustc-driver/executable.ts`: discovery tiers of §8.2 + rustc-dev probe + install hint                                                                                                                                                                       | mechanical (sonnet), mirror `rust-analyzer-executable.ts` | injected `deps.run` / fs fakes per tier, pin-mismatch rejection, Homebrew-only host → null + hint                                                                                                      |
| T3  | `adapters/rustc-driver/driver-build.ts`: first-use build into the data dir, offline, latch on failure                                                                                                                                                                 | mechanical                                                | fake spawn: build once, reuse by sourceHash, failure → latch                                                                                                                                           |
| T4  | `adapters/rustc-driver/callsite-runner.ts`: supervised spawn (env forcing of §2, budgets, `-j`), envKey, `run.json`/GC, latch lattice                                                                                                                                 | design-bound                                              | env assembled exactly (`RUSTUP_TOOLCHAIN`/`RUSTC`/`SYSROOT`/`CARGO_TARGET_DIR`/`CARGO_NET_OFFLINE`), user `target/` never referenced, envKey changes on Cargo.lock/pin/args, budget breach not latched |
| T5  | `adapters/rustc-driver/callsite-decoder.ts`: NDJSON → `definitionAt` map (dedupe, `origin: "macro"` excluded, row → `RustScipDefinition` table of §3)                                                                                                                 | mechanical                                                | golden NDJSON lines → expected `RustScipDefinition`, including derived impl and trait declaration                                                                                                      |
| T6  | contracts + resolve environment: `RustCallSiteSource` port, `rustCallSitesOf(ctx)` beside `rustAnalyzerScipOf`                                                                                                                                                        | design-bound                                              | type-level + environment wiring test                                                                                                                                                                   |
| T7  | `RustcCallSiteSymbolResolutionStrategy` before the SCIP slot; external gate consults the driver first                                                                                                                                                                 | design-bound                                              | chain-order test, edge / DROP / CONTINUE on a stub index, SCIP still reached on null                                                                                                                   |
| T8  | chain tally: `--rustc-callsites <dir>` input + `--rustc-oracle` disagreement report                                                                                                                                                                                   | mechanical                                                | tally unit test on a stub index                                                                                                                                                                        |
| T9  | `prime` / `get_index_status`: driver acquisition line (unit count, failed crates, latch, hint)                                                                                                                                                                        | mechanical                                                | formatter snapshot                                                                                                                                                                                     |
| T11 | Remove the rust-analyzer SCIP engine: `adapters/rust-analyzer/`, `RustAnalyzerScipSymbolResolutionStrategy`, `rustAnalyzerScipOf`, discovery + `CODEGRAPH_RUST_ANALYZER_*` env, install hint, chain-tally `--rust-analyzer*` flags; the MCP/CLI hint names the driver | design-bound (opus), after T7 lands and is measured       | driver tests cover every behaviour the SCIP tests pinned (external DROP, R3b/R3c/R3d verdicts) before SCIP tests go with their code                                                                    |
| T10 | live validation (owner-gated): `run-driver-corpus.sh` on tikv + servo, then the chain tally with the driver slot                                                                                                                                                      | orchestrator                                              | n/a                                                                                                                                                                                                    |

T1 runs in parallel with T2–T5. T6 → T7 → T8 run sequentially.

## 9. Open risks

1. **Exec is mandatory.** No proc-macro expansion means no typeck. The trust
   gate is a product decision.
2. **Nightly corpora drift.** tikv pins 2026-01-30 and the driver 2026-05-01.
   The feature gates exist; unstable library API changes inside them are
   unmeasured until the owner's tikv run. Failure mode: those crates have no
   rows and fall to SCIP, never a failed index.
3. **Pin bumps cost a port.** Two internal-API breaks in 3 months on a ~400 LOC
   surface. Budget ~0.5 day per bump, gated by the T1 fixture test.
4. **cfg coverage.** Host-only, default features. Windows-only code paths in
   corpora stay static/SCIP-only.
5. **Cold RSS on tikv/servo.** Bounded by `-j`, unmeasured here.
6. **Generic-bound and `dyn` calls** resolve to the trait DECLARATION
   (`resolvedImpl` null). That is correct, and the existing R3c `declaringTrait`
   gate handles it. It is not an in-project impl edge.
