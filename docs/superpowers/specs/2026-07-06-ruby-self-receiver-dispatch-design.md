# Self-receiver abstract-hook dispatch — design

Date: 2026-07-06 · Epic anchor: cai0 Ruby recall/precision · Beads: (created with plan)

## Summary

Two codegraph Ruby dispatch defects, discovered via live taxdome forensics, are
two branches of **one** gate. Both ship as a single epic increment.

- **DEFECT 1 (precision).** An over-cap dispatch fan-out is recorded as a
  `cg_ambiguous_fanout` aggregate even when the receiver chain is rooted in an
  **external** constant (witness: `Capybara…action…release.perform`,
  candidateCount 217). `get_callers(target, includeAmbiguous:true)` then surfaces
  pure external noise. The receiver is provably external, so no aggregate should
  be recorded.

- **DEFECT 2 (recall).** A call whose receiver is **`self` / `self.new` /
  `self.class.new`** inside a shared base method, where the member is
  **abstract** in the enclosing base (undefined, or a `raise
  NotImplementedError` stub) but **concretely defined by subtypes/includers**, is
  currently lost — dropped, pointed at the abstract stub, or left over-cap
  ambiguous. Witness anchor: the taxdome `KindOfService` service base — a shared
  `#call` template invokes a bare `perform` that ~200+ includer services each
  define; ~3548 `SomeService.call` sites collapse onto one shared template chunk
  with no terminal edge.

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

## Mechanism — self-receiver cone, RTA-pruned

Realize DEFECT 2 by **extending the existing cone-dispatch engine
(`cone-dispatch.ts`, `ConeDispatchResolver` + `ConeTypeLocator`) to implicit-self
/ `self.new` receivers**, rather than building a bespoke interprocedural pass.
Reuse maximally; the substrate already devirtualizes typed receivers and already
prunes cones to live (instantiated) types (RTA, `nearestDefiner`).

- **Bind implicit-self as a typed receiver.** In the walker's local-binding
  layer, a bare call / `self.new` / `self.class.new` inside `B` gets receiver
  type `= B` (the enclosing class/module). This is the single new fact; the rest
  is existing machinery.
- **Cone over B's subtypes overriding `m`.** The cone locator walks
  subtypes/includers of `B` that define `m` (`nearestDefiner` semantics already
  present), **RTA-pruned to instantiated types** — i.e. only concrete `C` with a
  live construction/entry site contribute (this is exactly the user's "рёбра
  только для тех `C`, у которых есть живой сайт", not blind includedBy).
- **Poly-base collapse above `coneMax`.** For large hierarchies (KindOfService's
  ~200), the cone exceeds `coneMax` and collapses to one poly-base edge — the
  honest bounded static representation. The context-sensitive *singular* target
  (`SomeService#perform` for a specific caller) is recovered at QUERY time by
  `trace_path` threading the entry constant, NOT stored per-edge. Small
  hierarchies (huginn-scale, ≤ cap) emit N concrete cone edges.

`self.class.new` / `self.new` returns an instance of the concrete self-type;
feed it to the same cone the same way `constInstanceType` already types
`Const.new`.

## Terminal policy (three structural states)

One engine, terminal action determined by the call's CURRENT graph state — never
by base identity:

- **CREATE** — no edge exists (e.g. Ruby-3.1 shorthand-hash bare self-calls). The
  cone emits fresh edges.
- **REDIRECT** — an edge exists pointing at `B`'s abstract stub. The cone's
  concrete overriders REPLACE the stub edge (the stub is `B`'s own def; the
  overriders are the real targets).
- **COLLAPSE** — the call is over-cap ambiguous. The cone (RTA-pruned /
  poly-base) REPLACES the ambiguous aggregate.

The engine must therefore be permitted to both **emit where no edge exists** and
**override an abstract-stub edge** — a three-state terminal, not three features.

## Representation (E1)

The resolved edge is emitted **at the syntactic call site** — the bare-self /
`self.new` call inside `B`'s shared method — with targets = the concrete
overriders. This is identical to how every other resolver strategy places edges
(edges live at call sites); no new "displaced" edge kind. It preserves the real
trace with the shared template node in the middle
(`SomeService.call → …B#call → …#perform`), matching the observed call structure.
Context-sensitivity is a query concern (`trace_path`), not a storage concern.

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
  ├─ receiver self / self.new (abstract m) → self-receiver cone (RTA)      [DEFECT 2]
  │        terminal: CREATE | REDIRECT | COLLAPSE
  └─ else (in-project name-collision)      → scoped ambiguous aggregate (unchanged)
```

## Scope boundaries

- IN: implicit-self / `self.new` / `self.class.new` receivers on abstract hooks
  (three terminal states); external-receiver aggregate suppression.
- OUT (adjacent follow-up): dynamic `public_send(self.class.<method>)`
  (graphql-ruby) — needs constant-fold `self.class.<m> → :symbol`.
- OUT (already covered): typed-local receivers (cone), literal receivers
  (`exact`), MRO scope-tail, ivar/param receiver-type inference.
- Do NOT touch: the f2jsb reindex/perf work (owned by a parallel session).

## Testing & validation

- Unit (TDD, RED first): predicate detection (each receiver kind × abstract-stub
  vs absent vs concrete-in-B negative); cone-on-self over a synthetic hierarchy
  (≤cap → N concrete edges; >cap → poly-base); three terminal states
  (create/redirect/collapse) as separate cases; external-receiver aggregate
  suppression (DEFECT 1).
- No production code before a failing test. Business-logic tests immutable.
- Live validation (user-gated reindex): measure taxdome codegraph recall
  byReceiverKind before/after via the committed
  `scripts/taxdome-codegraph-recall-forensics.ts` harness (~84s, ollama-free) —
  bareCall miss bucket must drop; no denominator gaming; DEFECT-1 check =
  `get_callers(any #perform, includeAmbiguous:true)` no longer returns the
  Selenium `dnd_helpers.rb` rows.

## Risks

- **Poly-base for big hierarchies** (KindOfService 200) yields a poly-base edge,
  not the singular concrete. Accepted: it is the honest bounded static answer;
  specifics recovered by `trace_path`. If a future increment wants the singular,
  that is context-sensitive cloning — explicitly deferred.
- **RTA liveness cost** on a 3M-LOC index — reuse the existing cone RTA path; do
  not add a second liveness pass.
- **Abstract-stub detection** (clause 3) must be conservative: only
  single-statement `raise NotImplementedError` / empty / bare `super` count as
  abstract, else a real base method is wrongly overridden. Guard with tests.
- Every dispatch file is a single-owner deep-silo (no second reviewer) — lean on
  adversarial self-review + the live harness, not a green unit suite alone.
