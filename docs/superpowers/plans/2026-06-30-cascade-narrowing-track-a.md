# Tier-2+3 Cascade Narrowing (Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or dinopowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add kwarg-name, block-presence, and literal-receiver narrowers to the xlnub untyped-dispatch cascade, and persist the full def-shape signature (arity/visibility/kwargs/block) to `cg_symbols` so narrowing survives a daemon cold-start incremental reindex.

**Architecture:** New optional contract fields (`KwargSignature`, `SymbolDefinition.kwargs?/.acceptsBlock?`, `CallRef.kwargKeys?/.hasKwargSplat?/.passesBlock?`) captured by the Ruby walker, threaded through the codegraph provider into both the in-memory symbol table AND DuckDB (`cg_symbols`), then consumed by three new neutral `DispatchCandidateNarrower`s appended to the cascade.

**Tech Stack:** TypeScript (ESM), tree-sitter-ruby, DuckDB (graph DB), vitest.

## Global Constraints

- **Conservatism invariant:** every narrower drops ONLY on PROVEN incompatibility; `undefined`/missing evidence ⇒ keep. `BlockNarrower` never empties the set.
- **DB migration number is `012`** — `008`-`011` are already taken by `cg-run-stats-*`. Migrations are SQL-string entries in `DATABASE_MIGRATIONS` (`infra/migration/database/migrations/index.ts`), each a `.ts` export + a mirrored `.sql` file. NOT the Qdrant `schema`/`Migration`-class pipeline.
- **`AritySignature` stays positional-only** — kwargs/block are separate fields.
- **Walker test rule:** preserve existing `it`/`describe` examples; new behaviour adds cases, never rewrites business-logic cases. Validate counts `>=` base.
- **No `eslint-disable`, no lowered coverage thresholds.** Fix the code.
- All worktree work is `npm run build && npm link` paired; reindex/live-validation is user-gated (4 active worktrees → never auto-build).

---

### Task 1: Persistence foundation + all contract fields (closes tfepp)

Touch the high-blast hub `codegraph.ts` ONCE — add every new optional field now; later tasks only populate them. Land migration 012 + client round-trip so arity/visibility (xlnub) AND the kwargs/block columns persist from the start.

**Files:**
- Modify: `src/core/contracts/types/codegraph.ts` (`AritySignature` block ~628, `SymbolDefinition` ~634, `CallRef` ~551, `ChunkExtraction` ~486)
- Create: `src/core/infra/migration/database/migrations/012-cg-symbols-arity-visibility.ts`
- Create: `src/core/infra/migration/database/migrations/012-cg-symbols-arity-visibility.sql`
- Modify: `src/core/infra/migration/database/migrations/index.ts` (register 012)
- Modify: `src/core/adapters/duckdb/client.ts` (`upsertSymbolsImpl` 395-420, `listAllSymbols` 687-702)
- Test: `tests/core/adapters/duckdb/client.test.ts` (or the existing graph-db round-trip test)

**Interfaces:**
- Produces: `KwargSignature { required: string[]; hasSplat: boolean }`; `SymbolDefinition.kwargs?: KwargSignature`; `SymbolDefinition.acceptsBlock?: boolean`; `CallRef.kwargKeys?: string[]`; `CallRef.hasKwargSplat?: boolean`; `CallRef.passesBlock?: boolean`; `ChunkExtraction.kwargs?`/`.acceptsBlock?` (mirroring existing `arity?`/`visibility?`). Persisted columns `arity_json`, `visibility`, `kwargs_json`, `accepts_block`.

- [ ] **Step 1: Add the contract fields**

In `src/core/contracts/types/codegraph.ts`, after the `AritySignature` interface add:

```ts
/** Keyword-arg envelope of a method definition (bd d9o7o). `required` = kwarg
 *  names with NO default (must be supplied); `hasSplat` = a `**opts` rest param
 *  (accepts arbitrary keys). Positional arity lives in AritySignature. */
export interface KwargSignature {
  required: string[];
  hasSplat: boolean;
}
```

In `SymbolDefinition` (after `visibility?`):

```ts
  kwargs?: KwargSignature;
  /** Method yields or takes an `&block` param (statically visible). `false` =
   *  PROVEN non-yielder; `undefined` = not captured / non-method. (bd d9o7o) */
  acceptsBlock?: boolean;
```

In `CallRef` (after `argCount?`):

```ts
  /** Keyword-arg key names at the call site (bd d9o7o). */
  kwargKeys?: string[];
  /** Call passes a `**opts` double-splat — unknown runtime keys (bd d9o7o). */
  hasKwargSplat?: boolean;
  /** Call passes a block (`{ … }` / `do … end`) (bd d9o7o). */
  passesBlock?: boolean;
```

In `ChunkExtraction`, mirror `arity?`/`visibility?` with `kwargs?: KwargSignature;` and `acceptsBlock?: boolean;` (so the walker can attach them to the chunk and the provider can thread them).

- [ ] **Step 2: Run tsc to confirm additive (no break across the 9 importers)**

Run: `npx tsc --noEmit`
Expected: PASS (optional fields are additive).

- [ ] **Step 3: Create migration 012 `.ts`**

`src/core/infra/migration/database/migrations/012-cg-symbols-arity-visibility.ts`:

```ts
/**
 * Codegraph schema — persist def-shape signature on cg_symbols (bd tfepp/d9o7o).
 *
 * arity/visibility (xlnub) + kwargs/block (d9o7o) flow walker→provider→symbol
 * table on a FULL reindex but were never persisted, so a daemon cold-start
 * INCREMENTAL reindex hydrated unchanged-file candidates without them and the
 * arity/visibility/kwarg/block narrowers degraded to no-op. Persist all four.
 *
 * All nullable (existing rows + non-method symbols). DuckDB rejects NOT NULL on
 * ALTER ADD COLUMN; NULL = "unknown" which the narrowers already treat as keep.
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_012_CG_SYMBOLS_ARITY_VISIBILITY = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS arity_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS visibility VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS kwargs_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS accepts_block BOOLEAN;
`;
```

- [ ] **Step 4: Create the mirrored `.sql`**

`012-cg-symbols-arity-visibility.sql` — identical SQL body (the four `ALTER TABLE … ADD COLUMN IF NOT EXISTS …;` lines).

- [ ] **Step 5: Register migration 012 in the barrel**

In `migrations/index.ts`: add the import after `011` and the array entry after the `011` row:

```ts
import { SQL_012_CG_SYMBOLS_ARITY_VISIBILITY } from "./012-cg-symbols-arity-visibility.js";
// …
  { filename: "012-cg-symbols-arity-visibility.sql", sql: SQL_012_CG_SYMBOLS_ARITY_VISIBILITY },
```

- [ ] **Step 6: Write the failing client round-trip test**

In `tests/core/adapters/duckdb/client.test.ts`, add (matching the file's existing setup):

```ts
it("round-trips arity/visibility/kwargs/acceptsBlock through cg_symbols", async () => {
  await client.upsertSymbols("a.rb", [{
    symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "a.rb",
    scope: ["Foo"], arity: { minRequired: 1, maxPositional: 2, hasSplat: false },
    visibility: "private", kwargs: { required: ["b"], hasSplat: false }, acceptsBlock: true,
  }]);
  const [def] = (await client.listAllSymbols()).filter((d) => d.symbolId === "Foo#bar");
  expect(def.arity).toEqual({ minRequired: 1, maxPositional: 2, hasSplat: false });
  expect(def.visibility).toBe("private");
  expect(def.kwargs).toEqual({ required: ["b"], hasSplat: false });
  expect(def.acceptsBlock).toBe(true);
});

it("round-trips a non-method symbol with all def-shape fields null", async () => {
  await client.upsertSymbols("b.rb", [{
    symbolId: "Bar", fqName: "Bar", shortName: "Bar", relPath: "b.rb", scope: [],
  }]);
  const [def] = (await client.listAllSymbols()).filter((d) => d.symbolId === "Bar");
  expect(def.arity).toBeUndefined();
  expect(def.kwargs).toBeUndefined();
  expect(def.acceptsBlock).toBeUndefined();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/client.test.ts -t "round-trips arity"`
Expected: FAIL (columns/round-trip not wired).

- [ ] **Step 8: Extend `upsertSymbolsImpl` INSERT**

In `client.ts` `upsertSymbolsImpl`, change the INSERT to the 9-column form:

```ts
await this.run(
  "INSERT OR IGNORE INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json, arity_json, visibility, kwargs_json, accepts_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  [def.relPath, def.symbolId, def.fqName, def.shortName, JSON.stringify(def.scope ?? []),
   def.arity ? JSON.stringify(def.arity) : null,
   def.visibility ?? null,
   def.kwargs ? JSON.stringify(def.kwargs) : null,
   def.acceptsBlock ?? null],
);
```

- [ ] **Step 9: Extend `listAllSymbols` SELECT + round-trip**

```ts
const rows = await this.queryAll<{
  rel_path: string; symbol_id: string; fq_name: string; short_name: string; scope_json: string;
  arity_json: string | null; visibility: string | null; kwargs_json: string | null; accepts_block: boolean | null;
}>("SELECT rel_path, symbol_id, fq_name, short_name, scope_json, arity_json, visibility, kwargs_json, accepts_block FROM cg_symbols");
return rows.map((row) => ({
  relPath: row.rel_path, symbolId: row.symbol_id, fqName: row.fq_name,
  shortName: row.short_name, scope: parseScope(row.scope_json),
  ...(row.arity_json ? { arity: JSON.parse(row.arity_json) as AritySignature } : {}),
  ...(row.visibility ? { visibility: row.visibility as SymbolDefinition["visibility"] } : {}),
  ...(row.kwargs_json ? { kwargs: JSON.parse(row.kwargs_json) as KwargSignature } : {}),
  ...(row.accepts_block !== null ? { acceptsBlock: row.accepts_block } : {}),
}));
```

(Import `AritySignature`, `KwargSignature` types at the top of `client.ts` if not already.)

- [ ] **Step 10: Run the round-trip tests + tsc**

Run: `npx vitest run tests/core/adapters/duckdb/client.test.ts -t "round-trips" && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/core/contracts/types/codegraph.ts src/core/infra/migration/database/migrations/ src/core/adapters/duckdb/client.ts tests/core/adapters/duckdb/client.test.ts
git commit -m "feat(contracts): persist def-shape signature (arity/visibility/kwargs/block) to cg_symbols

Adds KwargSignature + SymbolDefinition.kwargs?/.acceptsBlock? + CallRef
kwarg/block fields (optional, additive) and migration 012 ALTERing cg_symbols
with arity_json/visibility/kwargs_json/accepts_block; upsert/listAllSymbols
round-trip all four. Closes tfepp (arity/visibility durability on incremental
reindex); kwargs/block columns populated by later tasks."
```

---

### Task 2: KwargNarrower + walker kwarg capture

**Files:**
- Modify: `src/core/domains/language/kernel/dispatch-narrowing.ts` (add `KwargNarrower`)
- Modify: `src/core/domains/language/ruby/walker/walker.ts` (def-side kwarg capture in `collectRubyMethodSignatures`/`computeRubyArity` sibling; call-side in the `computeArgCount` site ~1300)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (thread `c.kwargs` into `defs` ~744, mirroring `arity`)
- Modify: `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts` (add `KwargNarrower` import only; wiring in Task 5)
- Test: `tests/core/domains/language/kernel/dispatch-narrowing.test.ts`, `tests/core/domains/language/ruby/walker/ruby-walker.test.ts`

**Interfaces:**
- Consumes: `KwargSignature`, `CallRef.kwargKeys?/.hasKwargSplat?`, `SymbolDefinition.kwargs?` (Task 1).
- Produces: `export class KwargNarrower implements DispatchCandidateNarrower`.

- [ ] **Step 1: Write the failing KwargNarrower unit test**

In `dispatch-narrowing.test.ts` add a `describe("KwargNarrower", …)` with:

```ts
const def = (id: string, required: string[], hasSplat = false): SymbolDefinition =>
  ({ symbolId: id, fqName: id, shortName: id, relPath: "a.rb", scope: [], kwargs: { required, hasSplat } });
const callWith = (kwargKeys?: string[], hasKwargSplat?: boolean): CallRef =>
  ({ callText: "x.m", receiver: "x", member: "m", startLine: 1, kwargKeys, hasKwargSplat });

it("drops a candidate whose required kwarg the call omits", () => {
  const cs = [def("A", ["b", "c"]), def("B", ["b"])];
  expect(new KwargNarrower().narrow(callWith(["b"]), cs, ctx).map((c) => c.symbolId)).toEqual(["B"]);
});
it("keeps all when the call has a ** double-splat", () => {
  const cs = [def("A", ["b", "c"])];
  expect(new KwargNarrower().narrow(callWith(["b"], true), cs, ctx)).toHaveLength(1);
});
it("keeps candidates with no captured kwargs (missing data)", () => {
  const plain: SymbolDefinition = { symbolId: "P", fqName: "P", shortName: "P", relPath: "a.rb", scope: [] };
  expect(new KwargNarrower().narrow(callWith(["z"]), [plain], ctx)).toHaveLength(1);
});
it("keeps all when the call has no captured kwargKeys", () => {
  const cs = [def("A", ["b"])];
  expect(new KwargNarrower().narrow(callWith(undefined), cs, ctx)).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "KwargNarrower"`
Expected: FAIL (`KwargNarrower is not defined`).

- [ ] **Step 3: Implement `KwargNarrower`**

In `dispatch-narrowing.ts` (after `ArityNarrower`):

```ts
/** Drop a candidate whose REQUIRED kwarg the call omits (ArgumentError). A
 *  call `**`-splat (unknown runtime keys) or no captured keys ⇒ keep. */
export class KwargNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    if (call.kwargKeys === undefined || call.hasKwargSplat) return candidates;
    const have = new Set(call.kwargKeys);
    return candidates.filter((c) => !c.kwargs || c.kwargs.required.every((k) => have.has(k)));
  }
}
```

- [ ] **Step 4: Run KwargNarrower test to verify it passes**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "KwargNarrower"`
Expected: PASS.

- [ ] **Step 5: Write the failing walker kwarg-capture tests**

In `ruby-walker.test.ts`, add cases asserting that for source `def m(a, b:, c: 1, **opts); end`, the extracted method signature carries `kwargs: { required: ["b"], hasSplat: true }` (note `c:` has a default → NOT required); and that a call `x.m(1, b: 2, **h)` produces `kwargKeys: ["b"]`, `hasKwargSplat: true`. Use the existing `extractFromRubyFile` harness pattern in that file.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "kwarg"`
Expected: FAIL.

- [ ] **Step 7: Implement walker def-side kwarg capture**

In `walker.ts`, in the per-line method-signature collector (alongside `computeRubyArity`/`collectRubyMethodSignatures`), add a `computeRubyKwargs(methodNode): KwargSignature | undefined`: scan `parameters`/`method_parameters` `namedChildren`; for each `keyword_parameter`, read its name child — if the node has NO value child (no default) push to `required`; set `hasSplat=true` on a `hash_splat_parameter`. Return `undefined` when there are no kwarg params (keep payload lean). Attach to the per-line sig map and onto `base.kwargs` next to `base.arity`/`base.visibility`.

- [ ] **Step 8: Implement walker call-side kwarg capture**

At the `computeArgCount` call site (~1300), add: `kwargKeys` = the `pair`-node key texts in the argument list; `hasKwargSplat` = presence of a `hash_splat_argument` child. Assign `callRef.kwargKeys`/`callRef.hasKwargSplat` only when non-empty/true.

- [ ] **Step 9: Thread `kwargs` through the provider**

In `provider.ts` (~744, where `arity`/`visibility` are spread into `defs`), add `...(c.kwargs !== undefined ? { kwargs: c.kwargs } : {})`.

- [ ] **Step 10: Run walker + provider + narrower tests + tsc**

Run: `npx vitest run tests/core/domains/language/ruby/walker tests/core/domains/language/kernel/dispatch-narrowing.test.ts && npx tsc --noEmit`
Expected: PASS. Verify `it`/`describe` count in `ruby-walker.test.ts` is `>=` base.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(trajectory): kwarg-name narrowing (omitted-required) + walker kwarg capture"
```

---

### Task 3: BlockNarrower + walker block capture

**Files:**
- Modify: `src/core/domains/language/kernel/dispatch-narrowing.ts` (add `BlockNarrower`)
- Modify: `src/core/domains/language/ruby/walker/walker.ts` (def-side `acceptsBlock`; call-side `passesBlock` at the `computeArgCount` site)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (thread `c.acceptsBlock`)
- Test: `dispatch-narrowing.test.ts`, `ruby-walker.test.ts`

**Interfaces:**
- Consumes: `SymbolDefinition.acceptsBlock?`, `CallRef.passesBlock?` (Task 1).
- Produces: `export class BlockNarrower implements DispatchCandidateNarrower`.

- [ ] **Step 1: Write the failing BlockNarrower unit test**

```ts
const bdef = (id: string, acceptsBlock?: boolean): SymbolDefinition =>
  ({ symbolId: id, fqName: id, shortName: id, relPath: "a.rb", scope: [], acceptsBlock });
const callBlk = (passesBlock?: boolean): CallRef =>
  ({ callText: "x.m", receiver: "x", member: "m", startLine: 1, passesBlock });

it("keeps only yielders when a block is passed and yielders exist", () => {
  const cs = [bdef("A", true), bdef("B", false), bdef("C", undefined)];
  expect(new BlockNarrower().narrow(callBlk(true), cs, ctx).map((c) => c.symbolId)).toEqual(["A", "C"]);
});
it("keeps ALL when no candidate yields (defensive block / missed detection)", () => {
  const cs = [bdef("A", false), bdef("B", false)];
  expect(new BlockNarrower().narrow(callBlk(true), cs, ctx)).toHaveLength(2);
});
it("keeps all when the call passes no block", () => {
  const cs = [bdef("A", false)];
  expect(new BlockNarrower().narrow(callBlk(false), cs, ctx)).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "BlockNarrower"`
Expected: FAIL.

- [ ] **Step 3: Implement `BlockNarrower` (discriminate-only)**

```ts
/** Block presence is legal-but-unused in Ruby, so it DISCRIMINATES, never
 *  empties: when a block is passed, prefer yielders — unless none exist. */
export class BlockNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    if (!call.passesBlock) return candidates;
    const yielders = candidates.filter((c) => c.acceptsBlock !== false);
    return yielders.length > 0 ? yielders : candidates;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "BlockNarrower"`
Expected: PASS.

- [ ] **Step 5: Write the failing walker block-capture tests**

Assert: `def m; yield; end` → `acceptsBlock: true`; `def m(&blk); end` → `acceptsBlock: true`; `def m; 1; end` → `acceptsBlock: false`; a call `x.each { }` and `x.each do; end` → `passesBlock: true`; `x.each` → `passesBlock` undefined/false.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "block"`
Expected: FAIL.

- [ ] **Step 7: Implement walker def-side `acceptsBlock`**

In the method-signature collector: `acceptsBlock = hasBlockParam || bodyContainsYield`. `hasBlockParam` = a `block_parameter` in the params; `bodyContainsYield` = a `yield` node anywhere under the method body (depth walk). Set `false` when neither (proven non-yielder); attach onto `base.acceptsBlock`.

- [ ] **Step 8: Implement walker call-side `passesBlock`**

At the `computeArgCount` site: `passesBlock = true` when the call node has a `block` or `do_block` child (the same nodes `computeArgCount` already filters out). Assign only when true.

- [ ] **Step 9: Thread `acceptsBlock` through the provider**

In `provider.ts` (~744): `...(c.acceptsBlock !== undefined ? { acceptsBlock: c.acceptsBlock } : {})`.

- [ ] **Step 10: Run tests + tsc**

Run: `npx vitest run tests/core/domains/language/ruby/walker tests/core/domains/language/kernel/dispatch-narrowing.test.ts && npx tsc --noEmit`
Expected: PASS; walker `it`/`describe` count `>=` base.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(trajectory): block-presence narrowing (discriminate-only) + walker block capture"
```

---

### Task 4: LiteralReceiverNarrower + Ruby literal classifier

**Files:**
- Modify: `src/core/domains/language/kernel/dispatch-narrowing.ts` (add `LiteralReceiverNarrower`)
- Modify: `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts` (Ruby literal classifier + construct the narrower with it; full wiring in Task 5)
- Test: `dispatch-narrowing.test.ts`

**Interfaces:**
- Consumes: `SymbolDefinition.scope`, `CallRef.receiver`.
- Produces: `export class LiteralReceiverNarrower implements DispatchCandidateNarrower` taking `constructor(private classify: (receiver: string | null) => string | null)`.

- [ ] **Step 1: Write the failing unit test**

```ts
const classify = (r: string | null): string | null =>
  r === null ? null : r.startsWith('"') ? "String" : r.startsWith("[") ? "Array" : null;
const sdef = (id: string, scope: string[]): SymbolDefinition =>
  ({ symbolId: id, fqName: id, shortName: id, relPath: "a.rb", scope });
const litCall = (receiver: string): CallRef => ({ callText: `${receiver}.m`, receiver, member: "m", startLine: 1 });

it("keeps only in-project reopens of the literal's core type", () => {
  const cs = [sdef("String#m", ["String"]), sdef("Foo#m", ["Foo"])];
  expect(new LiteralReceiverNarrower(classify).narrow(litCall('"s"'), cs, ctx).map((c) => c.symbolId)).toEqual(["String#m"]);
});
it("empties the fan-out when no candidate reopens the core type", () => {
  const cs = [sdef("Foo#m", ["Foo"])];
  expect(new LiteralReceiverNarrower(classify).narrow(litCall('"s"'), cs, ctx)).toHaveLength(0);
});
it("keeps all when the receiver is not a recognised literal", () => {
  const cs = [sdef("Foo#m", ["Foo"])];
  expect(new LiteralReceiverNarrower(classify).narrow(litCall("user"), cs, ctx)).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "LiteralReceiverNarrower"`
Expected: FAIL.

- [ ] **Step 3: Implement `LiteralReceiverNarrower`**

```ts
/** A literal receiver (`"s".m`, `[].m`) has a statically-certain core type T.
 *  Keep only candidates that reopen T in-project; none ⇒ empty fan-out (every
 *  match is a coincidental same-name method on another class). `classify`
 *  returns the core type name or null (non-literal). */
export class LiteralReceiverNarrower implements DispatchCandidateNarrower {
  constructor(private readonly classify: (receiver: string | null) => string | null) {}
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    const t = this.classify(call.receiver);
    if (t === null) return candidates;
    return candidates.filter((c) => c.scope[c.scope.length - 1] === t);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/domains/language/kernel/dispatch-narrowing.test.ts -t "LiteralReceiverNarrower"`
Expected: PASS.

- [ ] **Step 5: Add the Ruby literal classifier**

In `ruby-dynamic-dispatch.ts` add a module-level `classifyRubyLiteralReceiver(r: string | null): string | null` — `"`/`'`→`String`, `[`→`Array`, `{`→`Hash`, `:`→`Symbol`, `/^\d+$/`→`Integer`, `/^\d+\.\d+$/`→`Float`, else `null` (skip `true`/`false`/`nil`). Unit-test it inline or in the strategy test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(language): literal-receiver narrowing (core-type reopen) + ruby classifier"
```

---

### Task 5: Cascade wiring + live-validation gate

**Files:**
- Modify: `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts` (the `narrowers` array)
- Test: `tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts`

**Interfaces:**
- Consumes: `KwargNarrower`, `BlockNarrower`, `LiteralReceiverNarrower` (Tasks 2-4), `classifyRubyLiteralReceiver` (Task 4).

- [ ] **Step 1: Write the failing wiring test**

In `ruby-dynamic-dispatch.test.ts`, add a case where an untyped receiver fans out to two same-short-name defs differing by required-kwarg / block / literal, and assert the cascade narrows to the compatible one (or empties on literal mismatch). Mirror the existing wbj3 dynamic-receiver test setup.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.test.ts -t "narrow"`
Expected: FAIL (new narrowers not wired).

- [ ] **Step 3: Wire the cascade**

In `ruby-dynamic-dispatch.ts`, update imports + the `narrowers` array:

```ts
import { ArityNarrower, BlockNarrower, DuckVocabularyNarrower, KwargNarrower, LiteralReceiverNarrower, resolveNarrowedFanout, VisibilityNarrower } from "../../../kernel/dispatch-narrowing.js";
// …
  private readonly narrowers = [
    new DuckVocabularyNarrower(RUBY_DUCK_VOCAB),
    new LiteralReceiverNarrower(classifyRubyLiteralReceiver),
    new ArityNarrower(),
    new KwargNarrower(),
    new VisibilityNarrower(),
    new BlockNarrower(),
  ];
```

- [ ] **Step 4: Run the wiring test + full kernel/walker/strategy suite + tsc**

Run: `npx vitest run tests/core/domains/language && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(language): wire kwarg/block/literal narrowers into the dynamic-dispatch cascade"
```

- [ ] **Step 6: Live-validation gate (USER-GATED — do NOT auto-run)**

Per `.local/mcp-testing.md` + the no-auto-build/reindex rules (4 active worktrees): pause and request the user to (a) `npm run build && npm link` this worktree, (b) reconnect MCP, (c) trigger a Ruby-bench reindex. Then measure via `tea-rags index-codebase --json` `byReceiverKind` + a fan-out residual count: residual ↓, `resolveSuccessRate` non-regressing, ZERO false-narrow. Also verify a cold-start INCREMENTAL reindex hydrates arity/kwargs/block from `cg_symbols` (tfepp) — narrowing recall == full reindex.

---

## Self-Review

- **Spec coverage:** T1 → persistence (§Design.1, closes tfepp) + all contract fields (§2/§3 contracts); T2 → KwargNarrower + walker kwarg (§2); T3 → BlockNarrower + walker block (§3); T4 → LiteralReceiverNarrower + classifier (§4); T5 → cascade wiring (§5) + live validation (§Testing). All spec sections mapped.
- **Placeholders:** none — every code step shows the code. Walker capture steps reference exact tree-sitter node types (`keyword_parameter`, `hash_splat_parameter`, `block_parameter`, `yield`, `block`/`do_block`, `pair`, `hash_splat_argument`) and the exact threading site (`provider.ts` ~744).
- **Type consistency:** `KwargSignature{required,hasSplat}`, `acceptsBlock?: boolean`, `kwargKeys?/hasKwargSplat?/passesBlock?` used identically across T1 (define) and T2-T5 (consume); narrower class names match the wiring in T5.
- **Migration number:** `012` (008-011 taken) — corrected from the spec's illustrative `008`. Spec to be annotated.
