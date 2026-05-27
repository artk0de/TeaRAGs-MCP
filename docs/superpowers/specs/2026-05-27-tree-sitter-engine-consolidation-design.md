# Tree-sitter Chunker Engine Consolidation — Design

**Date:** 2026-05-27
**Status:** Approved (brainstorm)
**Beads:** `tea-rags-mcp-aah9` (Go, expanded to full DRY migration), `tea-rags-mcp-9zh4` (Ruby macro-walk generalization)
**Area:** `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` (engine) + `src/core/domains/language/{go,javascript,ruby}/`

## Problem

After the `domains/language` consolidation (spec `2026-05-25-domains-language-consolidation-design.md`),
per-language MODULES are served through the `LanguageProvider` capability
interface — but the chunker ENGINE (`tree-sitter.ts`, `TreeSitterChunker`) still
hardcodes language-specific logic internally. An audit of the engine finds
exactly two residues (no other `=== "<lang>"` branches exist):

1. **Go (4 sites + a direct import).** The engine `import`s `extractGoSymbol`
   from `chunker/hooks/go/` — the **last surviving language directory** under
   `chunker/hooks/` (only `go/` and the generic `types.ts` remain). Plus four
   `language === "go"` branches: chunk-type refinement (`type_declaration` body
   → `class`/`interface`), a min-length-floor bypass for Go named type aliases
   (`bd iiq6`), and an adjacent-merge guard. Go on the chunker side **never
   passed through the capability interface at all**.

2. **Ruby (orchestration naming).** `emitRubyMacroSymbols` /
   `walkRubyMacroScopes` carry "Ruby" in their identifiers and hardcode the
   `::` separator and the `class`/`module` scope-container set. The macro DATA
   is already injected via the `macroSymbols` capability; only the recursive
   scope-walk orchestration is language-shaped.

**Duplication (drift epicenter).** `chunker/hooks/go/symbol-resolver.ts:extractGoSymbol`
and `domains/language/go/walker/name-of.ts:goNameOf` encode the SAME Go
symbolId convention (`Receiver#Method`, `type Foo`) in two places — the comment
in `symbol-resolver.ts` literally says it exists to "match the codegraph
`goNameOf` output" (`bd n7x5`, `bd j2b7`). `.claude/rules/symbolid-convention.md`
mandates these stay in lockstep; today that lockstep is manual.

### Risk context (tea-rags enrichment, `**/chunker/**`)

`tree-sitter.ts` is the single highest-risk touch point — it appears in all
three risk lenses (hotspots / ownership / tech-debt): `bugFixRate` 32
("concerning"), `commitCount` 10, `relativeChurn` up to 5.04 ("high"), file
`instability` 0.857. **The consolidation must REDUCE the engine's branching
surface, never add to it.** The engine is, however, the one chunker file with a
second owner (Arthur 93% + Martin Halder) — so this refactor has partial
reviewer cover, unlike the deep-silo'd hooks.

## Goal

A fully language-agnostic chunker engine: **zero `language === "X"` branches and
zero language-named methods**. Per-language node→chunk behavior is injected
through one cohesive capability per language, colocated in
`domains/language/<lang>/`.

## Approach — single `ChunkClassifier` per language

The three branches of the top-level node path (`chunkSingleNode`: JS
`chunkSymbols`, the Go branch, the default) all answer one question: *"what
chunk(s) does THIS AST node produce?"* They collapse into one capability method
with one decision union.

**Critical boundary (must hold):** the classifier owns ONLY the node-level
decision. It does NOT absorb tree traversal, child recursion, the hook chain, or
the merge algorithm — those stay in the engine as the single generic walk.
Otherwise each language would re-implement the engine.

### Capability interface

Lives in `contracts/types/language.ts` (interfaces only, no Zod, no runtime —
per `.claude/rules/domain-boundaries.md`).

```ts
/**
 * Per-language node→chunk classification. Consulted by the engine for each
 * chunkable AST node when the generic chunk shaping would be wrong. Returning
 * `passthrough` accepts the engine's generic shaping (the common case).
 */
export interface LanguageChunkClassifier {
  classifyNode: (node: Parser.SyntaxNode, ctx: ClassifyContext) => ChunkDecision;
}

export interface ClassifyContext {
  code: string;
  /** Injected composer for languages that build a final symbolId (Go). */
  symbolIds: SymbolIdComposer;
}

export type ChunkDecision =
  | { kind: "passthrough" }                 // generic shaping (TS/Python/Java/Rust/Bash/Ruby)
  | { kind: "skip" }                        // drop this node
  | { kind: "emit"; chunks: EmittedChunk[] }; // explicit chunks (Go = 1, JS = N)

export interface EmittedChunk {
  name: string;
  /** Fully-composed symbolId, emitted verbatim to chunk metadata. */
  symbolId: string;
  chunkType: ChunkType; // Go: class/interface/block; JS: function
}
```

`classifier` is an OPTIONAL field on `LanguageChunkerHooks`. Absent ⇒ the engine
uses the generic path. Only **Go** and **JavaScript** ship a classifier; Ruby,
TypeScript, Python, Java, Rust, Bash, Markdown leave it undefined.

### What folds in, what stays

| Was (scattered) | Lang | Becomes |
| --- | --- | --- |
| `chunkSymbols?(node) → ChunkSymbol[]` | JS | `emit` with N chunks (`chunkType: "function"`) |
| Go branch `extractGoSymbol` + chunkType refine | Go | `emit` with 1 chunk |
| floor bypass `isGoNamedType` | Go | **gone for free** — `emit` bypasses the floor (floor applies only to `passthrough`) |
| merge guard `language === "go" && symbolId` | Go | **gone for free** — chunks from an `emit` decision are flagged `claimed`; merge skips them; `passthrough` chunks merge as before |

**Stays as separate capability (NOT folded):**

- `nameExtractor?(node) → string` — feeds the **passthrough** path (RSpec custom
  names). Orthogonal to classification.
- `macroSymbols?(container) → MacroSymbol[]` — **additive** container-child
  methods (Ruby DSL), not the container node's own chunk. Stays; generalized in
  Workstream 2.

The key win: both Go lifecycle branches vanish as a natural consequence of the
`emit` vs `passthrough` split — no dedicated `atomicNodeTypes` facet is needed.

## Out of scope (explicitly untouched)

The engine has three dispatch tiers; the classifier lives only in tier 3:

```
chunk(code, filePath, language)
├─ TIER 1: chunkerHooks.isDocumentation?  → markdownChunker.chunk()  (remark, not tree-sitter)
├─ TIER 2: langConfig === null?           → fallbackChunker.chunk()  (CharacterChunker)
└─ TIER 3: tree-sitter AST path           → classifyNode() per node  ◄── ONLY here
       recovery (0 chunks / parse error / oversize) also → fallbackChunker
```

- **Markdown (`MarkdownChunker`, tier 1).** A separate engine (peer of
  `CharacterChunker`), gated out by `isDocumentation` BEFORE the AST path.
  Markdown has no tree-sitter nodes, so it has nothing to classify.
  `MarkdownLanguage` stays config-only (`chunkerHooks = { chunkableTypes: [],
  isDocumentation: true }`, no classifier).
- **`CharacterChunker` fallback (tier 2 + recovery).** The symbol-less safety net
  for unsupported languages, parse errors, zero-chunk files, and oversize-chunk
  splitting (`enforceMaxChunkSize` → `symbolId#partN` inheritance). Orthogonal to
  `classifyNode`, which only runs when usable AST chunks exist. `emit` chunks are
  ordinary `CodeChunk`s and remain subject to the same size enforcement.
- **RSpec** (`hooks/ruby/rspec-scope-chunker.ts`, `rspec-filter.ts`) — a separate
  chunking mechanism via `ctx.skipChildren`; `bugFixRate` 50 ("critical"). Not
  touched.
- **Child path** (`processChildren` / `composeParentSymbol`) — already
  language-agnostic (driven by `nameExtractor` / `scopeSeparator` /
  `scopeContainerTypes`, zero `language===`). Not routed through `classifyNode`
  until a language needs a child-level override (YAGNI).
- **Generic traversal, recursion, hook chain, merge algorithm** — stay in the
  engine.

## Workstream 1 — `ChunkClassifier` + Go/JS migration

### Engine changes (`tree-sitter.ts`)

- **`chunkSingleNode`**: replace the `chunkSymbols` block + the `language === "go"`
  block + the default block with one switch:

  ```
  const decision = langConfig.classifier?.classifyNode(node, ctx) ?? { kind: "passthrough" };
    "emit"        → push each EmittedChunk at index+i; mark metadata.claimed = true
    "skip"        → return
    "passthrough" → content.length < 50 ? return (floor)
                    : extractName(nameExtractor) + buildSymbolId + getChunkType
  ```

- **Min-length floor**: remove the `isGoNamedType` exception and the early
  `continue` from the top-level loop in `chunk()`; the floor moves into the
  `passthrough` branch of `chunkSingleNode`. `emit` decisions bypass it.
- **`mergeSmallChunks`**: replace the `language === "go" && symbolId` guard with
  `if (chunk.metadata.claimed) return false`. The `claimed` flag is set only on
  chunks produced by an `emit` decision. `passthrough` chunks merge exactly as
  before (the existing TS small-type-alias merge test stays green).
- **`initializeParser` / `LanguageConfig`**: add `classifier: hooks.classifier`;
  **remove** the `chunkSymbols` field (folded into the classifier). `macroSymbols`
  and `nameExtractor` remain.
- **Remove**: `import { extractGoSymbol } from "./hooks/go/index.js"` and all four
  `language === "go"` branches.

`metadata.claimed` is a new transient boolean on `CodeChunk.metadata` (read only
by `mergeSmallChunks`); not persisted to the Qdrant payload.

### Go — DRY relocation (not deletion)

`chunker/hooks/go/` is **relocated**, not discarded (per
`.claude/rules/domains-language.md` #3 + the refactor-migration-test-order rule —
move logic, keep tests green, don't rewrite).

| Now | Destination | Why there |
| --- | --- | --- |
| `chunker/hooks/go/symbol-resolver.ts:extractGoSymbol` (the `Receiver#Method` / `type Foo` convention) | **`domains/language/go/naming.ts`** — neutral, provider-level | Consumed by BOTH the chunker classifier AND `walker/name-of.ts`. This is the chosen DRY: one source, two consumers. |
| chunker-side consumption | **`domains/language/go/chunking/classifier.ts`** (new `chunking/` dir, mirrors `ruby/chunking/`) | The chunker capability — `GoChunkClassifier` calls `naming.ts`. |
| `walker/name-of.ts:goNameOf` | stays in `walker/`, **refactored onto `naming.ts`** | The codegraph capability — drops its duplicate. |
| `chunker/hooks/go/index.ts` + the emptied directory | **removed after relocation** | The other 8 languages already vacated `chunker/hooks/`; Go is the last. `chunker/hooks/` retains only the generic `types.ts`. |

`GoChunkClassifier.classifyNode`: for `method_declaration` / `function_declaration`
/ `type_declaration` → `emit` with one `EmittedChunk` whose `name`/`symbolId`
come from `goSymbolOf` and whose `chunkType` is refined by inspecting the
`type_spec` body (`struct_type` → `class`, `interface_type` → `interface`, else
`block`). All other nodes → `passthrough`.

The shared `goSymbolOf` makes the chunker↔codegraph lockstep that
`symbolid-convention.md` mandates true **by construction** — no more mirror
drift.

The neutral placement (`go/naming.ts`, not `go/chunking/`) is deliberate: a
`chunking/`-resident primitive would force `walker/` to import from `chunking/`.
That sibling import is permitted within one provider, but the symbolId
convention is shared identity, not a chunking concept — neutral is honest.

### JavaScript

`chunkSymbols` → new `domains/language/javascript/chunking/classifier.ts`
(`JsChunkClassifier`) returning `emit` with N chunks (`chunkType: "function"`),
preserving the existing provider-owned precedence (dispatch-set wins; else
assignment + nested `Object.defineProperty` siblings, in order). The
`chunkSymbols` capability field is removed from the contract and `LanguageConfig`.

## Workstream 2 — Ruby macro-walk generalization (`bd 9zh4`)

In `tree-sitter.ts`:

- Rename `emitRubyMacroSymbols` → `emitMacroSymbols`, `walkRubyMacroScopes` →
  `walkMacroScopes`.
- **Separator**: the hardcoded `{ scopeSeparator: "::" }` → `langConfig.scopeSeparator`.
  Ruby resolves to `::` — no behavior change.
- **Container set**: the hardcoded `stmt.type !== "class" && stmt.type !== "module"`
  → driven by `langConfig.scopeContainerTypes`. This requires threading
  `scopeContainerTypes` + `scopeSeparator` into the two call sites (both have
  `langConfig` in scope).

**One intentional behavior delta (decided):** Ruby's `scopeContainerTypes` is
`["class", "module", "singleton_class"]`, but today's hardcode descends only
`class`/`module`. Reading `scopeContainerTypes` verbatim makes the macro-walk
also descend `singleton_class`, so macros inside `class << self` now emit
symbols — consistent with the regular `def`-path, which already descends
`singleton_class`. This is covered by a new test. (The macro-walk keeps the
existing one-step-deep convention: only immediate body statements, matching the
codegraph provider's `walkRubyTopLevel`.)

The macro DATA (`macroSymbols` capability) is unchanged; only the engine's
orchestration is de-language-named and parametrized. After W2 the engine has no
language-named identifiers.

## Migration order

Relocation keeps existing tests green; new entities get fresh tests (per
`.claude/rules/domains-language.md`, `.claude/rules/test-patterns.md`).

1. **Contract**: add `LanguageChunkClassifier`, `ChunkDecision`, `EmittedChunk`,
   `ClassifyContext` to `contracts/`. No behavior change.
2. **Go DRY module**: extract `goSymbolOf` into `domains/language/go/naming.ts`;
   point `goNameOf` at it; Go walker tests stay green (examples preserved).
3. **Classifiers**: implement `GoChunkClassifier` (`go/chunking/`) and
   `JsChunkClassifier` (`javascript/chunking/`); wire each into its provider's
   `chunkerHooks.classifier`.
4. **Engine (W1d — riskiest, the hotspot)**: route `chunkSingleNode` through the
   classifier; fold the floor + merge; remove the `extractGoSymbol` import, the
   four Go branches, and the `chunkSymbols` field; remove `chunker/hooks/go/`. A
   pure mechanical reroute — no logic change beyond moving branches into
   classifiers.
5. **Ruby (W2)**: rename + parametrize the macro-walk; add the `singleton_class`
   macro test.

W1 and W2 are independent and may land in separate commits.

## Testing

- **Count preservation** (`domains-language.md` #3): `it` / `test` / `describe`
  counts ≥ base branch for the go / javascript / ruby chunker + walker test
  files. Nothing dropped. Tests under `tests/.../chunker/hooks/go/` (if any)
  relocate to `tests/.../domains/language/go/`.
- **Behavior-identical** (existing assertions, must stay green):
  - Go: `struct_type` → `class`, `interface_type` → `interface`; named
    `type_declaration` alias keeps its symbolId and is NOT merged; TS small-type
    aliases DO merge.
  - JS: `module.exports` / `exports.foo` / `obj.method = fn`, `Foo.prototype.bar`,
    the `methods.forEach` HTTP-verb dispatch fan-out, nested
    `Object.defineProperty(this, …)` getters.
  - Ruby: nested `class A; class B; attr_accessor :x` → `A::B#x`.
- **New tests**:
  - `GoChunkClassifier` unit (passthrough vs emit; chunkType refinement).
  - `JsChunkClassifier` unit (the three former branches' precedence).
  - Engine: the `passthrough | skip | emit` switch and the `claimed` → no-merge
    rule.
  - Ruby: macros inside `class << self` (`singleton_class`) now emit symbols.
- **`symbolid-convention.md` live check**: a Go instance method appears as
  `Receiver#Method` identically in the chunker payload (`find_symbol`) AND in
  codegraph (`get_callers`) — now guaranteed by the shared `goSymbolOf`.

## Risk

`tree-sitter.ts` is a hotspot (`bugFixRate` 32, `relativeChurn` 5.04). Mitigation:
step 4 is a mechanical reroute with the full chunker + codegraph suites green
before and after; the net effect REMOVES branches (the goal), and the engine has
a second owner for review cover. The Go DRY collapse eliminates a standing drift
class (`extractGoSymbol` ↔ `goNameOf`) rather than adding surface.
