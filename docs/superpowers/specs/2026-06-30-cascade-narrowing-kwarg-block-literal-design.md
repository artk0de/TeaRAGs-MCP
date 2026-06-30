# Tier-2+3 Cascade Narrowing — Kwarg + Block + Literal + Persistence — Design

**Beads:** `tea-rags-mcp-d9o7o` (Tier-2+3 narrowers) + `tea-rags-mcp-tfepp`
(persist def-shape signature to `cg_symbols`) · parent program `cai0` · direct
continuation of `tea-rags-mcp-xlnub`
(`2026-06-30-dynamic-dispatch-fanout-narrowing-design.md`).

**Goal:** Deepen the xlnub untyped-dispatch narrowing cascade with three more
always-present static narrowers (no LSP / Sorbet / RBS), and make the whole
def-shape signature (arity + visibility from xlnub, kwargs + block from here)
survive a daemon cold-start incremental reindex by persisting it to
`cg_symbols`. Precision-first; the **conservatism invariant is non-negotiable**:
drop a candidate ONLY on PROVEN incompatibility (or, for block, near-certain
mismatch that never empties the set); missing evidence ⇒ keep.

## Background — what xlnub landed

xlnub replaced `RubyDynamicDispatchResolver`'s unconditional
`candidates.map(→edge)` tail with a **neutral narrowing cascade** in
`domains/language/kernel/dispatch-narrowing.ts`:

- `interface DispatchCandidateNarrower { narrow(call, candidates, ctx): SymbolDefinition[] }`
- `ArityNarrower` — keep `c` iff `c.arity` can accept `call.argCount`
  (`n < minRequired` ⇒ drop; `!hasSplat && n > maxPositional` ⇒ drop).
- `VisibilityNarrower` — explicit-receiver call cannot reach a `private` method.
- `DuckVocabularyNarrower(vocab)` — member in the language runtime vocabulary ⇒
  empty the whole fan-out.
- `resolveNarrowedFanout(call, candidates, ctx, narrowers, discount)` — runs the
  cascade then the consumer-split terminal (1 survivor → 1.0; m>1 → discount/m;
  0 → []).
- Ruby wiring:
  `RubyDynamicDispatchResolver.narrowers = [DuckVocabulary, Arity, Visibility]`.

Substrate already present (commit `de138631`):
`AritySignature { minRequired, maxPositional, hasSplat }` (positional-only by
contract — kwargs / block params explicitly excluded),
`SymbolDefinition.arity?` + `.visibility?` (flat siblings), `CallRef.argCount?`.
Walker capture: `collectRubyMethodSignatures` (per-line `{arity, visibility}`),
`computeRubyArity` (counts `identifier`/`optional_parameter`/`splat_parameter`,
ignores `keyword_parameter`/`hash_splat_parameter`/`block_parameter`),
`computeArgCount` (excludes `pair` kwargs and `block`/`do_block`).

## The gap this spec closes

1. **Kwarg names are sharper than positional count.** `def m(a, b:, c:)`
   requires kwargs `{b, c}`; a call `x.m(1, b: 2)` omits required `c:` with no
   `**` to supply it → `ArgumentError` at runtime → wrong target → droppable.
   xlnub's `ArityNarrower` is positional-only and never sees this.
2. **Block presence discriminates.** A call passing a block (`x.each { … }`)
   among same-short-name candidates strongly favours definers that yield/take a
   block over those that never do. (NOT a hard incompatibility — Ruby silently
   ignores an unused block — so this is a precision heuristic, see invariant.)
3. **Literal receivers leak coincidental in-project edges.** `"s".upcase` /
   `[].map` fall through to short-name fan-out (literal ≠ constant ≠ local
   binding), so a coincidental in-project `def upcase` becomes a false `dynamic`
   edge. The receiver's core type is statically certain.
4. **Persistence gap (tfepp).** `arity`/`visibility` flow correctly
   walker→provider→`InMemoryGlobalSymbolTable`→`lookupByShortName`→narrowers on
   a FULL `--force` reindex, but are NOT persisted to `cg_symbols`.
   `upsertSymbolsImpl` (`client.ts:411`) INSERTs only
   `(rel_path, symbol_id, fq_name, short_name, scope_json)`; `listAllSymbols`
   (`client.ts:694`) SELECTs the same 5. On a daemon cold-start INCREMENTAL
   reindex, candidates from UNCHANGED files hydrate WITHOUT arity/visibility →
   `ArityNarrower` / `VisibilityNarrower` degrade to no-op for them
   (`DuckVocabularyNarrower` still fires — it keys on `call.member`).
   Precision-SAFE (conservative keep → wider residual, never a false narrow) but
   narrowing recall degrades vs full reindex. The same fate awaits the new
   kwargs/block facets unless persisted.

## Design

### 1. Persistence first (tfepp) — one migration carries the full def-shape set

Doing persistence first means each narrower's walker capture auto-persists as it
lands; one migration, no follow-up `009`.

- **Migration `008-cg-symbols-arity-visibility`** (database pipeline,
  `infra/migration/database/migrations/`): add four nullable columns to
  `cg_symbols` — `arity_json VARCHAR`, `visibility VARCHAR`,
  `kwargs_json VARCHAR`, `accepts_block BOOLEAN`. Nullable covers existing rows
  and non-method symbols. `ALTER TABLE … ADD COLUMN IF NOT EXISTS` per column,
  idempotent.
- `DuckDbGraphClient.upsertSymbolsImpl` (`client.ts:395-420`): extend the INSERT
  column list + bind `JSON.stringify(def.arity ?? null)`,
  `def.visibility ?? null`, `JSON.stringify(def.kwargs ?? null)`,
  `def.acceptsBlock ?? null`.
- `DuckDbGraphClient.listAllSymbols` (`client.ts:687-702`): SELECT the four new
  columns; round-trip — `arity_json`/`kwargs_json` via `JSON.parse` (guard
  `null`/`"null"`), `visibility` verbatim, `accepts_block` as boolean. Attach to
  the returned `SymbolDefinition` only when non-null (preserve the
  optional-field shape: `...(arity ? { arity } : {})`).
- **`arity_json` + `visibility` alone CLOSE tfepp.** `kwargs_json` /
  `accepts_block` columns ship in the same migration but are populated by Tasks
  2-3; until then they round-trip `null` harmlessly.

### 2. Kwarg-name narrowing (d9o7o 2a)

- **Contracts** (`contracts/types/codegraph.ts`):
  - `interface KwargSignature { required: string[]; hasSplat: boolean }` —
    `required` = required-kwarg names (no default); `hasSplat` = def has
    `**opts`. (Optional-kwarg names are NOT captured here — the
    extra-unknown-key direction is deferred to Spec #2.)
  - `SymbolDefinition.kwargs?: KwargSignature` (flat sibling; `AritySignature`
    stays positional-only).
  - `CallRef.kwargKeys?: string[]` — kwarg key names at the call site.
  - `CallRef.hasKwargSplat?: boolean` — call passes `**opts` (unknown runtime
    keys could supply any required kwarg).
- **Walker def-side** (extend `collectRubyMethodSignatures` / sibling of
  `computeRubyArity`): collect `keyword_parameter` child names where the node
  has NO default value → `required`; `hash_splat_parameter` present →
  `hasSplat`. Colocated with the existing per-line `{arity, visibility}`
  capture.
- **Walker call-side** (where `computeArgCount` runs, `walker.ts:1300`): collect
  `pair`-node key names from the argument list → `kwargKeys`; detect
  `hash_splat_argument` (`**opts`) → `hasKwargSplat`.
- **`KwargNarrower`** (kernel):
  ```
  narrow(call, candidates) {
    if (call.kwargKeys === undefined || call.hasKwargSplat) return candidates;
    const have = new Set(call.kwargKeys);
    return candidates.filter((c) =>
      !c.kwargs || c.kwargs.required.every((k) => have.has(k)));
  }
  ```
  Drop `c` ⟺ `c.kwargs` defined ∧ call has no double-splat ∧ ∃ required kwarg ∉
  call keys (PROVEN `ArgumentError` → hard-incompat). Omitted-required direction
  only. `c.kwargs.hasSplat` is captured + persisted but unused by v1's narrow
  (reserved for the deferred extra-key direction).

### 3. Block-presence narrowing (d9o7o 2b)

- **Contracts**: `SymbolDefinition.acceptsBlock?: boolean`;
  `CallRef.passesBlock?: boolean`.
- **Walker def-side**: `acceptsBlock = hasBlockParam ∨ bodyContainsYield`.
  `hasBlockParam` = a `block_parameter` (`&blk`) child of the def's params;
  `bodyContainsYield` = a `yield` node anywhere in the method body. If neither →
  `false` (proven non-yielding); the union is reliably `false` only when we are
  certain, so an undetected forwarding never produces a false `false`. (`&block`
  is detected; `yield` is detected; the residual unknowns keep `acceptsBlock`
  defined-false only on real evidence.)
- **Walker call-side**: `passesBlock` = the call has a `block` or `do_block`
  child (already distinguished inside `computeArgCount`).
- **`BlockNarrower`** (kernel) — **discriminate-only** (LOCKED): block presence
  is legal-but-unused in Ruby, so it never empties the set:
  ```
  narrow(call, candidates) {
    if (!call.passesBlock) return candidates;
    const yielders = candidates.filter((c) => c.acceptsBlock !== false);
    return yielders.length > 0 ? yielders : candidates;
  }
  ```
  Keeps `acceptsBlock === true` and `undefined`; drops only PROVEN non-yielders,
  and only while ≥1 yielder survives. All-non-yielding ⇒ keep all (block is
  defensive or yield-detection missed) — consistent with "missing data → keep".

### 4. Literal-receiver narrowing (d9o7o Tier-3) — last, smallest, cuttable

- **`LiteralReceiverNarrower(classify)`** (kernel;
  `classify: (receiver: string) => string | null` injected, language-specific):
  - Ruby `classify`: `"…"`→`String`, `[…]`→`Array`, `{…}`→`Hash`, `:…`→`Symbol`,
    integer→`Integer`, float→`Float`, `true`/`false`→nil-out (skip), else
    `null`.
  - `narrow`: `const t = classify(call.receiver); if (!t) return candidates;`
    keep candidates whose enclosing class (last `scope` segment / fqName owner)
    is `t` — an **in-project reopen** of the core type; none ⇒ `[]` (every
    candidate is a coincidental same-name method on another class → wrong for a
    core-typed receiver). The literal→type map is Ruby-specific (DI mirrors
    `DuckVocabularyNarrower(vocab)`); the `scope == t` comparison is neutral.
- Lowest value (core types are mostly external); if time-boxed this task is cut
  without touching Tasks 1-3.

### 5. Cascade wiring

`RubyDynamicDispatchResolver.narrowers = [DuckVocabulary, LiteralReceiver, Arity, Kwarg, Visibility, Block]`.
Ordering rationale:

- `DuckVocabulary`, `LiteralReceiver` first — cheapest, can empty the fan-out
  fast (runtime vocab / core-typed receiver).
- `Arity`, `Kwarg`, `Visibility` — hard proven-incompatibility filters.
- `Block` LAST — discriminate-only tie-breaker; must run after the hard filters
  so its "keep all if no yielders" sees the already-narrowed set.

## Conservatism invariant (cascade contract)

| Narrower        | Drops on                                        | Can empty set?      |
| --------------- | ----------------------------------------------- | ------------------- |
| DuckVocabulary  | member ∈ runtime vocab                          | yes (whole fan-out) |
| LiteralReceiver | core-typed receiver, no in-project reopen       | yes                 |
| Arity           | positional count incompatible (ArgumentError)   | yes                 |
| Kwarg           | required kwarg omitted, no `**` (ArgumentError) | yes                 |
| Visibility      | explicit receiver → `private`                   | yes                 |
| Block           | proven non-yielder **while yielders remain**    | **no**              |

Every narrower keeps a candidate on missing evidence (`undefined` field).

## Deferred (Spec #2 / separate beads)

- **2c self/lexical tightening** — NOT in this cascade: `resolveDispatch`
  returns `[]` for `self` / implicit-self / constant / typed-local; those are
  owned by the exact / bare-call path (`RubyBareCallSymbolResolutionStrategy`).
  A different resolver path.
- **Extra-unknown-kwarg direction** — needs the full declared-kwarg name set
  (required + optional) and extends `KwargNarrower` / `KwargSignature`; lands in
  Spec #2 and rebases onto this spec's kwarg substrate.

## Testing

- TDD per kernel narrower
  (`tests/core/domains/language/kernel/dispatch-narrowing.test.ts`): red→green
  unit cases for `KwargNarrower` (omitted-required drop; `**` splat keep;
  `undefined` keep), `BlockNarrower` (discriminate; all-non-yield keep; no-block
  keep), `LiteralReceiverNarrower` (reopen keep; coincidental empty; unknown
  literal keep).
- Walker-capture tests: extend the Ruby walker tests for kwarg names / `**` /
  block-param / `yield` / call-site `pair` keys / `block` presence. **Preserve
  existing examples** (migration test rule — validate `it`/`describe` counts
  `>=` base, nothing dropped).
- Persistence round-trip test (`client` / graph-db test): upsert a
  `SymbolDefinition` carrying all four facets → `listAllSymbols` returns them
  intact; null/non-method symbols round-trip clean.
- Migration test: `008` applies, is idempotent, columns present.
- **Live validation** (user-gated reindex) on a Ruby bench (mastodon / huginn /
  octokit): fan-out residual ↓, `resolveSuccessRate` non-regressing, ZERO
  false-narrow (precision-safe). Cold-start incremental reindex confirms
  arity/kwargs/block survive (tfepp): re-measure narrowing recall == full
  reindex.

## Files

- `src/core/contracts/types/codegraph.ts` — `KwargSignature`,
  `SymbolDefinition.kwargs?`/`.acceptsBlock?`, `CallRef.kwargKeys?`/
  `.hasKwargSplat?`/`.passesBlock?`.
- `src/core/domains/language/kernel/dispatch-narrowing.ts` — `KwargNarrower`,
  `BlockNarrower`, `LiteralReceiverNarrower`.
- `src/core/domains/language/ruby/walker/walker.ts` — def-side kwarg/block
  capture, call-side kwarg/block capture, Ruby literal classifier.
- `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  — cascade wiring (add 3 narrowers).
- `src/core/adapters/duckdb/client.ts` — `upsertSymbolsImpl` / `listAllSymbols`
  4-column extension.
- `src/core/infra/migration/database/migrations/008-cg-symbols-arity-visibility.ts`
  — new migration + registration in the database migration runner.
- Test mirrors under `tests/core/…`.
