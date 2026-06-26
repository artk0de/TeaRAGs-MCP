# Ruby Type-Source Mechanism (YARD / Sorbet / RBS) — Design

Date: 2026-06-24 Status: Approved (brainstorming) — spec covers full
architecture + roadmap; implementation plan scoped to Increment 0 + 1 (YARD).

## 1. Motivation

Ruby dynamic-edge **recall** via static receiver type-inference is capped on
un-annotated Rails (measured on huginn: 0 YARD, untyped params, AR-core
methods). The precision pivot (Increment D `i9id8`: arity/visibility
dispatch-narrowing) sidesteps that wall but does not raise recall where types
_are_ declared.

This design goes after recall **where machine-readable types exist**: it adds a
common mechanism for three type sources — **YARD** annotations, **Sorbet**
(`sig {}` / `T.let` / RBI), and **RBS** (`sig/*.rbs`) — that seed receiver
types, and a source-agnostic propagation engine that threads those seeds through
chain calls and container/element flows.

### Two reframing facts (from validation research)

1. **The three annotation systems are mutually exclusive per project.** No large
   OSS project carries full YARD ∧ Sorbet ∧ RBS — they are competing team
   choices. Validation is therefore **per-mechanism fixture**, one golden repo
   per source (Section 9). A pervasively-typed OSS Rails _application_ does not
   exist; dense corpora are gems/tools.
2. **YARD parsing already exists** and already lives outside the god-method, in
   `ruby/walker/local-bindings.ts` (`collectYardParamTypes`,
   `collectYardReturnTypes`, `parseYardBracketType`), gated by
   `CODEGRAPH_RB_LOCAL_TYPE_TRACKING`. "Perfecting YARD" extends an existing
   seam, it does not build from zero.

### Core insight

All three mechanisms answer one question — _"what is the type of receiver X at
location L?"_ — differing only in **input format**, converging on the same
**output** (a type fact feeding `localBindings` / `functionReturnTypes`). What
the user called "chain calls / dynamic type" is **propagation**, not source
logic: the type of `a` flows through `a.b.c.d` identically regardless of how `a`
was seeded. Therefore the expensive logic is built **once**, source-agnostic,
and the three mechanisms are thin adapters.

## 2. Architecture — three layers

```text
[ Sources ]  YardSource | AstInferenceSource | SorbetSource | RbsSource
   (inline: per-file extract)              (sidecar: project pre-pass)
        |  emit RubyTypeFact (param/return/ivar/local + RubyTypeRef)
        v
[ TypeFactStore ]  merge + precedence (sorbet sig > yard > ast-inferred)
                   + union/container normalization
        |  exposes: localBindings(chunk) · returnType(scope,method) · ivarType(scope,ivar)
        v
[ Propagation engine ]  typeOfReceiver(chainExpr, ctx)
                        resolve-time, source-agnostic, built ONCE
        |  known terminal type -> existing resolveTypeInstanceMethod (resolve/DROP)
        |  union -> existing cone fan-out (coneMax)
        |  unknown hop -> STOP (no fabrication)
        v
[ existing SymbolResolutionStrategy chain + resolveDispatch ]  — backbone UNTOUCHED
```

Backbone respected: nothing new is added inside `collectRubyCalls` (`walker.ts`,
fanIn 16, transitiveImpact 29, god-method) or `RubyCallResolver#resolveDispatch`
(`ruby-resolver.ts`, fanIn 9, isHub). New behavior enters through new modules
behind the existing `strategies/` registry seam.

### Rejected alternatives

- **Vertical slices (per-mechanism end-to-end).** Triplicates chain-call logic
  and precision guards across three sites; contradicts "three _similar_
  mechanisms".
- **Source-only, no engine.** Chain-calls / return-threading stay scattered in
  the binding builder and do not scale to dynamic/container types.

## 3. Layer 1 — Type Sources

Normalized fact + type reference (new types in `contracts/types/language.ts`,
beside `ConeTypeLocator`, per `.claude/rules/resolver-architecture.md`):

```ts
interface RubyTypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  symbolScope: string[]; // enclosing class/module FQ scope, e.g. ["Octokit","Client"]
  methodName?: string; // param/return/local: the def it belongs to
  name?: string; // param / ivar / local name (undefined for return)
  line?: number; // 1-based; present for position-scoped inline facts
  type: RubyTypeRef;
}

type RubyTypeRef =
  | { form: "class" | "instance"; name: string } // User / User-instance
  | { form: "union"; members: RubyTypeRef[] } // [A, B]      -> cone
  | { form: "container"; element: RubyTypeRef }; // Array<Post> -> element Post
```

Two delivery modes — this is the architectural fork between YARD/Sorbet and RBS:

```ts
interface RubyInlineTypeSource {
  readonly name: string; // "yard" | "ast" | "sorbet"
  extract(input: RubyExtractInput): RubyTypeFact[]; // colocated, position-scoped
}

interface RubySidecarTypeSource {
  readonly name: string; // "rbs" | "rbi"
  extractProject(ctx: ProjectTypeSourceContext): RubyTypeFact[]; // FQ-name-keyed
}
```

- **Inline** (YARD comments, Sorbet `sig {}` / `T.let`): parsed from the same
  `.rb` file during `extractFromRubyFile`. `sig {}` is a Ruby AST node (call +
  block) — tree-sitter-ruby already parses it, **no new grammar**.
- **Sidecar** (`sig/*.rbs`, `sorbet/rbi/`): parsed in a project-level pre-pass,
  joined to `.rb` symbols by **fully-qualified name** (not by line).

Registry is a **typed array** (`INLINE_TYPE_SOURCES`, `SIDECAR_TYPE_SOURCES`),
not self-registration — house style per resolver-architecture.md rule #3. Adding
a mechanism = one module file + one array entry.

## 4. Layer 2 — TypeFactStore

Merge + normalize layer. Responsibilities:

- **Precedence** on conflict (e.g. YARD `[User]` vs Sorbet `T.nilable(Post)`): a
  single documented order, default `sorbet > rbs > yard > ast-inferred`. This is
  the layer's primary value.
- **Normalization** of `union` / `container` `RubyTypeRef`s into the shapes the
  engine consumes.
- **Persistence routing**: inline facts are persisted into `FileExtraction`
  (extending today's per-chunk `localBindings` + `functionReturnTypes` with an
  ivar-type map); sidecar facts are loaded by the pre-pass into the global
  resolve-time context.

Exposes exactly the lookups consumers need:

- `localBindingsForChunk(range) -> Record<var, LocalBinding[]>` (replaces
  today's per-chunk YARD+AST output in `collectLocalBindingsForChunk`)
- `returnType(scope, method) -> RubyTypeRef | undefined` (global; feeds chain
  threading)
- `ivarType(scope, ivar) -> RubyTypeRef | undefined`

## 5. Layer 3 — Propagation engine (resolve-time)

New module `ruby/resolver/type-propagation.ts`. Resolve-time because chain
threading needs **cross-file** information (return types, ancestors, the global
symbol table) unavailable in the per-file worker walk.

```text
typeOfReceiver(expr, ctx):
  local var with binding      -> seed type (existing localBindings)
  @ivar                       -> ivarType (existing classFieldTypes + new from sources)
  chain a.b...:
     t = typeOfReceiver(a, ctx)              # recurse on head
     for each link .m:
        t = returnTypeOf(t, m, ctx)           # store.returnType / DSL assoc map / ancestor MRO
        if t is unknown -> STOP               # precision: never fabricate
     return t
  container/element context (block param, .first, [i]) -> element type   # Incr-1 dynamic
  union                                                -> union (caller cones)  # Incr-1 union
```

**Precision policy reuses the two existing edge policies** — the engine only
extends how far a _known_ type travels:

- known terminal type -> `resolveTypeInstanceMethod` (resolve-or-**DROP**, the
  existing `localType` semantics)
- union -> existing **cone fan-out** with `coneMax` / confidence `1/N`
- unknown hop -> **STOP**; falls through to existing discounted dynamic fan-out
  (`RubyDynamicDispatchResolver`) / external classifier

This is the direct tie-back to the huginn precision pivot: chain propagation
**never invents an edge** — it stops at the first unknown hop.

## 6. Integration

The engine is invoked from a **new** `SymbolResolutionStrategy`
(`ruby/resolver/strategies/ruby-chain-type.ts`) slotted into the existing
`strategies/index.ts` registry, between the local-type and dynamic-dispatch
passes. `RubyCallResolver#resolveDispatch` and `collectRubyCalls` are not
modified. The single-target chain (`SymbolResolutionStrategy`,
`resolved`/`DROP`/`CONTINUE`) carries terminal/known resolutions; union/dynamic
fan-outs flow through the existing `DispatchResolverComponent` path.

## 7. Increment roadmap

| #                       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fixture / metric                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **0** refactor          | Introduce `TypeSource` + `TypeFactStore` + engine seam; **relocate** existing YARD (`collectYard*`, `parseYardBracketType`) and AST-inference (`constInstanceType`, `INSTANCE_RETURNING_METHODS`, `RELATION_RETURNING_METHODS`, copy-prop) behind the `yard` and `ast` adapters. Behaviour byte-identical: `resolveSuccessRate` / `byReceiverKind` must not move. Relocation discipline — relocate code -> existing tests green untouched -> redistribute tests last; no new behaviour. | self-test, zero delta                                            |
| **1** YARD to the limit | Build the propagation engine + the four capabilities (Section 8).                                                                                                                                                                                                                                                                                                                                                                                                                       | **octokit/octokit.rb** — dynamic-edge `resolveSuccessRate` delta |
| **2** Sorbet            | Inline adapter: `sig { params(...).returns(...) }` + `T.let` from tree-sitter AST.                                                                                                                                                                                                                                                                                                                                                                                                      | **Shopify/ruby-lsp @ v0.13.0**                                   |
| **3** RBS               | Sidecar adapter + project pre-pass + FQ-join. **Open sub-question**: RBS parse strategy — tree-sitter-rbs grammar vs hand parser for the signature subset. **NOT** shelling out to the `rbs` gem — the indexer stays Ruby-runtime-free.                                                                                                                                                                                                                                                 | **ruby/rbs**                                                     |

Increments 2 and 3 get their own spec -> plan -> implementation cycles (distinct
fixtures and open questions). This spec drives the plan for **0 + 1 only**.

## 8. Increment 1 detail — the four capabilities

1. **Chain-call threading (multi-hop)** — the recall driver. Today only one
   `@return` hop resolves. The engine threads `a.b.c.d` link-by-link via
   `returnType` + the Rails DSL association map + ancestor MRO; known type at
   every hop -> terminal resolve/DROP, first unknown hop -> stop.
2. **Container / element + block-param** — the "dynamic type" case.
   `Array<Post>` / `Relation<X>` -> element `Post`; `arr.each { |p| p.m }` ->
   block param `p : Post`; `.first` / `.last` / `[i]` -> element. Extends the
   hardcoded container list and lifts `receiverIsIndexAccess` suppression where
   the element type is known.
3. **Union `[A, B]` -> cone fan-out** —
   `@param x [Integer, String, Repository]`: the receiver may be any union
   member; fan out to in-project members as cone-edges (confidence `1/N`,
   reusing the existing `coneMax` mechanism). octokit-dense,
   precision-controlled.
4. **Exotic YARD tags** — `@type` (local var), `@!attribute` / `@!parse`,
   `@option`. Lowest ROI; sequenced as the **last sub-task** of Increment 1
   (droppable under time-box without blocking the recall wins from 1–3).

## 9. Validation harness

Per-mechanism golden fixture, each indexed as a separate project alias. Metric:
dynamic-edge `resolveSuccessRate` + `byReceiverKind`, source-gating env toggled
off/on for before/after delta.

| Mechanism | Fixture                         | Verified coverage                                                                                  |
| --------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| YARD      | `octokit/octokit.rb` (~11k LOC) | 1929/1942 = 99.3% tags carry `[Type]`; union + generic types pervasive                             |
| Sorbet    | `Shopify/ruby-lsp @ v0.13.0`    | codebase-wide `# typed: strict`, classic `sig {}` (HEAD migrated to RBS-inline `#:` — pin the tag) |
| RBS       | `ruby/rbs`                      | 50+ `.rbs` in `sig/`, Steep CI `check lib` vs `signature sig`                                      |

Backups: Sorbet -> `Shopify/tapioca @ v0.11.0`; RBS -> `soutaro/steep` (99.9%
Ruby) or inline `yob/pdf-reader`; YARD -> `lostisland/faraday` (~4k LOC, fast).
Rails-domain dense typing is uncovered by OSS — generate RBI via `tapioca` on an
arbitrary Rails app, or use the small `pocke/rbs_rails`.

## 10. Affected files (Increment 0 + 1)

#### New

- `contracts/types/language.ts` — `RubyTypeFact`, `RubyTypeRef`,
  `RubyInlineTypeSource`, `RubySidecarTypeSource`, `ProjectTypeSourceContext`
- `ruby/walker/type-sources/{yard,ast-inference,index}.ts` — relocated parsers +
  typed-array registry
- `ruby/walker/type-fact-store.ts` — merge / precedence / lookups
- `ruby/resolver/type-propagation.ts` — the engine
- `ruby/resolver/strategies/ruby-chain-type.ts` — new strategy

#### Modified

- `ruby/walker/local-bindings.ts` — thinned to the AST-source adapter; YARD
  parse moves to the `yard` source
- `ruby/walker/walker.ts::extractFromRubyFile` — drives sources via the store,
  not inline YARD
- `ruby/index.ts` — composes the source registry into the resolver
- `ruby/resolver/strategies/index.ts` — registers `ruby-chain-type`
- `contracts/types/codegraph.ts` — extend `CallContext` / `FileExtraction` with
  an ivar-type map and a richer return map if needed

## 11. Open questions / risks

- **`LocalBinding` shape.** `ruby-local-type.ts` reads `binding.valueKind`
  (`"class"` | `"instance"`); the survey saw `LocalBinding = { line, type }`.
  Confirm the exact field set during planning — the engine needs `valueKind` to
  pick class-vs-instance seed resolution.
- **Precision regression guard.** Multi-hop threading widens the surface for
  mis-resolution. Every increment gates on `resolveSuccessRate` not regressing
  on the self-test index and on a deliberate before/after on the fixture.
- **RBS parser (Increment 3).** Deferred; recorded above. Must not introduce a
  Ruby runtime dependency.

## 12. Out of scope

- Cross-language type sources (TS/Java already have their own resolvers).
- Inferring types from runtime/test execution.
- Sorbet / RBS implementation detail — owned by their own specs.
