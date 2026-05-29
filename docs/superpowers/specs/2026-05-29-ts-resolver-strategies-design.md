# TS Resolver — In-Code Resolution Strategies

**Date:** 2026-05-29 **Status:** Approved (design) **Scope:** Pilot —
`domains/language/typescript/resolver` only. Other languages follow once the
contract holds on TS.

## Problem

`TSCallResolver#resolve` is a single ~180-line method that is, in fact, an
ordered chain of independent resolution passes (the code already labels them
"Step 0", "First pass", "Second pass", "Third pass", "fallback"). Each pass is a
distinct technique for mapping a call site to a target symbol. The passes are
load-bearing in two ways the current shape hides:

1. **Order matters.** An unambiguous local-type hit must win over the ambiguous
   global short-name fallback. Reordering passes silently changes resolution.
2. **Two kinds of pass.** Most passes _resolve or fall through_. Some passes are
   _guards_ that must **drop the edge and stop the chain** — e.g. `super`
   without `classExtends` must return null rather than fall through to same-file
   lookup (bug `tea-rags-mcp-4rgg`). The drop-vs-continue distinction is encoded
   only as "early `return null`" vs "fall through", which is invisible at a
   glance and easy to break.

The walker is explicitly **out of scope**: it is bound to the tree-sitter
grammar of each language, shares almost no code across languages, and is already
decomposed into functions inside `walker/walker.ts` + barrel. There is nothing
to modularize there without inventing cross-language abstraction that does not
exist.

## Goal

Decompose `TSCallResolver#resolve` into one strategy unit per pass, with an
explicit three-state outcome, behind a per-language contract. The orchestrator
becomes a thin ordered loop. No cross-language code sharing — only the contract
shape is shared.

## Contract (shared, `contracts/`)

The contract is the **only** thing shared across languages. Each language owns
its own strategy implementations; `ts/super` and `ruby/super` differ in
substance (tsconfig paths vs Zeitwerk vs MRO), so sharing their bodies would
reintroduce `if (language === ...)` branching inside a "shared" strategy.

```ts
// contracts/types/language.ts (or a dedicated resolution.ts)

type InCodeResolutionOutcome =
  | { kind: "resolved"; target: InCodeResolutionTarget }
  | { kind: "drop" } // guard: stop the chain, emit NO edge
  | { kind: "continue" }; // not my case, try the next strategy

interface InCodeResolutionStrategy {
  readonly name: string; // debug id, e.g. "namedImport", "super"
  attempt(call: CallRef, ctx: CallContext): InCodeResolutionOutcome;
}
```

- `InCodeResolutionTarget` is the rename of the existing `ResolvedTarget`
  (`{ targetRelPath, targetSymbolId }`). The rename touches all 6 resolvers +
  walker types + codegraph consumers; it is part of this work for TS and the
  type itself is shared, so the rename lands repo-wide in one step even though
  only TS is decomposed.
- Helper constructors `resolved(target)`, `DROP`, `CONTINUE` keep strategy
  bodies readable.

**Naming.** Family is `InCodeResolution*` (no `Symbol`) per
`.claude/rules/naming.md` — `InCode` is the disambiguator (resolves symbols
present in the indexed codebase, not external libs / stdlib / type stubs).

## Per-language structure (TS pilot)

```
language/typescript/resolver/
  ts-resolver.ts                 # orchestrator: InCodeResolutionStrategy[] + loop
  strategies/
    ts-super.ts                  # TSSuperInCodeResolutionStrategy
    ts-this-member.ts            # TSThisMemberInCodeResolutionStrategy
    ts-field-type.ts             # TSFieldTypeInCodeResolutionStrategy
    ts-local-binding.ts          # TSLocalBindingInCodeResolutionStrategy
    ts-named-import.ts           # TSNamedImportInCodeResolutionStrategy
    ts-import-basename.ts        # TSImportBasenameInCodeResolutionStrategy
    ts-receiver-symbol.ts        # TSReceiverSymbolInCodeResolutionStrategy
    ts-global-short-name.ts      # TSGlobalShortNameInCodeResolutionStrategy
    ts-import-narrowed-fallback.ts # TSImportNarrowedFallbackInCodeResolutionStrategy
    index.ts                     # barrel
  ts-path-mapper.ts              # unchanged shared helper
  index.ts
```

## Orchestrator

```ts
class TSCallResolver {
  private readonly strategies: InCodeResolutionStrategy[];

  constructor(cfg: ResolverConfig) {
    this.strategies = [
      new TSSuperInCodeResolutionStrategy(cfg),
      new TSThisMemberInCodeResolutionStrategy(cfg),
      new TSFieldTypeInCodeResolutionStrategy(cfg),
      new TSLocalBindingInCodeResolutionStrategy(cfg),
      new TSNamedImportInCodeResolutionStrategy(cfg),
      new TSImportBasenameInCodeResolutionStrategy(cfg),
      new TSReceiverSymbolInCodeResolutionStrategy(cfg),
      new TSGlobalShortNameInCodeResolutionStrategy(cfg),
      new TSImportNarrowedFallbackInCodeResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): InCodeResolutionTarget | null {
    for (const s of this.strategies) {
      const outcome = s.attempt(call, ctx);
      if (outcome.kind === "resolved") return outcome.target;
      if (outcome.kind === "drop") return null;
      // continue → next strategy
    }
    return null;
  }
}
```

`ResolverConfig` carries `mode` (strict/first) and the TS-specific options
(`tsOptions` / `knownPaths` inputs). Free helpers (`pickSingleCandidate`,
`mapImportToFile`, `importMatchesReceiver`) stay as direct imports.

## The 9 TS strategies

Order is preserved exactly from today's `resolve`. "Outcomes" lists which
`kind`s each strategy can return.

| #   | `name`                   | What it does                                                                                                                                                                                 | Outcomes             |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1   | `super`                  | `super.x()` → parent class via `classExtends`, resolve `<Parent>#member`. No `classExtends` → drop (must not fall through to same-file, bug 4rgg). Always terminal when receiver is `super`. | resolved \| drop     |
| 2   | `thisMember`             | `this.x()` → `<EnclosingClass>#x` / `.x` in the same file.                                                                                                                                   | resolved \| continue |
| 3   | `fieldType`              | `this.field.x()` → declared field type from `classFieldTypes`, then `<Type>#x` / `.x`.                                                                                                       | resolved \| continue |
| 4   | `localBinding`           | `param.x()` where the walker bound `param` to a type in `localBindings` (bd x6ta). Unambiguous local type wins over import fallback.                                                         | resolved \| continue |
| 5   | `namedImport`            | receiver ∈ `import { Receiver } ...` `importedNames` (bd 2v16) → exact named-specifier match, FQN-narrow within the matched file.                                                            | resolved \| continue |
| 6   | `importBasename`         | basename-normalized compare (`rank-module.js` → `RankModule`, bd kiuw) — fallback for imports lacking `importedNames`.                                                                       | resolved \| continue |
| 7   | `receiverSymbol`         | receiver-as-symbol (bd kiuw): intersect "imported files" ∩ "files declaring receiver as top-level symbol"; single hit → resolve member there.                                                | resolved \| continue |
| 8   | `globalShortName`        | global short-name lookup; `pickSingleCandidate(mode)`.                                                                                                                                       | resolved \| continue |
| 9   | `importNarrowedFallback` | when global short-name is ambiguous (N>1, interface dispatch, bd 2qp6) → narrow ambiguous candidates by caller's imported files.                                                             | resolved \| continue |

## Testing

This is a **relocation refactor**, so it inverts normal TDD (`.claude/rules` →
refactor-migration-test-order):

1. Extract strategies — **code move only**, no behavior change.
2. Existing
   `tests/core/domains/language/typescript/resolver/ts-resolver.test.ts` stays
   **green** throughout — it is the integration safety net. It is NOT rewritten
   (business-logic tests are immutable).
3. Per-strategy unit tests are added **last**, after the relocation is green.

## Risks

- **Order / drop-point fidelity.** The whole correctness of resolution rests on
  pass order and the exact points where the chain drops vs continues (bugs 4rgg
  / 2qp6 / and the Ruby-side jsa0 / lttd). The migration must reproduce them
  exactly; the behavioral test suite is the guard.
- **Single-author silo.** The resolver files are 100% one author. Per
  `.claude/rules/silo-pairing.md` commits touching them carry a `Why:` line.
- **`ResolvedTarget` rename blast radius.** The type is shared; renaming to
  `InCodeResolutionTarget` touches all 6 language resolvers, walker types, and
  codegraph consumers in one step. tsc is the guard.

## Out of scope (YAGNI)

- Walker decomposition — bound to grammar, already function-decomposed.
- Cross-language shared strategy bodies or an abstract base across languages.
- Changing the `CallContext` shape.
- Decomposing the other 5 resolvers — follows after the TS pilot validates the
  contract.
