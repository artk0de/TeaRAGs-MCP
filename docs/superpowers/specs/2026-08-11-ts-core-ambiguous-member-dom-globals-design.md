# TS bare ambient-global classification + DOM/BOM vocabulary

Status: approved (mechanism refined post-approval — see "Revised mechanism")
Epic: `tea-rags-mcp-nl93h` (TS codegraph: typeChecker fallback resolver) Beads:
`tea-rags-mcp-4008o` (partial closure) + a new bead to be filed for the DOM/BOM
vocabulary extension

## Problem

`tea-rags-mcp-4008o` documented that `resolveSuccessRate`'s `noInProjectDef`
exclusion (`resolution-runner.ts#classifyMiss`) is lexical — a call is only
excluded from the denominator when `symbolTable.lookupByShortName(member)`
returns zero project-wide matches. Names like `parseInt`, `setTimeout`, `fetch`,
`String`-as-converter are excluded today only because no project symbol happens
to share the name; the day one does, they silently become permanent misses with
no resolver regression behind them.

Separately, live measurement on taxdome
(`project_taxdome_ts_resolve_rate_gap.md`) showed TypeScript/React
`resolveSuccessRate` far below tea-rags-mcp's own backend-TS baseline (bareCall
0.53 vs 0.98, chain 0.22 vs 0.90, index 0.20 vs 1.00). Inspection of
`src/core/domains/language/shared/ecmascript-globals.ts` (the vocabulary
`targetsExternalImport` consults) found it covers Node/ECMAScript core only —
zero DOM/BOM names. A React codebase calls `window.*`, `document.*`,
`localStorage.*`, `fetch(...)` constantly; tea-rags-mcp's own source (a Node
CLI/MCP server) never does, so this gap was invisible until measured against a
real frontend corpus.

## Revised mechanism (superseding the originally-approved `targetsCoreAmbiguousMember` idea)

The design as originally approved proposed a TS `targetsCoreAmbiguousMember`
implementation mirroring Ruby's `83cl7`. Re-grounding against the current code
(the repo advanced 133 commits between approval and implementation) shows a
cleaner fix exists, and that the Ruby-mirroring approach does not actually fit:

- Ruby's `ExternalCallClassifier#targetsCoreAmbiguousMember` explicitly requires
  an explicit receiver (`if (call.receiver === null) return false`) — sound for
  Ruby, where a bare call implicitly targets `self`, itself a typed receiver.
  TypeScript has no such implicit receiver; a bare ambient global call
  (`parseInt(x)`, `fetch(url)`) has no analogous "always-typed" interpretation,
  so the Ruby mechanism's precondition doesn't transfer.
- `targetsExternalImport` already runs BEFORE the lexical
  `lookupByShortName === 0` check in `classifyMiss`
  (`resolution-runner.ts:427-517`) and already has 6 cases, none of which cover
  a bare call to a true ambient global. Case 6 (`calleeIsExternalLocalBinding`)
  only covers identifiers whose TS declaration is a `Parameter` /
  `BindingElement` / function-body-local `VariableDeclaration` — confirmed by
  reading `isLocalValueBinding` in `ts-local-callee.ts:212-215`. An ambient
  global like `parseInt` has no such declaration in the caller's file at all;
  its declaration lives in `lib.es5.d.ts` at the global scope, so
  `classifyLocalCallee` returns `"notLocalBinding"` for it, and case 6 never
  fires.

So: add a **new case 7** directly to `targetsExternalImport`
(`ts-external-call.ts`), mirroring case 1's shape for the no-receiver side:

```ts
// case 7: a bare call to a known ambient global function/constructor —
// parseInt(x), fetch(url), setTimeout(fn) — no receiver, so cases 1-5 never
// see it, and case 6 only covers LOCAL value bindings (closures, hook
// returns), never a true ambient declared outside any file this project owns.
if (receiver === null && BARE_GLOBAL_CALLABLES.has(call.member)) return true;
```

Checked unconditionally (plain set membership, no type-checker cost) — the
cheapest case in the function, so it can run early alongside case 1.

This closes 4008o's ambient-global examples (`String`/`Number`/`Boolean` used as
bare converters, `parseInt`, `setTimeout`, `clearTimeout`, `fetch`, `isNaN`)
**by classification**, not lexical accident — and unconditionally, so a future
project symbol collision can never turn one of these into a miss (they never
reach `lookupByShortName` at all once `targetsExternalImport` claims them).

**Does not close:** 4008o's `put` example (`env-snapshot.ts`'s deliberately
unnamed function-scoped arrow, `grz07`/`w7qv4`) is a genuine in-project local
symbol the resolver correctly declines to pin — not an ambient global, so case 7
does not touch it. That residual is what 4008o's option 2 (scope-qualified
symbol recording) would address; it stays out of scope here. 4008o's closing
reason will say so explicitly rather than overclaim full closure.

No `TSCallResolver` method, no `LanguageSymbolResolver` interface change, no
`resolution-runner.ts` change — the fix is entirely inside the existing
`targetsExternalImport` function and its vocabulary file.

### 2. DOM/BOM vocabulary extension (new bead, not 4008o)

Extends `ecmascript-globals.ts` with three additions, following the file's
existing curation discipline (each addition gets a bd-tagged doc comment,
conservative membership — omission just means "stays in the miss pool," never
over-shrinks the denominator):

- `ECMASCRIPT_GLOBALS` (receiver-text, namespace-style — feeds case 1,
  unchanged): `window`, `document`, `navigator`, `localStorage`,
  `sessionStorage`, `history`, `location`, `screen`, `crypto`, `performance`.
- `ECMASCRIPT_BUILTIN_TYPES` (typed-instance calls — feeds case 3, unchanged):
  `Event`, `CustomEvent`, `FormData`, `Blob`, `File`, `FileReader`,
  `AbortController`, `Headers`, `Request`, `Response`, `IntersectionObserver`,
  `MutationObserver`, `ResizeObserver`, `WebSocket`, `Image`, `Audio`.
- `BARE_GLOBAL_CALLABLES` (new set, feeds new case 7): `parseInt`, `parseFloat`,
  `isNaN`, `isFinite`, `setTimeout`, `clearTimeout`, `setInterval`,
  `clearInterval`, `fetch`, `encodeURIComponent`, `decodeURIComponent`,
  `encodeURI`, `decodeURI`, `btoa`, `atob`, `structuredClone`,
  `requestAnimationFrame`, `cancelAnimationFrame`, `queueMicrotask`, `alert`,
  `confirm`, `prompt`, `String`, `Number`, `Boolean` (the bare-converter-call
  shape, distinct from case 1's receiver-text entries of the same names).

### 3. Sequencing

Land (1) and (2) together (one PR, TDD per file) — they share the vocabulary
file and are easiest to verify as a unit. Do **not** run the taxdome oracle or
force reindex until this merges: per this session's own
`feedback_wait_for_invalidating_work_before_expensive_ops` lesson, the DOM
vocabulary will materially change taxdome's raw numbers, so measuring before the
fix lands means redoing the (expensive) measurement.

After merge: run `scripts/ts-codegraph-typechecker-oracle.ts` scoped to
taxdome's frontend tree to decompose whatever gap remains into real defect
categories (same `TRUE DEFECT RESIDUAL` breakdown used throughout epic `nl93h`),
rather than assuming the DOM fix fully closes it. The 5x magnitude of the
original gap suggests React-idiom-specific causes (JSX callback density,
third-party UI library call density) may remain — this oracle run is what will
show whether that's true.

## Testing

- `targetsExternalImport` case 7: unit tests in the existing
  `tests/core/domains/language/typescript/resolver/` suite (likely
  `ts-builtin-receiver-guard.test.ts` or a new sibling file matching the file's
  existing per-case test organization) — bare `parseInt(x)` classified external,
  bare call to a project-local same-name function NOT reclassified (case 7 only
  fires when `receiver === null`, so a receiver-bearing call is untouched; a
  bare call to a genuine project function must still resolve — add a test
  proving case 7 doesn't shadow a real project bare-call match by running the
  vocabulary check only on calls that already fell through the earlier
  resolution strategies, matching how `targetsExternalImport` is invoked today
  as a pre-pass guard, not a resolution override).
- `ecmascript-globals.ts`: extend existing set-membership tests (if any) or add
  new ones asserting the three new/extended sets contain the DOM/BOM and
  bare-global names listed above.

## Out of scope

- 4008o's `put`-style local-closure-homonym case (option 2: scope-qualified
  symbol recording) — larger change, touches the `w7qv4`/`grz07` boundary, and
  does not explain the taxdome gap (that gap is ambient-global/receiver -shaped,
  not closure-shaped).
- Any change to `resolution-runner.ts` — not needed; the fix is entirely inside
  `targetsExternalImport`, already in the dispatch path.
- The taxdome oracle run itself — tracked as a follow-up gated on this design's
  merge, not part of this implementation.
