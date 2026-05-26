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
                                         //   internally an ordered chain of ResolverComponents — see §1b
```

`kernel` is shared by the capabilities of one language. It removes the
duplicated `scopeSeparator` / `disambiguateOverloads` (declared once) and owns
the per-language **detection** (`isInstanceMethod(node)`) that BOTH the chunker
and the walker need — `symbolid-convention.md` mandates a single detection
powering both.

symbolId **formatting** is a separate, **cross-language** concern: an injected
`SymbolIdComposer.compose(prefix, localName, { methodKind, scopeSeparator, absolute })`
applies the project rule (`#` instance / `.` class / `::`|`.` namespace). It is
a **dumb mapper** — it never inspects an AST node. Two clean responsibilities:
**the language decides** (detects instance-vs-class, supplies `scopeSeparator`)
**and the mapper formats** (receives the explicit `methodKind` flag, emits the
string). The interface lives in `contracts/`; the default implementation in
`domains/language/kernel/symbol-id.ts`. Crucially it is **injected via
`api/internal/` DI into EVERY symbolId-building consumer** — the chunker engine,
the chunker hooks, the codegraph provider, the resolvers — replacing the 5+
duplicated `buildSymbolId` / `joinSymbol` / manual-`#`-join sites that today can
drift from the convention independently. `~N` overload disambiguation stays in
the chunker engine (it depends on chunk-collision state, not on the mapper).

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

### 1b. Resolver internals: a chain of `ResolverComponent`s

`LanguageSymbolResolver.resolveCall` is NOT a monolith. Today `ts-resolver.ts`
packs **seven independent resolution approaches** into one `resolve()` body (a
fall-through if-ladder) plus a separate fan-out path. Each approach answers one
question — "can I resolve this call my way?" — and either returns a target or
defers. So each approach becomes a small **component** behind one interface —
`ResolverComponent`, declared in `contracts/types/language.ts` per
`domain-boundaries.md` (interfaces live in `contracts/`) — and the language
resolver is the ordered **chain** that runs them first-hit-wins:

```ts
interface ResolverComponent {
  // returns a target, or null to defer to the next component in the chain
  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null;
}
```

Each component is a class `implements ResolverComponent`, one file per approach.
`deps` (`tsOptions`, the ambiguous-resolve `mode`, the path mapper) are injected
through the component's **constructor** — current `TSCallResolver` constructor
args, relocated per component. The language facade (`ts/resolver/index.ts`) owns
the ordered `ResolverComponent[]` and returns the first non-null hit; the chain
order IS today's if-ladder order, preserving resolution precedence exactly.

TS/JS components (one class-file each; current `ts-resolver.ts` if-blocks become
files):

| Component file        | Approach (current source)                                        |
| --------------------- | ---------------------------------------------------------------- |
| `super.ts`            | `super(...)` / `super.X()` via `classExtends` walk (`resolveSuper`) |
| `this-intra-class.ts` | `this.X()` same-file lookup                                      |
| `field-type.ts`       | `this.field.method()` via `classFieldTypes`                     |
| `param-type.ts`       | typed-parameter receiver (`resolveByLocalType`, bd x6ta)        |
| `bare-import.ts`      | import-receiver — named-spec → basename → FQN-narrow passes      |
| `short-name.ts`       | global short-name + imports-narrowed fallback (bd 2qp6)         |

Two boundaries the components must respect:

- **`bare-import.ts` is ONE component, not three.** Its named-specifier /
  basename-normalize / FQN-narrowing passes are fallbacks **within one approach**
  (resolve a receiver through the import map). They stay in one file — splitting
  them would fragment one strategy across three "components" that never run
  independently.
- **Lookup-table dispatch is a DIFFERENT interface.** `resolveDispatch` returns
  `DispatchEdge[]` (fan-out, one call-site → N edges), not
  `ResolvedTarget | null`, and the mechanism is **language-neutral** (the n0zj
  contract — `dispatch` / `dispatchArgs` — is). It is a separate
  `DispatchResolverComponent` interface (also in `contracts/types/language.ts`)
  whose single language-neutral implementation lives in `domains/language/`
  (a `dispatch.ts` file, not a `shared/` catch-all), consumed by every language
  resolver, NOT duplicated per language:

  ```ts
  interface DispatchResolverComponent {
    resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[];
  }
  ```

`path-mapper` and `config-loader` are **NOT components** — they are shared infra
a component calls (tsconfig load + import→file mapping). They stay as plain
helper modules under the resolver capability, injected as part of `deps`.

The **walker** componentizes too, but as a **different shape**. Its passes are
heterogeneous — `collectImports → ImportRef[]`, `collectClassExtends → Map`,
`collectDispatchTables → Record<…>`, `collectParamBindings → ParamBinding[]`, …
— so a single `resolve`-shaped contract does not fit. Instead each pass is a
class behind a generic `ExtractionPass<T>` (interface in
`contracts/types/language.ts`, alongside `WalkContext`):

```ts
interface ExtractionPass<T> {
  // pure projection of the AST onto one facet of FileExtraction
  run(root: SyntaxNode, ctx: WalkContext): T;
}
```

This is a shared **form** (pure `root → one facet`), NOT a shared return type.
The walker facade is the **orchestrator**: it runs each pass and drops the
result into its slot on `FileExtraction` — a **union** of facets, not a
first-hit chain. Order is irrelevant except one data dependency (`collectCalls`
needs the table names from `collectDispatchTables`, threaded via `ctx`). An
extension point is a new facet = one new `ExtractionPass` + one `FileExtraction`
slot.

walker ⇄ resolver are **two sides of one graph facet**: each walker pass feeds
exactly one resolver component — `classExtends` → `super`, `classFieldTypes` →
`field-type`, `paramBindings` → `param-type`, `dispatchTables` +
`callbackParams` → `lookup-table`. The chain (resolver, first-hit) and the
orchestrator (walker, union) are deliberately **different patterns** — do NOT
unify them under one interface.

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
- The only direct importers of `domains/language/` concrete are the two
  composition roots, **both in `api/`** — the main `api/composition.ts` and the
  worker entry in `api/internal/` (see §5). No domain module imports it.

### 3. What moves, what stays

Phase-orchestrator **engines stay** in their domains and consume capabilities
through the injected `LanguageFactory`. Only per-language **descriptors move**.

| Stays (phase engine)                                                              | Moves to `domains/language/<lang>/`                                  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ingest/chunker/tree-sitter.ts`, `base.ts`, `infra/pool.ts`, `infra/worker.ts`    | `chunker/hooks/<lang>/**` → `chunking/` (modular hooks)                          |
| `codegraph/symbols/provider.ts` (`CodegraphEnrichmentProvider`)                   | `chunker/extraction/<lang>-walker.ts` + `ruby-macros.ts` → `walker/` (one `ExtractionPass` per facet) |
| `codegraph/infra/` (page-rank, tarjan), `symbols/payload-signals.ts`, presets     | `codegraph/symbols/resolvers/<lang>/**` → `resolver/` (one `ResolverComponent` per approach) |

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
the facade stays thin, but capability internals split as needed. `chunking`
holds modular hooks (Ruby aggregates 4 current files); `resolver` holds one
class-file **per resolution approach** behind the `ResolverComponent` interface
(§1b), plus `path-mapper` / `config-loader` infra; `walker` holds one class-file
**per extraction facet** behind `ExtractionPass<T>` (§1b). Capabilities are
**optional** per language: a doc language (markdown) has only `chunking` and no
`walker`/`resolver`.

```text
contracts/types/language.ts   // ALL interfaces: LanguageProvider, LanguageFactory, LanguageKernel,
                              //   LanguageChunkerHooks, LanguageWalker, LanguageSymbolResolver,
                              //   ResolverComponent, DispatchResolverComponent, ExtractionPass<T>, WalkContext,
                              //   SymbolIdComposer (injected — built by EVERY symbolId-building consumer)

domains/language/
  kernel/
    symbol-id.ts              // DefaultSymbolIdComposer (cross-language symbolId mapper — replaces the 5+
                              //   duplicated buildSymbolId / joinSymbol / manual `#`-join sites). Injected
                              //   into chunker engine, chunker hooks, codegraph provider/resolvers via api/internal DI.
                              //   Consumes infra/symbolid/classify.ts (INSTANCE_METHOD_SEPARATOR, node detection).
  factory.ts                  // LanguageFactory.create(lang) → fresh LanguageProvider (+ own Parser); supported(): string[]
  resolver-chain.ts           // resolveViaChain(components, call, ctx) — first-hit chain runner (lang-neutral)
  dispatch.ts                 // DispatchResolverComponent impl (lookup-table fan-out) — language-neutral (n0zj)
  index.ts                    // barrel
  typescript/
    index.ts                  // class TypeScriptLanguage implements LanguageProvider (thin facade) + barrel
    kernel.ts
    chunking/                 // index.ts barrel + test-scope-chunker, comment-capture, class-body-chunker, ...
    walker/                   // ExtractionPass classes (one facet each) + index.ts orchestrator:
                              //   imports, calls, class-extends, field-types, param-bindings,
                              //   dispatch-tables, callback-params
    resolver/                 // ResolverComponent chain (index.ts, first-hit order = today's if-ladder):
                              //   super, this-intra-class, field-type, param-type, bare-import, short-name
                              //   + path-mapper, config-loader (infra, not components)
  ruby/
    index.ts                  // facade + barrel
    kernel.ts
    chunking/                 // class-body-chunker, comment-capture, rspec-scope-chunker, rspec-filter
    walker/                   // ExtractionPass classes: imports (require + zeitwerk channel), calls,
                              //   symbols + macros (ruby-macros)
    resolver/                 // ResolverComponent chain: zeitwerk-const + the super / bare / short-name
                              //   passes ruby-resolver has today
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
- **Chunker worker** — the second composition root lives in **`api/internal/`**
  (the composition layer, NOT `ingest/`), symmetric to the main root. It is the
  worker thread's entry: it imports the concrete `LanguageFactory` + the chunker
  engine, calls `create(lang)` once per language (cached for the single-threaded
  message loop), and injects the factory into the engine. The chunker engine
  itself stays in `ingest/` and receives the factory **through a DI parameter**
  — it never imports `domains/language/` concretes. Keeping this root in the
  composition layer (not `ingest/`) is what lets the `no-restricted-imports`
  guard stay exception-free: `ingest/` is clean, and only the composition layer
  touches the concrete factory. (The thread mechanics in
  `chunker/infra/worker.ts` remain, but the *composition* — the concrete import
  + wiring — is what moves to `api/internal/`.)

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
  across threads (tree-sitter parsers are per-thread). The worker's second
  composition root lives in `api/internal/` (composition layer) — it imports
  the concrete factory directly and injects it into the `ingest/` chunker
  engine via a DI parameter; the engine never imports the concrete. Do NOT
  "simplify" this into one shared provider object, and do NOT push the concrete
  import down into `ingest/` (that would force a guard exception).
- **Domain boundaries.** Interfaces live in `contracts/`; `ingest`/`codegraph`
  import only the interface and receive the factory via DI — they MUST NOT import
  `domains/language/` directly (that would re-introduce the domain↔domain
  violation per `domain-boundaries.md`). Only the two `api/` composition roots
  (main + the worker entry in `api/internal/`) import the concrete factory.
- **Factory cost / caching.** `create(lang)` is **expensive** — it loads the
  tree-sitter grammar and builds a Parser. Callers MUST cache the instance per
  language within their context (the worker keeps one per language for its
  message loop); do NOT call `create()` per file. The pure core is shared, so
  only the Parser is the cost — but it is a real one.
- **Migration is code-relocation only — TDD is explicitly inverted here.** The
  existing chunker / codegraph tests ARE the behavioral contract, so the move
  writes **NO new tests**. The sequence per vertical is strict and non-
  negotiable: **(1) relocate code only** — imports update, logic does not;
  **(2) run the existing suite to green** at the OLD test locations, proving
  behavior is preserved; **(3) ONLY THEN redistribute the test files** to mirror
  the new module layout. Never reorder these — writing or moving tests before the
  code is green hides whether the relocation itself broke anything. Business-
  logic tests stay immutable per `.claude/rules/test-patterns.md`: relocating a
  test file is allowed, rewriting its assertions is not.

## Migration order (for the plan)

0. **Dependency guard first.** Add the eslint rule BEFORE moving any code:
   `domains/language/` must not import `ingest`/`trajectory`/`explore`, and
   `ingest`/`trajectory` must not import `domains/language/` (only the two
   `api/` composition roots may — main + the worker entry in `api/internal/`,
   which is NOT under the guard). This is *adding* a rule, not weakening one
   (per `linter-config.md`), so every later step trips the guard immediately on
   a wrong-direction import. **Done** — two `@typescript-eslint/no-restricted-imports`
   blocks in `eslint.config.js`; no worker exception needed.
1. **Skeleton:** interfaces in `contracts/types/language.ts` (capability ifaces
   + `ResolverComponent` / `DispatchResolverComponent` / `ExtractionPass` /
   `WalkContext` / `SymbolIdComposer`) + `LanguageFactory` in
   `domains/language/factory.ts` + `DefaultSymbolIdComposer` in
   `domains/language/kernel/symbol-id.ts` (unify `tree-sitter.ts:buildSymbolId`
   and `provider.ts:joinSymbol`) + per-language detection in each kernel; remove
   the duplicated `scopeSeparator` / `disambiguateOverloads`. **Done so far:**
   component interfaces + `SymbolIdComposer` in contracts, `resolveViaChain`
   chain runner, `DefaultSymbolIdComposer` (+ test, 10 green). **Next:** inject
   `SymbolIdComposer` into all 5+ symbolId-building consumers via `api/internal/`
   (deep-silo `tree-sitter.ts`/`provider.ts` + go/js hooks + go resolver),
   behavior-preserving — existing tests stay green.
2. **Per-language verticals**, richest first (Ruby: hooks + macros + zeitwerk),
   then the rest by the same template: ts, javascript, python, go, java, rust,
   bash, markdown. Each vertical follows the strict three-phase order from
   Constraints: **2a** relocate code into `chunking/` + `walker/`
   (`ExtractionPass` classes) + `resolver/` (`ResolverComponent` chain),
   writing no new tests; **2b** run the existing suite green (behavior
   preserved); **2c** only then move the test files to mirror the new layout.
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
