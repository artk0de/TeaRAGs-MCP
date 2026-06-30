# Dynamic-Dispatch Fan-out Precision Narrowing — Design

**Bead:** `tea-rags-mcp-xlnub` · parent program `cai0` · the PRECISION lever
(counterpart to the type-inference recall ceiling).

**Goal:** When an untyped short-name dispatch (`x.account`) would fan out to
every in-project definer of the member, NARROW the candidate set by call-site
evidence that is always present in source (arity, visibility) — so an agent
navigating the call graph reaches THE definition or an honest hole, never N
false candidates. Precision-first: may-edges are hallucination for navigation.

## Background — the measured gap

Forensic baseline (instrumented resolve pass, 3 live corpora, 2026-06-30):
**154,456 fan-out edges, 142,576 spurious excess** (edges beyond a single
target). mastodon (un-annotated Rails, worst): 6685 fan-out call sites; fan-out
`n` distribution **p50=4 / p95=80 / max=136**; 932 sites fan to 50+ targets;
`exactRatio` **0.061** — 94% of the call graph is may-edges. Dominators by total
edges: `account` 29360, `call` 27501, `account_id` 11904, `perform` 5032 (top-4
= 63%); generic Object/runtime methods `to_s`/`each`/`name`/`inspect`/ `empty?`.
octokit (ANNOTATED, YARD): `exactRatio` 0.844 — clean. Fan-out is inversely
proportional to type information; the precision-narrowing substrate
(arity/visibility) is present regardless of annotations, so it does NOT hit the
un-annotated-Rails wall that the type-inference recall axis (P3) hits.

## Root cause

`RubyDynamicDispatchResolver.resolveDispatch` (`ruby-dynamic-dispatch.ts`),
after excluding every typed/constant/relation/index/external receiver, reaches a
truly untyped receiver and does a global short-name lookup:

```
candidates = symbolTable.lookupByShortName(member).filter(isRubyPath)
return candidates.map(def => ({ edgeKind: "dynamic", confidence: discount/n, … }))
```

It emits **one `dynamic` edge per same-short-name in-project definer,
unbounded**. The CHA cone engine (`ConeDispatchResolver`, bead 2jet) has a
`coneMax` collapse (`>K` → poly-base); the dynamic-dispatch short-name fan-out
has NO equivalent. On un-annotated Rails (no receiver type → CHA cone can't fire
→ everything falls to dynamic-dispatch), `account` fans to 80+. The same untyped
tail is reached by the `dynamic`, `chain` (untyped `a.b.c`), and `ivar` (untyped
`@x.m`) receiver kinds — all three converge on this `candidates.map`, so all
three are in scope.

## Design — narrowing cascade (neutral kernel engine) + consumer-split terminal

Replace the unconditional `candidates.map(→edge)` tail with a **candidate
narrowing cascade** followed by a **consumer-split terminal**. The cascade is a
language-neutral engine in `domains/language/kernel`; per-language primitives
are injected (the cone-dispatch precedent: `ConeDispatchResolver` +
`ConeTypeLocator`). Untyped short-name fan-out is a general scripting-language
disease (Python / JS / Bash are equally dynamically typed) — Ruby is merely the
FIRST consumer; the engine and substrate are neutral so the other scripting
walkers plug in later.

### Components

1. **Neutral substrate (new optional contract fields + walker capture).** None
   of the narrowing evidence exists in the payload today.
   - `SymbolDefinition.arity?: AritySignature` —
     `{ minRequired, maxPositional, hasSplat }` recorded at each method
     definition. `maxPositional` is the count of positional params (required +
     optional); `hasSplat` true when a `*args` rest param is present (⇒
     unbounded max). Double-splat `**kwargs` / block params do NOT affect
     positional arity.
   - `SymbolDefinition.visibility?: "public" | "private" | "protected"` recorded
     at each method definition (stateful `private`/`protected` mode +
     `private :m` symbol-form tracking in the class-body walk).
   - `CallRef.argCount?: number` — positional argument count recorded at the
     call site (the AST node is already visited during call collection).
   - All three are ADDITIVE and OPTIONAL; a definition/call with the field
     absent is treated conservatively (see Decisions). The Ruby walker populates
     them in this increment; other scripting walkers populate them in
     follow-ups; the narrowing engine reads only the neutral fields.

2. **`DispatchCandidateNarrower` cascade (kernel engine).** Interface:
   `narrow(call, candidates, ctx) => SymbolDefinition[]`. The engine runs the
   injected narrowers left-to-right, each shrinking the surviving set. Three
   narrowers:
   - **`DuckVocabularyNarrower` (V).** If `member` ∈ the injected language duck/
     runtime vocabulary (Ruby: `to_s`, `inspect`, `hash`, `==`, `eql?`, `each`,
     `map`, `name`, `call`, `freeze`, `dup`, … — Object/Kernel/Enumerable), the
     fan-out is dropped WHOLE (`[]`): these names are never
     short-name-resolvable to a meaningful in-project target. The vocabulary is
     the per-language injection (reuses / extends the external-classifier vocab
     surface). This is the only narrower that can empty the set by member
     identity rather than per-candidate evidence.
   - **`ArityNarrower` (A).** Keep candidate `c` ⟺ its `arity` can PROVABLY
     accept `call.argCount`: drop iff `argCount < c.arity.minRequired` OR
     (`argCount > c.arity.maxPositional` AND NOT `c.arity.hasSplat`). A
     candidate with no recorded `arity`, or a call with no recorded `argCount`,
     is KEPT (cannot prove incompatible). Neutral logic over the neutral
     `AritySignature`.
   - **`VisibilityNarrower` (Vis).** The receiver here is always an explicit
     non-`self` receiver (bare / `self` / super are excluded upstream at
     `ruby-dynamic-dispatch.ts:61`). A `private` method cannot be invoked with
     an explicit receiver → drop `visibility === "private"` candidates.
     `protected` is KEPT (callable with an explicit receiver from within the
     hierarchy; we lack the receiver type to disprove it). A candidate with no
     recorded visibility is KEPT.
   - **Conservatism invariant:** a narrower drops a candidate ONLY on PROVEN
     incompatibility, NEVER on missing data. Over-dropping the true target is no
     worse than today (it was already buried in the fan-out); but we never
     fabricate a narrowing the evidence doesn't support.

3. **Consumer-split terminal.** After the cascade, `survivors`:
   - `=== 1` → emit ONE `dynamic` edge, **`confidence: 1.0`** (evidence-unique —
     the single candidate consistent with all available evidence; not
     type-proven, but the navigation target). Visible to navigation AND
     analytics.
   - `> 1` → emit the surviving in-project fan-out, **`confidence: discount/m`**
     (`m` = survivor count, the existing discount formula on the narrowed set).
     Counted by ANALYTICS (fanIn/fanOut/pageRank); HIDDEN from navigation. The
     "hole" is navigation-scoped, not analytics-scoped.
   - `=== 0` → `[]` (hole everywhere — nothing to count).
   - **External-safety (confirmed):** every survivor is `isRubyPath`-filtered
     and in-project by the resolver's documented invariant — the residual kept
     for analytics creates ZERO external fanIn/fanOut. It DOES add bounded
     in-project fanIn/caller-fanOut noise (washes out under percentile
     normalization); that is the accepted trade — navigation precision (hard
     constraint) dominates in-project analytics noise, which dominates external
     pollution (forbidden).

4. **Navigation edgeKind/confidence filter (query side).** `getCallers` /
   `getCallees` / `tracePath` currently `slice(0, 50)` with no confidence use,
   though `edge_kind` + `confidence` are persisted columns (migration 006). Add
   an edgeKind-aware filter: **show `dynamic` edges only at `confidence == 1.0`
   (narrowed-unique); always show `cone` / `exact` / `poly-base`** (typed real
   polymorphism and pinned edges must never be hidden). This plumbs
   `edge_kind` + `confidence` from the persisted columns into the caller/callee
   edge result (columns exist; the read path must select + filter them).
   Analytics (fanIn/fanOut/pageRank, computed over the full edge table) is
   unchanged.

### Decisions (locked)

- **Narrow, not blunt-cap.** The cap-on-threshold is the degenerate fallback;
  the feature NARROWS by arity + visibility + vocabulary first, reaching THE
  definition where evidence allows. Drop is only the terminal for irreducible
  ambiguity.
- **Terminal = narrow-to-1-or-hole for navigation.** No residual small cone is
  shown to navigation — a 2-survivor untyped dispatch is still 1-real-1-false, a
  may-edge, hidden. (Distinct from the typed CHA cone, where a small cone is
  real polymorphism and stays visible.)
- **Consumer split, not total drop.** The irreducible residual is kept
  in-project for analytics and hidden from navigation. Persisted-edge reduction
  is therefore PARTIAL — only narrowed-to-1 cases collapse N→1; the
  `account`-class residual survives for analytics. fanIn pollution is reduced
  where narrowable, tolerated in-project where not, and navigation is clean
  everywhere.
- **Neutral kernel engine.** `DispatchCandidateNarrower` + the cascade/terminal
  live in `domains/language/kernel`; substrate fields are neutral contract.
  Per-language injection = the duck vocabulary (V) and the walker that populates
  arity/visibility/argCount. A/Vis logic is neutral over the neutral fields.
- **Receiver-name convention REJECTED.** `@account → Account` (Rails
  duck-naming) has high Rails yield but is a heuristic GUESS — it would
  fabricate a new class of false edges, violating the precision axis. Out of
  scope.
- **Conservative narrowers.** Drop on proven incompatibility only; missing
  arity/visibility/argCount ⇒ keep.
- **`confidence == 1.0` is the navigation-visibility key for `dynamic`.**
  Reusing the existing `confidence` column avoids a new `edge_kind` enum value;
  the narrowed-unique edge keeps `edge_kind: "dynamic"` with `confidence: 1.0`.

## Soundness / precision

The typed CHA cone (2jet), `exact`, `poly-base`, and every non-fan-out receiver
kind are byte-identical — the cascade only replaces the untyped short-name
`candidates.map` tail. A narrower drops a candidate only when source evidence
PROVES it cannot be the call's target (wrong arity, or private under explicit
receiver), so a surviving-unique edge is the single evidence-consistent target.
Navigation never shows a multi-candidate untyped dispatch, so it never presents
a may-edge as a fact. Analytics retains the in-project signal (no external edge
ever created). Recall of TRUE edges does not regress: where a true target was
the lone survivor it is now PINNED (confidence 1.0) instead of buried at 1/n;
where it remains ambiguous it is hidden from navigation but still counted — the
same in-project contribution it made before.

## Scope / increments

This spec is the Ruby-first increment of a neutral mechanism:

1. Neutral substrate (contract fields) + the kernel cascade/terminal engine +
   the three neutral/injected narrowers.
2. Ruby walker populates arity + visibility (def-site) and argCount (call-site);
   Ruby injects the duck vocabulary and the narrower cascade into
   `RubyDynamicDispatchResolver`.
3. Navigation edgeKind/confidence filter in the caller/callee/trace read path.

Python / JS / Bash walker population + injection are explicit FOLLOW-UPS (the
engine and substrate are built neutral for them; not implemented here).

## Testing (TDD)

Unit (kernel engine + Ruby integration):

- `ArityNarrower`: a table of
  `(callArgCount, candidate AritySignature) → kept|dropped` covering
  `minRequired`, optional params, `*splat` (always kept), and the missing-arity
  keep case.
- `VisibilityNarrower`: private dropped under explicit receiver, protected kept,
  public kept, missing-visibility kept.
- `DuckVocabularyNarrower`: a member in the vocabulary empties the set; a member
  not in it is untouched.
- Terminal: 1 survivor → one edge confidence 1.0; `m>1` → `m` edges confidence
  `discount/m`; 0 → `[]`.
- Navigation filter: `dynamic` confidence `<1.0` hidden, `dynamic` confidence
  `1.0` shown, `cone`/`exact`/`poly-base` always shown.
- The typed cone / exact paths and all other receiver kinds keep their existing
  tests green UNTOUCHED (byte-identity oracle).

Live validation (user-gated build+link+reconnect+reindex, 4 corpora): dynamic
edge count drops where narrowable (`perform`/`call`/`merge` → narrowed-unique),
`exactRatio` rises partially; navigation `get_callers`/`get_callees` on a
narrowed-unique member returns THE single target; on an irreducible member
(`account`) returns the hole (analytics fanIn unchanged); typed-cone / exact /
other-kind resolved counts UNCHANGED on all 4 corpora; octokit (already clean)
unchanged.

## Files

- `src/core/contracts/types/codegraph.ts` — `AritySignature`,
  `SymbolDefinition.arity?` + `visibility?`, `CallRef.argCount?`.
- `src/core/domains/language/kernel/` — `DispatchCandidateNarrower` interface,
  the cascade/terminal engine (`resolveNarrowedFanout`), the neutral
  `ArityNarrower` + `VisibilityNarrower`.
- `src/core/domains/language/ruby/walker/walker.ts` — capture method arity +
  visibility (def-site) and call argCount (call-site).
- `src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`
  — build candidates, run the kernel cascade + terminal; inject the Ruby duck
  vocabulary. Provider `resolveExtraction` (god-method hotspot) is NOT touched.
- `src/core/domains/language/ruby/resolver/strategies/shared.ts`
  (`ResolverConfig`, isHub) — minimal additive config (the injected narrower
  list / vocabulary handle); no restructure.
- The caller/callee/trace read path (`graph-facade.ts` + the daemon graphDb
  query) — edgeKind/confidence-aware navigation filter; `edge_kind` +
  `confidence` selected from the persisted columns.

## Out of scope

- Receiver-name convention inference (`@account → Account`) — heuristic guess,
  precision-violating.
- Typed CHA cone (2jet) / `exact` / `poly-base` / non-fan-out receiver kinds —
  untouched.
- Python / JS / Bash walker substrate population + injection — neutral engine is
  built for them; their walkers are separate follow-ups.
- pageRank/fanIn confidence-weighting — analytics counts all in-project edges as
  today; down-weighting the residual by confidence is a possible future
  refinement, not this spec.
