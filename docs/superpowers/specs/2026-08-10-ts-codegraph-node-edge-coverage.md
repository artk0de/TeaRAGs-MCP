# TS codegraph node/edge coverage

Status: in progress (brainstorming for a typeChecker-based TS resolver, not yet
a finalized design). Tracks every syntax construct that should produce a
codegraph node or edge for TypeScript, against what the current resolver
(`src/core/domains/language/typescript/resolver/`) already handles.

## Why this doc exists

Ruby's resolver (`src/core/domains/language/ruby/resolver/`) is statistically
complete: ~30 `SymbolResolutionStrategy` classes + a `walker/type-sources/`
layer (YARD, AST inference, AR associations) + a DSL/framework grammar layer
(`ruby/dsl/`) + a 15896-line forensics harness
(`scripts/taxdome-codegraph-recall-forensics.ts`).

TS today: 10 strategy classes under `TSCallResolver`
(`src/core/domains/language/typescript/resolver/ts-resolver.ts`) plus tsconfig
path mapping. No type-source layer, no DSL layer (not needed — TS has no
implicit macro-DSL convention the way Rails does; decorators are explicit typed
constructs the type checker already understands), no measurement harness.
`ts.createProgram`/`typeChecker` are not used anywhere — the resolver is pure
tree-sitter heuristics.

Decisions locked so far in the brainstorm:

- **Program strategy: lazy per-file isolated `ts.Program`.** Built only when the
  tree-sitter chain fails to resolve a receiver AND the receiver kind is one
  that structurally needs type information — not for the whole repo, not
  proactively for the whole file.
- **Oracle mode: typeChecker as ground truth for the fast path.** Scan real
  repos for patterns from the table below, compute the tree-sitter answer AND
  the typeChecker answer for the same call site, diff. Corner cases surface
  automatically instead of requiring hand-authored fixtures per hypothesis
  (Ruby's `runBareDeferOracle`/`runSingleSegOracle` pattern).

Existing type vocabulary this table maps onto: `ReceiverKind` (`constant` |
`localVar` | `selfMember` | `super` | `bareCall` | `ivar` | `chain` | `index` |
`dynamic`, `src/core/domains/trajectory/codegraph/symbols/receiver-kind.ts`),
`MethodEdgeKind` (`exact` | `cone` | `poly-base` | `dynamic` | `registry`,
`src/core/contracts/types/codegraph-graph.ts`), `GraphEdges` (`fileEdges`,
`methodEdges`, `inheritance`, `ambiguousFanouts`, same file).

## Status legend

| Symbol | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| ✅     | handled by the current tree-sitter walker/resolver, confirmed by a test           |
| ✅?    | probably handled, not confirmed by a dedicated test — verify before relying on it |
| ⬜     | gap, solvable without typeChecker — plain tree-sitter work                        |
| 🔶     | gap, needs typeChecker — no amount of AST pattern-matching gets this right        |

## A. File/module edges (`GraphEdges.fileEdges`)

| Syntax                                 | Status | Notes                                                                                 |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `import { X } from './y'`              | ✅     | named specifier capture (bd `2v16`)                                                   |
| `import type { X } from './y'`         | ✅     | type-only import filter (bd `m19a`)                                                   |
| `import X from './y'` (default)        | ✅?    | not pinned by a dedicated test                                                        |
| `import * as X from './y'` (namespace) | ⬜     | `X.foo()` member access needs the namespace binding threaded into receiver resolution |
| `export { X } from './y'` (re-export)  | ⬜     | transitive alias: file A re-exports B, importer of A needs to land on B               |
| `export * from './y'` (barrel)         | ⬜     | common `index.ts` pattern                                                             |
| `import('./y')` (dynamic)              | ⬜/🔶  | promise-typed; resolving the awaited value's type needs typeChecker                   |
| `require('./y')` (CJS interop)         | ⬜     | mixed ESM/CJS is common in real repos                                                 |
| tsconfig `paths`/`baseUrl` alias       | ✅     | `ts-path-mapper.ts` + `ts-config-loader.ts`                                           |
| triple-slash `/// <reference path>`    | ⬜     | rare, mostly legacy code                                                              |

## B. Call edges (`GraphEdges.methodEdges`, keyed by `ReceiverKind`)

| Syntax                                       | ReceiverKind     | Status                                                                                                                               |
| -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `foo()` bare call                            | `bareCall`       | ✅ (`TSGlobalShortNameSymbolResolutionStrategy`)                                                                                     |
| `this.foo()`                                 | `selfMember`     | ✅ (`TSThisMemberSymbolResolutionStrategy`)                                                                                          |
| `super.foo()` / `super()`                    | `super`          | ✅ (bd `3a84`)                                                                                                                       |
| `obj.foo()`, typed receiver                  | `chain`          | ✅? narrow cone via `TSFieldType`/`TSConeTypeLocator`                                                                                |
| `obj?.foo()` optional chaining               | `chain`          | ⬜ — verify the parser doesn't drop the edge on `?.`                                                                                 |
| `arr[i].foo()` computed member access        | `index`          | ⬜                                                                                                                                   |
| `obj['foo']()` computed call, string literal | —                | ⬜ — literal member name is resolvable without typeChecker                                                                           |
| `new ClassName()`                            | —                | ✅ (bd `i252`)                                                                                                                       |
| `` tag`template` `` tagged template          | —                | ⬜ — rare (styled-components etc.)                                                                                                   |
| method passed as value (`arr.map(this.foo)`) | —                | ⬜ — no Ruby analog either; nobody resolves this edge today                                                                          |
| `foo.call(obj, ...)` / `.apply` / `.bind`    | `dynamic`        | ⬜ — Ruby has a `dynamic` analog for `send`                                                                                          |
| generic call `foo<T>()`                      | —                | 🔶 — signature resolution depends on `T`                                                                                             |
| overloaded function call                     | —                | 🔶 — which of N signatures fires needs `getResolvedSignature`                                                                        |
| union-typed receiver `(a: A \| B).foo()`     | `chain`, fan-out | 🔶 — tree-sitter only ever sees one branch; typeChecker sees both, needs `cone`/`poly-base` fan-out like Ruby's CHA devirtualization |

## C. Receiver-type determination (feeds B, not an edge on its own)

| Mechanism                                                                | Status         | Needs typeChecker?                                |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------- |
| explicit param type annotation                                           | ✅ (bd `x6ta`) | no                                                |
| class field type annotation                                              | ✅ (bd `2yfi`) | no                                                |
| `const x: Foo = ...` explicit                                            | ✅?            | no                                                |
| `const x = new Foo()` inferred                                           | ✅?            | no — tree-sitter can do this                      |
| return-type inference via another call (`const x = makeFoo()`)           | ⬜             | 🔶 — or duplicate Ruby's body-last-expr heuristic |
| generic instantiation (`Container<Foo>`)                                 | ⬜             | 🔶                                                |
| structural/duck typing (`{ foo(): void }` type literal)                  | ⬜             | 🔶 — no nominal class name exists at all          |
| union narrowing after `typeof`/`instanceof`/discriminant                 | ⬜             | 🔶                                                |
| interface declaration merging (multiple `interface Foo {}` across files) | ⬜             | 🔶 — or a manual merge pass                       |
| conditional/mapped types                                                 | ⬜             | 🔶 — low priority, rarely call-site critical      |

## D. Inheritance edges (`GraphEdges.inheritance`)

| Syntax                                     | Status                                                          |
| ------------------------------------------ | --------------------------------------------------------------- |
| `class A extends B`                        | ✅ (bd `d29r`, `collectClassExtends`/`collectInheritanceEdges`) |
| `class A implements IFoo`                  | ⬜ — no body inheritance, but matters for structural dispatch   |
| `abstract class` / `abstract method`       | ⬜                                                              |
| mixin pattern (`class A extends Mixin(B)`) | ⬜ — analog of Ruby `include`                                   |
| declaration merging via namespace          | ⬜ — rare                                                       |

## E. TS-specific constructs, no Ruby analog

| Construct                                         | Category                         | Priority                                                                                                             |
| ------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Decorators (`@Injectable`, `@Controller`, custom) | metadata edge                    | medium — typeChecker already sees the decorator factory as an ordinary call; no DSL grammar layer needed (confirmed) |
| JSX (`<Foo prop={x} />`)                          | call edge (component resolution) | high for frontend repos — sugar over `React.createElement`, same mechanics as import-basename + type resolution      |
| Function overload signatures                      | signature resolution             | medium — pure typeChecker territory                                                                                  |
| Namespace/module merging (`namespace Foo {}` × N) | symbol merge                     | low — rare in modern code                                                                                            |

## Coverage summary

Of ~35 cases: **~12 already solved** by the current tree-sitter chain, **~10
solvable without typeChecker** (just not implemented — `require()`, re-export,
namespace import, computed access, `.call`/`.apply`, method-as-value), **~10
genuinely need typeChecker** (generics, overloads, union narrowing, structural
typing, interface merging, cross-call return-type inference).

typeChecker is a fallback for ~30% of cases, not a replacement for the resolver
— the design should add it as a narrow last-resort strategy in the existing
`SymbolResolutionStrategy` chain, not restructure the chain around it.

## Post-Wave-3 baseline (measured 2026-08-10, bd tea-rags-mcp-cko34)

Everything above this heading is the PRE-implementation picture and is kept as
the historical record. This section supersedes its numbers.

Measured on `main` @ `6c4cc7e0` (Waves 1–3 of `tea-rags-mcp-nl93h` merged: the
14-pass strategy chain, union dispatch resolver, builtin-receiver precision
guard, `.tsx`-aware import mapping). Corpus: this repo's own `src/`, the same
one every earlier oracle run used.

```bash
npx tsx scripts/ts-codegraph-typechecker-oracle.ts --json oracle.json
```

895 files, 14721 scored call sites, 6514 in-project checker answers, 5880
external checker answers, 57s.

### Raw versus decomposed

A raw mismatch count is an upper bound on defects, not a defect count. The
decomposition is now code (`decomposeOracleMismatches` and the three
`reconcileOracle*` reconcilers), so these numbers are reproducible rather than
re-derived by hand each time — which is what made the earlier runs impossible to
compare.

| Mismatch    | Raw  | Reconciled away                           | True defects |
| ----------- | ---- | ----------------------------------------- | ------------ |
| `wrongFile` | 709  | 636 interface-vs-impl                     | **73**       |
| `missed`    | 739  | 733 unpinned target, 2 anonymous callable | **4**        |
| `phantom`   | 3612 | 3508 both sides external                  | **104**      |

The three earlier headlines all reconcile against this, and none of them
contradicted each other — they were counting different things:

- Track C's "true resolver recall gap is 4 sites" reproduces EXACTLY: `missed`
  decomposes to 4 defects.
- `6b3gj`'s raw `missed 649 / wrongFile 707 over 6283` is this run's raw
  `739 / 709 over 6514`; the spread is corpus drift between the two commits, not
  a methodology difference.
- `6b3gj`'s phantom residual of 104 reproduces EXACTLY: of 3612 raw phantoms,
  exactly 104 are rows where the chain named project source.

### The whole recall gap is import aliasing

All 4 `missed` defects are a renamed binding — the call site uses a local alias
and the chain never reaches the declaration behind it:

| Call site                                           | Checker's answer                      |
| --------------------------------------------------- | ------------------------------------- |
| `ruby-table-dispatch.ts:120` `formMatches(…)`       | `shared.ts::symbolIdIsInstanceMethod` |
| `freshness-check.ts:61` `this.deps.readGitState(…)` | `repo-git-state.ts::readRepoGitState` |
| `git-log-reader.ts:40` `buildFileSignalMapImpl(…)`  | `file-reader.ts::buildFileSignalMap`  |
| `git-log-reader.ts:71` `buildChunkChurnMapImpl(…)`  | `chunk-reader.ts::buildChunkChurnMap` |

### `wrongFile` is dominated by declaration-versus-implementation

636 of 709 are the checker naming a `FunctionType` / `MethodSignature` on an
interface or abstract base while the chain named the concrete implementation of
that same member (`embeddings.getModel()` → chain `OllamaEmbeddings#getModel`,
checker `adapters/embeddings/base.ts::getModel`). Both sides identified the same
call; the graph deliberately prefers the implementation edge.

The 73 residual defects are one shape: a bare or short name over-matched to a
same-named symbol in an unrelated file — `getDaemonPaths` resolved to the Qdrant
daemon when the checker says the DuckDB one, `cleanup()` resolved to
`OnnxEmbeddings#cleanup` when the target is a local arrow function.

### `phantom` is mostly a naming defect in the harness, not in the resolver

`phantom` is documented as "the chain invented an IN-PROJECT edge for a call
that provably leaves the project", but `diffResolution` only checks that the
chain answered at all. The chain routinely answers with a `node_modules`
declaration — the same conclusion the checker reached — and every one of those
rows was being counted as a fabricated edge.

Of 3612 raw phantoms, **3508 have the chain naming the exact same external file
the checker named**, and zero name a different external file. The remaining 104
are the real precision surface:

| Bucket                                    | Count | Verdict                                       |
| ----------------------------------------- | ----- | --------------------------------------------- |
| default-lib member (`set`, `has`, `push`) | 91    | fabricated                                    |
| external package, concrete declaration    | 2     | fabricated                                    |
| external package, interface declaration   | 11    | 8 fabricated, 3 arguable on manual inspection |

The 91 default-lib rows are Track C's original finding intact: builtin members
matched by bare short name (`set` 36, `has` 11, `test` 10, `push` 7, `map` 6).
The 3 arguable rows are `MaterializedNode#childForFieldName` / `#child`, where
the project's own mirror of the tree-sitter node type may genuinely be the
runtime receiver.

Raw phantom rose from Track C's 1341 to 3612 BECAUSE the typeChecker strategies
landed: the chain can now answer external calls correctly, and the harness
misfiles each correct external answer as a fabricated edge. A rising raw phantom
count was evidence of the epic working.

### `structuralTyping` precision: 63.2% raw, 1.7% real

`pmxuv` reported `structuralTyping` at 1344 phantom / 5592 external (24.0%).
That number is the RAW phantom rate, undecomposed — and it does not survive
decomposition:

| Measure                           | Value                |
| --------------------------------- | -------------------- |
| raw phantom / external (this run) | 3443 / 5445 = 63.2%  |
| both sides external (agreement)   | 3346                 |
| arguable external-interface match | 4                    |
| **fabricated edges**              | **93 / 5445 = 1.7%** |

A dedicated `structuralTyping` precision fix is not warranted at the scale
`pmxuv` reported. The residual 93 are not a structural-typing defect at all —
they are bare short-name matching against default-lib members, which is a
different fix in a different strategy.

### Known harness limits, unchanged by this run

- `checkerExternalNonSource` cannot do the job it was written for. `toRelPath`
  returns a relative path for anything under the repo root, and `node_modules`
  is under the repo root, so every package `.d.ts` counts as "non-source
  in-repo" — 5880 of 5880 on this run. The `origin` field on `OracleTargetFacts`
  is the working version of that probe.
- The corpus has no `.tsx`, so `jsx` gets no signal here.
- `unionNarrowing` reaches 8 call sites total; its rates are noise.
