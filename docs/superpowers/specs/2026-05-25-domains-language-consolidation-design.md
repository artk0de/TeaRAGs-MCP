# `domains/language` — Per-Language Code Consolidation

**Date:** 2026-05-25
**Status:** Design — pending implementation plan
**Scope:** Full consolidation, all supported languages

## Problem

Language-specific code is spread across **three** locations in **two** domains.
For a single language (Ruby shown), the per-language code lives in:

| Concern               | Current location                                                                 | Pipeline phase      |
| --------------------- | -------------------------------------------------------------------------------- | ------------------- |
| Chunking hooks + AST config | `domains/ingest/pipeline/chunker/hooks/ruby/**` + `LanguageDefinition` in `chunker/config.ts` | ingest              |
| Symbol walker         | `domains/ingest/pipeline/chunker/extraction/ruby-walker.ts` + `ruby-macros.ts`   | codegraph (!)       |
| Call resolver         | `domains/trajectory/codegraph/symbols/resolvers/ruby/**` + `LanguageConfig` in `symbols/provider.ts` | codegraph           |

Two concrete smells, confirmed by tea-rags signals:

1. **Cross-domain coupling.** `codegraph/symbols/provider.ts` imports every
   `*-walker.ts` from the ingest domain via `../../../ingest/...`. The provider
   is `fanOut 15`, `instability 0.94`. The walker is a codegraph-extraction
   concern that physically lives in `ingest/chunker/`.
2. **Duplicated per-language config.** `scopeSeparator` and
   `disambiguateOverloads` are declared **twice** for the same language — once in
   `LanguageDefinition` (chunker) and once in `LanguageConfig` (codegraph). Two
   sources of truth for one language's properties.

Adding a new language today means touching two domains, ~3 directories, and two
registries.

## Goal

A new leaf domain `domains/language` collects all language-specific code. Adding
a language = adding one folder under a single common interface, registered in
one place. Consumers (ingest chunker, codegraph provider) pull the capability
they need.

## Design

### 1. Interface: thin facade composing named capabilities

`LanguageProvider` is a per-language facade (~50 lines, delegation only). It
composes four sub-modules kept as small focused files:

```text
LanguageProvider (facade per language)
├── kernel: LanguageKernel              // parser load, node types, scopeSeparator, scopeContainerTypes,
│                                        //   disambiguateOverloads, isInstanceMethod(node) → bool  (DETECTION — language's job)
├── chunkerHooks: LanguageChunkerHooks  // chunkableTypes, childChunkTypes, alwaysExtractChildren, isDocumentation, hooks,
│                                        //   nameExtractor, keepShortChildChunkTypes
├── walker: LanguageWalker              // walk(input) → FileExtraction, nameOf(node) → NamedSymbol
└── resolver: LanguageSymbolResolver    // resolveCall(site) → target, path mapping (zeitwerk, ts-config, python-path)
```

`kernel` is shared by the capabilities of one language. It removes the
duplicated `scopeSeparator` / `disambiguateOverloads` (declared once) and owns
the per-language **detection** (`isInstanceMethod(node)`) that BOTH the chunker
and the walker need — `symbolid-convention.md` mandates a single detection
powering both.

symbolId **formatting** is a separate, **cross-language** concern: a shared
`composeSymbolId(scopeStack, localName, { instanceMethod, scopeSeparator })`
applies the project rule (`#` instance / `.` class / `::`|`.` namespace / `~N`
overload). It is a **dumb mapper** — it never inspects an AST node. Two clean
responsibilities: **the language decides** (detects instance-vs-class, supplies
`scopeSeparator`) **and the mapper formats** (receives the explicit
`instanceMethod` flag, emits the string).

### 1a. symbolId convergence (the root invariant)

The chunker (`nameExtractor`) and the walker (`nameOf`) pursue **different
goals** — the chunker needs the right method/class symbol as a **chunk
boundary**; the walker/resolver need a **symbolId** for callees/callers. But
both MUST converge on the **same symbolId**, which physically lives in some
chunk. Otherwise codegraph edges point at symbolIds that have no chunk, and
`find_symbol` / `callees` / `callers` break.

Today the two paths keep that construction synchronized **by hand** through two
parallel configs — this is the root cause of symbolId divergence (bd
`tea-rags-mcp-bdvm`, why `scopeContainerTypes` and a duplicated
`disambiguateOverloads` exist). The unification has two pieces:

1. The per-language **detection** (`isInstanceMethod` + `nameOf`'s
   `instanceMethod` flag) is defined ONCE in the language's kernel and reused by
   both that language's chunker and walker.
2. The **format mapper** `composeSymbolId` is ONE cross-language function both
   call (replacing today's `tree-sitter.ts:buildSymbolId` and
   `provider.ts:joinSymbol`).

So within a language the detection cannot drift between chunker and walker, and
across languages the format cannot drift. Detection stays language-owned; only
the format is shared.

Two legitimate divergences that do not break the model:

1. **`#partN`.** The chunker splits an oversized method (`enforceMaxChunkSize`)
   and appends `#part1`/`#part2` on top of the base symbolId. This is a
   chunk-only artifact the walker never sees → `composeSymbolId` yields the
   **base** symbolId; the `#partN` suffix stays in the chunker engine.
2. **Doc languages.** Markdown chunks use `doc:<hash>` ids with no codegraph
   symbols → a doc language has `chunkerHooks` but no `walker`/`resolver`
   (capabilities are optional per language).

See `.claude/rules/symbolid-convention.md` for the full `#` vs `scopeSeparator`
table that `composeSymbolId` must implement.

A `LanguageProvider` is a **per-context instance** created by
`LanguageFactory.create(lang)` — it owns a fresh tree-sitter `Parser` (parsers
are stateful and per-thread; see §5). The capability **logic and config**
(`composeSymbolId`, node-type tables, `scopeSeparator`, hook definitions)
are pure, module-level immutables that instances merely reference — the cost of
an instance is the Parser, not the logic. Within a context the `chunk()`
(ingest) and `walk()`/`resolve()` (codegraph) capabilities share no mutable
state with each other beyond that Parser, so a phase calls only the capability
it needs.

### 2. Dependency direction

`domain-boundaries.md` forbids domain↔domain imports (`ingest -x-> trajectory`,
etc.). The current `codegraph/provider.ts → ingest/.../walker.js` import is
therefore already a **hard violation**, not just a smell. So consumers must NOT
import `domains/language/` directly — they go through the `contracts/` interface
+ DI, exactly the existing `EnrichmentProvider` / `TrajectoryRegistry` pattern.

```text
contracts/  (interfaces: LanguageProvider, LanguageFactory, LanguageKernel,
             LanguageChunkerHooks, LanguageWalker, LanguageSymbolResolver
             + reused FileExtraction, NamedSymbol, ChunkExtraction)
     ↑                  ↑                          ↑
domains/language/   ingest/chunker            codegraph/symbols
(concrete impls)    (iface + injected          (iface + injected
                     LanguageFactory)            LanguageFactory)
```

- `domains/language/` imports only `contracts/` (+ `infra/`, tree-sitter npm).
  No back-imports — it is a leaf domain.
- `ingest` and `codegraph` import the **interface** from `contracts/` and
  receive the concrete `LanguageFactory` via **DI** from `api/composition.ts`.
  They never import `domains/language/`.
- The lone direct importer of `domains/language/` concrete is the chunker
  **worker** entry — a second composition root (see §5).

### 3. What moves, what stays

Phase-orchestrator **engines stay** in their domains and consume capabilities
through the injected `LanguageFactory`. Only per-language **descriptors move**.

| Stays (phase engine)                                                              | Moves to `domains/language/<lang>/`                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ingest/chunker/tree-sitter.ts`, `base.ts`, `infra/pool.ts`, `infra/worker.ts`    | `chunker/hooks/<lang>/**` → `chunking.ts`                            |
| `codegraph/symbols/provider.ts` (`CodegraphEnrichmentProvider`)                   | `chunker/extraction/<lang>-walker.ts` + `ruby-macros.ts` → `symbols.ts` |
| `codegraph/infra/` (page-rank, tarjan), `symbols/payload-signals.ts`, presets     | `codegraph/symbols/resolvers/<lang>/**` → `resolver.ts`             |

`tree-sitter.ts` and `provider.ts` are hotspot/deep-silo files. They are **not
rewritten** — they swap their source of config from a local map to the injected
`LanguageFactory.create(lang)`.

**One exception beyond "swap the config source":** symbolId composition. Today
the symbolId-building logic is smeared — partly in the chunker engine
(`tree-sitter.ts` `processChildren` assembles `parentSymbolId` from the scope
stack) and partly in the walkers. Per §1a the **format mapping** moves into the
shared cross-language `composeSymbolId`, and the per-language **detection** into
the language's kernel. So the engines keep orchestrating, but symbolId
formatting is **extracted** to one shared mapper called by both `nameExtractor`
and `nameOf` — this is logic relocation, slightly more than a config swap, and
the migration plan must treat it as a behavior-preserving extraction (tests stay
green).

### 4. Target structure

A capability is a **sub-folder with a barrel**, not necessarily a single file —
the facade stays thin, but capability internals split as needed (Ruby `chunking`
aggregates 4 current files; TS `resolver` aggregates resolver + path-mapper +
config-loader). Capabilities are **optional** per language: a doc language
(markdown) has only `chunking` and no `symbols`/`resolver`.

```text
contracts/types/language.ts   // INTERFACES: LanguageProvider, LanguageFactory, LanguageKernel,
                              //   LanguageChunkerHooks, LanguageWalker, LanguageSymbolResolver

domains/language/
  factory.ts                  // LanguageFactory.create(lang) → fresh LanguageProvider (+ own Parser); supported(): string[]
  index.ts                    // barrel
  shared/                     // cross-language helpers
    symbol-id.ts              //   composeSymbolId (replaces buildSymbolId + joinSymbol) — dumb mapper, no AST
    index.ts                  //   + resolver base, walker helpers
  typescript/
    index.ts                  // class TypeScriptLanguage implements LanguageProvider (thin facade) + barrel
    kernel.ts
    chunking/                 // index.ts barrel + test-scope-chunker, comment-capture, class-body-chunker, ...
    symbols/                  // index.ts barrel + typescript-walker, nameOf
    resolver/                 // index.ts barrel + ts-resolver, ts-path-mapper, ts-config-loader
  ruby/
    index.ts                  // facade + barrel
    kernel.ts
    chunking/                 // class-body-chunker, comment-capture, rspec-scope-chunker, rspec-filter
    symbols/                  // ruby-walker + ruby-macros
    resolver/                 // ruby-resolver + zeitwerk
  markdown/
    index.ts                  // facade + barrel (chunking only — partial provider)
    chunking/                 // markdown chunker
  python/ ... go/ ... java/ ... rust/ ... bash/ ... javascript/
```

Single-file capabilities collapse to `chunking.ts` instead of `chunking/` when a
language needs only one file (e.g. `go/resolver.ts`) — the barrel rule applies
only once a capability has multiple files (consistent with
`.claude/rules/barrel-files.md`).

### 5. Wiring

`LanguageFactory.create(lang)` **spawns a fresh `LanguageProvider` instance**
(with its own tree-sitter `Parser`) — it does not return a shared singleton.
This is the parallelism foundation: tree-sitter parsers are stateful and
per-thread (`worker.ts`: "each worker thread creates its own Parser instances"),
so each execution context creates its own instances and nothing is shared across
threads. The pure core (`composeSymbolId`, config tables) is module-level and
shared as immutable data. `create` replaces both current maps
(`LanguageDefinition` in the chunker + `LanguageConfig` in the codegraph
provider).

The factory has **two composition roots**, because a worker thread cannot
receive the main process's DI graph (functions / native handles are not
structured-cloneable across `postMessage`):

- **Main process** — `api/composition.ts` constructs the concrete
  `LanguageFactory` and injects it (as the `contracts/` interface) into
  `IngestFacade` and the codegraph provider. Same pattern as `TrajectoryRegistry`.
- **Chunker worker** — `chunker/infra/worker.ts` is the second composition root:
  it imports the concrete factory module directly and calls `create(lang)` once
  per language, caching the instance for its single-threaded message loop
  (mirrors today's "create the chunker once per worker").

Why `create(lang)` and not constructor-inject a single provider: `lang` is a
**runtime discriminator** (a file's language is known only when processing it),
so there is no single provider to inject — it is a keyed family resolved at call
time. That is legitimate keyed resolution, not a service-locator anti-pattern,
because the factory itself is injected rather than reached from a global.

## Constraints & Risks

- **No god-module.** Sub-modules stay small focused files; the facade is thin;
  the factory is one module. A language folder is a set of small files, not one
  800-line class.
- **Silo/hotspot migration.** `provider.ts`, `tree-sitter.ts`,
  `contracts/types/codegraph.ts` are deep-silo/hotspot. Migrate one language at a
  time; engines are not rewritten. Each language move keeps the per-concern files
  intact (relocated, not flattened).
- **Worker boundary / parallelism.** `LanguageFactory.create(lang)` spawns a
  fresh instance with its own Parser; instances are NEVER shared by reference
  across threads (tree-sitter parsers are per-thread). The worker is a second
  composition root — it imports the concrete factory directly; main injects it
  via DI. Do NOT "simplify" this into one shared provider object.
- **Domain boundaries.** Interfaces live in `contracts/`; `ingest`/`codegraph`
  import only the interface and receive the factory via DI — they MUST NOT import
  `domains/language/` directly (that would re-introduce the domain↔domain
  violation per `domain-boundaries.md`). Only the worker root imports the
  concrete factory.
- **Factory cost / caching.** `create(lang)` is **expensive** — it loads the
  tree-sitter grammar and builds a Parser. Callers MUST cache the instance per
  language within their context (the worker keeps one per language for its
  message loop); do NOT call `create()` per file. The pure core is shared, so
  only the Parser is the cost — but it is a real one.
- **TDD.** Existing chunker/codegraph tests are the behavioral contract. After a
  language move, imports update but logic does not — the tests must stay green
  (business-logic tests are immutable per `.claude/rules/test-patterns.md`).

## Migration order (for the plan)

0. **Dependency guard first.** Add a depcruise/eslint rule BEFORE moving any
   code: `domains/language/` must not import `ingest`/`codegraph`, and
   `ingest`/`codegraph` must not import `domains/language/` (only `api/` and the
   worker root may). This is *adding* a rule, not weakening one (per
   `linter-config.md`), so every later step trips the guard immediately on a
   wrong-direction import.
1. **Skeleton:** interfaces in `contracts/types/language.ts` + `LanguageFactory`
   in `domains/language/factory.ts` + shared `composeSymbolId` in
   `domains/language/shared/symbol-id.ts` (unify `tree-sitter.ts:buildSymbolId`
   and `provider.ts:joinSymbol`) + per-language detection in each kernel; remove
   the duplicated `scopeSeparator` / `disambiguateOverloads`.
2. **Per-language verticals**, richest first (Ruby: hooks + macros + zeitwerk),
   then the rest by the same template: ts, javascript, python, go, java, rust,
   bash, markdown.
3. **Cut the cross-domain import:** inject `LanguageFactory` into
   `codegraph/provider.ts` instead of importing
   `../../../ingest/.../extraction/*-walker.js` — this clears the
   `domain-boundaries.md` violation.
4. **Delete** the emptied `chunker/extraction/`, `chunker/hooks/<lang>/`,
   `codegraph/symbols/resolvers/<lang>/`, and the two old config maps.

## Out of scope

- Rewriting the chunker engine (`tree-sitter.ts`) or the codegraph engine
  (`provider.ts`) internals beyond swapping the config source.
- Changes to payload schema, signals, or rerank presets.
- Adding new languages (this is a relocation, not a feature add).
- **Changing the symbolId format.** `composeSymbolId` unifies two existing
  implementations (`buildSymbolId` + `joinSymbol`) but the id shape — `#`
  instance / `.` class / `::`|`.` namespace / `~N` overload from
  `symbolid-convention.md` — does NOT change. Behavior-preserving extraction, not
  a convention redesign.
