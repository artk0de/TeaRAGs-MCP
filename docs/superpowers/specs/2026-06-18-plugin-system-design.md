# tea-rags Plugin System — Design (MVP, augment-only)

**Status:** Approved design (brainstorming complete) — ready for implementation
plan. **Date:** 2026-06-18 **Scope class:** Sub-epic → Epic (new SDK package +
host loader + walker pass-runner).

## Problem

Adding language behavior to tea-rags today requires editing core. The closed
OCP-set lives in `domains/language/factory.ts` `LanguageFactory#build` — a
hardcoded `switch` that statically imports all 9 native languages. There is no
supported way for a third party to:

- teach an existing language about a DSL (Rails `has_many`, RSpec `it`,

  TS decorators) — custom **walker** passes, custom **resolution** strategies,
  custom **chunking**;

- ship that behavior as an installable npm package;
- get it promoted into core cheaply once it proves out.

This spec defines a plugin system that makes language behavior **extensible by
composition** without touching the high-churn deep-silo core (`factory.ts`,
`contracts/types/language.ts`, `tree-sitter.ts`).

## Goals

1. Third parties **augment** an existing native `LanguageProvider` with extra

   chunking / walker / resolution behavior, shipped as npm packages or local
   paths.

2. Plugins depend only on a thin, versioned public SDK — never on churny

   internal contracts.

3. A proven plugin is **cheap to merge into core**: move the file, swap one
   import, push into a native array — same interfaces and mechanism as native.
4. Authoring is **maximally convenient** — builders, AST facade, symbol

   constructors, and an out-of-process test harness.

## Non-goals (YAGNI for MVP)

- Registering a **brand-new language** end-to-end (e.g. Kotlin with its own

  tree-sitter grammar). Augment-only.

- **Replacing** native behavior. Composition is append/chain only.
- Sandboxing / isolation of untrusted plugin code.
- Hot-reload, plugin-to-plugin dependencies, plugin-defined derived signals or

  rerank presets.

- Cross-service / cross-repository edges — see **TBD: Cross-service linking**.

## Key decisions (resolved in brainstorming)

| #   | Decision              | Choice                                                                                                             |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Plugin scope          | augment-only: chunking + walker + resolver                                                                         |
| 2   | Composition semantics | append/chain only; native always runs first; replace is structurally impossible                                    |
| 3   | Public contract       | published `@tea-rags/plugin-sdk`, structurally **identical** to internal contracts                                 |
| 4   | Merge-to-core model   | shared contract + shared mechanism per component; merge = move + swap import + push into native array              |
| 5   | Walker aggregation    | **Model A** — a pass returns `Partial<FileExtraction>`; the host merges append-only                                |
| 6   | Discovery             | tea-rags config (env / MCP config): a list of refs (npm name OR local path); multiple allowed; keyed by `language` |
| 7   | Authoring style       | builders primary (`defineLanguagePlugin`, `strategy`/`pass`/`chunkableCalls`, `ast.*`, `sym.*`, test harness)      |

### Why these hold together

- The resolver mechanism is **already shared**: `RubyCallResolver` assembles a

  `SymbolResolutionStrategy[]` and delegates to the `resolver-chain.js` runner;
  native strategies (`RubyArRelationGuardSymbolResolutionStrategy`, …) implement
  the exact
  `SymbolResolutionStrategy { name, attempt → resolved|drop|continue }` a plugin
  strategy implements. Plugin strategy ≡ native strategy.

- The chunker mechanism is **already shared**: `LanguageChunkerHooks.hooks` is
  an

  ordered `ChunkingHook[]`; a plugin hook appends to it.

- Only the **walker** is not yet pass-shaped: `LanguageWalker.walk` is a

  monolithic per-file traversal. The plugin system introduces a pass-runner +
  `mergeExtraction` so native (future) and plugin passes share `ExtractionPass`.
  The native monolith is **not** rewritten — passes run after it and merge
  partials.

## Architecture

### Data flow

```text
tea-rags config (env TEA_RAGS_PLUGINS)
  → PluginLoader (bootstrap)            resolve ref (npm|path) → import → validate manifest
  → resolved absolute plugin paths
  → passed into BOTH worker boundaries  (chunker worker + codegraph worker)
  → AugmentingLanguageFactory(nativeFactory, loadedPlugins)   inside each worker
        create(lang):
          base = nativeFactory.create(lang)           // factory.ts untouched
          return mergeProvider(base, pluginsFor(lang)) // append-only
```

### Component map

| Component                            | DOES                                                                                 | OWNS                        | INTERFACE                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------ |
| `@tea-rags/plugin-sdk` (new package) | publish frozen contracts + builders + AST/sym helpers + test harness                 | new top-level package       | `defineLanguagePlugin`, `strategy`, `pass`, `chunkableCalls`, `ast.*`, `sym.*` |
| `PluginLoader`                       | resolve config refs → import → validate manifest (typed errors)                      | `bootstrap/plugins/`        | `(refs: PluginRef[]) → LoadedPlugin[]`                                         |
| `AugmentingLanguageFactory`          | decorator over `LanguageFactoryDescriptor`; merge native provider + matching plugins | `domains/language/plugins/` | `create(lang) → LanguageProvider`                                              |
| `mergeProvider`                      | pure: native provider + contributions[] → augmented provider                         | `domains/language/plugins/` | append/union per §Composition rules                                            |
| `mergeExtraction`                    | pure: base `FileExtraction` + `Partial<FileExtraction>` → merged                     | `domains/language/plugins/` | concat arrays, union Records, never delete                                     |
| walker pass-runner                   | run native monolith, then `[...nativePasses, ...pluginPasses]`, merge partials       | walker engine               | Model A                                                                        |
| `AppConfig.plugins`                  | hold `PluginRef[]` parsed from env                                                   | `bootstrap/config/`         | Zod-validated list                                                             |

### Worker boundary (critical)

AST traversal happens in **two** workers, both loading a `LanguageModule` via
dynamic `import(modulePath)`:

- `domains/ingest/pipeline/chunker/infra/worker.ts` (chunking + walking for

  chunks),

- `domains/trajectory/codegraph/factory.ts` (call/edge resolution).

Both must build `AugmentingLanguageFactory(nativeFactory, loadedPlugins)`. The
**host (main thread)** resolves plugin refs to absolute paths; each worker
receives a `pluginModulePaths: string[]` in its worker config and
dynamic-imports each plugin itself (worker threads cannot share object graphs).

## Public SDK surface

```ts
import { defineLanguagePlugin } from "@tea-rags/plugin-sdk";

import { rspecChunking } from "./chunking.js";
import { associationResolver } from "./resolver.js";
import { activeRecordPass } from "./walker.js";

export default defineLanguagePlugin({
  name: "tea-rags-plugin-rails",
  language: "ruby", // match key against native ruby provider
  resolver: [associationResolver], // append to resolver-chain
  walker: [activeRecordPass], // append to pass-pipeline (Model A)
  chunker: { hooks: [rspecChunking] },
});
```

### 1. Resolution strategy — string-level, zero tree-sitter

`SymbolResolutionStrategy` receives an already-parsed `CallRef`
(`receiver`/`member`/`callText` are strings) and a `CallContext` (`symbolTable`,
`localBindings`, …), returns a three-state outcome. Native `RubyArRelationGuard`
is the reference style.

```ts
import { drop, next, resolved, strategy, sym } from "@tea-rags/plugin-sdk";

export const associationResolver = strategy(
  "rails-association",
  (call, ctx) => {
    const model = ctx.localBindings?.[`${call.receiver}.${call.member}`];
    if (!model) return next(); // not ours → continue chain
    const hit = ctx.symbolTable.classNamed(model);
    return hit ? resolved(sym(hit.relPath, hit.symbolId)) : drop();
  },
);
```

Knowledge: three-state semantics, `symbolTable` API. No AST.

### 2. Chunking — declarative, node-type names

```ts
import { ast, chunkableCalls } from "@tea-rags/plugin-sdk";

// each RSpec `it "..." do … end` becomes its own searchable chunk
export const rspecChunking = chunkableCalls(["it", "describe", "context"], {
  name: (node) => ast.firstStringArg(node), // "renders the index"
});
```

Knowledge: target grammar node types (`call`), how to read an argument —
mitigated by `ast.*`. Full `ChunkingHook { process(ctx) }` remains the power
path.

### 3. Walker pass — full AST, returns `Partial<FileExtraction>`

```ts
import { ast, pass, sym } from "@tea-rags/plugin-sdk";

const AR_MACROS = new Set(["has_many", "has_one", "belongs_to"]);

export const activeRecordPass = pass("rails-associations", (root, ctx) => {
  const chunks = [];
  const bindings: Record<string, string> = {};
  for (const call of ast.calls(root)) {
    const macro = ast.calleeName(call); // "has_many"
    if (!AR_MACROS.has(macro)) continue;
    const assoc = ast.firstSymbolArg(call); // :posts → "posts"
    chunks.push(sym.methodChunk(ctx, assoc, call)); // synthetic User#posts
    bindings[`${ctx.classScope}.${assoc}`] = ast.modelName(assoc);
  }
  return { chunks, localBindings: bindings }; // append-only merge
});
```

Knowledge: target grammar AST shape, which `FileExtraction` channels to write.
`ast.*` / `sym.*` hide the raw tree-sitter cursor; grammar semantics they do
not.

### Knowledge matrix

| Contribution           | tree-sitter | DSL grammar knowledge             | tea-rags internals         | Difficulty |
| ---------------------- | ----------- | --------------------------------- | -------------------------- | ---------- |
| Resolution strategy    | none        | minimal (method names as strings) | `symbolTable`, three-state | low        |
| Chunking (declarative) | via `ast.*` | node types (`call`)               | `chunkType`, name          | medium     |
| Walker pass            | via `ast.*` | full (nodes + args)               | `FileExtraction` channels  | high       |

### DX conveniences (owner: user)

1. `defineLanguagePlugin()` + builders `strategy`/`pass`/`chunkableCalls` — no

   class boilerplate, no raw outcome/partial construction. Builders **return the
   canonical interface** (`SymbolResolutionStrategy`, `ExtractionPass`,
   `ChunkingHook`) so merge-to-core holds.

2. `ast.*` facade (`calls`, `calleeName`, `firstSymbolArg`, `firstStringArg`,

   `childOfType`, `textOf`) — covers ~90% of DSL tasks without a raw cursor.

3. `sym.*` constructors (`sym(relPath, id)`, `sym.methodChunk`) — correct

   symbolIds / chunks without knowing `SymbolIdComposer`.

4. **Test harness from the SDK** (`runStrategy(call)`, `runPass(code)`,

   `parseFixture(code)`) — author TDDs a contribution **without booting tea-rags
   / Qdrant**. Primary convenience multiplier.

5. Narrow context — builders hand the contribution only the relevant slice of

   `CallContext` (string strategies get `receiver`/`member`/`symbolTable`/
   `localBindings`), not all 12 fields.

## Composition rules ("only appends")

- Array channels (`chunkableTypes`, `childChunkTypes`, `hooks`, resolver

  strategies, walker passes) — native entries first, then plugins in **config
  order**.

- Resolver three-state: the native chain runs first; only when native returns

  `continue` do plugin strategies get a turn. A plugin cannot override an
  already-`resolved` call.

- Single-function hooks (`nameExtractor`, `classifier`, `macroSymbols`) —
  wrapped

  in a **fallback chain**: native first; the plugin is consulted only when
  native returns `undefined` / empty.

- Multiple plugins targeting one language — all appended, order = config order.
- `mergeExtraction` for walker partials: concat arrays (`chunks`, `imports`),

  union Records (`classAncestors`, `localBindings`, `dispatchTables`, …); never
  delete or overwrite a native key. Records must be plain `Record` (NOT `Map`)
  to round-trip the NDJSON spill — enforced by the SDK conformance test.

## Discovery & configuration

- New config field `AppConfig.plugins: PluginRef[]`, parsed from env

  `TEA_RAGS_PLUGINS` (JSON array) in `buildEnvInputs` / `parseAppConfigZod`.

- `PluginRef` is a string: starts with `.` / `/` → local path; otherwise an npm

  specifier. The indexed project (Rails/Kotlin) is not a JS project — plugin
  packages live in tea-rags' own runtime (global / data-dir), the config only
  **activates** them.

- Multiple entries allowed. Each plugin's manifest `language` field keys it to a

  native provider; a `ruby` plugin never attaches to a TS project.

## Merge-to-core procedure

A proven plugin is promoted by:

1. Move `resolver.ts` / `walker.ts` / `chunking.ts` into

   `domains/language/<lang>/{resolver/strategies, walker, chunking}/`.

2. Swap `import … from "@tea-rags/plugin-sdk"` → the internal contract path.
3. Push the contribution into the native array (`RubyCallResolver` strategy list

   / native `passes` list / `LanguageChunkerHooks.hooks`).

No logic rewrite — the builder output already implements the canonical
interface. A **conformance test** in CI asserts SDK types are mutually
assignable with internal types, so "swap import" never silently breaks on drift.

## Testing strategy

- `mergeProvider` / `mergeExtraction` — pure unit tests for each rule

  (append, union, three-state fallback, single-fn fallback, no-overwrite).

- `PluginLoader` — npm resolve, local-path resolve, broken manifest → typed

  error.

- SDK builders — `strategy`/`pass`/`chunkableCalls` produce objects assignable

  to the canonical interfaces.

- SDK test harness — self-test that `runStrategy`/`runPass`/`parseFixture` work

  on a fixture plugin offline.

- Integration — a fixture plugin (local path) augments ruby; live reindex of a

  worker surfaces the new symbols (`has_many` → `User#posts` searchable).

- SDK ↔ internal conformance type test.

## New / changed files (approximate)

**New:**

- `packages/plugin-sdk/` — the published SDK package (contracts mirror,
  builders,

  `ast.*`, `sym.*`, test harness).

- `src/bootstrap/plugins/loader.ts` — `PluginLoader`.
- `src/core/domains/language/plugins/augmenting-factory.ts` — decorator.
- `src/core/domains/language/plugins/augment.ts` — `mergeProvider` /

  `mergeExtraction`.

**Changed:**

- `src/bootstrap/config/` — add `plugins` field + env parsing.
- `src/bootstrap/factory.ts` — wire `PluginLoader`, pass plugin paths into both

  workers.

- chunker worker + codegraph factory — accept `pluginModulePaths`, build

  `AugmentingLanguageFactory`.

- walker engine — add the pass-pipeline + `mergeExtraction` seam.

**Untouched:** `factory.ts` (`LanguageFactory#build`), native providers,
`contracts/types/language.ts` (beyond possibly re-exporting for the SDK mirror).

---

## TBD: Cross-service linking (post federated search)

> **Not in MVP scope.** Captured so the SDK contract is designed without
> foreclosing it.

The SDK must eventually let a plugin **create edges across service / repository
boundaries** — frontend ↔ backend service ↔ outer (third-party) service — i.e.
inter-microservice links, not just intra-file/intra-repo edges. Concretely: a
plugin should be able to emit an edge whose target lives in a **different
indexed project** (e.g. a frontend `fetch("/api/orders")` call resolved to the
backend route handler in another repo; a backend client call resolved to an
outer service's OpenAPI operation).

This depends on **federated search** existing first — there is currently no
cross-collection / cross-project resolution substrate; `SymbolResolutionTarget`
addresses a single collection's `relPath` + `symbolId`. Open questions to
resolve when federated search lands:

- Target addressing across collections — `SymbolResolutionTarget` needs a

  project/collection qualifier (or a new `CrossServiceTarget`).

- How a plugin declares the **contract surface** it links against (route table,

  OpenAPI spec, GraphQL schema, protobuf) — likely a new contribution kind
  beyond walker/resolver/chunker.

- Resolution timing — cross-service edges resolve **after** all member

  collections are indexed (a federated post-pass), not during single-repo
  ingest.

- Whether outer (third-party) services are represented as synthetic nodes or

  require their own lightweight index.

Tracked as `tea-rags-mcp-<TBD>` under the SDK epic; blocked on the federated
search epic.
