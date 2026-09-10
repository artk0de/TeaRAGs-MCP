# Python Frontier E4.1 — Dispatch Fan-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the 441 residual rows that have no receiver type at all, by
giving Python the dispatch components Ruby has had since `wbj3`. Two families
carry the mass: `untypedNameReceiver` (423 rows after the flask correction in
decision 1, 378 of them polar) and `unionBranchReceiver` (18, all polar).
`protocolReceiver` measured 0 and is dropped from this plan. The measured prize
is bigger than "a fan": **265 of those rows narrow to exactly ONE candidate, and
264 of the 265 are the oracle's own target** — a confidence-1 edge each, in the
1:1 columns, at a 0.4 % error rate. The genuine fan is the smaller half — 62
rows at a Python cap of 4, 61 of which contain the right answer.

**Architecture:** Three moves, in this order. (1) The narrowing CASCADE — which
narrowers, in which order — relocates out of `RubyDynamicDispatchResolver` into
`kernel/dispatch-cascade.ts` as `buildDispatchCascade(opts)`; the narrowers
themselves already live in the kernel and do not move, and Ruby keeps its duck
vocabulary and literal-receiver map as injected data behind a thin adapter. (2)
The Python walker starts filling the two SIGNATURE channels that already exist
in the neutral contract and are Ruby-only today — `ChunkExtraction.arity` /
`.kwargs` on the def side, `CallRef.argCount` / `.kwargKeys` / `.hasKwargSplat`
on the call side — which is what makes `ArityNarrower` and `KwargNarrower` do
anything at all for Python. (3) `PythonCallResolver.resolveDispatch` stops being
`this.cone.resolveDispatch` and becomes
`resolveDispatchViaComponents([union, cone, dynamic], …)`, where `dynamic` fans
a bare untyped name over the in-project classes declaring the member and `union`
fans a union-annotated receiver over its arms. Both new components stand down
whenever the exact chain would answer — enforced by PROBING the chain inside the
component, which is how Ruby does it and the only predicate that survives
Python's terminal DROP guards.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses. No new dependency, no schema migration: `cg_symbols` already carries
`arity_json` / `kwargs_json` / `visibility` / `accepts_block`
(`src/core/adapters/duckdb/cg-symbols-row.ts:75`), and
`CodegraphSymbolsProvider#buildSymbolDefs`
(`src/core/domains/trajectory/codegraph/symbols/provider.ts:750`) already
threads all four onto `SymbolDefinition`. Python has simply never written them.

**Spec:** `docs/superpowers/specs/2026-09-10-python-frontier-e4-design.md` —
"E4.1 — dispatch fan-out" (the two moves and what is NOT re-decided), "E4.0 B —
fan scoring" (the columns this increment is measured in, and why fan and 1:1 are
never summed), D3 / D4 (separate bars; `ambiguous` counts as a recall miss), D8
(the family table that puts E4.1 first), D9 (the chain-wrong population E4.0.5
owns — this plan must not absorb it), and "Interaction with 4vg1i / 8qyax"
(`ambiguousFanout` per kind is the live column this increment moves;
`callsUnnarrowedTemplate` must stay 0 for every Python bucket). Predecessors
whose plan format this one reuses:
`docs/superpowers/plans/2026-09-10-python-e4-0-measurement.md` (E4.0) and
`docs/superpowers/plans/2026-09-10-python-django-managers.md` (E3). Relocation
protocol:
`docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md`
→ "Relocation protocol (one bead per seam)".

---

## Decision record

### 1 — The attribution, measured (2026-09-10, dumps under `~/.claude/jobs/dffe3647/tmp/e4-attr/`)

Every `untypedNameReceiver` and `unionBranchReceiver` row from E4.0.4's five
`--oracle merged` dumps was re-classified with the same
`scripts/lib/py-residual-families.ts`, then sub-bucketed by WHY the receiver
name carries no binding fact, and joined against a scan of every in-project
class declaring the called member.

**A correction to D8 first.** flask's `untypedNameReceiver` count is **13, not
22**. The E4.0.4 report run could not read flask's sources — its residual rows
live in `examples/…` and `docs/…` as well as `src/…`, and a `--corpus-root` that
does not join with those relPaths turns every tier-2 read into a miss (flask's
published binding-line miss rate is 68.8 %, against 8–13 % on the corpora whose
reads worked). With the sources readable, 8 of those rows are
`moduleAliasMember` (E4.6a) and 1 is `pytestFixture`. Every other corpus
reproduces D8 exactly: ugnest 4, httpx 5, netbox 23, polar 378, union 18,
protocol 0. **E4.1's target mass is 441 rows, not 450.**

| sub-bucket (why the name is unbound) | ugnest | flask  | httpx | netbox | polar   | total   |
| ------------------------------------ | ------ | ------ | ----- | ------ | ------- | ------- |
| `callResultInProject`                | 2      | 2      | 0     | 7      | 287     | 298     |
| `paramAnnotated`                     | 0      | 2      | 0     | 0      | 30      | 32      |
| `loopTarget`                         | 0      | 2      | 5     | 5      | 17      | 29      |
| `assignedAlias`                      | 0      | 4      | 0     | 0      | 19      | 23      |
| `callResultExternal`                 | 0      | 3      | 0     | 1      | 7       | 11      |
| `tupleUnpack`                        | 0      | 0      | 0     | 0      | 8       | 8       |
| `comprehension`                      | 0      | 0      | 0     | 1      | 5       | 6       |
| `paramUnannotated`                   | 0      | 0      | 0     | 4      | 0       | 4       |
| `walrus`                             | 0      | 0      | 0     | 4      | 0       | 4       |
| `assignedOther`                      | 0      | 0      | 0     | 0      | 4       | 4       |
| `noBindingFound`                     | 2      | 0      | 0     | 1      | 0       | 3       |
| `withOrExcept`                       | 0      | 0      | 0     | 0      | 1       | 1       |
| **total**                            | **4**  | **13** | **5** | **23** | **378** | **423** |

`paramUnannotated` splits netbox 1 first-positional-of-a-module-function, 1
later-positional-of-a-method, 2 later-positional-of-a-module-function;
`paramAnnotated` (a parameter the annotation facet declined — `Any`, a bare
`Optional`, a container) splits polar 4 first-of-method / 26 later-of-method,
flask 1 / 1. `callResultInProject` — a local assigned from an in-project call
the walker could not type — is **70 % of the whole family** and is the shape
E4.6b's call-result fold also aims at; it is answered here without waiting for
that fold, because the fan does not need to know the return TYPE, only the
member. **`owners(member)` — the candidate set the `dynamic` component would
build.** Counted as "in-project classes declaring a `def member`", the same set
`lookupByShortName(member)` returns once the language filter and the
instance-member filter are applied. A `@staticmethod` / `@classmethod` counts as
an owner in this scan and would not in the component, so every fan number below
is an UPPER bound.

| corpus | n   | p50 | p95 | max | share =1 | share ≤4 | share >16 | oracle target ∈ owners | oracle target is a module fn |
| ------ | --- | --- | --- | --- | -------- | -------- | --------- | ---------------------- | ---------------------------- |
| ugnest | 4   | 10  | 45  | 69  | 0 %      | 0 %      | 50 %      | 2 (50.0 %)             | 2                            |
| flask  | 13  | 1   | 4   | 11  | 69.2 %   | 92.3 %   | 0 %       | 13 (100 %)             | 0                            |
| httpx  | 5   | 11  | 11  | 11  | 0 %      | 40 %     | 0 %       | 5 (100 %)              | 0                            |
| netbox | 23  | 3   | 57  | 57  | 34.8 %   | 60.9 %   | 34.8 %    | 21 (91.3 %)            | 1                            |
| polar  | 378 | 1   | 20  | 109 | 61.9 %   | 75.4 %   | 9.3 %     | 376 (99.5 %)           | 2                            |

**recall@fan BEFORE any narrowing is 417/423 = 0.986.** The six rows whose
target is not in the candidate set at all are: ugnest `join` ×2 (a `str.join`
the oracle pins to a project helper), netbox `resolve_serializer` and `values`,
polar `compute_from_period` and `get_cumulative` — three of the six are
module-level functions rather than methods, which an instance-member fan cannot
reach by construction.

**What the kernel signature narrowing buys, measured.** Applying an arity +
kwarg model equivalent to `ArityNarrower` / `KwargNarrower` to the same 423
rows:

|                             | before narrowing | after         |
| --------------------------- | ---------------- | ------------- |
| candidates, mean            | 7.08             | 5.30          |
| candidates, p95             | 22               | 20            |
| rows narrowing to exactly 1 | 251              | **265** (+14) |
| rows over the cap 16        | 73               | **36** (−37)  |

Half of the over-cap population is narrowed back under the cap, and 14 rows
become exact answers. That is the whole measured case for Task E4.1.2 — without
the signature channels, `resolveNarrowedFanout` runs two no-op narrowers.

**The outcome split, and the cap sweep** (pooled, after narrowing, `single` =
one survivor = confidence-1 edge, `fan` = 2…cap, `ambiguous` = over cap):

| cap | single | single WRONG | fan | fan contains target | fan p50 | fan p95 | ambiguous | ambiguous that had a target | rows answered | share of 423 |
| --- | ------ | ------------ | --- | ------------------- | ------- | ------- | --------- | --------------------------- | ------------- | ------------ |
| 4   | 265    | 1            | 62  | 61                  | 2       | 4       | 96        | 92                          | 326           | 0.771        |
| 6   | 265    | 1            | 74  | 73                  | 2       | 6       | 84        | 80                          | 338           | 0.799        |
| 8   | 265    | 1            | 78  | 77                  | 2       | 6       | 80        | 76                          | 342           | 0.809        |
| 16  | 265    | 1            | 122 | 118                 | 4       | 11      | 36        | 35                          | 383           | 0.905        |

Per corpus at cap 4: polar 248 single / 51 fan / 79 ambiguous, netbox 8 single
(1 wrong) / 6 fan / 9 ambiguous, flask 9 single / 3 fan / 1 ambiguous, httpx 0 /
2 / 3, ugnest 0 / 0 / 4.

**`unionBranchReceiver`, all 18 rows** (all polar, all a union-ANNOTATED
receiver — 14 of the 18 are parameters annotated `A | B`, e.g.
`price: ProductPriceSeatUnit | ProductPriceUnit`; the rest are dotted receivers
whose tail field is union-annotated): owners p50 1, p95 3, max 9. After
narrowing: **12 single (12/12 correct), 6 fan (6/6 contain the target, p95 3), 0
ambiguous.** recall@fan 1.000, precisionProxy 0.79.

### 2 — Go / no-go, against the thresholds the orchestrator set

The bar: a component ships only if its rows reach **recall@fan ≥ 0.85 at p95 fan
≤ 4 after narrowing**; otherwise the number is recorded and the component stops.

- **`union` — GO, unconditionally.** recall@fan 1.000 at p95 3, and two thirds
  of its rows are not fans at all but single exact answers. 18 rows is small; it
  ships because it is cheap (the arms are already in the `TypeRef` algebra) and
  because it removes a wrong-arm hazard the walker change in Task E4.1.4 would
  otherwise introduce.
- **`dynamic` — GO at a Python fan cap of 4, not at the corpus-adaptive 16.** At
  cap 16 the fan half reads recall 118/122 = 0.967 but **p95 11**, which fails
  the stated bar; at cap 4 it reads 61/62 = 0.984 at p95 4, which meets it. The
  cap is therefore a per-language policy value — `PY_DISPATCH_FAN_MAX = 4`,
  floor-min'd against `dispatchFanoutPolicyFor(ctx.symbolTable).cap` so the
  corpus-adaptive cap can only ever LOWER it — with
  `CODEGRAPH_PY_DISPATCH_FAN_MAX` as the re-measure knob. The cost is booked
  openly: 96 rows become `ambiguous` and 92 of them had a target, which is D4's
  "an over-cap decision that discarded the right answer is a cost of the cap".
- **The `single` half is not a fan and is not gated by the fan bar.** 265 rows
  narrow to one candidate; those are confidence-1 edges landing in the 1:1
  columns under the ≤ 2 % fabricated+wrongFile bar, and they are the increment's
  actual recall win: **polar +248, netbox +8 (1 wrong), flask +9**, ~+2.0 pp on
  polar's 1:1 recall by the oracle's own denominators. The stop rule for the
  executor is stated on that half too: if the measured A/B shows more than **3**
  new `wrongFile` / fabricated rows across the five corpora from `single`
  outcomes, the `single` terminal is demoted to a fan edge (confidence
  `discount / 1`) and the number is recorded rather than argued away.
- **`protocolReceiver` — DROPPED.** Measured 0 rows on all five corpora, with
  and without tests walked. No component, no gate, no mention beyond this line.

### 3 — Ordering: how a new component lives under a runner that dispatches FIRST

`CallEdgeResolutionRunner` calls `resolver.resolveDispatch(call, ctx)` BEFORE
`resolver.resolve(call, ctx)`, a non-empty fan REPLACES the chain's answer, and
an `ambiguous` verdict returns with NO edges and NO chain fallback
(`resolution-runner.ts:549–583`). Nothing about that changes here — it is Ruby's
path too, and changing it would move Ruby.

**The component itself declines every site the chain would answer**, which is
option (a) of the three the spec floats, and it is chosen because it is the only
one that already has a production precedent: Ruby's
`RubyDynamicDispatchResolver` opens with `rubyDynamicFanoutSuppressed`, whose
second gate (`exactPassAnswersReceiver`) literally calls the pass helpers and
returns `true` on a non-null target. Python cannot use Ruby's cheaper trick of
probing two named passes: its chain answers a bare untyped name from three
different passes (`namingConvention`, `importedName`, `globalShortName`) and its
terminal guards DROP rather than continue, so the only honest predicate for
"would the chain answer this" is the chain's own outcome. So:

- `PythonChainAnswerProbe` wraps the composed chain and memoises ONE result per
  `CallRef` identity (with the `CallContext` identity checked, so a re-walk of
  the same extraction under a different context cannot read a stale answer).
  `PythonCallResolver.resolve` goes through the same probe, so the runner's
  `resolveDispatch` → `resolve` pair costs one chain run per site, not two.
- Component order is `[union, cone, dynamic]`, matching the spec and Ruby's
  reason: a union receiver NAMES its types, CHA only knows descendants. `table`
  has no Python analogue (no `call.dispatch` is ever set by the Python walker)
  and is not added.
- The cone keeps its exact behaviour and its position ahead of the chain. It is
  wrapped — not modified — by a thin `PythonConeDispatchResolver` that declines
  a receiver whose in-force local binding carries a `union` `typeRef`, so the
  union arms cannot be read as their first arm by the CHA path (see decision 5).

The gate that proves the ordering held is E4.0.3's own column:
`exactReplacedByFan` and `exactReplacedByAmbiguous` must both stay **0** on all
five corpora. A non-zero there means a component fired on a site the chain
owned.

### 4 — Precision: three populations, three bars, none of them merged

- **`single` outcomes** are confidence-1 edges. They are governed by the
  standing 1:1 bar — fabricated + `wrongFile` ≤ 2 % of edges, ugnest phantom 0,
  at most +0.5 pp per increment — and by the ≤ 3-row stop rule in decision 2.
  Measured exposure: 1 wrong row in 265.
- **Fan edges** carry `discount / m`, stay navigation-hidden through the
  existing `isNavigationVisibleEdge` confidence floor (nothing is added for
  that; the confidence they carry is already below it), and are scored ONLY by
  E4.0.3's fan columns: `recallAtFan`, `fanSizeP50/P95`, `precisionProxy`,
  `fanPhantom`. `fanPhantom` must stay ≤ 5 % of fan rows per corpus.
- **`ambiguous`** emits nothing, and is reported: `ambiguousShare` offline, and
  `CodegraphResolveKindRow.ambiguousFanout` per receiverKind live. Python reads
  0 in that column today; after this increment it will not, and that divergence
  is the increment landing, not a defect. `callsUnnarrowedTemplate` must still
  read 0 in every Python bucket — the registries it reads are Ruby-only and the
  4vg1i gate restricts it to `constant` receivers.

Gross `lost` stays **0** per corpus, measured row-level, not netted.

### 5 — The union walker fact, and the wrong-arm hazard it creates

Python's annotation facet drops a union outright:
`python-annotation-type-source.ts:71` skips any parameter whose ref has no
single nominal arm, and `pushAssignmentFact` returns early on the same test. So
`LocalBinding.typeRef` never carries a Python union today, even though the
channel exists for exactly this (`codegraph-local-binding.ts:36–43`, "union …
ride the EXISTING localBindings channel"), the store already knows how to fill
it (`type-fact-store.ts` `firstMemberName`), and Ruby already uses it.

Task E4.1.4 lifts that gate — and lifting it is dangerous, because
`LocalBinding.type` is a required STRING and every Python string reader would
then see the FIRST ARM as if it were the receiver's type. A union param that is
`match` today via `importedName` could become a `wrongFile` on arm 1 tomorrow.
That is exactly D9's `chainWrong` shape, and this plan must not manufacture more
of it. So the fact ships together with three declines, all Python-side, none of
them touching the kernel or Ruby:

1. `PythonLocalBindingSymbolResolutionStrategy` CONTINUEs when the in-force
   binding's `typeRef.form === "union"` — the union receiver is the dispatch
   component's, not the chain's.
2. `pythonSingleHopType` (in `python-receiver-type-ports.ts`) answers
   `undefined` for the same binding, which is the read-side statement of the
   rule its own comment already makes on the write side.
3. `PythonConeDispatchResolver` declines it, per decision 3.

The A/B for that task therefore checks one thing above all others: **rows that
were `match` before are still `match`**, per corpus, gross.

### 6 — No new channel for signatures; the neutral one has been there all along

The orchestrator's Task 1b asked for a `defSignatures` channel behind a
`signatureOf` / `callShape` port. It is not needed and would be a second way to
say the same thing. `ChunkExtraction` already declares `arity` / `paramNames` /
`visibility` / `kwargs` / `acceptsBlock` (`codegraph-extraction.ts:468–495`),
`CallRef` already declares `argCount` / `kwargKeys` / `hasKwargSplat` /
`passesBlock` (`codegraph-extraction.ts:568–577`), `buildSymbolDefs` threads all
of them, and `cg_symbols` persists them. Every one is documented "populated by
the Ruby walker" — the port is real, it simply has one implementor. Task E4.1.2
adds the second. The kernel narrowers keep taking `CallRef` + `SymbolDefinition`
and gain no new parameter, so the relocation in Task E4.1.1 stays a composition
move.

Python fills `arity` and `kwargs` (and `hasKwargSplat` on the call side). It
does NOT fill `visibility`, `acceptsBlock` or `paramNames`: Python has no
visibility keyword the walker can read (`_name` is a convention, and treating it
as `private` would drop legitimate candidates), no block argument, and
`paramNames` exists for Ruby's argument-position → parameter-name join, which
nothing in this plan uses. `VisibilityNarrower` and `BlockNarrower` are no-ops
on absent evidence by construction, so Python takes the same cascade Ruby does
and simply gets two fewer working filters.

### 7 — What is deliberately NOT a lever here

`ctx.instantiatedTypes` — the RTA prune that could cut the fan further
(`cone-dispatch.ts:78`) — is populated by the Ruby walker only
(`ruby/walker/type-channels.ts:51`). Adding a Python instantiation set is a
walker epic of its own with its own measurement, and the cap sweep above shows
the fan is already inside the bar at cap 4 without it. Recorded, not scheduled.

---

## Global Constraints

- **Ruby is byte-identical.** The only Ruby files this plan may touch are
  `ruby/resolver/strategies/ruby-dynamic-dispatch.ts` (loses its inline narrower
  array, gains a `buildDispatchCascade(...)` call) and, if the barrel requires
  it, `ruby/resolver/strategies/index.ts`. The two risk files
  (`ruby/resolver/type-propagation.ts`,
  `ruby/walker/type-sources/ast-inference.ts`) and `ruby-resolver.ts` /
  `ruby-dynamic-fanout-gates.ts` are NOT touched. No incidental improvement
  rides along.
- **Existing tests are moved, never rewritten**
  (`.claude/rules/resolver-architecture.md` §4). A pin that now has a better
  answer is edited only with a bead comment naming the row and the corpus.
- **E4.0.5 is running in parallel on `python-global-short-name.ts`,
  `python-imported-name.ts` and `strategies/shared.ts`.** This plan does not
  edit those three files. It CONSUMES the same-language candidate guard E4.0.5
  adds to `shared.ts`: read its exported name in Step 0 of Task E4.1.3 and use
  it. Do not add a second language filter. If Step 0 finds the guard absent —
  E4.0.5 not yet merged — the task stops and reports, rather than inventing one.
- **The harnesses need no change.** Both `py-codegraph-jedi-oracle.ts` and
  `codegraph-chain-tally.ts` build the production resolver and already call
  `resolveDispatch` per site (E4.0.3); new components flow into the fan columns
  for free. A task that finds itself editing `scripts/` for measurement has
  found a harness bug and reports it.
- **Flag names.** Dispatch is ON by default in both harnesses; the pre-E4.0.3
  columns are `--no-dispatch`. The oracle takes `--oracle jedi|lsp|merged`, and
  every number in this plan's gates is `--oracle merged --workers 8`.
- **Perf.** chain-tally wall ≤ +25 %, peak RSS ≤ +20 %, measured interleaved
  B/A/A/B with the min of each side, on netbox AND polar. No per-call filesystem
  probes — membership questions go to `hasFile` / `hasFilesUnder`.
- **Determinism.** jedi's answer wobbles by up to 2 rows per run on netbox and 1
  on polar (E4.0.3's control). A diff at or under that on the ORACLE columns,
  with every chain column byte-identical, is the instrument; anything larger is
  the change.
- **Capability sync.** Tasks E4.1.2, E4.1.3 and E4.1.4 each change what Python
  PRODUCES for an already-indexed project, so each bumps `versions.walker` in
  `src/core/domains/language/python/capability.ts` by one — READ THE CURRENT
  VALUE FIRST, E4.0.5 is bumping it 4 → 5 in parallel — and runs
  `npm run gen:lang-compat`, committing the regenerated artifacts
  (`.claude/rules/language-capability-sync.md`).
- **Commits.** `feat(language): … (w205u)`, `test(language): … (w205u)`,
  `refactor(language): … (w205u)`, `docs(plans): … (w205u)`. Body wrapped at ≤
  100 columns. Trailers
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01FNCoxgrknsrkLSDjn1p5Mm`.
- **Execution.** A fresh Opus executor per task, in its own agent worktree,
  ff-merging `worktree-py-frontier-e4` in Step 0. Tool calls ≤ 8 min; writes ≤
  120 lines per call. TDD: the failing test first, always. Live validation
  (reindex + `prime`) is user-gated and is NOT part of any task's gate. Never
  push.

---

## File Structure

```text
src/core/domains/language/
├── kernel/
│   ├── dispatch-cascade.ts                      NEW  E4.1.1 — buildDispatchCascade(opts)
│   ├── dispatch-narrowing.ts                    MOD  E4.1.1 — resolveNarrowedFanout gains
│   │                                                 an optional { cap, edgeKind } bag
│   └── fanout-policy.ts                         —    unchanged
├── ruby/resolver/strategies/
│   └── ruby-dynamic-dispatch.ts                 MOD  E4.1.1 — inline array → cascade call
├── python/
│   ├── capability.ts                            MOD  walker bump ×3, codegraph tech text
│   ├── CLAUDE.md                                MOD  E4.1.5 — dispatch section
│   ├── walker/
│   │   ├── walker.ts                            MOD  E4.1.2 — join signatures onto chunks,
│   │   │                                             call shapes onto CallRefs
│   │   └── passes/
│   │       ├── python-def-signatures.ts         NEW  E4.1.2 — arity/kwargs + call shape
│   │       └── python-annotation-type-source.ts MOD  E4.1.4 — stop dropping union refs
│   └── resolver/
│       ├── python-resolver.ts                   MOD  resolveDispatch → components; probe
│       ├── python-receiver-type-ports.ts        MOD  E4.1.4 — singleHopType declines union
│       ├── strategies/
│       │   ├── python-local-binding.ts          MOD  E4.1.4 — CONTINUE on a union binding
│       │   └── index.ts                         —    unchanged
│       └── dispatch/                            NEW  the component package
│           ├── index.ts                         NEW  barrel
│           ├── python-chain-probe.ts            NEW  E4.1.3 — memoised chain answer
│           ├── python-dispatch-gates.ts         NEW  E4.1.3 — pythonDynamicFanoutSuppressed
│           ├── python-dispatch-policy.ts        NEW  E4.1.3 — PY_DISPATCH_FAN_MAX + env
│           ├── python-dynamic-dispatch.ts       NEW  E4.1.3 — the 423-row component
│           ├── python-cone-dispatch.ts          NEW  E4.1.4 — thin cone adapter
│           └── python-union-dispatch.ts         NEW  E4.1.4 — the 18-row component

tests/core/domains/language/
├── kernel/dispatch-cascade.test.ts              NEW  E4.1.1 — order + opt-in data
├── ruby/resolver/strategies/…                   —    MOVED only if a test moves with code
└── python/
    ├── walker/python-def-signatures.test.ts     NEW  E4.1.2
    └── resolver/dispatch/
        ├── python-dynamic-dispatch.test.ts      NEW  E4.1.3
        ├── python-dispatch-gates.test.ts        NEW  E4.1.3
        └── python-union-dispatch.test.ts        NEW  E4.1.4

docs/superpowers/plans/2026-09-10-python-e4-1-dispatch-fanout.md   THIS FILE (measurement
                                                                   record appended at close)
~/.claude/jobs/<job>/tmp/e4-1/                                     A/B row dumps, not in repo
```

---

## Context the implementer needs

### The pieces that already exist, verbatim

**The terminal** (`kernel/dispatch-narrowing.ts`, end of file). It runs the
cascade, then splits: 0 survivors → empty edges; 1 → one edge at confidence 1.0;
`> cap` → `{ kind: "ambiguous", member, candidateCount }` with no edges; else m
edges at `discount / m`. The cap is
`dispatchFanoutPolicyFor(ctx.symbolTable).cap` =
`max(16, ceil(p99 defs-per-member))`, memoised per symbol-table identity, and it
reads **16 on all five Python corpora** (p99 5–11).

**The composer** (`domains/language/resolver-chain.ts:75`):

```ts
export function resolveDispatchViaComponents(
  components: readonly DispatchResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): DispatchFanoutOutcome {
  for (const component of components) {
    const outcome = component.resolveDispatch(call, ctx);
    if (outcome.kind === "ambiguous" || outcome.edges.length > 0)
      return outcome;
  }
  return { kind: "edges", edges: [] };
}
```

Order IS precedence, `ambiguous` is decisive, and a component that has nothing
to say returns `emptyDispatchFanout()`.

**The component interface** (`contracts/types/language.ts:99`) is one method:
`resolveDispatch: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome`.

**Ruby's dynamic component**
(`ruby/resolver/strategies/ruby-dynamic-dispatch.ts`) is the shape to copy: a
private `narrowers` array, a suppression gate, a short-name lookup filtered to
the language's own files, then the terminal:

```ts
const candidates = ctx.symbolTable
  .lookupByShortName(call.member)
  .filter((def) => isRubyPath(def.relPath));
if (candidates.length === 0) return emptyDispatchFanout();
const discount =
  this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, discount);
```

**The Python chain** (`python-chain-factory.ts`) is
`[super, selfField, selfMember, localBinding, chainType, namingConvention, importedName, globalShortName]`,
composed in ONE place that both harnesses call. `PythonCallResolver` holds it,
plus one `PythonImportFileMapper` and one `PythonAncestorLinearizerCache` whose
memos are keyed by symbol-table identity — a new collaborator that needs either
takes the resolver's instance, never a fresh one.

**The runner's dispatch path** (`resolution-runner.ts:549–583`):
`resolveDispatch` first; `ambiguous` → push to `ambiguousFanouts`, return
`"ambiguous"`, no chain; non-empty edges → push each with its `edgeKind` +
`confidence`, return; only then `resolver.resolve`. Nothing in this plan edits
that file.

### The walker seam Task E4.1.2 lands on

`buildPythonExtraction` (`python/walker/walker.ts:124`) maps `input.chunks` —
each `{ symbolId, startLine, endLine, scope }` — to `ChunkExtraction`, and calls
come from `collectPythonCalls(root)` (line 985), which pushes
`{ callText, receiver, member, startLine }` and nothing else. There is no AST
node on the chunk, so the def signature has to be collected in its own pass
keyed by the def's start line and joined by `c.startLine`, the same way
`callResultBindings` is collected once per file and sliced per chunk.
`walkPythonScopes` (`walker/passes/python-annotation-type-source.ts`) already
yields every `def` site with its line, name and class chain — reuse it rather
than writing a third tree walk.

### The union facts Task E4.1.4 lands on

`pythonTypeRefFromNode` already builds `{ form: "union", members }` for `A | B`
and `Optional[T]` (`walker/passes/python-type-annotation.ts`, via
`typeRefUnionOf`). Two call sites then throw it away:
`extractPythonAnnotationFacts`'s parameter loop (line 71,
`pythonNominalReceiverName(ref) === undefined` → `continue`) and
`pushAssignmentFact` (same test → `return`). `TypeFactStore` already handles
what comes through: `refToName` answers `undefined` for a union, and
`firstMemberName` supplies the string `LocalBinding.type` requires while
`typeRef` carries the arms.

### The gate commands, exactly

```bash
# Row-level A/B, five corpora (B = worktree HEAD before the task, A = after).
for c in ugnest flask httpx netbox polar; do
  npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus $c --oracle merged --workers 8 \
    --json ~/.claude/jobs/<job>/tmp/e4-1/<side>-$c.json > ~/.claude/jobs/<job>/tmp/e4-1/<side>-$c.txt
done

# Identity control for a task that must not move the 1:1 columns at all.
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus flask --oracle merged --no-dispatch …

# Chain tally, drift + dispatchDrift must read 0, five corpora.
npx tsx scripts/codegraph-chain-tally.ts --corpus <c> --lang python

# Ruby relocation gate (Task E4.1.1 only).
npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts
npx tsx scripts/spikes/ruby-resolver-parity.ts --corpus mastodon
npx tsx scripts/spikes/ruby-walker-composition-parity.ts --corpus mastodon
npx tsx scripts/codegraph-chain-tally.ts --corpus mastodon --lang ruby   # and taxdome
```

The oracle's summary line already prints `coneMax`, `dispatchDrift`,
`fanoutPolicy` and the fan columns; `dispatchDrift > 0` voids the fan numbers of
that run and is a hard stop, not a note.

### Reading the A/B like the previous increments did

Compare per corpus, gross, not netted: rows that were `match` and are no longer
(`lost`, must be 0), rows that became `match` (`gained`), `wrongFile` +
fabricated delta (the precision bar), `exactReplacedByFan` /
`exactReplacedByAmbiguous` (must be 0), and the fan block — `single`, `fan`,
`ambiguous`, `recallAtFan`, `fanSizeP50/P95`, `fanPhantom`, `ambiguousShare`.
E4.0.3's record is the baseline: today all five corpora read 16 `single`, 14
`fan`, 0 `ambiguous` — every one of them from the cone.

---

## Task E4.1.1 — Relocate the narrowing CASCADE into the kernel (`w205u`)

**Goal.** The narrowers are already neutral and already in the kernel; their
COMPOSITION is not. Move the composition to `kernel/dispatch-cascade.ts`, give
the terminal the two optional knobs Python needs, and leave Ruby byte-identical.

**Files.** NEW `src/core/domains/language/kernel/dispatch-cascade.ts`; MOD
`src/core/domains/language/kernel/dispatch-narrowing.ts`; MOD
`src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.ts`;
NEW `tests/core/domains/language/kernel/dispatch-cascade.test.ts`.

**Interfaces.**

```ts
export interface DispatchCascadeOptions {
  /** Members that are never short-name resolvable in this language. */
  readonly duckVocabulary?: ReadonlySet<string>;
  /** Literal receiver text → its core type name, or null. */
  readonly classifyLiteralReceiver?: (receiver: string | null) => string | null;
}
export function buildDispatchCascade(
  opts?: DispatchCascadeOptions,
): DispatchCandidateNarrower[];

export interface NarrowedFanoutOptions {
  /** Cap override; the EFFECTIVE cap is min(this, policy cap). */
  readonly cap?: number;
  /** Edge kind for the emitted edges. Default `"dynamic"`. */
  readonly edgeKind?: DispatchEdge["edgeKind"];
}
```

### Steps — E4.1.1

- [ ] **Step 0.** In a fresh agent worktree, `git fetch` and ff-merge
      `worktree-py-frontier-e4`. Confirm `git log -1` matches the plan's base.
      Run `npx vitest run tests/core/domains/language/kernel` once — green
      before you start, or stop and report.
- [ ] **Step 1 (RED).** Write
      `tests/core/domains/language/kernel/dispatch-cascade.test.ts` pinning the
      ORDER, because the order is the behaviour: - `buildDispatchCascade()` → 4
      narrowers,
      `[ArityNarrower, KwargNarrower,       VisibilityNarrower, BlockNarrower]`
      (assert with `instanceof`). -
      `buildDispatchCascade({ duckVocabulary: new Set(["each"]) })` → 5, duck
      FIRST. -
      `buildDispatchCascade({ duckVocabulary, classifyLiteralReceiver })` → 6,
      `[Duck, Literal, Arity, Kwarg, Visibility, Block]` — Ruby's exact order. -
      A cascade built with a duck vocabulary empties the candidate set for a
      member in it (behavioural, not just shape). Run it; it fails on the
      missing module.
- [ ] **Step 2 (GREEN).** Create `kernel/dispatch-cascade.ts`:

```ts
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
  VisibilityNarrower,
  type DispatchCandidateNarrower,
} from "./dispatch-narrowing.js";

/**
 * The untyped-dispatch narrowing CASCADE, in the one order every language runs
 * it (relocated from `RubyDynamicDispatchResolver`'s private array, bd
 * tea-rags-mcp-w205u / E4.1). The narrowers themselves are neutral and stay in
 * `dispatch-narrowing.ts`; what is shared here is the ORDER and the two
 * language-data injections.
 *
 * Language-specific narrowers run FIRST because they can empty the set outright
 * — a duck-vocabulary member has no meaningful in-project target at all, and a
 * literal receiver's type is statically certain — and the signature narrowers,
 * which only ever drop PROVEN-incompatible candidates, run after. A language
 * that supplies neither gets the signature half, which is exactly what Python
 * needs: `VisibilityNarrower` and `BlockNarrower` keep every candidate when the
 * walker records no `visibility` / `acceptsBlock`, so they are inert rather
 * than wrong there.
 */
export interface DispatchCascadeOptions {
  readonly duckVocabulary?: ReadonlySet<string>;
  readonly classifyLiteralReceiver?: (receiver: string | null) => string | null;
}

export function buildDispatchCascade(
  opts: DispatchCascadeOptions = {},
): DispatchCandidateNarrower[] {
  const cascade: DispatchCandidateNarrower[] = [];
  if (opts.duckVocabulary !== undefined)
    cascade.push(new DuckVocabularyNarrower(opts.duckVocabulary));
  if (opts.classifyLiteralReceiver !== undefined) {
    cascade.push(new LiteralReceiverNarrower(opts.classifyLiteralReceiver));
  }
  cascade.push(
    new ArityNarrower(),
    new KwargNarrower(),
    new VisibilityNarrower(),
    new BlockNarrower(),
  );
  return cascade;
}
```

- [ ] **Step 3 (RED).** Extend
      `tests/core/domains/language/kernel/dispatch-narrowing.test.ts` (ADD
      cases, edit nothing existing) for the two new knobs: -
      `resolveNarrowedFanout(call, 6 candidates, ctx, [], 0.4, { cap: 4 })` →
      `{ kind: "ambiguous", candidateCount: 6 }`. - the same call with
      `{ cap: 64 }` and a symbol table whose policy cap is 16 → still
      `ambiguous` (the policy cap is a ceiling; an option may only lower it). -
      `{ edgeKind: "cone" }` → every emitted edge carries `edgeKind: "cone"`. -
      no options → today's behaviour, byte-identical.
- [ ] **Step 4 (GREEN).** In `dispatch-narrowing.ts`, thread the bag. `edgeFor`
      gains a kind parameter; the terminal gains the cap min:

```ts
const edgeFor = (
  c: SymbolDefinition,
  confidence: number,
  edgeKind: DispatchEdge["edgeKind"],
): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath: c.relPath,
  targetSymbolId: c.symbolId,
  edgeKind,
  confidence,
});

export interface NarrowedFanoutOptions {
  readonly cap?: number;
  readonly edgeKind?: DispatchEdge["edgeKind"];
}

export function resolveNarrowedFanout(
  call: CallRef,
  candidates: SymbolDefinition[],
  ctx: CallContext,
  narrowers: DispatchCandidateNarrower[],
  discount: number,
  opts: NarrowedFanoutOptions = {},
): DispatchFanoutOutcome {
  const edgeKind = opts.edgeKind ?? "dynamic";
  let survivors = candidates;
  for (const narrower of narrowers) {
    survivors = narrower.narrow(call, survivors, ctx);
    if (survivors.length === 0) return { kind: "edges", edges: [] };
  }
  if (survivors.length === 1)
    return { kind: "edges", edges: [edgeFor(survivors[0], 1.0, edgeKind)] };
  // The policy cap is the ceiling; a language may only ask for a TIGHTER one.
  const policyCap = dispatchFanoutPolicyFor(ctx.symbolTable).cap;
  const cap =
    opts.cap === undefined ? policyCap : Math.min(opts.cap, policyCap);
  if (survivors.length > cap)
    return {
      kind: "ambiguous",
      member: call.member,
      candidateCount: survivors.length,
    };
  const confidence = discount / survivors.length;
  return {
    kind: "edges",
    edges: survivors.map((c) => edgeFor(c, confidence, edgeKind)),
  };
}
```

- [ ] **Step 5 (RELOCATION).** In `ruby-dynamic-dispatch.ts` replace the private
      array with the cascade call — same order, same data, nothing else touched:

```ts
private readonly narrowers = buildDispatchCascade({
  duckVocabulary: RUBY_DUCK_VOCAB,
  classifyLiteralReceiver: classifyRubyLiteralReceiver,
});
```

      Keep `classifyRubyLiteralReceiver` exported from this file (its tests and
      `ruby-dynamic-fanout-gates.ts` import it). Drop the now-unused narrower
      imports; keep `resolveNarrowedFanout`.

- [ ] **Step 6 (GATE — Ruby parity, all four legs, all automatic).**
      `npx vitest run tests/core/domains/language/ruby tests/scripts/ruby-resolver-parity.test.ts`
      green with ZERO test edits; `scripts/spikes/ruby-resolver-parity.ts` and
      `scripts/spikes/ruby-walker-composition-parity.ts` on mastodon →
      mismatches 0; `codegraph-chain-tally.ts --lang ruby` on mastodon AND
      taxdome → `edges` / `fileOnly` / `unresolved` byte-identical to a pre-edit
      run of the same command. Record the four numbers in the commit body.
- [ ] **Step 7 (GATE — Python is untouched).**
      `codegraph-chain-tally.ts --lang     python` on flask and netbox:
      byte-identical, `dispatchDrift` 0. This task changes no Python behaviour
      and the tally is what proves it.
- [ ] **Step 8.** `npx eslint --max-warnings 0` on the touched files,
      `npm run type-check`, `npx prettier --check` on them. Commit:
      `refactor(language): relocate the dispatch narrowing cascade to the kernel (w205u)`.
      No capability bump — output is byte-identical on every language.

---

## Task E4.1.2 — Python def signatures and call shapes (`w205u`)

**Goal.** Fill the four neutral signature fields Python has never written, so
`ArityNarrower` and `KwargNarrower` stop being no-ops for it. Measured worth:
+14 exact answers and 37 rows pulled back under the cap (decision 1). This task
changes NO resolution behaviour on its own — nothing consumes the fields until
Task E4.1.3 — and the A/B gate is that it changes nothing.

**Files.** NEW
`src/core/domains/language/python/walker/passes/python-def-signatures.ts`; MOD
`src/core/domains/language/python/walker/walker.ts`; MOD
`src/core/domains/language/python/capability.ts`; NEW
`tests/core/domains/language/python/walker/python-def-signatures.test.ts`.

**Interfaces.**

```ts
export interface PythonDefSignature {
  readonly arity: AritySignature;
  readonly kwargs?: KwargSignature;
}
/** Keyed by the `def` line, which is the chunk's `startLine`. */
export function collectPythonDefSignatures(
  root: AstNode,
): Map<number, PythonDefSignature>;
export function pythonCallShape(callNode: AstNode): {
  argCount?: number;
  kwargKeys?: string[];
  hasKwargSplat?: boolean;
};
```

**The emission rule, and why it is shaped this way.** Python lets a caller pass
a positional-or-keyword parameter BY KEYWORD, which Ruby cannot, so a naive
`minRequired` would drop live candidates through `ArityNarrower`. The rule that
avoids it without touching a kernel narrower:

| field                 | Python meaning                                                                   |
| --------------------- | -------------------------------------------------------------------------------- |
| `arity.minRequired`   | positional(-only and -or-keyword) params with NO default, `self` / `cls` dropped |
| `arity.maxPositional` | all positional params, `self` / `cls` dropped                                    |
| `arity.hasSplat`      | the def has `*args`                                                              |
| `kwargs.required`     | KEYWORD-ONLY params with no default — the only ones a call must name             |
| `kwargs.optional`     | every positional-or-keyword param name ∪ keyword-only names with defaults        |
| `kwargs.hasSplat`     | the def has `**kwargs`                                                           |

`optional` carrying the positional names is what makes `KwargNarrower`'s
extra-unknown rule correct for Python: `f(timeout=3)` against `def f(timeout)`
must KEEP. Measured on the 423 rows: this model and a model that also credits
keyword-fills toward `minRequired` produce the SAME outcome split (265 single /
62 fan / 96 ambiguous at cap 4) and both drop the oracle's target on **0** rows,
across the 101 rows that pass keywords at all.

### Steps — E4.1.2

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4` (it
      now carries E4.1.1). `npx vitest run tests/core/domains/language/python`
      green before starting.
- [ ] **Step 1 (RED).**
      `tests/core/domains/language/python/walker/python-def-signatures.test.ts`,
      parsing real Python through the project's own AST helper (copy the parser
      setup from `tests/core/domains/language/python/walker/`'s existing
      files): - `def f(a, b=1, *args, k, j=2, **kw)` →
      `arity {minRequired:1,       maxPositional:2, hasSplat:true}`,
      `kwargs {required:["k"],       optional:["a","b","j"], hasSplat:true}`. -
      `def m(self, x)` inside a class → `minRequired:1, maxPositional:1` (`self`
      dropped), `kwargs.optional` contains `x` and not `self`. -
      `@classmethod def c(cls, x)` → same, `cls` dropped. - `def g(a, /, b)` →
      `minRequired:2`, `kwargs.optional` = `["b"]` only (a positional-only param
      cannot be named). - `async def h()` →
      `{minRequired:0, maxPositional:0, hasSplat:false}`, `kwargs` absent. - a
      nested `def` inside a `def` gets its OWN entry at its own line. -
      `pythonCallShape` on `f(1, 2, k=3, **rest)` →
      `{argCount:2,       kwargKeys:["k"], hasKwargSplat:true}`; on `f()` →
      `{argCount:0}`; on `f(*xs)` → `{argCount:0, hasKwargSplat:false}` with
      `argCount` ABSENT (a positional splat means the count is unknown — omit
      rather than lie).
- [ ] **Step 2 (GREEN).** Write the pass. Walk `function_definition` nodes, read
      the `parameters` field, and classify each child by node type —
      `identifier` / `typed_parameter` / `default_parameter` /
      `typed_default_parameter` are ordinary params, `list_splat_pattern` is
      `*args` (and starts the keyword-only region), `keyword_separator` is a
      bare `*` (starts it without a splat), `dictionary_splat_pattern` is
      `**kw`, `positional_separator` is `/` (everything before it is
      positional-only). Drop a leading `self` / `cls` when the def's parent
      chain has a `class_definition`. Return `undefined` for `kwargs` when both
      lists are empty and there is no `**`. Reuse `walkPythonScopes` for the def
      sites so this is not a third tree walk.
- [ ] **Step 3 (GREEN).** Join in `walker.ts`. Collect once per file beside
      `callResultBindings`, then in the `input.chunks.map` body:

```ts
const defSignatures = collectPythonDefSignatures(input.tree.rootNode);
// … inside the chunk map, after `calls`:
const signature = defSignatures.get(c.startLine);
if (signature !== undefined) {
  base.arity = signature.arity;
  if (signature.kwargs !== undefined) base.kwargs = signature.kwargs;
}
```

      A chunk whose `startLine` is not a `def` (a class chunk, a module chunk)
      simply gets nothing, which is the same absence Ruby leaves on non-methods.

- [ ] **Step 4 (GREEN).** Call shapes in `collectPythonCalls` (`walker.ts:985`).
      Both push sites gain the spread — and ONLY these two, so a decorator call
      (`collectPythonDecoratorCalls`) keeps its current shape, since a decorator
      application's argument list is not the decorated call's:

```ts
out.push({ callText: node.text, receiver: …, member: …, startLine, ...pythonCallShape(node) });
```

- [ ] **Step 5 (GATE — the fields reach the symbol table).** Add one case to
      `tests/core/domains/language/python/resolver/python-resolver.test.ts`'s
      neighbourhood (a NEW file if that one is about resolution only): build a
      `FileExtraction` through the walker, run it through
      `CodegraphSymbolsProvider#buildSymbolDefs`'s public path or assert on the
      extraction directly, and check a method def carries `arity` / `kwargs`.
- [ ] **Step 6 (GATE — nothing moved).** Row-level A/B on all five corpora,
      `--oracle merged`: every column byte-identical except the documented jedi
      wobble (≤ 2 rows netbox, ≤ 1 polar, oracle-side only). Chain tally ×5:
      drift 0, `dispatchDrift` 0, `edges` / `fileOnly` / `unresolved`
      byte-identical. Ruby untouched — no Ruby run needed, but state that in the
      commit body.
- [ ] **Step 7 (PERF).** netbox + polar chain-tally B/A/A/B, min of each side:
      wall ≤ +25 %, peak RSS ≤ +20 %. This is a per-def AST read on a walk that
      already parses the file; a regression here means the pass is walking the
      tree a second time.
- [ ] **Step 8.** Bump `versions.walker` by 1 in `python/capability.ts` (read
      the current value — E4.0.5 may have moved it), add the one-line comment
      naming the bead as the neighbours do, `npm run gen:lang-compat`, commit
      the regenerated files. `npx eslint --max-warnings 0`,
      `npm run type-check`. Commit:
      `feat(language): emit python def signatures and call shapes (w205u)`.

---

## Task E4.1.3 — `PythonDynamicDispatchResolver`, the 373-row component (`w205u`)

**Goal.** Fan a bare, unbound, untyped name receiver over the in-project classes
declaring the member, narrowed by the kernel cascade and capped at 4. Scope is
the `dynamic` receiverKind — 373 of the family's 423 rows. The other 50
(`localVar` 45, `selfMember` 5) are DECLINED on purpose: a receiver the walker
bound has a chain pass that owns it, and that pass's terminal DROP is the guard
that stopped `serializer.is_valid()` resolving to `ConfirmationCode`
(`python-local-binding.ts`'s header). Re-opening it is a different bead.

**Expected, measured on those 373 rows at cap 4** (upper bound — the owners scan
counts `@staticmethod` / `@classmethod` defs the component's instance-member
filter will not):

| corpus | rows | `single` (confidence-1) | of those WRONG | `fan` | fan contains target | fan p95 | `ambiguous` |
| ------ | ---- | ----------------------- | -------------- | ----- | ------------------- | ------- | ----------- |
| ugnest | 4    | 0                       | 0              | 0     | —                   | —       | 4           |
| flask  | 11   | 9                       | 0              | 2     | 2                   | 2       | 0           |
| httpx  | 5    | 0                       | 0              | 2     | 2                   | 2       | 3           |
| netbox | 23   | 8                       | 1              | 6     | 5                   | 3       | 9           |
| polar  | 330  | 215                     | 0              | 39    | 39                  | 4       | 76          |
| **Σ**  | 373  | **232**                 | **1**          | 49    | 48 (0.980)          | 4       | 92          |

**Files.** NEW
`src/core/domains/language/python/resolver/dispatch/{index,python-chain-probe,python-dispatch-gates,python-dispatch-policy,python-dynamic-dispatch}.ts`;
MOD `python/resolver/python-resolver.ts`; MOD `python/capability.ts`; NEW
`tests/core/domains/language/python/resolver/dispatch/{python-dynamic-dispatch,python-dispatch-gates}.test.ts`.

**Interfaces.**

```ts
export class PythonChainAnswerProbe {
  constructor(chain: readonly SymbolResolutionStrategy[]);
  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null; // memoised per CallRef
  answers(call: CallRef, ctx: CallContext): boolean; // resolve(...) !== null
}
export function pythonDynamicFanoutSuppressed(
  call: CallRef,
  ctx: CallContext,
  probe: PythonChainAnswerProbe,
  coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
): boolean;
export function pythonDispatchFanCap(ctx: CallContext): number;
export class PythonDynamicDispatchResolver implements DispatchResolverComponent {
  constructor(
    cfg: ResolverConfig,
    probe: PythonChainAnswerProbe,
    coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
  );
}
```

### Steps — E4.1.3

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4` (it
      carries E4.1.1 + E4.1.2). Then read
      `src/core/domains/language/python/resolver/strategies/shared.ts` and find
      the same-language candidate guard E4.0.5 added (the helper that keeps a
      short-name candidate only when its `relPath` is a Python file). Record its
      exact exported name — every later step calls it. **If it is not there,
      STOP and report: E4.0.5 has not merged and this task cannot filter
      candidates without duplicating its fix.**
- [ ] **Step 1 (RED — the probe).** `python-dispatch-gates.test.ts`: a probe
      built over a two-strategy stub chain calls `attempt` exactly ONCE for two
      `resolve` calls with the same `CallRef` + `CallContext`, and re-runs when
      the `CallContext` identity changes. Assert with a counting stub.
- [ ] **Step 2 (GREEN).** `dispatch/python-chain-probe.ts`:

```ts
/**
 * The chain's answer for a call, computed at most once per call site.
 *
 * The runner asks `resolveDispatch` BEFORE `resolve` and lets a non-empty
 * fan-out replace the chain's answer (`resolution-runner.ts:557`), so a
 * last-resort component must know whether the chain would have answered. Ruby
 * asks two named passes (`exactPassAnswersReceiver`); Python cannot, because a
 * bare name is answered by `namingConvention`, `importedName` OR
 * `globalShortName` and its terminal guards DROP rather than continue. The
 * honest predicate is the chain's own outcome, so it is computed here and
 * MEMOISED — the resolver's own `resolve` reads the same entry, and the pair
 * costs one chain run per site rather than two.
 *
 * Keyed by `CallRef` IDENTITY with the `CallContext` identity carried beside
 * it: the same `CallRef` object is never re-walked under a different context
 * within a run, and checking it makes a harness that does so correct anyway.
 */
export class PythonChainAnswerProbe {
  private readonly memo = new WeakMap<
    CallRef,
    { ctx: CallContext; target: SymbolResolutionTarget | null }
  >();
  constructor(private readonly chain: readonly SymbolResolutionStrategy[]) {}

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    const hit = this.memo.get(call);
    if (hit !== undefined && hit.ctx === ctx) return hit.target;
    const target = resolveViaChain(this.chain, call, ctx);
    this.memo.set(call, { ctx, target });
    return target;
  }

  answers(call: CallRef, ctx: CallContext): boolean {
    return this.resolve(call, ctx) !== null;
  }
}
```

- [ ] **Step 3 (RED — the gates).** In the same test file, one case per gate,
      each asserting `pythonDynamicFanoutSuppressed` is `true`: bare call
      (`receiver === null`); `self` and `self.repo`; any dotted receiver
      (`mod.thing`, `a.b.c`); a receiver ending in `)` (`build().run`) or `]`
      (`items[0]`); a capitalised receiver (`Repo`, `cls`); a receiver with a
      `localBindings` entry in force at the call line; a member in the Python
      duck vocabulary (`get`, `items`, `keys` — injected as the resolver's own
      `targetsCoreAmbiguousMember`, never a second copy of the vocabulary); a
      call the probe answers. One case asserting `false`: a bare lowercase name
      with no binding, no import, an unanswered chain.
- [ ] **Step 4 (GREEN).** `dispatch/python-dispatch-gates.ts`. The order is the
      behaviour and cheap tests come first — the probe runs last because it is
      the only expensive one:

```ts
const PYTHON_CLASS_HEAD = /^[A-Z]/;

export function pythonDynamicFanoutSuppressed(
  call: CallRef,
  ctx: CallContext,
  probe: PythonChainAnswerProbe,
  coreAmbiguous: (call: CallRef, ctx: CallContext) => boolean,
): boolean {
  const r = call.receiver;
  if (r === null || r === "") return true; // bare call — E4.6b's shape
  if (r === "self" || r === "cls") return true; // selfMember / classObject paths
  if (r.includes(".")) return true; // field hop / module alias — E4.6a, E4.6c
  if (r.endsWith(")") || r.endsWith("]")) return true; // chain head / element hop — E4.6b, E4.5
  if (PYTHON_CLASS_HEAD.test(r)) return true; // a class object, not a value
  if (resolveLocalBinding(ctx.localBindings, r, call.startLine) !== undefined)
    return true;
  if (findPythonImportBinding(ctx.imports, r) !== null) return true; // module alias — E4.6a
  if (coreAmbiguous(call, ctx)) return true; // dict/list/str runtime
  return probe.answers(call, ctx); // the chain owns it
}
```

      Import `resolveLocalBinding` from `contracts/types/codegraph.js` and
      `findPythonImportBinding` from `../strategies/shared.js` (READ-only — the
      file is E4.0.5's).

- [ ] **Step 5 (RED — the cap).** `python-dynamic-dispatch.test.ts`: with a stub
      symbol table whose `shortNameDefCounts` gives a policy cap of 16,
      `pythonDispatchFanCap(ctx)` is 4; with `CODEGRAPH_PY_DISPATCH_FAN_MAX=8`
      it is 8; with a policy cap of 2 (a tiny corpus) it is 2 — the policy cap
      is a ceiling the language may only lower.
- [ ] **Step 6 (GREEN).** `dispatch/python-dispatch-policy.ts`:

```ts
/**
 * Python's dispatch fan cap (bd tea-rags-mcp-w205u, E4.1 decision 2).
 *
 * The corpus-adaptive policy reads 16 on all five measurement corpora (its
 * floor; p99 defs-per-member is 5–11). At 16 the untyped-name fan measures
 * recall 118/122 at p95 ELEVEN, which fails E4.1's p95 ≤ 4 bar; at 4 it
 * measures 61/62 at p95 4 and 96 rows become `ambiguous`. So Python asks for a
 * tighter cap and the corpus-adaptive one stays the ceiling — a corpus whose
 * p99 justified something smaller keeps the smaller number.
 */
export const PY_DISPATCH_FAN_MAX = 4;

export function pythonDispatchFanCap(ctx: CallContext): number {
  const raw = Number(process.env.CODEGRAPH_PY_DISPATCH_FAN_MAX);
  const requested =
    Number.isInteger(raw) && raw > 0 ? raw : PY_DISPATCH_FAN_MAX;
  return Math.min(requested, dispatchFanoutPolicyFor(ctx.symbolTable).cap);
}
```

- [ ] **Step 7 (RED — the component).** In `python-dynamic-dispatch.test.ts`,
      against a small in-memory symbol table: - one owner of the member → ONE
      edge, `confidence === 1`, `edgeKind       "dynamic"`, the owner's
      `symbolId`; - three owners → three edges at `discount / 3`,
      sorted-stable; - three owners of which two take no argument and the call
      passes one → the arity narrower leaves ONE, `confidence === 1` (this is
      the `arity`-channel case Task E4.1.2 exists for; assert it fails without
      `arity` on the defs, i.e. keeps 3); - nine owners →
      `{ kind: "ambiguous", member, candidateCount: 9 }` and NO edges; - a
      candidate in a `.rb` / `.ts` file is never in the set (the E4.0.5 guard —
      the cross-language fabrication D9 found); - a candidate whose `symbolId`
      names a module-level function (no `#`) is not in the set for a value
      receiver; - a suppressed shape → `emptyDispatchFanout()`.
- [ ] **Step 8 (GREEN).** `dispatch/python-dynamic-dispatch.ts`:

```ts
/**
 * Untyped-name short-name fan-out for Python (bd tea-rags-mcp-w205u, E4.1).
 *
 * `service.execute()` where nothing typed `service`: no annotation, no
 * constructor call, no import — 373 of the 423 rows E4.0.4 attributed to
 * `untypedNameReceiver`, 330 of them polar. The exact chain declines them all
 * (its typed passes have nothing to read and `globalShortName` is gated), so
 * they are misses today. This component resolves `member` by short name over
 * the project's own Python classes, narrows the candidates by the kernel
 * cascade, and lets the terminal decide: one survivor is an EDGE at confidence
 * 1, two to `pythonDispatchFanCap` are a discounted fan, more than that is
 * `ambiguous` with nothing emitted.
 *
 * It is the LAST component and it declines every receiver anything else can
 * answer — see `pythonDynamicFanoutSuppressed`, whose final gate runs the chain
 * itself. That ordering is what keeps the runner's dispatch-first path honest:
 * a fan REPLACES a chain answer, so a component that fires where the chain
 * answers would bury an exact edge under N discounted ones.
 */
export class PythonDynamicDispatchResolver implements DispatchResolverComponent {
  private readonly narrowers = buildDispatchCascade();

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly probe: PythonChainAnswerProbe,
    private readonly coreAmbiguous: (
      call: CallRef,
      ctx: CallContext,
    ) => boolean,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (
      pythonDynamicFanoutSuppressed(call, ctx, this.probe, this.coreAmbiguous)
    )
      return emptyDispatchFanout();
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member)
      .filter((def) => isPythonProjectDef(def) && def.symbolId.includes("#"));
    if (candidates.length === 0) return emptyDispatchFanout();
    const discount =
      this.cfg.dynamicReceiverConfidence ?? DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT;
    return resolveNarrowedFanout(
      call,
      candidates,
      ctx,
      this.narrowers,
      discount,
      {
        cap: pythonDispatchFanCap(ctx),
      },
    );
  }
}
```

      `isPythonProjectDef` is E4.0.5's guard from `strategies/shared.ts` under
      whatever name Step 0 recorded — do not re-implement it. The `#` test is
      the instance-member rule: a value receiver dispatches an instance method,
      never a module-level function or a `Cls.static` spelling.
      `DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT` is Ruby's constant in
      `ruby/resolver/strategies/shared.ts`; do NOT import across languages —
      declare Python's own in `python-dispatch-policy.ts` with the same value
      and a comment saying it is deliberately a separate knob.

- [ ] **Step 9 (GREEN — wiring).** In `python-resolver.ts`: build the probe from
      the composed chain, pass it and the classifier's predicate into the
      component, and compose. `resolve` goes through the probe so the chain runs
      once per site:

```ts
this.chain = createPythonSymbolResolutionChain(cfg, this.importFileMapper, this.ancestorLinearizers);
this.probe = new PythonChainAnswerProbe(this.chain);
this.cone = new ConeDispatchResolver(new PythonConeTypeLocator(cfg, this.importFileMapper), cfg.coneMax ?? CONE_MAX_DEFAULT);
this.dynamic = new PythonDynamicDispatchResolver(cfg, this.probe, (call, ctx) =>
  this.external.targetsCoreAmbiguousMember(call, ctx),
);
this.dispatchComponents = [this.cone, this.dynamic];
// …
resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
  return this.probe.resolve(call, ctx);
}
resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
  return resolveDispatchViaComponents(this.dispatchComponents, call, ctx);
}
```

      Update the `resolveDispatch` doc comment: it is no longer "cone only".
      `this.external` must be constructed BEFORE the component that closes over
      it — order the constructor body accordingly.

- [ ] **Step 10 (GATE — unit + harness parity).**
      `npx vitest run tests/core/domains/language/python tests/core/domains/language/kernel`
      green with no existing test rewritten. Then chain tally ×5
      (`--lang python`): `chainDrift` 0 and `dispatchDrift` 0 — the tally
      composes a second dispatch stack from the same pieces, so a non-zero
      `dispatchDrift` means the component reads state the harness cannot
      rebuild.
- [ ] **Step 11 (GATE — the A/B, and the two stop rules).** Row-level A/B ×5,
      `--oracle merged --workers 8`. Report, per corpus: gross `lost` (**must be
      0**), gained, `wrongFile` + fabricated delta, `exactReplacedByFan` and
      `exactReplacedByAmbiguous` (**both must be 0**), and the fan block
      (`single`, `fan`, `ambiguous`, `recallAtFan`, `fanSizeP50/P95`,
      `fanPhantom`, `ambiguousShare`). **Stop rules:** more than 3 new
      `wrongFile` + fabricated rows across the five corpora traceable to
      `single` outcomes → demote the single terminal to a discounted edge and
      record the number; `recallAtFan` < 0.85 or fan p95 > 4 on any corpus with
      ≥ 10 fan rows → do not ship the fan half, record the number, and open a
      bead. Either way the `single` half and the measurement stand.
- [ ] **Step 12 (PERF).** netbox + polar chain-tally `--lang python` B/A/A/B,
      min of each side: wall ≤ +25 %, RSS ≤ +20 %. The probe is the thing to
      watch — if the memo is wrong, the chain runs twice per site and this is
      where it shows.
- [ ] **Step 13.** Bump `versions.walker` (read it first), update the
      `codegraph.tech` sentence to name the dispatch components,
      `npm run     gen:lang-compat`, commit the regenerated artifacts. eslint /
      prettier / type-check clean. Commit:
      `feat(language): fan untyped python name receivers over member owners (w205u)`.

---

## Task E4.1.4 — `PythonUnionDispatchResolver`, and the union fact it needs (`w205u`)

**Goal.** A receiver annotated `A | B` fans over its arms' members. All 18 rows
are polar. **14 of them are the shape this task ships** — a union-annotated
PARAMETER, an undotted name — and they measure **9 `single` (0 wrong), 5 fan
(5/5 contain the target, max fan 3), 0 `ambiguous`**. The other 4 are dotted
receivers whose union sits on a class FIELD (`benefit.type`, `meter.filter`,
`subscription.discount`), and `classFieldTypes` is a bare-string map that
collapses a union on write (`python-annotation-type-source.ts`'s
`pushAssignmentFact` comment). Carrying a `TypeRef` on the field channel is a
separate seam; those 4 rows are recorded here and deferred.

**Files.** MOD `python/walker/passes/python-annotation-type-source.ts`; MOD
`python/resolver/strategies/python-local-binding.ts`; MOD
`python/resolver/python-receiver-type-ports.ts`; NEW
`python/resolver/dispatch/python-union-dispatch.ts`; NEW
`python/resolver/dispatch/python-cone-dispatch.ts`; MOD
`python/resolver/python-resolver.ts`; MOD `python/capability.ts`; NEW
`tests/core/domains/language/python/resolver/dispatch/python-union-dispatch.test.ts`;
MOD the annotation-facet and local-binding test files (ADD cases only).

### Steps — E4.1.4

- [ ] **Step 0.** Fresh agent worktree; ff-merge `worktree-py-frontier-e4`
      (carries E4.1.1–E4.1.3). Green suite before starting.
- [ ] **Step 1 (RED — the walker fact).** In the annotation-facet test file,
      add: `def f(price: SeatPrice | UnitPrice)` produces ONE `param` fact whose
      `type` is a union `TypeRef` with two members; the resulting `LocalBinding`
      carries `typeRef.form === "union"` and a `type` string equal to the FIRST
      arm; `Optional[Foo]` still collapses to `Foo` (the nilable arm is dropped
      by `typeRefReceiverForm` and must NOT become a union); `Any`, a bare
      `Optional`, and a container still produce NOTHING.
- [ ] **Step 2 (GREEN).** In `extractPythonAnnotationFacts`'s parameter loop,
      replace the drop with a union-aware admit:

```ts
const ref = pythonTypeRefFromNode(param.annotation, selfClass);
if (ref === undefined) continue;
// A union with two or more reachable arms is admitted with the ARMS intact:
// `LocalBinding.typeRef` is the channel built for it, the store supplies the
// string `type` from the first arm, and every Python string reader declines a
// union binding (decision 5) so no arm is ever read as THE type.
if (
  pythonNominalReceiverName(ref) === undefined &&
  typeRefNonNilArms(ref).length < 2
)
  continue;
```

      `typeRefNonNilArms` (`kernel/type-ref.ts:84`) is the arm accessor — use it
      rather than testing `form === "union"` directly, so a nilable
      `Foo | None` keeps collapsing to `Foo` through `pythonNominalReceiverName`
      and only a genuinely two-way union is admitted. Apply the
      same edit to `pushAssignmentFact`'s local branch ONLY — its attribute
      branch keeps the collapsed nominal ref, because `classFieldTypes` cannot
      carry arms.

- [ ] **Step 3 (RED — the three declines).** Add cases: `localBinding` CONTINUEs
      (does not DROP, does not resolve) for a receiver whose in-force binding is
      a union; `pythonSingleHopType` answers `undefined` for the same; the cone
      adapter returns `emptyDispatchFanout()` for it.
- [ ] **Step 4 (GREEN).** ONE predicate, three callers. Add to
      `dispatch/python-dispatch-gates.ts` (it is the file both dispatch and the
      chain can import without a cycle — the strategies already import from
      `contracts`, and `dispatch/` imports from `strategies/`, so put the
      predicate where BOTH can reach it: if that creates a cycle, move it to
      `python/resolver/python-union-binding.ts` and import it from all three):

```ts
/** Is the receiver's in-force binding a union of two or more reachable arms?
 *  Such a binding belongs to `PythonUnionDispatchResolver`; every string reader
 *  declines it, because `LocalBinding.type` can only carry the FIRST arm. */
export function unionBindingInForce(
  receiver: string,
  atLine: number,
  ctx: CallContext,
): boolean {
  const binding = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  return (
    binding?.typeRef !== undefined &&
    typeRefNonNilArms(binding.typeRef).length >= 2
  );
}
```

      Then: in `PythonLocalBindingSymbolResolutionStrategy#attempt`, before
      anything else, `return CONTINUE`; in `pythonSingleHopType`,
      `return undefined`; and the new adapter:

```ts
/**
 * The Python CHA cone, plus the one thing the shared engine cannot know: a
 * union receiver belongs to `PythonUnionDispatchResolver`, not to CHA.
 *
 * `ConeDispatchResolver` types its receiver through
 * `resolveLocalBindingType`, which returns the bare `type` STRING — and for a
 * union binding that string is the first arm (the store has nowhere else to put
 * one). Coning on arm 1 would answer `price.get_minimum_seats()` from
 * `SeatPrice`'s subtypes while the annotation says the value may be a
 * `UnitPrice`. The union component runs first and normally answers, so this
 * guard only fires when it found no in-project member — and there the honest
 * answer is nothing, not arm 1.
 */
export class PythonConeDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cone: ConeDispatchResolver) {}
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (
      call.receiver !== null &&
      unionBindingInForce(call.receiver, call.startLine, ctx)
    ) {
      return emptyDispatchFanout();
    }
    return this.cone.resolveDispatch(call, ctx);
  }
}
```

- [ ] **Step 5 (RED — the component).** `python-union-dispatch.test.ts`: a
      receiver bound to `A | B` where both declare the member → 2 edges,
      `edgeKind "cone"`, confidence 0.5 each; where only `A` declares it → ONE
      edge at confidence 1; where neither does → `emptyDispatchFanout()`; where
      the member is inherited by `B` from a base → the MRO answer's OWN spelling
      (`Base#m`), deduped against `A`'s if they are the same symbol; a non-union
      binding → empty; ten arms → `ambiguous`.
- [ ] **Step 6 (GREEN).** `dispatch/python-union-dispatch.ts`. Arms → MRO member
      lookup → back to `SymbolDefinition`s → the same kernel terminal, so the
      cap, the discount and the single-survivor rule are shared with every other
      component rather than re-decided here:

```ts
export class PythonUnionDispatchResolver implements DispatchResolverComponent {
  private readonly narrowers = buildDispatchCascade();
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper,
    private readonly linearizers: PythonAncestorLinearizerCache,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    if (call.receiver === null) return emptyDispatchFanout();
    const binding = resolveLocalBinding(
      ctx.localBindings,
      call.receiver,
      call.startLine,
    );
    const arms =
      binding?.typeRef === undefined ? [] : typeRefNonNilArms(binding.typeRef);
    if (arms.length < 2) return emptyDispatchFanout();
    const seen = new Set<string>();
    const candidates: SymbolDefinition[] = [];
    for (const arm of arms) {
      if (arm.form !== "class" && arm.form !== "instance") continue;
      const target = resolvePythonMemberOnTypeThroughMro(
        arm.name,
        call.member,
        arm.form,
        ctx,
        this.mapper,
        this.linearizers.for(ctx),
        this.cfg.mode,
      ).target;
      if (target?.targetSymbolId == null) continue;
      if (seen.has(target.targetSymbolId)) continue;
      seen.add(target.targetSymbolId);
      const def = ctx.symbolTable
        .lookupByShortName(call.member)
        .find(
          (d) =>
            d.relPath === target.targetRelPath &&
            d.symbolId === target.targetSymbolId,
        );
      if (def !== undefined) candidates.push(def);
    }
    if (candidates.length === 0) return emptyDispatchFanout();
    return resolveNarrowedFanout(call, candidates, ctx, this.narrowers, 1.0, {
      cap: pythonDispatchFanCap(ctx),
      edgeKind: "cone",
    });
  }
}
```

      The discount is `1.0` — a union NAMES its types, so `1/n` is the honest
      confidence and matches `RubyUnionDispatchResolver`. Check
      `resolvePythonMemberOnTypeThroughMro`'s real signature in `shared.ts`
      before writing this (READ-only, E4.0.5 owns the file) and adapt the call;
      do not change the helper.

- [ ] **Step 7 (GREEN — wiring).**
      `this.dispatchComponents = [this.union,     this.cone, this.dynamic]`,
      where `this.cone` is now the `PythonConeDispatchResolver` wrapper. Union
      before cone: the annotation names the exact possible types, CHA only knows
      descendants — the same reason Ruby orders them that way.
- [ ] **Step 8 (GATE — the wrong-arm check, which is this task's real risk).**
      Row-level A/B ×5. Beyond the standing columns, report explicitly: rows
      that were `match` before and are not after, **per corpus, gross, must be
      0**; and the count of rows whose `answeredBy` changed to / from
      `localBinding` or `chainType` (a union binding leaking into the chain
      shows up there first). `exactReplacedByFan` / `…ByAmbiguous` 0.
- [ ] **Step 9 (GATE — the rest).** Unit suites green with no rewrite; chain
      tally ×5 `chainDrift` 0 / `dispatchDrift` 0; perf B/A/A/B on netbox +
      polar within budget.
- [ ] **Step 10.** Bump `versions.walker` (read it first), refresh
      `codegraph.tech`, `npm run gen:lang-compat`, commit regenerated artifacts.
      Commit:
      `feat(language): fan union-annotated python receivers over their arms (w205u)`.

---

## Task E4.1.5 — Cap sweep, closing gates, and the measurement record (`w205u`)

**Goal.** Decide the shipped cap on evidence rather than on this plan's
estimate, close the standing gates, and write down what actually happened.

**Files.** MOD `src/core/domains/language/python/CLAUDE.md`; MOD
`src/core/domains/language/python/capability.ts` (tech text only, no further
bump); MOD this plan (measurement record); no other source file.

### Steps — E4.1.5

- [ ] **Step 1 (the cap sweep, measured not assumed).** Run the oracle on polar
      and netbox with `CODEGRAPH_PY_DISPATCH_FAN_MAX=16`, dump rows, and compute
      the sweep offline from `fanSize` — at cap 16 every over-4 outcome is still
      a FAN with its size recorded, so caps 4 / 6 / 8 / 16 are all derivable
      from that one run, while a run at cap 4 cannot reconstruct the wider ones.
      Report `single` / `fan` / `ambiguous`, `recallAtFan`, `fanSizeP95`,
      `precisionProxy` and `fanPhantom` at each cap. Ship the smallest cap whose
      fan half clears recall ≥ 0.85 at p95 ≤ 4; the plan's estimate is 4. If the
      measured answer differs, change `PY_DISPATCH_FAN_MAX` and say why in the
      record — this is the one number in the increment that is allowed to move
      on evidence.
- [ ] **Step 2 (full A/B, five corpora, the shipped configuration).** One final
      `--oracle merged --workers 8` pass per corpus against the E4.0.4 baseline
      dumps. Table: sites, match, gross lost (0), gained, fabricated, wrongFile,
      1:1 recall by receiverKind, then the fan block. Plus `exactReplacedByFan`
      / `…ByAmbiguous` (0) and `ambiguousShare`.
- [ ] **Step 3 (coverage).** `npm run test:coverage` exit 0. Coverage below
      threshold → delegate to the `coverage-expander` agent
      (`subagent_type: "coverage-expander"`, `run_in_background: true`); never
      lower a threshold, never add an eslint-disable.
- [ ] **Step 4 (navigators).** Add a short **Dispatch** section to
      `python/CLAUDE.md`'s Resolver part: the component order and why
      (`union → cone → dynamic`), the fact that the dynamic component probes the
      chain and what that implies for anyone adding a strategy (a new strategy
      that answers a bare untyped name automatically shrinks the fan, and that
      is the intended coupling), the Python cap and its env knob, and the union
      binding rule ("a union binding is the dispatch component's; every string
      reader declines it"). LINK to `.claude/rules/resolver-architecture.md` §1
      rather than restating it, and state each fact once — the cap lives here,
      not also in the kernel navigator.
- [ ] **Step 5 (capability text).** Final `codegraph.tech` sentence naming the
      three components and the signature channels. `npm run gen:lang-compat`;
      the drift-guard test must be green.
- [ ] **Step 6 (measurement record).** Append
      `## Measurement record — E4.1     (w205u, <date>, HEAD <sha>)` to this
      plan: the cap sweep table, the five-corpus A/B, the per-corpus fan block,
      the Ruby parity numbers from E4.1.1, the perf B/A numbers, and — required
      — every place the measured result differs from decision 1's estimate, with
      the number, not a characterisation of it.
- [ ] **Step 7 (live validation — USER-GATED, not a gate of this plan).** After
      the user asks for it:
      `DEBUG=1 tea-rags index-codebase --project <alias> --wait-enrichments --force-enrichments codegraph --languages python --json`,
      then `DEBUG=1 tea-rags prime <path>` and read `## Codegraph resolve`:
      `ambiguousFanout` per Python receiverKind should be non-zero for the first
      time (compare against the offline `ambiguousShare`; a large divergence
      means the corpus-adaptive cap saw a different p99 on a hydrated symbol
      table than on a freshly built one), and `· N unnarrowed`
      (`callsUnnarrowedTemplate`) must still read **0** in every Python bucket.
      Never chain a reindex off a build; one authorization is one run.

---

## Task order, and what each one unblocks

| #   | task                         | unblocks                                                          | may run in parallel with                                |
| --- | ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | **E4.1.1** kernel cascade    | every component's narrowing                                       | E4.1.2 (disjoint files)                                 |
| 2   | **E4.1.2** signatures        | makes the cascade non-inert for Python; +14 singles, −37 over-cap | E4.1.1                                                  |
| 3   | **E4.1.3** dynamic component | the 373-row family; the `ambiguousFanout` column going live       | — (needs 1 + 2)                                         |
| 4   | **E4.1.4** union component   | 14 rows, and the wrong-arm guard for the walker fact it lands     | — (needs 1; safer after 3, so the A/B has one variable) |
| 5   | **E4.1.5** sweep + close     | the shipped cap, the record                                       | —                                                       |

E4.1.3 and E4.1.4 both edit `python-resolver.ts`'s constructor. Running them in
parallel would put two executors in the same constructor for no gain — 4 is
small and its risk is in the walker, not in the component.

## What this plan does NOT claim

- **It does not fix `chainWrong`.** D9's 63 rows — flask's nine
  `open(path, mode)` → `FlaskClient#open`, polar's cross-language `range(...)` →
  a `.tsx` symbol — are E4.0.5's, and this plan's components never fire where
  the chain answers, so it cannot repair them and must not be credited with them
  either. It does DEPEND on E4.0.5's language guard.
- **It does not touch the 50 non-`dynamic` rows** of `untypedNameReceiver`
  (`localVar` 45, `selfMember` 5). They sit behind chain terminal guards that
  exist for a measured reason.
- **It does not answer the 4 dotted union rows.** They need a class-field
  channel that can carry a `TypeRef`.
- **It does not move `recallLegacy` or any 1:1 number by construction.** The
  `single` outcomes DO move 1:1 recall — that is the point — but every fan and
  every `ambiguous` is scored in its own column group, and the headline recall
  for a corpus stays the confidence-1 one (D3).
- **It does not tune the cone.** `coneMax` (8), the poly-base collapse, and the
  cone's `localBinding` precondition are untouched; the only change to the cone
  path is a wrapper that declines a union receiver.
- **It does not claim the estimates are the results.** Every number in decision
  1 and in the task tables is an offline model over E4.0.4's dumps — an owners
  scan that counts static methods as owners, and an arity model that reproduces
  the kernel's narrowers rather than being them. The A/B is the measurement;
  where it disagrees, it wins and the record says so.
