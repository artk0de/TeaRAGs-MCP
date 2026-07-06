# Self-receiver abstract-hook dispatch — design

Date: 2026-07-06 · Epic anchor: cai0 Ruby recall/precision · Beads epic: `tea-rags-mcp-u7d9l`

## Summary

Two codegraph Ruby dispatch defects, discovered via live taxdome forensics, are
two branches of **one** gate. Both ship as a single epic increment.

- **DEFECT 1 (precision).** An over-cap dispatch fan-out is recorded as a
  `cg_ambiguous_fanout` aggregate even when the receiver chain is rooted in an
  **external** constant (witness: `Capybara…action…release.perform`,
  candidateCount 217). `get_callers(target, includeAmbiguous:true)` then surfaces
  pure external noise. The receiver is provably external, so no aggregate should
  be recorded.

- **DEFECT 2 (recall).** A shared base method (`M` in module/class `A`) issues a
  bare implicit-self call to a hook `H` that `A` does not define but its
  subtypes/includers do. Resolving `H` at that shared template — where `self` is
  abstract — is where recall dies: it drops, points at the abstract stub, or goes
  over-cap ambiguous. Witness anchor: taxdome `KindOfService` — its `#call`
  template calls a bare `perform` no includer-agnostic definition exists for.
  The fix resolves NOT at the template but at each **entry** `Const.call`, where
  the receiver `Const` is a concrete constant → the hook narrows to exactly one
  `Const#perform`. (The ~3548 `SomeService.call` sites are the entry fanIn and
  already resolve to the class-method entry; the abstract-hook miss is the single
  bare `perform` inside the template — the recall surface is the abstract-hook
  call sites across the witness bases, not 3548.)

The mechanism is a **purely structural predicate** — it depends on NO codebase,
NO gem, NO method name. `KindOfService`/`call`/`perform` never appear in the
code. The nine bases surfaced by the generality probes are *witnesses* that the
predicate fires broadly, not a hardcoded list.

## Measured evidence (generality)

Three read-only forensic probes over indexed Ruby projects.

**taxdome-internal — systemic, not KindOfService-specific.** ≥5 in-codebase
bases satisfy the predicate across three terminal states, ~90–140 lost terminal
edges beyond the ~3548 KindOfService sites:

| Base (witness) | terminal | ~scale | current graph state |
| --- | --- | --- | --- |
| `KindOfService` | bare `perform` on self | 3548 sites / 200+ | drop |
| `BaseProcessor` | `self.new.process_result` | 59 subclasses | ambiguous (candidateCount 59) |
| `ApplicationCsvExporter` | bare `build` | ~12–14 | edge → abstract stub |
| `Tech::BaseExportWorker` | bare `export_service`/`export_type`/… | ~11 | edge → abstract stub |
| `BaseEvent#to_h` | shorthand-hash `type:`/`action:`/… | dozens (fanIn 86) | no edge at all |

plus a `Base*`/`Abstract*` population (`Payload::Base`, `BaseAdapter#mapping`,
`Types::Base#valid?`, `SkipStrategy#should_skip?`) of the same silhouette.

**Cross-project — form near-universal, but only the target sub-form is lost.**
The pattern exists in 4/4 non-trivial Ruby projects + sinatra (out-of-repo), but
codegraph **already resolves** the receiver-is-typed variants — do NOT
re-implement them:

| Witness | terminal sub-form | status |
| --- | --- | --- |
| mastodon `BaseService.new.call` | literal receiver | already `exact` |
| huginn `agent.check` | typed local → cone | already `poly-base` |
| octokit `Connection#get` | MRO scope-tail | already `exact` |
| **taxdome `KindOfService`** | **bare-hook on abstract self** | **lost** ← target |
| **graphql-ruby `Resolver#resolve`** | `public_send(self.class.resolve_method)` | **lost** ← adjacent |

Consequence: the incremental win concentrates in **bare/`self.new` receiver on
an abstract hook**. Typed/literal receivers are out of scope (covered). The
dynamic `public_send(self.class.<m>)` variant is **adjacent** — same insight, but
needs an extra constant-fold capability; a separate follow-up, not this epic.

## Generalized predicate (no codebase dependency)

A call site fires the mechanism iff ALL hold — every clause is a structural fact
about the AST node and the symbol graph, never a name:

1. **Receiver kind** ∈ { implicit-self (bare call) | `self.new` | `self.class.new` }.
2. **Enclosing** method is defined in a type `B` (class OR module).
3. **Abstract-in-B**: `B` does not concretely define the member `m` — either `B`
   has no own definition of `m`, or `B`'s own `m` is an abstract stub (body is a
   single `raise NotImplementedError` / empty / bare `super`).
4. **Concrete-in-subtypes**: at least one subtype/includer of `B` defines `m`
   with a real body.

When the predicate holds, the concrete self-type is drawn from the type flowing
into `B`, and `m` resolves to the concrete override(s).

## Mechanism — entry-anchored self-narrowing (interprocedural)

DEFECT 2 is NOT a cone/CHA fan-out. Cone is context-INsensitive: it conflates
every entry onto the shared template node and emits N edges
(`KindOfService#call → {all ~200 includers}#perform`). No single execution
dispatches to all 200 — that fan-out is a **representation error**, not
completeness (and above `coneMax` it degrades to a useless file-only poly-base).

The real trace is per-entry and singular. The ambiguity is artificial — it
appears only when resolving at the shared template where `self` is abstract. At
the ENTRY the receiver is a **concrete constant** (`Create.call` — `Create` is
known), so the candidate set narrows to exactly ONE by construction:

```
Create.call   → Create#perform     (receiver Create concrete → 1)
Refresh.call  → Refresh#perform    (receiver Refresh concrete → 1)
```

**The narrowing key is the concrete constant receiver at the entry**, not the
type hierarchy — the cone is degenerate (a point) from the start. Mechanism, per
entry call-site `Const.member`:

1. `member` resolves via MRO/ancestry (`resolveInstanceMethodInClassChain`) to an
   inherited method `M` declared in ancestor `A` (module/class) — NOT in `Const`
   itself.
2. `M` is a **self-dispatch template**: its body reaches a hook `H` on `self` —
   as a bare implicit-self call (`H`), `self.H`, or a class-method template that
   instantiates self and dispatches (`self.new.H` / `self.class.new.H`) — where
   `A` does NOT define `H` but `Const` DOES. `H` is discovered structurally, not
   by name — see the pre-pass below. The self-reach may be multi-hop within `A`'s
   own methods (`export_to_string → build_columns → build`).
3. Emit ONE edge to `Const#H`. `Const` concrete ⇒ single target; no fan-out, no
   poly-base, no cone.

### Template→hook discovery (the interprocedural pre-pass)

Recognising "`M` self-dispatches abstract hook `H`" needs `M`'s body (its bare
self-calls) — the resolver sees one call at a time, so a pre-pass builds a map
`templateMethodSymbolId → abstractHookMember`. Structural predicate per method
`M` in type `A`: `M` contains a bare implicit-self call to member `H`, `A` does
NOT concretely define `H` (abstract: absent, or a `raise NotImplementedError` /
empty / bare-`super` stub), and ≥1 subtype/includer of `A` defines `H`. The
provider already holds every method's call-list in its two-pass extraction, so
the map is one cheap pass — NO grammar, NO name catalogue, NO `KindOfService` /
`perform` / `call` literal anywhere.

### Wiring channels — the mechanism spans all four

`A` relates to its concrete definers of `H` through any Ruby mixin channel; the
mechanism is defined over their **union**, not `include` alone:

| Channel | `A`'s role | concrete definers |
| --- | --- | --- |
| `class C < A` | superclass template | subclasses |
| `include A` | mixed-in template | includers |
| `prepend A` | pre-pended template (above `C` in MRO) | prependers |
| `extend A` | class-method template (`self.call` → `self.new.H`) | extenders |

`extend` is NOT an edge case — it is the primary channel for class-method-entry
templates (the `self.call` / `self.process_result` shape; witness `BaseProcessor`).
Feasibility is already met: the walker captures every channel — `classAncestors`
folds `< / include / extend` into one list, `classPrependedAncestors` holds
`prepend`, `includedBy` gives the reverse (module → includers). No new walker
work; the discovery pre-pass and the entry MRO walk read existing structures.
Entry resolution across the singleton/extend channel is proven live: `Const.call`
already resolves to the class-method template (fanIn 3548).

## Terminal policy (three structural states)

The entry-anchored resolution yields exactly ONE concrete `Const#H`; the terminal
action depends on the entry call's CURRENT graph state — never on base identity:

- **CREATE** — no edge exists for the entry's hook path → emit `Const#H`.
- **REDIRECT** — an edge points at `A`'s abstract stub → replace with concrete
  `Const#H`.
- **COLLAPSE** — the call is over-cap ambiguous → replace the ambiguous aggregate
  with the single `Const#H`.

One resolver, three terminal states, one concrete target each.

## Representation — entry-anchored (not template-anchored)

The edge is attributed to the **entry call-site's enclosing method**, threaded to
the concrete hook: `enclosing(Const.member) → Const#H`. One edge per real entry —
they never pile up at the shared template node, so the 200-fan-out cannot recur.
`get_callers(Create#perform)` → the real callers, 1-to-1.

The physical edge bypasses the middle template node (`KindOfService#call`), which
keeps only its own already-existing entry edges. The literal 3-node path
(`SomeService.call → KindOfService#call → SomeService#perform`) is the
context-SENSITIVE trace; storing it WITH the middle node would need call-site-
qualified edges (a context-sensitive graph model — explicitly out of scope). The
entry-anchored edge gives the same `get_callers` / `trace_path` answers at
method→method granularity.

## Precision branch (DEFECT 1)

Same gate, sibling branch. In `provider.ts` `resolveExtraction`, the
`resolveDispatch` "ambiguous" verdict currently records the
`cg_ambiguous_fanout` aggregate and `continue`s BEFORE the `targetsExternalImport`
external check. Fix: when the dispatch fan-out's receiver is **provably external**
(chain rooted in an external constant — reuse
`RubyExternalVocabulary#isQualifiedReceiverExternal` / `resolveChain`), classify
`externalSkipped` and DO NOT record the aggregate. The K-cap is unaffected (it
already suppresses the *edges*); this suppresses the *aggregate row* for external
receivers. Net: the 7 Selenium noise rows disappear; no recall change.

Gate shape:

```
over-cap / abstract-self dispatch fan-out
  ├─ receiver provably external            → suppress aggregate            [DEFECT 1]
  ├─ entry Const.member → inherited self-  → emit Const#H (concrete → 1)   [DEFECT 2]
  │   dispatch template with abstract H       terminal: CREATE|REDIRECT|COLLAPSE
  └─ else (in-project name-collision)      → scoped ambiguous aggregate (unchanged)
```

## Scope boundaries

- IN: self-dispatch to an abstract hook — bare `H` / `self.H` / `self.new.H` /
  `self.class.new.H`, possibly multi-hop — across ALL wiring channels
  (`< / include / prepend / extend`); entry-anchored narrow-to-1 by the concrete
  constant receiver; three terminal states; external-receiver aggregate
  suppression (DEFECT 1, done).
- OUT (adjacent follow-up): dynamic `public_send(self.class.<method>)`
  (graphql-ruby) — needs constant-fold `self.class.<m> → :symbol`.
- OUT (adjacent follow-up, closes the dynamic-extend gap): an
  `ActiveSupport::Concern` DSL grammar — `include ActiveSupport::Concern` +
  `class_methods do … end` is a recognizable static shape that installs the
  block's methods as class methods on includers. Modeled as a grammar (like the
  gem-gated vocabularies), it makes the Concern extend-channel statically visible
  so the entry `Const.<classMethod>` resolves and the self-dispatch mechanism
  anchors on top. Composes with the core; not required for the literal-`extend` /
  `def self.<m>` witnesses (whose entries already resolve — `KindOfService.call`
  fanIn 3548).
- OUT (already covered): typed-local receivers (cone), literal receivers
  (`exact`), MRO scope-tail, ivar/param receiver-type inference.
- Do NOT touch: the f2jsb reindex/perf work (owned by a parallel session).

## Testing & validation

- Unit (TDD, RED first): template→hook discovery predicate (bare self-call to H,
  A abstract-in-H via absent / `raise NotImplementedError` / empty / bare-super,
  ≥1 subtype defines H; negative when A concretely defines H); entry-anchored
  narrow-to-1 (`Const.member` → single `Const#H`, NOT a fan-out; two concrete
  Consts → two distinct 1-edges, never piled on the template); three terminal
  states (create/redirect/collapse) as separate cases; external-receiver
  aggregate suppression (DEFECT 1, done).
- No production code before a failing test. Business-logic tests immutable.
- Live validation (user-gated reindex): measure taxdome codegraph recall
  byReceiverKind before/after via the committed
  `scripts/taxdome-codegraph-recall-forensics.ts` harness (~84s, ollama-free) —
  bareCall miss bucket must drop; no denominator gaming; DEFECT-1 check =
  `get_callers(any #perform, includeAmbiguous:true)` no longer returns the
  Selenium `dnd_helpers.rb` rows.

## Risks

- **Modest recall-rate surface.** The abstract-hook miss is the ONE bare hook
  inside each shared template (not the entry fanIn — `KindOfService.call`'s ~3548
  callers already resolve). Addressable ≈ the abstract-hook call sites across the
  witness bases + `Base*/Abstract*` population (~dozens–low-hundreds of call
  sites out of ~4452 bareCall misses). Real but bounded; the per-entry EDGES are
  the higher-value navigation win.
- **Interprocedural pre-pass cost** on a 3M-LOC index — the template→hook map is
  one pass over method call-lists the provider already materialises in its
  two-pass extraction; must not add a second full walk. Bound to methods whose
  enclosing type is abstract-in-member.
- **Abstract-stub detection** must be conservative: only absent, single-statement
  `raise NotImplementedError`, empty, or bare-`super` bodies count as abstract —
  else a real base method is wrongly treated as a hook. Guard with tests.
- **Context-sensitivity ceiling.** The literal 3-node trace is not stored (method
  →method graph); entry-anchored edges preserve navigation answers but bypass the
  template node. Call-site-qualified edges (true context sensitivity) are
  explicitly out of scope.
- Every dispatch file is a single-owner deep-silo (no second reviewer) — lean on
  adversarial self-review + the live harness, not a green unit suite alone.

## Implementation status (v1 — shipped, branch `worktree-cg-self-dispatch`, NOT merged)

Shipped and green (unit + e2e through the real provider two-pass):

- **DEFECT 1 (precision).** External-rooted receiver chain suppresses the
  `cg_ambiguous_fanout` aggregate — `chainRootConstantIsExternal` gate in
  `ruby-dynamic-dispatch.ts`. e2e `provider-ambiguous-fanout-external.test.ts`.
- **Discovery pre-pass** (`self-dispatch-discovery.ts`, in
  `domains/trajectory/codegraph/symbols/` — a codegraph pre-pass, NOT a resolver
  concern; the dependency-direction guard forbids `trajectory → domains/language`).
  `discoverSelfDispatchTemplates` + provider-facing pure adapters
  (`extractSelfDispatchMethods`, `buildSelfDispatchProbe`,
  `foldSelfDispatchTemplates`).
- **Entry strategy** `RubySelfDispatchEntrySymbolResolutionStrategy` (in the
  resolve chain, BEFORE `constant`): `Const.member` → template `M` (class-method
  MRO) → `ctx.selfDispatchTemplates[M]` → `resolveTypeInstanceMethod(Const, H)` →
  single `Const#H`.
- **Provider two-pass wiring**: Ruby-gated pass-1 accumulation of light
  `SelfDispatchMethod` records → barrier discovery over the run-global symbol
  table + hierarchy view → `CallContext.selfDispatchTemplates` threaded per file.

Deferred (safe under-coverage, no false edges — each a follow-up bead):

- **Stub REDIRECT terminal.** `definesConcretely` currently answers "a body
  exists", not "concrete vs abstract stub" — there is NO stub signal in the
  extraction (`SymbolDefinition`/`ChunkExtraction` carry no
  `raise NotImplementedError`/empty/bare-super marker). So the ABSENT-hook CREATE
  case (dominant service-object shape, e.g. KindOfService) is covered; a
  `raise NotImplementedError` stub reads as concretely-defined and its REDIRECT
  template is not discovered. Needs a walker-emitted `isAbstractStub` flag.
- **Multi-hook templates.** `foldSelfDispatchTemplates` EXCLUDES a template that
  reaches >1 distinct hook (a genuine fan-out the single-target
  `SymbolResolutionStrategy` cannot express) — deferred to a
  `DispatchResolverComponent` variant, not silently truncated.
- **Two-hop class-method entry** (`self.call → new.call → #call → perform`): the
  constant entry resolves to the class-method template only; an instance-method
  template two hops in is not reached in v1.
- **Adjacent grammars** (unchanged from Scope): graphql-ruby
  `public_send(self.class.<m>)`; `ActiveSupport::Concern` `class_methods do…end`.

## Live validation findings (2026-07-06) — v1 is a validated NO-OP on taxdome

Measured in-process via `scripts/taxdome-codegraph-recall-forensics.ts` (extended
with the DEFECT-2 wiring behind `CODEGRAPH_SELF_DISPATCH=1`, and a new
distinct-edge-target coverage metric), A/B OFF vs ON, on huginn + taxdome.

**Discovery is CORRECT on real code.** taxdome: **44 templates discovered**
(huginn: 5) — including the exact recall-hole template `KindOfService#call →
perform`, plus 39 real concern hooks (`…#acceptable_payment_methods → firm`,
`…Shortcodes#resolved_* → client`, `SoftDeletable#restore → update`, …) and 5
class-form (`ApplicationRecord.external_name → name`, …). `definesConcretely`,
`relatedConcreteTypes` (2127 KindOfService includers), and the abstract-hook
predicate all resolve correctly.

**The entry strategy fires on ZERO taxdome calls** (ON ≡ OFF: 18270 edge targets,
missWithInProjectDef 21207, resolveSuccessRate 84.62% — identical). No regression,
no false edges — but no recall gain either. Root cause: **every discovered
template is reached by a shape v1 does NOT anchor**:

- **39 instance-form templates** (incl. `KindOfService#call → perform`) are entered
  by INSTANCE dispatch / bare-self-in-includer, not `Const.member`. v1 only
  anchors a **constant receiver**.
- **KindOfService specifically** is a **two-hop, self-instance-binding** chain:
  `Create.call` (class method installed by `class_methods do` — ActiveSupport::
  Concern) → `instance = new(*a); instance.call` → instance `#call` → `perform`.
  The class entry `KindOfService.call`'s only self-hook is `new` (the `instance.
  call` delegation is on a LOCAL var across two statements, invisible to the
  single-hop self-receiver predicate). v1 does one hop, `Const.member → Const#H`.
- **5 class-form templates** are one-hop-eligible but have no `Const.member`
  call-sites (called bare/self internally).

**Verdict:** v1 ships a proven-correct *discovery* + a *safe, narrow* constant-entry
resolver (e2e-proven on `<`-inheritance / literal-`self.call` shapes), but it does
NOT move taxdome recall. Closing the real taxdome hole needs a **v2 entry
mechanism**: self-instance local-binding tracking (`inst = new(…); inst.m`) +
multi-hop (class-entry → instance-template → hook) + the ActiveSupport::Concern
`class_methods do` grammar so `Const.call` resolves to the class template. Filed
as a follow-up; v1 is the correct foundation it builds on.

**Incidental harness fix:** the committed forensics harness read `.length` on the
`DispatchFanoutOutcome` object returned by `resolveDispatch` (always falsy →
always fell through to `resolve()`), under-counting dispatch edges — taxdome
`resolveSuccessRate` was reported ~62% vs the corrected ~85%. Fixed here; prior
harness numbers under-reported dispatch resolution.
