# G1 — ActiveRecord association + query-interface return types

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. The single biggest
precision lever in the live taxdome graph.

## Measured evidence

- `firm.owner` + `@firm.owner`: **4 634 dynamic edges (conf 0.04) vs 26 exact**.
- 30 992 edges with conf < 0.05 on 2 373 call sites (avg fan-out 13.1).
- Ambiguous aggregates topped by AR members: `firm` 1 902 sites / 411 k
  candidates (max 240), `user`, `client`, `data`; schema-column `firm_id`
  717 sites / 124 k candidates.
- chain receiverKind: missWithDef 4 953, ambiguous 1 670 — roots are
  `Model.find(...)`-class calls with unknown return type.

Root cause: the receiver's type IS declared — by `belongs_to`/`has_one`/
`has_many` and by the AR query interface — but no fact source feeds those
declarations into type propagation.

## Mechanism — two halves, no new engine

### G1a — association type-source (walker side)

New type-source `walker/type-sources/associations.ts` emitting `RubyTypeFact`s
from the SAME parsed macro invocations `walker/macro-expansion.ts` already
processes for `declares` (zero extra AST walk):

| Macro | Fact |
| --- | --- |
| `belongs_to :owner, class_name: "User"` | `Enclosing#owner → User` (`class_name` wins) |
| `belongs_to :firm` | `Enclosing#firm → Firm` (inflection: camelize) |
| `has_one :profile` | `Enclosing#profile → Profile` |
| `has_many :employees` | `Enclosing#employees → container(Employee)` (singularize + camelize) |
| `scope :active` | `Enclosing.active → container(Enclosing)` (return facet added to the existing declares) |

- Container form reuses the existing `RubyTypeRef` container representation —
  `returnTypeOf` (`resolver/type-propagation.ts`) already unwraps containers
  for multi-hop chains. No propagation change for G1a.
- Grammar stays DATA in `dsl/rails.ts` (per `.claude/rules/ruby-dsl.md`): a new
  declarative facet on association entries naming the type-derivation rule
  (`class_name-or-inflect`, singular vs collection). The INTERPRETER lives in
  the walker type-source. Inflection helper: reuse the existing singularize
  used by `collectionAssoc` (`post_ids` derivation) — single shared helper,
  not a second inflector.
- Store precedence: YARD > associations (annotation beats inflection) —
  extend `DEFAULT_SOURCE_ORDER` in `walker/type-fact-store.ts`.
- **Silence rules (precision gates):** `polymorphic: true` → NO fact;
  `class_name` given as a non-literal expression → NO fact; `through:` →
  fact from the association's own name/class_name only (Rails semantics keep
  the target model correct for `through`).
- `included do` attribution: association macros inside a Concern's
  `included do` block lexically attribute facts to the CONCERN. This is
  correct-by-construction for lookup: `returnTypeOf` falls back to
  `structuredReturnTypes["<ancestor>#<member>"]`
  (`type-propagation.ts:273`) and the includer's ancestors contain the
  concern. Covered by a dedicated test case.

### G1b — AR query-interface vocabulary (resolver side)

The query interface (`find`, `where`, …) is defined by Rails on EVERY model —
emitting per-model facts would bloat the store (72 k symbols × ~20 methods).
Instead: an O(1) fallback rule inside `returnTypeOf`, consulted AFTER declared
facts (declared type beats vocabulary):

```
member ∈ AR_QUERY_VOCABULARY && receiverType is an AR model
  (hierarchy: transitive ancestor ApplicationRecord | ActiveRecord::Base)
  → instance-returning (find, find_by, find_by!, first, last, take, create,
    create!, new, find_or_create_by, find_or_initialize_by) ⇒ receiverType
  → relation-returning (where, order, joins, includes, preload, eager_load,
    merge, distinct, limit, offset, not, or, and, unscoped, all)
    ⇒ container(receiverType)
  → prefix rule: find_by_<attr> / find_by_<attr>! ⇒ receiverType
```

- Vocabulary is DATA in `dsl/rails.ts` (one exported const, categorized
  instance/relation). Interpreter is one hook in
  `resolver/type-propagation.ts` next to the existing container unwrap.
- The is-AR-model check uses the hierarchy view already in `CallContext` —
  no new context field, no contracts change.

### Precision byproduct — schema-column noise dies for free

Once receivers are typed (G1a+G1b), dynamic fan-out no longer fires for them
(it only fans out UNTYPED receivers); a typed-receiver member miss
(`firm.firm_id` — schema column, no in-project def) flows into the existing
external-member suppression instead of a 173-candidate aggregate. The
`firm_id` 124 k-candidate noise needs NO dedicated code.

## Performance

- Zero new passes: facts are emitted in the walker visit that already parses
  macros; store merge is O(facts); G1b is an O(1) map lookup per unresolved
  chain hop.
- Store growth bounded by real association count (taxdome: thousands, not
  72 k × 20).

## Scope boundaries

- OUT: `method_missing` beyond the vocabulary, `constantize` targets, runtime
  `establish_connection`-style dynamic models (the honest ~8 % never-resolvable).
- OUT: polymorphic associations (no static type — silence, never fabricate).
- STI: fact points at the declared class; the existing cone dispatch handles
  descendant fan-out.

## Testing & validation

- TDD RED-first per facet: class_name literal, inflection, has_many container,
  polymorphic silence, through, scope return, included-do attribution
  (ancestor lookup), vocabulary instance/relation/prefix rules, is-AR-model
  gate (a non-model class named `find` must NOT match).
- Harness A/B targets: `firm.owner` 4 634 dynamic → exact; conf < 0.05 edges
  −60–80 %; `firm`/`user`/`client`/`firm_id` aggregates collapse; chain
  missWithDef drops materially. Record numbers here before merge.
