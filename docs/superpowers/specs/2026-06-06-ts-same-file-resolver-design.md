# TS codegraph resolver — same-file resolution pass

**Date:** 2026-06-06
**Status:** Design approved, pending implementation plan
**Area:** `src/core/domains/language/typescript/resolver/`

## Problem

Probing the real `CodegraphEnrichmentProvider` sink over two TypeScript
repositories (tea-rags 585 files, markdownlint-mcp 59 files) measured in-repo
call-edge resolution at ~77% (tea-rags) and ~86% (markdownlint). The raw
`resolveSuccessRate` is dominated by the share of EXTERNAL calls (stdlib / npm),
which are correctly unresolved — it is not a quality metric. The quality metric
is the **addressable miss**: an unresolved call whose target short-name exists in
the repo's symbol table.

Categorizing addressable misses surfaced one deterministic, zero-false-positive
corner case shared by both repos:

**The caller's own file defines the target, but no strategy prefers it when the
short-name is globally ambiguous.**

Concretely:

- **bare-call to a same-file function** — `helper()` where `helper` is defined in
  the same file, and the short-name occurs N>1 times across the repo.
  `globalShortName` drops on ambiguity; `importNarrowedFallback` cannot help (the
  function is not imported). Evidence: markdownlint **17/17** addressable misses
  (`getHeadingLevel`, `isTableLine`, `isInCodeBlock`, `changeHeadingLevel`,
  `extractReferenceLinkDefinitions` — each defined locally per rule file);
  tea-rags `resolveDataDir` / `defaultDeps` (copy-paste local helpers across 4
  cli files).
- **same-file `new X()`** — `new MerkleNode()` inside `merkle.ts` where
  `MerkleNode` is declared in the same file. The walker emits
  `{receiver: "MerkleNode", member: "constructor"}` (walker.ts:289). Imported
  constructors already resolve via `namedImport`; same-file ones miss because
  `globalShortName` keys on `member="constructor"` (ambiguous across all ~238
  constructors). 12 genuine in-repo misses in tea-rags.
- **same-file `Class.staticMember()`** — analogous, smaller volume.

### Out of scope (by design)

- **interface→impl ambiguity** — `embeddings.checkHealth()` where `embeddings:
  EmbeddingProvider` (interface) has 6 implementers. Needs fan-out semantics.
- **multi-hop chain receivers** — `ctx.app.x.y()`. Needs full type inference.
- **imported constructors / imported functions** — already handled by
  `namedImport`. Not re-implemented here.

## Solution

A single new strategy, `TSSameFileSymbolResolutionStrategy`, inserted into the
ordered chain at **position 8** — after `receiverSymbol`, before
`globalShortName`:

```
1  super (DROP guard)
2  thisMember
3  fieldType
4  localBinding
5  namedImport
6  importBasename
7  receiverSymbol
8  sameFile           ← NEW
9  globalShortName
10 importNarrowedFallback
```

**Precedence rationale.** Placed before `globalShortName`, the pass is *strictly
additive*: it resolves exactly the cases `globalShortName` drops on ambiguity.
For a globally-unique name (N=1) the result is identical whether `sameFile` or
`globalShortName` resolves it. Placed after the receiver/import strategies, an
explicit import still wins over a same-file coincidence (lexically impossible to
conflict, but precedence keeps the intent ordered). It does not touch the tested
`globalShortName` or `importNarrowedFallback` code paths.

### Algorithm — `attempt(call, ctx)`

Dispatch on call shape; in every branch resolve via
`pickSingleCandidate(mode)` — exactly one same-file candidate → `resolved`; zero
or more-than-one → `CONTINUE` (hand off to `globalShortName` /
`importNarrowedFallback`). Never guesses.

| Call shape | Guard | Candidate filter | Target |
| ---------- | ----- | ---------------- | ------ |
| **bare-call** | `call.receiver === null` | `lookupByShortName(member)` ∩ `def.relPath === ctx.callerFile` | the sole same-file symbol |
| **constructor** | `member === "constructor"` and `receiver` is `/^[A-Z]/` | `lookupByShortName("constructor")` ∩ `relPath === callerFile` ∩ `scope[-1] === receiver` | `Class#constructor` (walker synthesizes it even when implicit — bd vw1u) |
| **Class.static** | `receiver` is `/^[A-Z]/`, `member !== "constructor"` | `lookupByShortName(member)` ∩ `relPath === callerFile` ∩ `scope[-1] === receiver` | `Class.staticMember` in the same file |
| anything else (lowercase `var.method()`) | — | — | `CONTINUE` (var typing is `localBinding`/`fieldType`'s job, already run) |

### Self-loop

No bespoke self-loop guard. The pass emits only TRUE edges: a same-file
`helper()` that resolves to the enclosing symbol is genuine recursion (a real
call), not the FALSE self-loop that motivated the `super` DROP guard (bd 4rgg,
where `super.x` with no `classExtends` would wrongly target a same-class method).
`globalShortName` already resolves unique recursive functions to self-edges
today; this pass introduces no new class of self-loop. Central self-loop edge
filtering, if ever wanted, is a separate concern.

## Components

- **New:** `src/core/domains/language/typescript/resolver/strategies/ts-same-file.ts`
  — `TSSameFileSymbolResolutionStrategy implements SymbolResolutionStrategy`,
  `name = "sameFile"`, constructed with `ResolverConfig` (for `mode`). Reuses
  `pickSingleCandidate` and the `resolved`/`CONTINUE` outcome helpers. No new
  contract types.
- **Modified:** `strategies/index.ts` — export the new class.
- **Modified:** `ts-resolver.ts` — instantiate and insert at chain position 8;
  update the pass-order doc comment.

## Testing (TDD)

1. **Unit** — `tests/core/domains/language/typescript/resolver/strategies/ts-same-file.test.ts`,
   mirroring existing strategy tests:
   - bare-call resolves to the same-file definition when the short-name is
     ambiguous across files;
   - `new X()` resolves to same-file `X#constructor`;
   - `Class.staticMember()` resolves to same-file `Class.staticMember`;
   - ambiguous WITHIN the file → `CONTINUE`;
   - target not in caller file → `CONTINUE`;
   - imported (not same-file) symbol → `CONTINUE` (regression guard:
     `namedImport` still owns it).
2. **Chain** — `ts-resolver.test.ts`: a same-file definition wins over global
   ambiguity; the existing `"imports-narrowed fallback for ambiguous global
   short-name"` test must still pass unchanged.
3. **Regression metric** — re-run the probe harness over tea-rags +
   markdownlint-mcp; expect markdownlint bare-call addressable misses 17→~0 and a
   measurable rise in tea-rags in-repo resolution (same-file bare helpers + 12
   constructor edges + same-file statics). Exact deltas recorded post-impl.

## Risk

- Resolver strategy files are deep-silo single-owner (bus-factor) and the
  orchestrator `ts-resolver.ts` is high-churn/recent. Mitigation: new strategy is
  isolated single-purpose; orchestrator change is one insertion + a doc-comment
  update; no edits to existing strategy internals.
- No false-positive risk: every branch requires a UNIQUE same-file candidate.
