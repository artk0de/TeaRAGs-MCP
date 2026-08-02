# Module-mass signals — rename, selection fix, industry floors

Status: approved 2026-08-02 Supersedes the symbol-mass slice of
`docs/superpowers/specs/2026-08-01-risk-assessment-structural-axis-design.md`
§A.

## Problem

`tea-rags prime` renders this for the tea-rags index itself:

```
classLines      — source: small ≤26 / large ≤31.25 / megaclass ≤35.15 · test: —
fileSymbolCount — source: typical ≤5 / busy ≤11 / god-module ≤42.7
```

A 35-line class is not a megaclass. Three independent defects produce that line.

### D1 — `chunkType: "class"` selects only member-less classes

`assignSymbolMass` (`chunker/symbol-mass.ts:159`) stamps `memberCount` and
`classLines` only when `chunk.metadata.chunkType === "class"`, and
`indexClasses` (:66) builds its class map from the same predicate.

For TypeScript that predicate almost never holds. A class **with** members is
chunked by `typescriptBodyChunkingHook`
(`domains/language/typescript/chunking/class-body-chunker.ts:397`), which writes
`ctx.bodyChunks` carrying no `chunkType` at all — those chunks land as
`"block"`. `getChunkType()` (`chunker/tree-sitter.ts:1391`) is reached only for
a chunkable node the hook chain did not claim, i.e. a class with nothing to
extract.

Measured on the live index: `chunkType.class = 37` against **418** `class`
declarations in `src/`. The 37 are presets (`RelevancePreset`,
`GodModulePreset`) and one-line error subclasses
(`class TrajectoryGitError extends TrajectoryError {}`). `Reranker` — 688 lines,
51 chunks — carries `chunkType: "block"` and no `classLines` at all.

So the percentile sample for `classLines` is 20 values spanning 13..38, drawn
exclusively from classes that have no members by construction. Every label
derived from it is meaningless, and the chunk half of the `godModule` preset is
dead for TypeScript.

### D2 — the signals measure the wrong quantity

`classLines` is a class span, but the label vocabulary around it (`god-module`,
the `godModule` preset, `GodModuleCompositePreset`) is about **modules**, and in
this project a module is a file. Two different units share one word.

`fileSymbolCount` counts every folded `symbolId` on every code chunk — classes,
interfaces, type aliases, enums, functions and methods alike. Consequences:

- `contracts/types/trajectory.ts` scores 13 while declaring nothing but types. A
  type barrel is not a god module.
- a class with 10 methods contributes 11 (itself plus each method).

The industry counts callables: pylint `too-many-public-methods` 20, Sonar S1448
35 methods, PMD `TooManyMethods` 10. No linter counts "symbols per file" — the
current metric has no external anchor at all.

### D3 — percentiles alone cannot express "too big"

Percentiles are relative by construction: on a clean codebase p95 marks the
largest 5% whatever their absolute size, so a tidy project always reports
"megaclass" for something. On a legacy monolith the reverse holds — p50 may sit
above every published limit and a 400-line file reads as "small". A percentile
answers "large **for this project**"; nothing in the current pipeline answers
"large, full stop".

### Aggravating factor — the index is stale

`fileSymbolCount` covers 107 of 1695 files: the symbol-mass commit `fa7c30ae`
merged but no full reindex ran (bead `fy79n`). This narrows the sample further,
but it is not the root cause — D1 holds on a freshly built index too.

## Not shipped yet

`git tag --contains fa7c30ae` is empty; the latest tag `v1.36.0` predates the
commit. `classLines`, `memberCount` and `fileSymbolCount` have never reached a
published index. Every rename below is therefore a plain rename of an unreleased
field: no migration, no deprecation cycle, no `BREAKING CHANGE` footer. A full
reindex is still required, for the same reason the feature already required one.

## Design

### Signals after the change

| Signal            | Scope                   | Measures                            | Labels                       |
| ----------------- | ----------------------- | ----------------------------------- | ---------------------------- |
| `moduleLines`     | file (`dedupeByFile`)   | physical lines of the file          | small / large / god-module   |
| `fileMethodCount` | file (`dedupeByFile`)   | distinct callables declared in file | typical / busy / god-module  |
| `memberCount`     | container (1 per class) | direct members of the class         | typical / large / god-module |

`classLines` is renamed to `moduleLines` and re-pointed at the file. The class
span disappears as a signal; class mass is carried by `memberCount`, which is
what the industry limits anyway.

`memberCount`'s top label moves `god-class` → `god-module` so the vocabulary
stays on one unit. Three signals sharing a label name is fine — they are three
axes of the same verdict, and labels are already reused across signals
(`typical`, `low`, `high`).

### `moduleLines`

Physical line count, `code.split("\n").length`. Not SLOC: ESLint `max-lines`
counts physical lines by default, so the floors below are directly comparable,
and no second parse is needed.

`assignSymbolMass(chunks, code)` gains the source text and stamps the value on
every code chunk of the file, exactly as `fileMethodCount` is stamped. Keeping
the computation inside `symbol-mass.ts` holds the colocation rule: one place
populates all fields of the structure.

### `fileMethodCount`

Distinct folded `symbolId`s of chunks whose `chunkType` is `function`, `test` or
`test_setup`. A type-only file scores 0, which is the correct answer for a
god-module axis. The name follows house convention (`memberCount`,
`commitCount`, `blameContributorCount`) — singular noun plus `Count`; "method"
already covers top-level functions elsewhere in the project (`methodLines`,
`methodDensity`, the `god-method` label).

`SymbolCountSignal` (`static/rerank/derived-signals/symbol-count.ts`) keeps its
derived-signal name `symbolCount` — the weight key is preset-facing API and no
preset's meaning changes — but reads `fileMethodCount` and updates its prose.

### `memberCount` selection fix

`indexClasses` stops reading `chunkType`. A class is indexed from any chunk that
declares it as a parent: `parentSymbolId` present, and `parentType` containing
`class`, `module` or `struct`. That is the same language-independent test
`getChunkType()` already applies to node types, so Ruby modules, Go structs and
TS/Java/Python classes are all covered without per-language knowledge.

The value is stamped on the class's **representative chunk** — the one with the
lowest `startLine`. One class contributes exactly one value, so the percentile
is correct with no deduplication, and `chunkTypeFilter: "class"` leaves the
descriptor: the value exists only where it was stamped.

Alternative considered and rejected: stamp every chunk of the class and widen
`dedupeByFile` into `dedupeBy: "file" | "container"`. It needs a new
`containerSymbolId` payload field purely to key the dedup, and buys only that
`memberCount` is visible on any chunk of the class rather than the first.

### Floors

A floor is the smallest value a label may resolve at, regardless of what the
percentile says:

```
threshold(label) = max(percentile(label), floor(label))
```

Monotonicity is preserved automatically — percentiles are monotone by
construction and the floors are declared monotone, so an element-wise max of two
monotone sequences is monotone.

Floors apply to **source scope only**. Test files are systematically longer than
production code and the industry excludes them (RuboCop `Metrics/ModuleLength`
and `Metrics/BlockLength` ship with `Exclude: spec/**`, ESLint `max-lines` is
routinely disabled for tests). Under a shared floor most test files would
collapse into the top label and size-ranking of tests would stop working.
Test-scope labels stay purely percentile-derived, which still answers the useful
question: which test is anomalous **among tests**.

#### Where floors live

Per language, in `domains/language/<lang>/signal-floors.ts`, aggregated by
`LanguageFactory.signalFloors()` — the same shape as the existing
`capabilities()` aggregator: it imports one const per language and never
constructs a provider, so no grammar or Parser is loaded.

`signalFloors()` joins `create()` and `supported()` on the
`LanguageFactoryDescriptor` contract, which makes the method mandatory for any
factory. A drift-guard test asserts every native language appears in the map, so
a new language cannot be added without a deliberate decision about its floors —
`markdown` declares `{}` explicitly rather than by omission.

Languages with no `domains/language/` module (`sql`, `json`, `yaml` on the
character chunker) contribute no floors and keep pure percentile labels.

Floors do **not** go in `capability.ts`: that descriptor generates
`language-compatibility.md` and the README block under
`.claude/rules/language-capability-sync.md`, and it is scoped to capability
tiers.

#### Values

| Language               | `moduleLines` large / god-module | `memberCount` large / god-module | `fileMethodCount` busy / god-module |
| ---------------------- | -------------------------------- | -------------------------------- | ----------------------------------- |
| typescript, javascript | 300 / 600                        | 10 / 20                          | 15 / 30                             |
| ruby                   | 100 / 250                        | 10 / 20                          | 12 / 25                             |
| python                 | 500 / 1000                       | 20 / 30                          | 20 / 35                             |
| java                   | 750 / 1500                       | 20 / 35                          | 20 / 35                             |
| go                     | 500 / 1000                       | 15 / 30                          | 15 / 30                             |
| rust                   | 500 / 1000                       | 15 / 30                          | 15 / 30                             |
| bash                   | 300 / 600                        | —                                | 15 / 30                             |
| markdown               | `{}`                             | `{}`                             | `{}`                                |

Anchors: ESLint `max-lines` 300 · RuboCop `Metrics/ClassLength` and
`Metrics/ModuleLength` 100 · pylint `max-module-lines` 1000 and
`too-many-public-methods` 20 · Sonar java S104 750 and S1448 35 methods · PMD
`TooManyMethods` 10.

Go and Rust publish no module-level limit (clippy `too_many_lines` 100 and
golangci `funlen` 60 both bound functions), so they sit between TypeScript and
Java.

`fileMethodCount` is the one row without a direct anchor — every published limit
counts methods per **class**, not per file. The values take the class limit with
headroom for a file holding a few classes. They are calibration, not citation,
and should be re-checked against the distribution after the first full reindex.

`methodLines` gets no floors in this change. Its current
`small ≤10 / large ≤36 / decomposition_candidate ≤175` is already plausible, and
the mechanism stays open for it.

#### Where floors are applied

Both consumers of percentile thresholds read `SignalStats.percentiles` directly:

- `Reranker` (`domains/explore/reranker.ts:629`) passes them to `resolveLabel`
  for the ranking overlay.
- `IndexMetricsQuery#buildSignalMetrics`
  (`domains/explore/queries/index-metrics.ts:62`) reads them to build the
  `labelMap` that `get_index_metrics` and prime render.

A single pure function in `domains/explore/` —
`applySignalFloors(percentiles, labels, floors)` → `Record<number, number>` —
raises each percentile whose label declares a floor, and both call sites wrap
their `percentiles` through it. Each already knows the language and the scope it
is resolving for, which is all the function needs to be applied conditionally.

Stats in the cache stay raw. A floor is domain knowledge, not distribution math
— the project's Stats/Metrics split puts it on the Metrics side. The practical
consequence is that changing a floor takes effect on the next query with no
stats recompute and no reindex.

`appendGlobalSignalsIfPolyglot` builds a language-less "global" bucket; floors
are per-language, so that bucket keeps raw percentiles.

The `SignalFloors` type lives in `contracts/types/trajectory.ts` beside
`PayloadSignalDescriptor`; `contracts/types/language.ts` imports it for the
factory signature. `domains/explore/` never imports `domains/language/` —
composition root passes the map through, as it already does for descriptors and
presets.

## Blast radius

| File                                            | Change                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `chunker/symbol-mass.ts`                        | `moduleLines` + `fileMethodCount` computation, container indexing |
| `chunker/tree-sitter.ts`                        | untouched — `getChunkType` stays as is                            |
| `ingest/pipeline/file-processor.ts`             | pass `code`, stamp renamed fields                                 |
| `core/types.ts`                                 | `CodeChunk.metadata` field renames                                |
| `trajectory/static/payload-signals.ts`          | descriptors: rename, labels, drop `chunkTypeFilter`               |
| `trajectory/static/provider.ts`                 | payload writes                                                    |
| `static/rerank/derived-signals/symbol-count.ts` | reads `fileMethodCount`                                           |
| `static/rerank/presets/god-module.ts`           | overlay mask                                                      |
| `composite/presets/god-module.ts`               | overlay mask                                                      |
| `contracts/types/trajectory.ts`                 | `SignalFloors`                                                    |
| `contracts/types/language.ts`                   | `LanguageFactoryDescriptor.signalFloors()`                        |
| `domains/language/<lang>/signal-floors.ts`      | new, 9 files                                                      |
| `domains/language/factory.ts`                   | `signalFloors()` aggregator                                       |
| `domains/explore/signal-floors.ts`              | new — `applySignalFloors`                                         |
| `domains/explore/reranker.ts`                   | floors injection + apply                                          |
| `domains/explore/queries/index-metrics.ts`      | floors injection + apply                                          |
| `api/internal/composition.ts`                   | wire floors into explore                                          |

## Testing

Red-first per `.claude/rules/test-invariants.md`, since every item below is an
intentional invariant change.

1. **Selection** — a TS class whose chunks come from the body-chunker (no
   `chunkType: "class"` anywhere) yields `memberCount` on exactly one chunk, the
   lowest-`startLine` one. This is the D1 regression test and must fail against
   today's `symbol-mass.ts`.
2. **Counting** — a file of only interfaces and type aliases scores
   `fileMethodCount: 0`; a class with N methods scores N, not N+1.
3. **`moduleLines`** — equals the file's physical line count, stamped on every
   code chunk, absent from documentation chunks.
4. **Floors** — `max` semantics both ways (percentile wins above the floor,
   floor wins below it); untouched for test scope; untouched for a language with
   no floors; monotonicity preserved.
5. **Factory** — `signalFloors()` covers every language in `supported()` (drift
   guard).
6. **Renames** — existing symbol-mass and preset tests move to the new field
   names; the examples themselves are preserved per
   `.claude/rules/domains-language.md` §3.

## Rollout

Payload shape changes, so schema drift fires and a full reindex is required —
already pending as `fy79n`. Sequence: build + `npm link` in the worktree,
reconnect MCP,
`tea-rags index-codebase --project tea-rags --wait-enrichments --force --json`,
then read `prime` and check the three signals report plausible thresholds.
`fileMethodCount` floors get re-checked against the observed distribution at
that point.
