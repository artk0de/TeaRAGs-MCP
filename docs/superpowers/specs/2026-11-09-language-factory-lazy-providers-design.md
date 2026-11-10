# LanguageFactory lazy provider registry — design

- Date: 2026-11-09
- Bead: tea-rags-mcp-zkd96
- Status: implemented
- Supersedes: none (extends
  `2026-05-25-domains-language-consolidation-design.md` §1/§2)

## Problem

`LanguageFactory#build` held a native switch over per-language classes,
statically imported from each vertical's `index.ts` facade. That made
`factory.ts` the root of a static import closure over EVERY language's
resolver/walker chain, and `factory.ts` is (transitively) imported by the
chunker, the pipeline, codegraph and the composition root. Consequence:
`vitest related` on any resolver file — e.g.
`python/resolver/dispatch/python-dispatch-gates.ts` — selected every integration
test that boots the pipeline. Measured on main 89f59fb4b: 547 test files / 6573
tests / 137s for a two-gate-file edit (grew from 355/4048/111s when the bead was
opened).

## Direction (fixed by the bead)

Reach per-language resolver/walker implementations through a lazy,
module-path-based registration — the same precedent as worker-thread DI via
injected module path (`.claude/rules/domains-language.md` §2) — while capability
descriptors stay statically readable (gen:lang-compat, versions).

## Design

### What stays static

`capability/native.ts` (per-language `capability.ts` consts) and the
`<lang>/signal-floors.ts` consts. Both are const-only modules with no
resolver/walker reach: `supported()`, `capabilities()` and `signalFloors()` need
no preload and stay synchronous.

### What goes lazy

`src/core/domains/language/provider-sources.ts` (new) owns:

- `NATIVE_LANGUAGES` (moved verbatim from `factory.ts`);
- `ProviderConstructionDeps` — the six construction arguments the factory
  threads (ambiguousResolveMode, repoRoot, crossRunParseCache,
  manifestFilesReader, rustExternalSignatureSources, rustcCallSiteSource);
- `providerSources: ReadonlyMap<string, ProviderSource>` where each source
  `await import()`s its vertical's facade **with a dynamic import and a literal
  specifier** and returns a SYNC `ProviderBuilder` bound to the deps.

Dynamic `import()` is invisible to the static import graph vitest `related`
walks — that invisibility IS the fix. Rule §1 still holds: construction stays
encapsulated in the factory (the registry is domain-internal, not a
consumer-assembled container).

### Factory contract

- `preload(langs?)` — loads sources (default: every supported language),
  idempotent, concurrent calls deduped; unknown languages are skipped (`create`
  reports them).
- `static preloaded(options?)` — construct + preload-everything in one await;
  the ergonomic form for direct constructions in tests and scripts.
- `create(lang)` — UNCHANGED signature, still synchronous, still grammar-checks
  and caches. New failure mode: a supported language whose module is not loaded
  throws `LanguageModuleNotPreloadedError` (`LANGUAGE_MODULE_NOT_PRELOADED`,
  message names the preload remediation). Unknown languages keep throwing
  `UnsupportedLanguageError`.
- `LanguageFactoryDescriptor` (contracts) gains OPTIONAL
  `preload?: (langs?) => Promise<void>` — optional so test doubles need not
  carry it; consumers call it as `await factory.preload?.()`.

### Production seams (who preloads)

| Seam                | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composition root    | `createComposition` is now `async` and `await languageFactory.preload()`s before wiring the codegraph trajectory (its provider constructor eagerly `create()`s all languages via the `collect*` helpers). Bootstrap `wireComposition`/`createIngestSection`/`createIngestFacade` and the two per-project seams (`ProjectIngestFactory.forPath`, `AppDeps.ingestForPath`, `ExploreOps.enrichmentHealthFrameForPath`) became async/awaiting accordingly. |
| Chunker worker init | `chunker/infra/worker.ts` `buildChunker` preloads after in-thread construction.                                                                                                                                                                                                                                                                                                                                                                        |
| Codegraph runtime   | `trajectory/codegraph/factory.ts` `createCodegraphProviderRuntime` preloads after in-thread construction.                                                                                                                                                                                                                                                                                                                                              |
| Migration parser    | `api/internal/migration-parser.ts` preloads exactly `["ruby"]`.                                                                                                                                                                                                                                                                                                                                                                                        |

Workers keep constructing their own factory in-thread via the injected
`languageModulePath` (unchanged); they preload it immediately.

### Facade

`language/index.ts` no longer re-exports `RubyLanguage`, `TypeScriptLanguage`,
`MarkdownLanguage`, `YamlLanguage` — nothing outside the domain imported them,
and a facade re-export is a static import of the whole vertical.
`chunkRailsMigration` / `foldRailsTableMigrations` stay: the ruby
chunking/schema subtrees import no resolver code. `providerSources` is exported
for tests that assert registry/set consistency.

### Tests and scripts

`new LanguageFactory()` + sync `create()` no longer works without a preload.
Established shapes (codemod + manual fixes):

- inside an async test: `const factory = await LanguageFactory.preloaded();`
- at describe scope: `const factory = new LanguageFactory();` +
  `beforeAll(async () => { await factory.preload(); });`
- statics-only usages (`supported()` / `capabilities()` / `signalFloors()`):
  plain `new LanguageFactory()`, unchanged.

Test examples (describe/it bodies, assertions, fixtures) are untouched — only
construction/await plumbing adapted (rules doc §3).

## Acceptance evidence

Measured on the branch (see the bead for numbers):

1. `vitest related` on the two gate files selects only language-local tests (was
   547 files / 6573 tests / 137s).
2. Full suite + coverage green.
3. Codegraph harness edge dumps byte-identical on the substrate corpora
   (construction semantics unchanged — same classes, same args, same order).

## Alternatives rejected

- **Async `create()`** — would ripple through every consumer call site and
  hundreds of test expressions for no locality gain beyond preload.
- **Top-level-await eager registry in the factory module** — re-eager-loads all
  14 verticals (TS compiler, 2.3MB Swift vocabulary) in every process,
  regressing bbo1h.2/.3.
- **`require(esm)` for sync lazy loading** — breaks under vitest's transform
  (`.js` specifiers map to `.ts` sources only for static/dynamic import).
- **Deferred resolver construction inside each provider** — pushes the same
  problem into 14 verticals with far larger behavioral risk.
