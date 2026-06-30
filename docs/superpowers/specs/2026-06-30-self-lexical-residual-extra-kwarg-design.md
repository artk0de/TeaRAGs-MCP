# Self/Lexical Residual Tightening + Extra-Unknown-Kwarg Narrowing — Design (Spec #2)

**Beads:** `tea-rags-mcp-d9o7o` deferred residue (2c self/lexical + extra-kwarg
direction) · parent program `cai0` · **parallel track B** to Spec #1
(`2026-06-30-cascade-narrowing-kwarg-block-literal-design.md`).

**Goal:** Two independent precision squeezes that did NOT fit Spec #1's cascade:
(A) measure and surgically tighten the residual in the already-near-exact
self / implicit-self lexical+ancestor resolution; (B) add the
**extra-unknown-kwarg** direction to `KwargNarrower` — drop a candidate when the
call passes a kwarg key the def cannot accept (no matching declared kwarg and no
`**` splat → `ArgumentError: unknown keyword`). Conservatism invariant holds
throughout: drop ONLY on PROVEN incompatibility (or measured residual); missing
evidence ⇒ keep.

## Track relationship to Spec #1

- **Part A (2c) is INDEPENDENT of Spec #1** — touches
  `ruby-self-member.ts` / `ruby-bare-call.ts` / the shared MRO walk
  (`shared.ts`) + an instrumentation harness. ZERO overlap with Spec #1's files
  (kernel cascade, walker capture, contracts kwarg/block, `client.ts`) → true
  parallel, near-zero conflict surface.
- **Part B (extra-kwarg) EXTENDS Spec #1** — modifies `KwargSignature`,
  `KwargNarrower`, and the walker kwarg-capture that Spec #1 introduces. It
  **rebases onto Spec #1 before merge** (accepted cost). Until Spec #1 lands,
  develop against the Spec #1 interface: `KwargSignature` gains `optional:
  string[]`; the walker additionally captures optional (defaulted) kwarg names.

## Part A — self/lexical measured-residual tightening (2c)

**Already landed (NO rebuild):** `RubySelfMemberSymbolResolutionStrategy`
(kh9vo — `resolveInstanceMethodInClassChain(enclosingClass, member)`, enclosing +
ancestor MRO, terminal DROP on miss); `RubyBareCallSymbolResolutionStrategy`
(t5iw/brp1 — MRO-aware scope narrowing `[enclosing, ...collectAncestorChain]`
nearest-first); cross-form preference (55xil — drop class-form when instance-form
exists). The bead's "resolves near-exact via lexical class + ancestors … tighten"
is a surgical squeeze, NOT a build. **Data first; no speculative lever.**

### Task A0 — Instrumentation (data before code)

Extend the existing forensic resolve-pass instrumentation (the same harness that
produced the xlnub fan-out baseline: 154,456 fan-out edges across 3 live corpora)
with a per-`receiverKind` residual counter for `selfMember` and `bareCall`:

- `resolved-exact` — single lexically-correct target.
- `dropped-no-lexical-match` — member not in enclosing class or any ancestor
  (selfMember terminal DROP; bareCall MRO walk empty at every level).
- `ambiguous-fell-through` — bareCall MRO narrowing found >1 at the nearest
  level, fell to `pickSingleCandidate` → strict CONTINUE.
- `single-global-taken-without-lexical-verify` — bareCall `fallback.length === 1`
  took the lone global match WITHOUT verifying it sits in the caller's MRO.

Emit the aggregate per Ruby bench (mastodon / huginn / octokit). **Deliverable:
a concrete residual table** — how many self / implicit-self calls are unresolved
or possibly mis-resolved, and the dominant cause.

### Task A1 — Targeted fix (specced FROM A0 data)

The fix is chosen by A0's dominant residual cause — NOT pre-committed. Candidate
levers, each gated on A0 proving the residual:

- **bareCall single-global lexical-verify** — if A0 shows
  `single-global-taken-without-lexical-verify` is a precision leak (the lone
  match is in an unrelated class), demote it to a low-confidence / drop when the
  match is not MRO-reachable AND ≥1 other signal disagrees. (Recall-guarded: a
  lone global match is often a legit top-level / Kernel helper.)
- **cross-form within MRO levels** — apply 55xil's instance>class preference
  inside each `atLevel` of the bareCall MRO walk if A0 shows same-level
  cross-form ambiguity.
- **prepend / mixin depth** — extend the MRO walk only if A0 shows inherited- or
  prepended-method misses.

Conservatism invariant: tighten ONLY where A0 proves a residual; never trade
recall for unmeasured precision. If A0 shows the residual is negligible, Part A
closes as "measured, no fix warranted" — a valid, honest outcome.

## Part B — extra-unknown-kwarg narrowing

Extends Spec #1's kwarg substrate with the second incompatibility direction.

### Contracts

- `KwargSignature` gains `optional: string[]` — declared optional (defaulted)
  kwarg names. Full declared set = `required ∪ optional`. (Spec #1 ships
  `{ required, hasSplat }`; Part B adds `optional`.)
- **Walker def-side**: capture `keyword_parameter` WITH a default value →
  `optional` (Spec #1 captured only the no-default → `required` ones). Same
  colocated capture site.
- **Persistence**: `kwargs_json` already serialises the whole `KwargSignature`
  object (Spec #1 migration 008) — `optional` rides along, **no new migration**.

### KwargNarrower extension

Appended AFTER Spec #1's omitted-required filter (same narrower, second clause):

```
// Spec #1 clause: every required key present (omitted-required → drop).
// Part B clause: every passed key declared (extra-unknown → drop).
if (call.kwargKeys === undefined || call.hasKwargSplat) return survivors;
return survivors.filter((c) => {
  if (!c.kwargs || c.kwargs.hasSplat) return true; // def **opts accepts any key
  const declared = new Set([...c.kwargs.required, ...c.kwargs.optional]);
  return call.kwargKeys.every((k) => declared.has(k));
});
```

Drop `c` ⟺ `c.kwargs` defined ∧ ¬`c.kwargs.hasSplat` ∧ call has no `**` ∧ ∃
passed key ∉ declared (PROVEN `ArgumentError: unknown keyword`). Combined with
Spec #1, `KwargNarrower` now enforces BOTH directions: every required key
present AND every passed key declared.

Conservatism: def `**opts` (`hasSplat`) → keep (accepts arbitrary keys); call
`**` (`hasKwargSplat`) → keep; missing `c.kwargs` / `call.kwargKeys` → keep.

### Testing

- TDD (`dispatch-narrowing.test.ts`): passed-key-not-declared + no def splat →
  drop; def `**opts` → keep; call `**` → keep; all keys declared → keep; mixed
  with Spec #1's required check.
- Walker: optional-kwarg name capture (preserve existing examples; validate
  `it`/`describe` counts ≥ base).
- Live: residual fan-out further ↓ vs the Spec #1 baseline, ZERO false-narrow.

## Files

- **Part A**: forensic instrumentation harness (debug-gated; locate the xlnub
  baseline harness and extend it); `ruby-self-member.ts` / `ruby-bare-call.ts` /
  `shared.ts` (A1, data-driven — only the levers A0 justifies).
- **Part B** (rebases onto Spec #1): `contracts/types/codegraph.ts`
  (`KwargSignature.optional`); `kernel/dispatch-narrowing.ts` (`KwargNarrower`
  second clause); `ruby/walker/walker.ts` (optional-kwarg capture).

## Sequencing

- Part A runs immediately, fully parallel to Spec #1.
- Part B's contract/walker/narrower edits are drafted against the Spec #1
  interface but land (rebase + merge) AFTER Spec #1 to avoid the
  `KwargNarrower`/`KwargSignature`/walker conflict.
