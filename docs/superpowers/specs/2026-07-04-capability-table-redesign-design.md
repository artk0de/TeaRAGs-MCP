# Capability-Table Redesign (bd tea-rags-mcp-ifrrn)

**Date:** 2026-07-04 · **Status:** approved, release-blocking

Redesign the generated README "Languages Compatibilities" table so it reads as a
product-facing capability matrix, not an internal chunker-hook dump — and close
the descriptor-accuracy gaps found during review.

## Problem

The generated table (`capability/readme.ts` → README spoiler) has four issues:

1. **Too technical** — the AST cell lists raw hook names (`rspecFilter,
   commentCapture, rspecScopeChunker, bodyChunker`) that mean nothing to a
   reader.
2. **Flat / low signal** — no visual encoding of support level; hand-ordered
   language list (not capability-ranked).
3. **Content bugs** — Markdown is shown `partial` but is actually `full` (builds
   ToC, smart chunking); the Ruby descriptor string `"11-strategy + 4 dispatch
   components"` is stale vs the shipped 15-grammar DSL catalogue + fan-out cap +
   dispatch-narrowing.
4. **Collapsed & unlabelled** — the `<details>` spoiler shows only its summary
   until clicked; no legend for any visual scheme.

Underlying gap (separate follow-up): `gen:lang-compat` propagates
descriptor→docs and drift-guard guards *that*, but **nothing ties resolver CODE
→ the hand-written `capability.ts` descriptor** — so graph-improvement work can
silently leave the descriptor stale.

## Design

### 1. Mandatory hook short-descriptor

`LanguageCapability.ast.hooks` changes from `string[]` to
`{ name: string; short: string }[]`. `short` is **type-required** — a new hook
cannot be added to a descriptor without a real, short product phrase (what it
*does*: `"groups RSpec blocks"`, not the impl name). Lives in the hand-written
capability descriptor (contained, type-enforced, no coupling to the runtime
`ChunkingHook`). The AST cell renders the `short` phrases on a new line; raw hook
names are dropped from the README.

Blast radius (from tea-rags enrichment): the `LanguageCapability` contract
(`contracts/types/language.ts`, high-churn but bugFix-healthy), the ~5
descriptors with hooks (ts/js/go/rust/ruby), `readme.ts`, `rule.ts` if it reads
hooks, and `drift-guard`. All within the capability subsystem.

### 2. Capability-ranked row order

Rows sort by a lexicographic capability score, top-supported first:

```
score = codegraph*100 + ast*10 + tests
ast:    full 2 / partial 1 / none 0
tests:  high 3 / medium 2 / low 1 / na 0
codegraph: high 3 / moderate 2 / minimal 1 / none 0   (ruby typed → untyped tier)
```

Ties broken by a stable secondary (current DISPLAY order). Resulting bands:
TypeScript · JavaScript · Ruby (323) → Python · Go · Java · Rust (222) → Bash
(121) → Markdown (20) → sql · jsonc · json (0). Markdown lands above the
character-chunker languages (full AST) but below code languages (no call graph)
— the ranking resolves "where does Markdown go" naturally.

### 3. Moon-phase tier badges (distinct per tier)

Each tier keyword gets a distinct moon phase forming a fullness gradient
(fuller = more capable), so `full≠high` and `medium≠moderate` are visually
distinct:

```
maximum 🌕 · full 🌔 · high 🌖 · medium 🌓 · moderate 🌗 · partial 🌒 · low 🌒 · minimal 🌘 · none/N/A/TBD 🌑
```

Rendered as `<phase> **<tier>**` (bold keyword). Language names are
`***bold-italic***`.

### 4. Legend + summary hook

The `<summary>` toggle gains a moon emoji and a one-line legend appears
immediately inside the details, so the subtle gradient is self-documenting:

```markdown
<summary>🌗 Supported languages & support levels</summary>

**Support:** 🌕 maximum · 🌔 full · 🌖 high · 🌓 medium · 🌗 moderate · 🌒 partial/low · 🌘 minimal · 🌑 none
```

### 5. Content-accuracy fixes (descriptor edits)

- **Markdown** `ast.tier` `partial → full`; tech mentions ToC + smart chunking;
  codegraph stays `none` (no call graph).
- **Ruby** `codegraph.tech` rewritten from the shipped code — the 15-grammar DSL
  catalogue (`ruby/dsl/catalogue.ts`), fan-out cap, dispatch-narrowing — the
  exact string derived from the code at implementation time (NOT invented). Tier
  unchanged unless the audit shows a real move.

### 6. Scope boundaries

- `rule.ts` (agent-facing rule file) stays **plain** — no emoji/legend/short
  prose; agents want the machine tier. Emoji + short + legend are README-only.
- drift-guard stays green: regenerate both artefacts via `npm run
  gen:lang-compat`; the test already asserts README/rule == descriptor output.
- The moon mapping + tier→int score + hook short-render live in `readme.ts`
  (pure functions, unit-testable).

## Follow-up (separate bead)

A CI agent (`claude.yml`) reads resolver/strategy CODE and regenerates the
`capability.ts` `tier`/`tech` fields — closes the code→descriptor drift that
drift-guard does not catch (drift-guard only guards README/rule ↔ descriptor).

## Testing

- `readme.ts` unit tests: tier→moon mapping (each tier distinct on the flagged
  pairs), score/sort order (TS/JS/Ruby band first, Markdown above char-langs),
  hook short-render on a new line, legend + summary present.
- Contract: `hooks` structured shape compiles; `short` required (a descriptor
  missing it fails tsc).
- drift-guard: README + rule regenerated, test green.
- Descriptor accuracy: markdown FULL, ruby tech reflects the real catalogue.
