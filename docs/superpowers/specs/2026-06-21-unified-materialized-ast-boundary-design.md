# Unified Materialized AST Boundary

**Date:** 2026-06-21 **Status:** Approved (design) **Related:** rdv7d (ruby
callsAttempted jitter), yl9tv (single parser thread / crossPass spill),
chunker-process-pool epic, bd memory
`tree-sitter-not-thread-safe-process-global`

## Problem

`node-tree-sitter` lazily recreates a JS wrapper object for a node on **every**
accessor call (`.parent`, `.childForFieldName`, `.namedChildren`, …). The
wrappers reference into the native tree through a cache subject to GC and
internal cursor reuse. **Re-access / late-access** of a node whose wrapper was
already reclaimed returns an _inconsistent_ result on an otherwise **fixed,
unchanged tree**. The parse tree's structure (`type`, `startIndex`/`endIndex`,
`startPosition`/`endPosition`) and `rootNode.text` are deterministic; the
context accessors are not.

The Ruby walker detects **bare-identifier calls** (`foo` ≡ `foo()`) via
`isBareIdentifierCallSite(node)` (reads `node.parent`) gated by
`collectMethodLocalBindings` (reads `childForFieldName("parameters")`). When
those accessors flap, the gate misfires and the call set sporadically inflates —
ruby `callsAttempted` for a fixed file flips between its clean value and ~2×. On
huginn full-reindex this surfaces as a ~7% run-to-run jitter in ruby
`callsAttempted` (summed over many files). TypeScript/JavaScript are unaffected
because their walkers key off structural `call_expression` node **types** (a
stable accessor) and have no bare-identifier/`.parent`-sensitive path — hence
the exact ruby-jitters / TS-stable asymmetry observed.

This is **below the thread level**: it reproduces single-threaded,
single-process, with a freshly-parsed tree and no parser reuse. The chunker
process-pool (which fixed _cross-thread_ AST corruption) could not address it.

### Empirical evidence (engine-level, deterministic repro)

| Experiment                                                                                          | Result                                                | Conclusion                                               |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Tree fingerprint (`type`+`startIndex`+`endIndex` over every node), 40 runs                          | `distinct=1`                                          | structure + positions deterministic                      |
| `rootNode.text === code`, 40 runs                                                                   | `40/40 true`                                          | node text buffer correct                                 |
| Walk the **same fixed tree object** 30× → call count                                                | `distinct=[182,198,203]`                              | context-accessor reads non-deterministic on a fixed tree |
| In-process fresh-engine parse+walk 40× → call count                                                 | `[109, 200, 125, 203, 201, 202]` (109 clean dominant) | sporadic ~2× inflation, not reuse/concurrency            |
| **EAGER single-pass capture** of `childForFieldName`(×9 fields)+`parent`+`namedChildren`, 30×3 runs | `distinct=1`                                          | **an eager one-touch-per-node pass is deterministic**    |

The last row is the load-bearing finding: the instability is in
re-access/late-access, NOT in a single eager touch. A one-pass materialization
that visits each node exactly once and immediately records its accessor results
is deterministic.

Repro tests (worktree, currently RED except DECIDER):
`tests/core/domains/ingest/pipeline/chunker/infra/pool-ruby-jitter-repro.test.ts`,
`tests/core/domains/ingest/pipeline/chunker/infra/ruby-walker-carryover.test.ts`
(carryover / in-process / SAME-tree RED; DECIDER GREEN).

## Goal

Eliminate the native-accessor non-determinism for the **entire post-parse
pipeline** (chunking AND codegraph extraction, all languages) by materializing
the native tree into an immutable plain-JS AST in ONE eager pass right after
parse, and routing every downstream consumer through the plain-JS node. After
the boundary, native `Parser.SyntaxNode` exists nowhere in the pipeline — the
bug class is removed structurally, for every current language and every future
walker.

## Scope decision: unify the whole layer, not walkers only

The native node is consumed across the **entire** post-parse layer, not just the
codegraph walkers. Translating only walkers would (a) leave the chunker on
native nodes — its hooks also call `childForFieldName`/`.parent`, so chunking
keeps the latent hazard — and (b) introduce two node types with perpetual
conversion. We unify ALL consumers onto a single `AstNode`. The native
`SyntaxNode` is touched ONLY by the materializer.

### Consumer surface (audited)

- **Chunker core** — `chunker/tree-sitter.ts` (`findChunkableNodes`,
  `processChildren`, `chunkWithChildExtraction`, classifier dispatch,
  intermediate-scope `.parent` walk).
- **Per-language chunking hooks** — `domains/language/<lang>/chunking/*`
  (`rspec-scope-chunker`, `test-scope-chunker`, `class-body-chunker`,
  `rspec-filter`, js `symbol-resolver`, ruby `macros`).
- **Kernel** — `domains/language/kernel/collect-symbols.ts`, ruby
  `walker/ast-utils.ts` (`walk`).
- **Codegraph walkers + `nameOf`** — `domains/language/<lang>/walker/*`.
- **Contracts** — `contracts/types/language.ts`, `contracts/types/chunker.ts`
  (`WalkInput.tree`, `HookContext.containerNode`, `ExtractionPass.run`,
  `nameOf`, `isInstanceMethod`).

The codegraph provider's direct-mode `extractOneFile`
(`trajectory/codegraph/symbols/provider.ts`) parses + walks too; it must
materialize on the same boundary so the `reindex_changes` path is equally
deterministic.

## The `AstNode` contract

`AstNode` mirrors the exact subset of `Parser.SyntaxNode` the audit found in use
— 16 members, no cursors, no `descendantsOfType`/`id`/`equals`, only
`previousNamedSibling` among siblings. Mirroring the API by name makes the
migration a near-mechanical annotation swap: call sites are unchanged, only the
declared type flips.

```ts
// src/core/contracts/types/ast.ts  (new)
export interface AstNode {
  readonly type: string;
  /** Source slice — getter over the shared code string: code.slice(startIndex, endIndex). NOT stored per node. */
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: readonly AstNode[];
  readonly namedChildren: readonly AstNode[];
  readonly childCount: number;
  readonly namedChildCount: number;
  child(index: number): AstNode | null;
  namedChild(index: number): AstNode | null;
  childForFieldName(field: string): AstNode | null;
  readonly parent: AstNode | null;
  readonly previousNamedSibling: AstNode | null;
}

/** Thin mirror of Parser.Tree's single used accessor. */
export interface MaterializedTree {
  readonly rootNode: AstNode;
}
```

Notes:

- `text` is a getter that slices a single shared `code` string by
  `startIndex`/`endIndex` — no per-node string storage (avoids the O(source ×
  depth) blowup of storing each node's text).
- `parent` and `previousNamedSibling` are back-references set during the build
  pass (not re-derived on access).
- `childForFieldName` reads from a per-node `fields` map captured eagerly during
  the build (the proven-deterministic access pattern).

## The materializer (the boundary)

```ts
// src/core/domains/ingest/pipeline/chunker/materialize.ts  (new, or kernel-side)
export function materializeTree(
  nativeRoot: Parser.SyntaxNode,
  code: string,
): AstNode;
```

- ONE eager top-down pass over the native tree. Per native node, construct a
  `MaterializedNode` capturing: `type`, `startIndex`, `endIndex`,
  `startPosition`, `endPosition`, `children[]` + `namedChildren[]` (both arrays
  — refs are cheap), `fields` (field name → child), `parent` (back-ref),
  `previousNamedSibling`. `text` is a getter over `code`.
- Lives in `chunkWithTree` immediately after `parser.parse(code)`. Returns the
  `AstNode` root that BOTH `findChunkableNodes` and the walker consume. The
  native `Tree` is dropped right after materialization (no native node escapes).
- The codegraph `extractOneFile` direct path materializes on the same function.

### Memory

Per node ≈ `type` (shared interned string), 6 numbers, 2 reference arrays, a
small `fields` map, 2 references ≈ 100–150 B. d3.js (268 KB, ~130k nodes) ≈
15–20 MB transient, **per file, freed after the walk**. The native tree (same
order of magnitude) already lived there during the walk; net peak increase is
modest. Text is never duplicated (sliced on demand).

### Open implementation detail (resolve in the plan)

Field capture — how the materializer learns each child's field name without a
hardcoded per-grammar list:

1. **Generic `fieldNameForChild(i)` loop** — for each child index, call
   `node.fieldNameForChild(i)`; build `fields`. Simple, but an extra native call
   per child.
2. **Internal `TreeCursor`** — a single forward cursor walk yields
   `cursor.currentFieldName` per child for free and is the most efficient full
   traversal. The cursor is used ONLY inside the materializer; no downstream
   consumer sees it.

Recommendation: (2) — one cursor pass materializes structure + fields in a
single efficient traversal. The plan validates that the chosen capture is
deterministic with a DECIDER-style test (materialize ×N → identical) before the
consumer migration.

## Migration

Additive-first, build green at every step, per
`.claude/rules/domains-language.md`:

1. Introduce `AstNode` / `MaterializedTree` (contracts) + `materializeTree`
   (new), with unit tests + a determinism guard. No consumer change. Build
   green.
2. Flip `chunkWithTree` to materialize after parse and return the `AstNode`
   root; internally adapt `findChunkableNodes` to the new type.
3. Swap `Parser.SyntaxNode` → `AstNode` in contracts (`WalkInput.tree` →
   `MaterializedTree`, `HookContext.containerNode`, `ExtractionPass.run`,
   `nameOf`, `isInstanceMethod`).
4. Swap consumers domain-by-domain: chunker core → each chunking hook → each
   walker → `collectSymbols` / `ast-utils`. API-mirroring keeps each file a
   minimal, near-mechanical change.
5. `extractOneFile` (codegraph direct path) materializes on the same boundary.

### Test-example preservation (mandatory)

Per `.claude/rules/domains-language.md` and the `refactor-migration-test-order`
memory: this is a relocation/type-swap, NOT a behavior change for the walkers'
extraction logic — **preserve every walker and chunker test example**
(`it`/`describe`), adapt only imports/setup. Validate per-file `it`/`describe`
counts are `>=` base; nothing dropped. Test helpers that build nodes from a real
tree-sitter parse now materialize the tree first. The ONLY behavior change is
determinism: previously-flaky call counts become their stable clean value (e.g.
ruby `service_1` = 109).

## Testing

- The rdv7d repro tests (carryover / in-process / SAME-tree / pool) go **GREEN**
  — call counts become stable.
- DECIDER stays green (documents the rationale).
- New determinism guard: `materializeTree` → walk N× → byte-identical extraction
  (regression sentinel).
- All existing chunker + walker test examples preserved and green (count
  validation).
- Live integration (per yl9tv Task 5b dual-path): `force_reindex` ruby project
  ×2 → stable `callsAttempted`; `reindex_changes` ×2 → no regression (covers the
  `extractOneFile` path).

## Affected files

| File                                                        | Change                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `contracts/types/ast.ts` (new)                              | `AstNode`, `MaterializedTree` interfaces                                          |
| `chunker/materialize.ts` (new)                              | `materializeTree` eager single-pass                                               |
| `chunker/tree-sitter.ts`                                    | materialize after parse; `findChunkableNodes`/`processChildren` consume `AstNode` |
| `contracts/types/language.ts`, `contracts/types/chunker.ts` | swap node param/return types to `AstNode` / `MaterializedTree`                    |
| `domains/language/kernel/collect-symbols.ts`                | consume `AstNode`                                                                 |
| `domains/language/<lang>/walker/*` (7 langs)                | `nameOf` + walk consume `AstNode`                                                 |
| `domains/language/<lang>/chunking/*`                        | hooks consume `AstNode`                                                           |
| `domains/language/ruby/walker/ast-utils.ts`                 | `walk` over `AstNode`                                                             |
| `trajectory/codegraph/symbols/provider.ts`                  | `extractOneFile` materializes                                                     |
| tests (chunker + walker + kernel)                           | adapt setup to materialize; preserve all examples                                 |

## Alternatives considered

- **Surgical per-walker** (thread parent/field context top-down, drop `.parent`
  in each walker) — touches the same deep-silo surface, per-language, and can
  never be _proven_ to have caught every fragile accessor. Rejected for the
  uniform boundary.
- **Bump/pin node-tree-sitter** — cheap to check first; unlikely to fully close
  a long-standing GC/node-validity behavior. Not mutually exclusive — may be run
  as a pre-check, but the boundary is the durable fix.
- **web-tree-sitter (WASM)** — could fix determinism and thread-safety (might
  retire the process pool), but the largest migration, unproven for this bug,
  separate epic.

## Constraints

- Language-agnostic: one materializer fixes all languages + the chunker.
- Keep tree-sitter (no WASM in this epic).
- Preserve behavior exactly except determinism (flaky counts → stable clean
  value).
- Per `domains-language.md`: preserve all walker/chunker test examples; validate
  `it`/`describe` counts `>=` base.
- The DECIDER result is the design's foundation: an eager single-pass capture is
  deterministic.
