# Multi-Target Dispatch Resolution — Design

**Status:** Approved (brainstorming complete) **Date:** 2026-05-25 **Bead:**
tea-rags-mcp-n0zj **Area:**
`src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.ts`,
`src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.ts`,
`src/core/domains/trajectory/codegraph/symbols/provider.ts` (run-global
aggregation), `src/core/contracts/types/codegraph.ts` (new fields).

## Problem

The codegraph drops call edges that go through a **lookup-table dispatch**.
Canonical case (`provider.ts`):

```ts
const LANGUAGES: Record<string, LanguageConfig> = {
  ".ts": { walker: extractFromTypescriptFile, nameOf: tsNameOf /* … */ },
  ".rb": { walker: extractFromRubyFile /* … */ },
  // … 8 languages
};
const walker = LANGUAGES[ext].walker; // computed-member on a const object
walker(input); // ← edge DROPPED today
```

`ext` is a runtime value, so the resolver cannot statically pick an entry, and
`walker(input)` resolves to nothing. Consequence: every walker
(`extractFromTypescriptFile`, …) reports `get_callers = []`, `fanIn = 0`, and is
mislabeled as dead/peripheral by `architecturalHub` / bug-hunt / risk-assessment
— when it is in fact called by the core dispatcher. The pattern is common
(plugin registries, command maps, strategy/visitor tables); any such code shares
this blind spot.

The existing single-target channels (`localBindings: varName→one Type`,
`classFieldTypes`) cannot express "this value could be any of N functions", so a
new mechanism is required.

## Goal & scope

A **long-term, composable** mechanism — not a single-pattern matcher that
accrues corner-case patches. It must cover the dispatch-table **family** in one
model:

- **Table shapes:** S1 wrapper-object map `{ k: { field: fn } }` (select via
  `.field`); S2 direct-function map `{ k: fn }` (the entry IS the function).
- **Access patterns:** direct (`TABLE[k].field(x)`, `TABLE[k](x)`), field-bound
  (`const f = TABLE[k].field; f(x)`), entry-bound
  (`const e = TABLE[k]; e.field(x)`).
- **Key kinds:** dynamic key (`[ext]`) → fan-out to ALL entries; static
  string-literal key (`["ts"]`) → resolve to the ONE matching entry.
- **Locality:** in-file tables AND cross-file imported tables.
- **Bounded inter-procedural (callback parameter, single hop):** a dispatch
  candidate-set passed as a call **argument** to an in-repo function/method,
  bound to that callee's parameter, and **invoked via the parameter inside the
  callee** → fan-out edges from the callee to the candidates. Single hop only
  (arg → param → call); no function-return flow, no param→param chaining, no
  cross-file argument propagation (see Out of scope).

### Why these exactly — driven by real gaps in the tested repo

The `provider.ts` dispatcher exercises every covered case (and nothing beyond):

```ts
const langConfig = LANGUAGES[ext]; // entry-bound, dynamic key
parser.setLanguage(langConfig.loadParser()); // entry-bound field CALL  → covered (S1)
this.collectSymbols(tree, langConfig.nameOf /*…*/); // field passed as ARG, invoked
//   inside collectSymbols → callback-param
return langConfig.walker({
  /*…*/
}); // entry-bound field CALL  → covered (S1)
```

`walker` / `loadParser` (orphaned walkers — the bead's core symptom) are
entry-bound field calls → covered by the candidate-set model. `nameOf`
(`tsNameOf`, `rbNameOf`, … — orphaned the same way) is passed as a callback into
`collectSymbols` and invoked there → requires the bounded inter-procedural hop.
Together these close the entire LANGUAGES dispatch blind spot. The `resolvers`
Map (`factory.ts`) dispatches `.resolve()` through a `CallResolver`-typed
parameter — already resolved by the param-type fix (bead x6ta) — so it is not a
gap here.

Language: **TypeScript/JavaScript** walker+resolver in this iteration. The
contract additions are language-neutral so other walkers can opt in later
(YAGNI: no other-language walker emits them now).

## Core abstraction: candidate function set

Rather than pattern-matching one syntactic shape, the walker performs a tiny
**abstract interpretation** over "which functions could this expression be",
composing through `subscript → member → binding → call`:

1. **const tables** (in-file): record `{ k: fn }` (S2) and
   `{ k: { field: fn } }` (S1) preserving the key→value mapping.
2. **`TABLE[key]`** → candidate set: static literal key → the single matching
   entry; dynamic key → all entries.
3. **`.field`** applied to a candidate set of objects → narrows to that field's
   values.
4. **`const x = <expr>`** → `x` carries the candidate set (works for both
   field-bound and entry-bound — no special case).
5. **call** `<expr>(args)` / `x(args)` → the call dispatches to the candidate
   set.

Because resolution composes, bound/direct/entry-bound and S1/S2 are the SAME
mechanism — no new corner cases inside this class.

## Walker / resolver split (respects the walker contract)

Walkers **extract**, resolvers **resolve** (per
`.claude/rules/codegraph-walkers.md`). The walker never resolves names to
symbols — even for in-file tables. It emits:

1. The const dispatch **tables** it defines (raw entry→value names), and
2. On each dispatching `CallRef`, a **dispatch reference** (`table`, `field`,
   `key`).

The resolver, holding the **run-global** aggregate of all tables plus the
per-file import map, resolves every dispatch call uniformly — in-file and
cross-file collapse to one path.

### Contract additions (`contracts/types/codegraph.ts`)

```ts
// A const dispatch table defined in one file. Key→value preserves static-key
// precision. Value is either a function name (S2) or a field→fnName map (S1).
interface DispatchTable {
  entries: Record<string, string | Record<string, string>>;
}

interface FileExtraction {
  // … existing fields …
  dispatchTables?: Record<string, DispatchTable>; // tableName → table
  // Bounded inter-procedural: for each in-file function/method, the parameter
  // positions that are invoked as `param(...)` inside its body ("callback
  // params"). Keyed by the function's symbolId. Enables nameOf-style edges.
  callbackParams?: Record<string, number[]>; // fnSymbolId → invoked param indices
}

interface CallRef {
  // … existing callText/receiver/member/startLine …
  // Present when this call dispatches through a table. The resolver expands it
  // to fan-out edges. `field: null` ⇒ S2 (entry is the function directly).
  // `key: null` ⇒ dynamic key (fan-out all); a string ⇒ static literal key.
  dispatch?: { table: string; field: string | null; key: string | null };
  // Present when this call passes a dispatch candidate-set as an ARGUMENT. The
  // resolver joins it to the callee's callbackParams: if the callee invokes the
  // parameter at `argIndex`, the callee fans out to the candidates. Candidates
  // are dispatch references (resolved against run-global tables), mirroring
  // `dispatch` — so the arg may itself be `TABLE[k].field`.
  dispatchArgs?: Array<{
    argIndex: number;
    candidate: { table: string; field: string | null; key: string | null };
  }>;
}
```

`CallContext` gains optional `dispatchTables?: Record<string, DispatchTable>`
(run-global) and reuses the existing per-file import map for table-name
disambiguation.

### Walker (`typescript-walker.ts`)

New pure helpers (one populate site each, colocation rule):

- `collectDispatchTables(root)` → `Record<string, DispatchTable>`. Finds
  module/file-level `const NAME = { … }` (`lexical_declaration` const + `object`
  literal) whose values are object literals (S1) or plain identifiers (S2). For
  S1, only fields whose value is a plain identifier across entries are recorded;
  mixed/inline-arrow/non-identifier values drop that field/entry.
- Candidate-set tracking through `const` bindings in a function body: a local
  bound to `TABLE[key]` (entry-ref), `TABLE[key].field` (field-ref), tracked in
  a per-chunk map `name → { table, field|null, key|null }`.
- Call extraction sets `CallRef.dispatch` when the callee is (a) a tracked
  dispatch-bound local, or (b) a direct `TABLE[key].field(...)` /
  `TABLE[key](...)` member/subscript chain where `TABLE` is a name (resolved
  later as in-file or imported). The walker does NOT decide in-file vs imported
  — it records the table NAME; the resolver disambiguates.

tree-sitter-ts/js nodes: `lexical_declaration`(`const`) → `variable_declarator`
→ `object`; `pair`(key `property_identifier`/`string`, value
`identifier`/`object`); `subscript_expression`(object + index);
`member_expression` (object + property); `call_expression`(function +
arguments). Static key = `index` is a `string`; dynamic = otherwise.

### Provider (`provider.ts`) — run-global aggregation

Mirror `runReturnTypes`/`runExtends`: in pass-1 (`sink.write`), merge each
file's `dispatchTables` into a run-global `runDispatchTables` keyed by table
name, retaining the defining file's relpath for import disambiguation. Pass it
into every `CallContext.dispatchTables`. Reset on the empty-run path.

### Resolver (`ts-resolver.ts`) — fan-out

For a `CallRef` with `dispatch`:

1. Resolve the table: if the table name is imported in this file (import map),
   prefer the table defined in the imported file; else fall back to a run-global
   table of that name (in-file or unambiguous global).
2. Select candidates: `field` non-null → S1, read each entry's `field` value;
   `field` null → S2, the entry value itself. `key` non-null (static) → only
   that entry; `key` null (dynamic) → all entries.
3. For each candidate function name, resolve it via the EXISTING bare-name /
   import resolution and emit one edge per resolved target. Unresolved names →
   drop (no fabrication). Normal receiver resolution is skipped for this call.

Edges fan out: one call-site → N `(caller, callee)` edges (the honest
over-approximation for a dynamic key). Each target's `fanIn` += 1.

### Bounded inter-procedural (callback parameters)

Covers `this.collectSymbols(tree, langConfig.nameOf, …)` where `nameOf` is
invoked inside `collectSymbols`. Single hop, in-repo callee.

**Walker** emits two more things:

- `callbackParams[fnSymbolId] = [indices]` — while walking each function/method
  body, record parameter positions that are invoked as `param(...)` (the param
  identifier is the `function` of a `call_expression`). For `collectSymbols`
  this is `[1]` (`nameOf`).
- On a call site whose callee is a named in-repo function/method, for each
  argument that is itself a dispatch candidate-set (`TABLE[k].field` or a
  dispatch-bound local), emit a `dispatchArgs` entry `{ argIndex, candidate }`.
  The walker records the callee NAME on the existing `CallRef` (receiver/member)
  so the resolver can resolve which function is called.

**Resolver** join (run-global): when it resolves a call to a callee `F` that has
`callbackParams`, for each `dispatchArg` whose `argIndex ∈ callbackParams[F]`,
expand the candidate (same table/field/key resolution as `dispatch`) and emit
fan-out edges **from F** to each candidate function. The edge source is the
callee (`collectSymbols`), because that is where the parameter is invoked. The
candidate union is taken across all call sites passing a dispatch value at that
position (run-global), so `collectSymbols → {tsNameOf, rbNameOf, …}`.

Single hop only: a candidate-set arriving via a parameter is NOT re-propagated
if `F` passes it onward to yet another callee (that is full points-to — out of
scope). A param invoked inside `F` fans out to the candidates passed at its call
sites; it does not chain.

## Safety (no false positives — m46z principle)

- Only **const** object literals (not reassignable) qualify as tables.
- S1 fields / S2 entries contribute only when the value is a **plain
  identifier** (a named function reference). Inline arrows (anonymous — no
  symbol to point at), method shorthands, spreads, computed values, non-const,
  and non-literal tables are excluded from the candidate set.
- Static literal key → exactly one entry (no over-approximation when the target
  is statically known).
- A dispatch whose table cannot be resolved (name not in import map and not in
  run-global tables) → drop. An unresolved candidate name → drop.
- Cross-file: import-map disambiguation prevents binding to a same-named table
  in an unrelated file; if still ambiguous (same name, multiple files, no import
  edge) → drop rather than guess.

## Testing

- **Walker unit** (`typescript-walker.test.ts`): S1
  `const T={a:{w:fnA},b:{w:fnB}}`
  - `const f=T[k].w; f(x)` → `CallRef.dispatch={table:"T",field:"w",key:null}`;
    S2 `const H={a:fnA,b:fnB}; H[k](x)` →
    `dispatch={table:"H",field:null,key:null}`; static key `T["a"].w(x)` →
    `key:"a"`; entry-bound `const e=T[k]; e.w(x)` → `dispatch` set; inline-arrow
    entry → excluded; non-const → no dispatch. Plus `collectDispatchTables`
    shape assertions (entries preserve key→value).
- **Resolver unit** (`ts-resolver.test.ts`): dynamic key over a 2-entry table →
  2 edges; static key → 1 edge (the matching entry); S2 direct → entry fns;
  unresolved candidate → drop; unknown table → drop; cross-file table resolved
  via import map → edges; same-name ambiguous table without import → drop.
- **Walker unit — callback params**: `function run(f){ f(x) }` →
  `callbackParams["run"]=[0]`; `class C { m(a,cb){ cb() } }` →
  `callbackParams["C#m"]=[1]`; a param NOT invoked → absent. Call site
  `collectSymbols(tree, T[k].w, …)` →
  `CallRef.dispatchArgs=[{argIndex:1, candidate:{table:"T",field:"w",key:null}}]`.
- **Resolver unit — inter-proc join**: callee `F` with `callbackParams=[1]` and
  a call passing dispatch candidates at arg 1 → edges `F → each candidate`; arg
  at a NON-callback position → no edges; callee without `callbackParams` → no
  edges; candidate union across two call sites → both reach `F`.
- **Provider unit** (`provider.test.ts`): `runDispatchTables` aggregates across
  files; `callbackParams` aggregated run-global; empty-run reset.
- **Integration** (tea-rags self-index, when embedded Qdrant is stable):
  `get_callers("extractFromTypescriptFile")` ⊇ the `provider.ts` dispatcher (was
  `[]`); other walkers likewise; AND `get_callers("tsNameOf")` ⊇
  `CodegraphSymbolsProvider#collectSymbols` (the callback-param hop) — also was
  `[]`.
- **silo-pairing:** `ts-resolver.ts` is deep-silo — the commit MUST carry a
  `Why:` line.

## Out of scope (YAGNI)

The bounded inter-procedural hop (arg → param → call, single hop, in-repo
callee) IS in scope (covers `nameOf`). Beyond it remains out:

- **Full points-to / multi-hop flow:** a candidate-set returned from a function,
  or re-propagated when the callee passes its parameter onward to another callee
  (param → param chaining), or flowing across more than one call boundary. This
  is research-grade inter-procedural analysis — the tested repo does not need it
  (`nameOf` is a single hop).
- **Cross-file argument propagation:** the callback-param join is run-global so
  a cross-file call site + callee work, but only for the single arg→param→call
  hop; no chained cross-file flow.
- Non-TS/JS walkers emitting `dispatchTables` / `callbackParams` (contract is
  ready; no producer yet).
- `Object.values(TABLE).forEach(e => e.field(x))` iteration-dispatch and
  higher-order `Array.map(fn)` — different pattern; revisit only if observed.
- Reassigned / mutated tables (`let`, `TABLE[k] = …`) — non-const excluded by
  the safety rule.

## Implementation order

1. Contract fields (`DispatchTable`, `FileExtraction.dispatchTables` +
   `callbackParams`, `CallRef.dispatch` + `dispatchArgs`,
   `CallContext.dispatchTables` + run-global callbackParams).
2. Walker: `collectDispatchTables` + candidate-set binding tracking + call
   `dispatch` tagging (TDD walker tests first).
3. Walker: `callbackParams` (invoked param positions) + `dispatchArgs` on call
   sites (TDD).
4. Provider: run-global aggregation (`runDispatchTables` + run-global
   callbackParams) + reset.
5. Resolver: dispatch fan-out with import disambiguation (TDD).
6. Resolver: callback-param inter-proc join — fan-out from callee (TDD).
7. Full suite green + build; integration on tea-rags self-index when Qdrant
   stable (`extractFromTypescriptFile` AND `tsNameOf` gain callers).
