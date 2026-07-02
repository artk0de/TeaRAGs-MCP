# lawlq.1 — Scoped AST Return-Type Inference (Design)

**Bead:** `tea-rags-mcp-lawlq.1` (epic `tea-rags-mcp-lawlq`, post-mn00t recall
residual; blocked-by `tea-rags-mcp-mn00t`) **Status:** approved (Approach A,
forms 1–6 including branch unions) **Date:** 2026-07-02

## Problem

`structuredReturnTypes` (`"Class#method"` → `RubyTypeRef`) is populated today
only by YARD `@return` facts (`collectYardReturnFacts`, bd 9bliu). On
un-annotated Rails there are zero YARD tags, so `returnTypeOf` case 1/3 never
fires and chain receivers stay untyped: chain X (in-project-def failures) =
mastodon 369, graphql-ruby 259, huginn 127, plus a dynamic-bucket tail. The only
AST-side substrate is `collectRubyBodyReturnTypes` (local-bindings.ts:215) —
FLAT (`Record<methodName, string>`, no scope keys, feeds only the
`functionReturnTypes` case-4 fallback) and limited to `constInstanceType` last
expressions.

## Approaches considered

- **A. Type-source channel + shared binding-env module (chosen).** New collector
  in `ast-inference.ts` mirroring the 9bliu precedent (`collectYardReturnFacts`
  — the scoped sibling of a flat reader); facts ride the existing
  `RubyTypeFactStore` → `structuredReturnTypesMap` → `returnTypeOf` path. Zero
  edits in walker.ts and resolver.
- **B. Extend `collectRubyBodyReturnTypes` in local-bindings + forward through
  walker.** Rejected: the forwarding-maps channel runs through
  `extractFromRubyFile` — hotspot+hub (30 commits, chunk fanOut 22, chunk
  commitCount 15 extreme); the type-source channel achieves the same without
  touching the hub.
- **C. Resolver-side lazy inference at resolve time.** Rejected: no AST exists
  at resolve time (the tree lives only in the walker phase) — would require
  re-parsing callee bodies, a layering break.

## Design (Approach A)

### Component 1 — `walker/type-sources/binding-env.ts` (new, pure functions)

Extracted shared module breaking the import cycle (`local-bindings` already
imports `ast-inference`, so reuse in the reverse direction is impossible):

- `applyBindingNode(node, env)` — the single set of binding rules
  (`constInstanceType` / relation→container / copy-propagation / `||=`) over
  `Map<string, RubyTypeRef>`.
- `terminalPositions(body)` — terminal value positions of a method body: last
  non-`rescue`/`ensure` statement, recursive descent into `if` / `unless` /
  `case` / ternary branches, plus every `return EXPR` in the body (skipping
  nested `def` / `class` / `module`; non-local `return` from blocks included).
- `typeOfTerminal(node, env, ivarFields, enclosingClass)` — priority: `self` →
  instance(enclosing); `constInstanceType`; `relationElementConst` (from mn00t —
  hence the blocked-by); `instance_variable` → ivarFields; `identifier` → env;
  bare `CONST` → class form.

### Component 2 — `collectAstReturnFacts(input)` in `ast-inference.ts`

walkScope over the class/module stack (the `collectRubyIvarFieldTypes` pattern);
per class: an ivar-binding pass, then per-method env + terminals → facts
`{ kind: "return", source: "ast", symbolScope, methodName, type }`.
`singleton_method` emits the class-form (`.`) key, instance methods `#` —
exactly as 9bliu does. Invoked from `rubyAstInferenceTypeSource.extract`.

### Component 3 — union invariant (form 6, soundness)

- nil terminals (`nil`, missing `else`, guard `return nil`) and `raise`
  terminals are SKIPPED — they do not block the fact (nil-branch-ignored
  convention, consistent with mn00t `||=`).
- Any non-nil UNTYPEABLE terminal → NO fact for the method (a partial union is
  false precision — forbidden).
- All paths one type → plain instance fact, not a union. More than 4 union
  members → skip (real polymorphic factories are ≤3; downstream
  `RubyUnionDispatchResolver` caps anyway).
- Unions travel ONLY via `structuredReturnTypes` (the RubyTypeRef channel;
  contract test exists). String-valued maps drop unions via `refToName` →
  undefined — correct.

### Not touched

`walker.ts`, `type-fact-store.ts` (source precedence sorbet>rbs>yard>ast already
demotes ast below annotations), `type-propagation.ts`, resolver, `contracts/`.
Flat `collectRubyBodyReturnTypes` stays as the `functionReturnTypes` case-4
fallback; its removal is a separate cleanup after the live measurement.

### Coordination

Execution strictly AFTER mn00t lands (blocked-by set): the design references
post-mn00t interfaces (`relationElementConst`, RubyTypeRef-valued bindings).
Consolidating `extract`'s own binding branches onto `applyBindingNode` is a
refactor step inside this task — existing tests green as the gate.

## Testing

TDD per form; existing tests immutable. New describes in `ast-inference.test.ts`
(or a dedicated `ast-return-facts.test.ts`): each form 1–6, union invariant
negatives (untypeable branch → no fact; nil branch skipped; >4 members → skip),
singleton `.`-key, YARD-over-ast precedence via `structuredReturnTypesMap`.

## Live validation

Standard protocol (build+link worktree, reconnect, user-gated force reindex): 4
corpora — bench-mastodon, huginn, graphql-ruby, octokit. Primary bucket: chain
recall (mastodon 0.849, graphql 0.770, huginn 0.488) + dynamic tail.
Honest-denominator gate: `externalSkipped` / `callsNoInProjectDef` must not
grow.

## Forecast

Sub-epic; substrate-exists ×0.5–0.7, union-terminal novelty ×1.2–1.5: P25 2 /
P50 3 / P75 4.5 burst days.
