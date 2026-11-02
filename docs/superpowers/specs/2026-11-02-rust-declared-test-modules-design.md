# Rust files reached only through `#[cfg(test)] mod x;` are test code

Bead: tea-rags-mcp-52wk3.10, epic tea-rags-mcp-52wk3 (inline test chunks).

## Problem

`#[cfg(test)] mod testutil;` in `crates/searcher/src/lib.rs` makes the separate
file `crates/searcher/src/testutil.rs` compile only in the test build. Nothing
inside `testutil.rs` says so: the fact lives in the file that declares the
module. Live validation on ripgrep showed the file indexed as production: its
chunks carry no `payload.isTest`, and `RegexMatcher` and its methods entered the
codegraph with zero fan-in, which makes them dead-code candidates.

Test classification is per path today. Every consumer calls `classify(relPath)`
(`primitives/paths/file-classification/classify.ts`) or the filter built from
the same installed conventions:

| Consumer                              | Where                                                                | Isolate                    |
| ------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `payload.isTest`                      | `StaticPayloadBuilder#buildPayload` → `detectTestFile`               | main                       |
| enrichment skip / `skippedAs: "test"` | `enrichment/policy.ts` `classifyPath`                                | main and enrichment worker |
| codegraph exclusion                   | `buildCodegraphExclusionFilter` (`codegraph/exclusion/exclusion.ts`) | enrichment worker          |
| scoped force selector                 | `rechunk-work-set.ts` `isTestPath`                                   | main                       |

Path patterns (`rust/test-files.ts`: `**/*_test.rs`, `**/tests.rs`) cover the
conventional names only.

## Decision

A language may declare, once per index run, the project files that are test code
by a cross-file fact. The set is an additive input to test classification: a
path is a test path when the installed conventions match it OR it is in the
declared set. Absent or empty set → classification is exactly as today.

### Contract

`LanguageProvider` gains an optional capability, following the shape of
`DependencyManifestSource` / `codegraphExclusionGlobs`: given the project root
and the run's current file list (relative paths), return the relative paths of
files that are test code by declaration. A `collect…` helper aggregates it over
the factory's languages the same way `collectDependencyManifestSources` does.
Name it through `get_naming_lexicon` before committing to one.

### Rust implementation

Lives in the Rust vertical, beside `rust/manifest.ts`.

- Candidates: `.rs` files of the current file list. A text prefilter (the file
  contains `cfg(test)` or `cfg(` together with a `mod <ident>;` declaration)
  avoids parsing files that cannot declare one; a hit is confirmed on the AST.
- A declaration counts when it is a body-less `mod_item` that is test-only per
  `isInlineTestNode` (`rust/inline-tests.ts`), or ANY body-less `mod_item` of a
  file already in the set (transitive closure: a module declared from test code
  is test code), or any body-less `mod_item` nested in an inline module that is
  test-only.
- Resolution of `mod x;` declared in file `F` in directory `D`, inside inline
  modules `a { b { … } }`:
  - `#[path = "p"]` on the declaration: `D/p` for a declaration at file level;
    inside inline modules, `D/a/b/p`.
  - otherwise the module directory is `D` when `F` is `mod.rs`, `lib.rs`,
    `main.rs` or a crate root, else `D/<stem of F>`; then append the inline
    module path; the child is `<dir>/x.rs`, else `<dir>/x/mod.rs`.
  - only paths present in the current file list are returned.
- Iterate to a fixpoint over the closure; cycles are impossible to loop on
  because the set only grows.

### Delivery

Computed once per run on the main thread, before change detection, in the
incremental (`ReindexPipeline#prepareReindexContext` / `reindexChanges`) and the
full (`indexing.ts`) paths. Installed into classification on the main thread,
and handed to enrichment / codegraph isolates through the per-run channel they
already receive their run configuration on (never re-derived per isolate). The
installed set defaults to empty, so a context that never installs one classifies
as before and nothing throws.

### Incremental coherence

`payload.isTest` and `skippedAs` are persisted per point, and an unchanged file
is never re-chunked. So the previous run's set is persisted with the existing
snapshot state (no new per-collection artifact; check
`domains/maintenance/footprint/CLAUDE.md` before placing it). On each run the
symmetric difference between the previous and the current set is invalidated
through `synchronizer.invalidateEntries` at the point where
`invalidateRechunkWorkSet` runs, so flipped files come out of change detection
as MODIFIED and are re-chunked, re-stamped and their codegraph rows replaced. A
missing previous set (first run after the upgrade, or an old snapshot) is
treated as empty — the run then re-chunks exactly the files now in the set.

### Versioning

Rust chunking/walker are already bumped in this unreleased branch. The shared
classification and pipeline changes are byte-identical for every project with no
declared test files; record that with `Versions: unchanged — …` and re-pin.

## Out of scope

- `cfg_attr`-driven module paths and `#[path]` inside `cfg_attr`.
- Other languages: none has a declaration-driven test module.
