# Rust residual after the rustc call-site driver

Research note for closing the Rust codegraph residual once the driver strategy
(SPEC.md) lands. Measured offline on existing artifacts; no tally or driver
re-run.

## Inputs and method

| Corpus  | Residual rows (`missWithInProjectDef`) | Static edges (TSV `exact`) | Driver rows                     |
| ------- | -------------------------------------- | -------------------------- | ------------------------------- |
| ripgrep | `measure/int3/ripgrep.ndjson`, 2,138   | `int3/ripgrep.tsv`, 5,322  | `/tmp/rg-driver.ndjson`, 29,002 |
| tikv    | `measure/int3/tikv.ndjson`, 55,951     | `int3/tikv.tsv`, 76,984    | `driver/tikv.ndjson`, 424,259   |
| servo   | `measure/ta1/servo.ndjson`, 40,668     | `ta1/servo.tsv`, 51,898    | `driver/servo.ndjson`, 195,509  |

servo uses `ta1`: `int3/servo.txt` has no `TOTAL` line, so that run never
finished. Driver runs were `cargo check --workspace --all-targets --keep-going`,
default features, host target `aarch64-apple-darwin`.

Rate = resolved / (resolved + missWithInProjectDef). Driver rows that answer
external or derived take the site out of the denominator.

Scripts are in `~/.claude/jobs/101d63dd/tmp/residual/`. `lib.mjs` holds the
shared helpers (name-token mapper, bracket lexer, driver index). `analyze.mjs`
does the precise join and bucketing, `precision.mjs` compares static edges
against the driver, and `localkind.mjs` splits the local-callee rows. Each run
writes `<corpus>.remaining.ndjson`, one row per unserved site with its bucket.

### Precise join (the key production will use)

Driver key: `(relPath, line, col)` of the callee NAME token, with `col` as a
0-based UTF-16 index. A residual row's `startLine`/`startColumn` mark the start
of the call expression (0-based), not the name token. The mapper:

1. Walks the source from `(startLine, startColumn)` and matches `callText` one
   character at a time with whitespace dropped on both sides. `callText` folds
   newlines, so multi-line chains still map. If the column does not match, it
   retries the column as a byte offset converted to UTF-16.
2. Picks the callee token: the last occurrence of `member` that stands as a
   whole identifier, follows `.` / `::` / `>` or opens the text, is followed by
   `(` or `::<`, and sits at bracket depth 0.
3. Takes the line and column of that token from the source line, which is UTF-16
   because it is a JS string index.

Mapping failures: 0 on all three corpora, apart from macro-invocation call texts
(`write!(…)`), which are bucket d. **Name sanity check:** wherever the precise
key hits, at least one driver row has callee name == `member` (0 mismatches on
all three corpora). The position key alone is safe.

## 1. Precise join vs strict join

| Corpus  | Residual | inProject | external | derived | mixed |  **none** | strict `none` | strict `mixed` |
| ------- | -------: | --------: | -------: | ------: | ----: | --------: | ------------: | -------------: |
| ripgrep |    2,138 |     1,122 |      856 |      37 |     0 |   **123** |           267 |              5 |
| tikv    |   55,951 |    17,847 |   31,558 |   4,381 |     1 | **2,164** |         8,359 |            166 |
| servo   |   40,668 |    20,232 |   17,595 |   1,735 |     0 | **1,106** |         8,348 |             74 |

How the strict `none` rows land under the precise join:

| Corpus  | → inProject | → external | → derived | stay none |
| ------- | ----------: | ---------: | --------: | --------: |
| ripgrep |          78 |         66 |         0 |       123 |
| tikv    |       1,785 |      4,381 |        29 |     2,164 |
| servo   |       3,022 |      4,204 |        31 |     1,106 |

Almost all of the gain comes from multi-line chains, where the name token sits
on a later line than `startLine`. The precise join also settles every strict
`mixed` row: two calls with the same name on one line become two different
columns.

## 2. What remains after the precise join

Bucket definitions. The bucketer takes the first rule that matches, in this
order:

- **d — macro invocation recorded as a call.** `callText` is `name!(…)` and the
  walker emitted it with `member = name`. The compiler has no fn call there.
- **c — crate failed under the pinned toolchain.** servo `tests/capi/`
  (`servo-capi-tests` build script failed). It holds **0** residual rows on all
  three corpora. The tikv driver log has no failures.
- **b0 — file never compiled.** The driver has no rows for the whole file.
  - `crateNoRows`: the crate is outside the build. tikv
    `components/engine_tirocks` is in the workspace `exclude` (`Cargo.toml`:
    "Only enable tirocks in local development"), and servo `support/crown`
    (rustc plugin) is also outside it.
  - `fileOfBuiltCrate`: the module is cfg-gated where it is declared, e.g.
    `#[cfg(all(target_os = "linux", feature = "bcc-iosnoop"))] mod biosnoop;`,
    `threads_linux.rs`, `cgroup.rs`, servo `egl/android`, `egl/ohos`, `openxr`,
    `vello_backend`.
- **b — cfg-disabled body or statement.** The enclosing `fn` body has zero
  driver rows (`bodyNotCompiled`), or the body compiles but the statement or
  block carries a `#[cfg]` (`stmtCfg`). Labels come from the cfg attributes on
  the enclosing items and statement: `test`, `feature`, `target`, other.
- **e — local callee.** A `bareCall` whose name is a local binding (`let`,
  closure param, fn param, pattern). The driver drops it as `drop.localCallee`,
  because rustc resolves the callee to `Res::Local`.
- **a — call inside macro arguments that the driver did not serve.** Effectively
  empty: 1 servo row, a mis-detected `if`. Calls inside macro ARGUMENTS come
  back as `origin: "source"` rows and are already served. macro_rules BODIES
  produced 0 residual rows.
- **f — same name at another position** on the call's lines: 0 rows. The mapper
  is exact.
- **g — no row, no explanation.** The remaining unclassified rows. They are
  local callees the binding regex missed (pattern-bound closures like
  `Validate::Region(id, validate) => validate(…)`) and cfg blocks the header
  scan missed.

### tikv: 2,164 remaining

| Bucket                                                                               | Rows | Examples                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| e.localCallee                                                                        |  660 | `backup-stream/src/subscription_track.rs:665` `ts(42)` with `let ts = TimeStamp::new;` · `backup-stream/src/metadata/store/pd.rs:239` `insert("a", …)` (closure) · `cdc/src/delegate.rs:613` `send(downstream)` |
| d.macroInvocationAsCall                                                              |  466 | `cmd/tikv-ctl/src/executor.rs:128` `error!("raft db not exists…")` · `write!` ×413 · `debug!` / `info!` / `error!` ×51                                                                                          |
| b0.fileNotCompiled:crateNoRows                                                       |  393 | `engine_tirocks/src/cf_options.rs:30` `RocksCfOptions(…)` · `engine_tirocks/src/properties/range.rs` (89) · `engine_tirocks/src/util.rs` (63)                                                                   |
| b0.fileNotCompiled:fileOfBuiltCrate                                                  |  303 | `tikv_util/src/metrics/threads_linux.rs` (109) · `tikv_util/src/sys/cgroup.rs` (61) · `file_system/src/io_stats/biosnoop.rs:87` `IDX_ALLOCATOR.free(…)`                                                         |
| b.bodyNotCompiled (feature+test 123, target 80, feature 43, test 36, target+test 23) |  305 | `file_system/src/file.rs:243` `self.0.mode(mode)` (unix) · `cloud/gcp_v2/src/credentials.rs:40` fips feature · `backup-stream/src/metadata/store/pd.rs:307` failpoints+test                                     |
| b.stmtCfg (feature 11, target+test 9, test 8, ossl 4)                                |   32 | `cmd/tikv-server/src/main.rs:228` `#[cfg(feature = "trace-async-tasks")] { … .init() }` · `crypto/src/fips.rs:20` `#[cfg(ossl1)]`                                                                               |
| g.noRow                                                                              |    5 | `cdc/src/endpoint.rs:1326` `validate(&self.old_value_cache)` (pattern-bound closure) · `raftstore/src/store/fsm/store.rs:590` `tick()`                                                                          |

### servo: 1,106 remaining

| Bucket                                                      | Rows | Examples                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| b0.fileNotCompiled:fileOfBuiltCrate                         |  709 | `webxr/openxr/mod.rs` (107) · `ports/servoshell/egl/app.rs` (81), `egl/ohos` (72), `egl/android` (68) · `fonts/platform/freetype/android/font_list.rs` (60) · `canvas/vello_backend.rs` (54) · `allocator/tracking.rs:52` |
| e.localCallee                                               |  179 | `constellation/constellation.rs:1429` `callback(user_contents)` · `devtools/protocol.rs:168` `handler(request)` · `fonts/font_store.rs:102` `callback(…)`                                                                 |
| b0.fileNotCompiled:crateNoRows                              |   67 | `support/crown/src/common.rs:33` `other.len()`                                                                                                                                                                            |
| b.bodyNotCompiled (target 46, feature 30, feature+target 2) |   78 | `constellation/sandboxing.rs:204` `self.arg(arg)` · `profile/system_reporter.rs:163` · `bluetooth/adapter.rs:32` (btleplug feature)                                                                                       |
| b.stmtCfg (target 12, feature 16, other 3)                  |   31 | `media/backends/gstreamer/render-unix/lib.rs:75` `GLDisplayEGL::with_egl_display(…)` · `background_hang_monitor/sampler_mac.rs:85` x86 `thread_state64_t::new()`                                                          |
| d.macroInvocationAsCall                                     |   26 | `ports/servoshell/desktop/tracing.rs:76` `target_variant!("Resized")`                                                                                                                                                     |
| g.noRow                                                     |   14 | `fonts/font_context.rs:705` `callback(family_name, None)` · `media/audio/decoder.rs:36` `callback()` · `net/image_cache.rs:664` `callback(…)`                                                                             |
| other                                                       |    2 | `script/engine/init.rs:135` (in a closure inside `debug!` args) · `shared/base/threadboost.rs:34` (target)                                                                                                                |
| c.crateFailed                                               |    0 | `tests/capi` has no residual rows                                                                                                                                                                                         |

### ripgrep: 123 remaining

| Bucket                              | Rows | Examples                                                                                                      |
| ----------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------- |
| d.macroInvocationAsCall             |   83 | `crates/cli/src/human.rs:48` `write!(f, …)` (write 56, writeln 14, matches 13)                                |
| e.localCallee                       |   12 | `crates/core/flags/doc/mod.rs:33` `replacement(name, &mut out)` · `crates/core/flags/hiargs.rs:776` `get(&m)` |
| b.stmtCfg (feature 9, target 6)     |   15 | `crates/core/flags/hiargs.rs:414` pcre2 · `crates/core/flags/doc/version.rs:89` SSE2 (x86)                    |
| b.bodyNotCompiled (target 7)        |    7 | `crates/ignore/src/walk.rs:290` `self.metadata.clone()` (windows)                                             |
| b0.fileNotCompiled:fileOfBuiltCrate |    5 | `crates/globset/src/serde_impl.rs:88` (feature `serde1`)                                                      |
| g.noRow                             |    1 | `crates/ignore/src/walk.rs:1086` `filter(ent)` (local callee)                                                 |

### Local-callee split (e + bareCall g), from `localkind.mjs`

| Corpus  | Rows | `let f = |   … | ` closure | `let f = path::fn;` fn item | fn param `impl Fn` / `&dyn Fn` | generic param `F` | pattern binding | unknown |
| ------- | ---: | -------: | --: | --------: | --------------------------: | -----------------------------: | ----------------: | --------------- | ------- |
| tikv    |  673 |      209 | 300 |         6 |                          34 |                              8 |               116 |
| servo   |  192 |       53 |   0 |        71 |                          20 |                             17 |                31 |
| ripgrep |   13 |        3 |   0 |         2 |                           8 |                              0 |                 0 |

## 3. Closability per bucket

| Bucket                             | Closable? | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rows (tikv / servo / rg)                                            | Precision risk                                                                                                                 |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| d macro invocation as call         | yes       | Driver emits one row per macro invocation at the macro name token: `expn_data().macro_def_id` gives def path, crate, `inProject` and def span. The strategy answers macro-call sites from those rows. An in-project `macro_rules!` gives an edge to the macro def; std, core and dependency macros are external and leave the denominator. A static fallback without the driver would teach the tally that `name!(…)` call texts are never fn calls.                                                                              | 466 / 26 / 83                                                       | None for fn edges. Today these sites can only bind wrongly, to a project fn that happens to share the name (`write`, `error`). |
| e local callee                     | yes       | Driver: when `qpath_res` is `Res::Local`, read `typeck.node_type(callee)`. `FnDef(def_id)` gives a real edge (`callKind: "local"`). `Closure`, `FnPtr`, a `dyn Fn` / generic `F: Fn` param, or `FnDef` behind a param all get a row with `defKind: "closure"` / `"fnPointer"`, and the tally classifies those as unresolvable (out of the denominator, no edge). Same for `drop.nonPathCallee` (`(self.f)(x)`). The static walker could also flag bare calls to a local binding as `localCallee`, which works for cfg'd code too. | 665 / 193 / 13 (tikv: 300 become real edges, e.g. `TimeStamp::new`) | Low. Today a closure named `insert` can only bind to an unrelated project `insert`.                                            |
| b, b0 `fileOfBuiltCrate`, cfg      | partly    | A host-target driver cannot see these. Options: (i) opt-in extra cargo args (`--features …`), user config only, never `--all-features` by default, because tikv's test-engine features conflict; (ii) leave them to the static chain. Target-gated code (linux/android/ohos/windows on a macOS host) cannot close.                                                                                                                                                                                                                | tikv 640 (feature ≈ 180) / servo 818 / rg 27                        | —                                                                                                                              |
| b0 `crateNoRows` (excluded crates) | no        | The crates are outside `--workspace` (`exclude = ["components/engine_tirocks"]`, `support/crown`). Building them would mean a second cargo invocation per excluded manifest, for crates that are deliberately excluded. Not worth it.                                                                                                                                                                                                                                                                                             | 393 / 67 / 0                                                        | —                                                                                                                              |
| c crate failed                     | n/a       | 0 residual rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 0 / 0 / 0                                                           | —                                                                                                                              |
| a / f                              | n/a       | Macro-argument calls are already `source` rows. The precise mapper has no position drift.                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0 / 1 / 0                                                           | —                                                                                                                              |

## 4. Precision: static edges vs the driver

All unique `exact` static edges from the TSV, joined to the driver row at the
callee-name token. **Disagree** means the driver says external, says derived, or
names an in-project def in a different file.

| Corpus  | Static edges | Judged (driver row present) |  Agree | Driver external | Driver derived | Other file (re-target) | **Disagree rate** |
| ------- | -----------: | --------------------------: | -----: | --------------: | -------------: | ---------------------: | ----------------: |
| ripgrep |        5,322 |                       4,749 |  4,575 |             146 |             28 |                      0 |          **3.7%** |
| tikv    |       76,984 |                      71,261 | 51,353 |          19,108 |             78 |                    166 |         **27.2%** |
| servo   |       51,898 |                      49,871 | 42,510 |           6,083 |              7 |                    199 |         **12.6%** |

`sameFileOtherOwner` (tikv 556, servo 1,072) is left out of the disagree counts.
In the examples it is a parser artefact of `<impl Trait for X>` paths or a
`pub use … as Alias` re-export, not a wrong edge. The TSV has no target line, so
it cannot be checked further. Not judged: `mapFail` rows, which are
macro-invocation edges like `info!` / `box_err!` with tikv `info` ×733, and
sites without a driver row.

The disagreements are systematic, not noise:

- tikv: `Res#unwrap` (`tidb_query_datatype/src/codec/mysql/decimal.rs`,
  `pub enum Res<T>` with `fn unwrap`) receives **14,140** static edges. Almost
  every `.unwrap()` in the corpus binds there: `cmd/build.rs:16`
  `….output().unwrap()`, `cmd/tikv-ctl/src/cmd.rs:968` `opt.cmd.unwrap()`. The
  driver gives `std::result::Result::unwrap` / `Option::unwrap`. Other cases:
  `String::from` → `engine_traits/src/errors.rs::String.from`,
  `region.get_end_key()` → `RegionSnapshot#get_end_key` where the driver gives
  `kvproto::metapb::Region::get_end_key`.
- servo: `Response#Ok` receives **2,936** bareCall edges. Every `Ok(…)` binds to
  a project item where the driver gives `std::prelude::v1::Ok`. Also `drop(x)` →
  `CommandReader#drop` (ripgrep) and `Trace#drop` (tikv), where the driver gives
  `std::mem::drop`.
- ripgrep: `a.as_ref()` → `Glob#as_ref`, `decomp_cmd.clone()` →
  `ignore::Error#clone` (driver: derived `Clone`), `Parser::new()` →
  `flags/parse.rs::Parser.new` (driver: `regex_syntax::Parser::new`).
- Re-targets (other file, in-project): `self.set_region_tombstone(…)` in
  `cmd/tikv-ctl/src/executor.rs`. Static binds the same-name method on the local
  impl; rustc picks the inherent method on `DebuggerImpl` in
  `src/server/debug.rs:313`. Trait-impl dispatch: `self.storage.write(…)` →
  `LocalStorage as ExternalStorage` (`external_storage/src/local.rs:89`), where
  static gives `Arc#write`.

**Decision:** the driver must OVERRIDE earlier static strategies wherever it has
a row at the exact name position, external answers included. The static
"resolved" count on tikv is inflated by about 19k false edges, roughly 25% of
static edges. Override lowers the headline rate a little (see §5) and removes
tens of thousands of wrong graph edges. By the project's own rule, a lost
correct edge is a regression and so is a wrong edge kept. Sites where the driver
has no row (cfg'd or excluded code) keep the static answer, and the fallback
that produced `Res#unwrap` and `Response#Ok` is still active there (task R5).

## 5. Proposed tasks and projected rates

Projections are cumulative. "R" counts static-resolved sites plus driver
inProject sites. The projections assume every driver `inProject` row maps to a
table symbol, which is unmeasured and is part of R1's gate. R3 counts every
macro row as leaving the denominator (a lower bound).

| Corpus  | Strict (reported) | R1 precise join | R2 override | R3 macro rows | R4 local callees | Remaining floor (cfg / excluded) |
| ------- | ----------------: | --------------: | ----------: | ------------: | ---------------: | -------------------------------: |
| ripgrep |            ≥0.959 |          0.9813 |      0.9808 |        0.9937 |       **0.9957** |                          27 rows |
| tikv    |            ≥0.916 |          0.9777 |      0.9722 |        0.9780 |       **0.9866** |                       1,034 rows |
| servo   |            ≥0.891 |          0.9849 |      0.9835 |        0.9839 |       **0.9868** |                         887 rows |

### R1 — position-keyed driver lookup (adapter), ≤60k tokens

The driver adapter indexes `origin: "source"` rows by
`(relPath, line, col UTF-16)`, deduping on `(relPath, line, col, callee)` per
SPEC §3. The strategy looks up `CallRef.memberStartColumn` / `memberStartLine`,
never `startLine` plus the name. Check that the walker's member position is the
name token for multi-line chains. That case is where the 6k tikv and 7k servo
strict misses came from.

TDD: fixture with a multi-line chain `foo\n    .bar()\n    .baz()` (the driver
row sits on the `.baz` line), a non-ASCII prefix on the line (`"é"` before the
call), two same-name calls on one line (`a.get(x).get(y)`), and a turbofish
`.collect::<Vec<_>>()`.

Gate: count the inProject rows whose `(defRelPath, defLine, name)` fails to map
to a table symbol. Report it before trusting R1.

### R2 — driver authority over the static chain, ≤80k tokens

When a driver row exists at the position, its answer wins over every earlier
strategy. External or derived answers turn a static in-project edge into
`external`; an in-project answer re-targets. No driver row leaves the static
chain as it is.

TDD: pin `x.unwrap()` with an in-project `enum Res { fn unwrap }` plus a driver
row giving `core::option::Option::unwrap`; the expected result is external and
no edge. Pin the `Ok(…)` bareCall the same way. Pin the re-target with
`self.m()` where the driver row has an inherent `defRelPath` in another file.
Measure the edge diff on the tikv offline harness. Expected losses are about
19.1k external, 78 derived, 166 re-targeted. Any loss whose driver row is
inProject in the same file is a bug.

### R3 — macro-invocation rows, ≤100k tokens (driver change + strategy)

The driver walks `ExprKind::MacCall` survivors via
`span.ctxt().outer_expn_data()`, taking the outermost expansion per call-site
span. It emits
`{origin: "macroInvocation", macro, macroDefPath, calleeCrate, inProject, defRelPath, defLine}`
at the macro name token. Bump the NDJSON format and the cache key. The strategy
serves walker call sites whose `callText` is `name!(…)` from these rows only:
in-project `macro_rules!` gives an edge, everything else is external.

TDD: a driver fixture crate with a local `macro_rules! my_log`, `write!`,
`matches!`, and a re-exported dependency macro. A strategy test where
`write!(f, …)` with a project `fn write` present resolves external, not to the
fn. Yield: 466 / 26 / 83.

### R4 — local and indirect callees, ≤100k tokens (driver change + tally class)

On `Res::Local` or a non-path callee, the driver emits a row from the callee
expression type. `FnDef` gives a real def (`callKind: "local"`). `Closure`,
`FnPtr`, `Dynamic`, and `Param` with an Fn bound give
`defKind: "closure" | "fnPointer" | "fnParam"`, `inProject: false`, no def. The
tally gets an `unresolvable.localCallee` class for those.

TDD: a fixture with `let ts = TimeStamp::new; ts(42)` (expect an edge to
`TimeStamp::new`), `let insert = |k, v| …; insert(…)`, `fn f(cb: impl Fn())`,
and `(self.f)(x)`. Yield: 665 / 193 / 13, of which tikv gets 300 new real edges.

Static complement, optional: the walker marks a `bareCall` whose name is bound
by a local `let` or pattern in the enclosing fn. That also covers cfg'd code.

### R5 — demote the static name-only fallback where the driver is silent, ≤80k tokens, design-bound

The fallback that produced `Res#unwrap` (14k) and `Response#Ok` (2.9k) is still
active in code the driver cannot see: about 1–2k sites per corpus. Two options:

- (a) Find the strategy that binds `x.unwrap()` to the corpus's only in-project
  `unwrap` and gate it with the existing R3c external rule for std-prelude names
  (`unwrap`, `Ok`, `drop`, `clone`, `as_ref`, `from`).
- (b) A driver-calibrated prior: if the driver resolves ≥95% of a member name's
  compiled sites externally, the uncompiled sites that only the name fallback
  resolved become external.

(b) needs no hand-written list but couples strategies, so it needs an owner
decision. TDD: a corpus-level fixture with a compiled site plus a cfg'd site
calling `.unwrap()`.

The rate effect is small. The precision effect sits in cfg'd code only.

### R3c — external-trait declaration rows are external (owner decision 2026-10-23)

After R1–R5, 712 residual misses (tikv 492, servo 160, ripgrep 60) were driver
rows at the DECLARATION member of a trait that std or a dependency declares:
`Clone::clone` (~300), `AsRef::as_ref` (~180), `Iterator::next`,
`Default::default`, `slog::Drain::log`, rocksdb `CompactionFilter*`, mozjs
`Trace::trace`. These are generic-bound and `dyn` calls plus compiler-builtin
impls (tuple `Clone`). The old R3c rule kept them misses because some project
impl of the trait declares the member, and for these traits some unrelated
type's impl always does.

Decision: such a row is EXTERNAL. The compiler-named callee is the external
trait item, and which impl runs is monomorphization dispatch, not the resolved
target. Undecidable is reserved for callees that cannot be named (R4). The
decision moves the miss gate (`targetsExternalImport`) and nothing else. The
chain keeps R3c's CONTINUE, because a static pass that names the impl that runs
(tikv `TimeStamp::from(ts)` → the project `From` impl) is a correct edge. A DROP
variant lost 36 / 5 / 7 such edges. A workspace trait's sourceless declaration
keeps the R3c / R3d project-impl gate.

Measured with `--rustc-driver`, edge diff 0 lost / 0 gained on all three:

| corpus  | before            | after             |
| ------- | ----------------- | ----------------- |
| tikv    | 0.980 77191/78759 | 0.986 77191/78267 |
| servo   | 0.982 64400/65571 | 0.985 64400/65409 |
| ripgrep | 0.986 6249/6340   | 0.995 6249/6280   |

The remaining residual is cfg / silent-driver floor (`SILENT:*`), 41 / 115 / 1
in-project callables, and servo's 11 workspace-trait rows.

### Not proposed

- Building excluded crates (tikv `engine_tirocks`, servo `support/crown`): 393 /
  67 rows. They are deliberately outside the workspace build.
- Default `--all-features`: tikv features conflict. Feature-gated rows are about
  180 on tikv and 38 on servo. Expose this as user config at most.
- Target-gated code (linux / android / ohos / windows on a macOS host) is the
  hard floor: about 700 of the 1,034 tikv floor rows and about 800 of
  servo's 887.
