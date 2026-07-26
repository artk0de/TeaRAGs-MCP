# G0 — VTA oracle gate (measurement, not implementation)

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. Prior research rejected
full VTA fixpoint (`2026-07-02-mn00t-ast-inference-expansion-design.md`,
option C) and scoped receiver-type inference intra-chunk
(`2026-06-24-ruby-receiver-type-inference-design.md`). Live numbers agree the
addressable bucket looks small (index receiverKind missWithDef = 581;
`&:sym` never enters `callsAttempted` at all). This design VALIDATES that
verdict with an oracle measurement before any VTA investment.

## What it measures

Extend `scripts/taxdome-codegraph-recall-forensics.ts` with an oracle counter:
for each candidate site, IF the element type were known perfectly, would the
member resolve to an in-project def? Count **sites and edges**, report top
patterns. No resolver change, no reindex — in-process over the same extraction
the harness already builds (~90 s).

### Buckets

| Bucket | Shape | Oracle question |
| --- | --- | --- |
| A | `coll.each { \|x\| x.m }` — block-param calls | `m` defined in-project? |
| B | `coll.map(&:m)` — symbol-to-proc | `m` defined in-project? (currently NOT in callsAttempted — recall invisible today) |
| C | `obj[k].m` — index receiver | live missWithDef = 581 (upper bound already known, recount for consistency) |
| D | Concern-coverage audit (three sub-counts, below) | how many sites do the remaining Concern gaps address? |

Bucket D is NOT VTA — it rides the same harness run because it is the same
kind of question (how many sites does a candidate mechanism address). Full
Concern surface audit (2026-07-10, user question) found the closed vs open map:
`class_methods do` closed by walker reclassification (bead `82o24`,
`walker/name-of.ts`); include/prepend MRO channels closed (`brp1`/`n2kpz`,
`lz8t`); `included do` chunker-transparent. Three gaps remain, each a D
sub-count:

- **D1 — legacy extend:** `def self.included(base); base.extend(ClassMethods);
  end` — class-method entries `Includer.m` where `m` lives in
  `Concern::ClassMethods` and currently does NOT resolve. If fat: shape fact in
  `dsl/activesupport.ts` + walker emits an `extend` inheritance edge from the
  recognized `included` hook; existing MRO does the rest.
- **D2 — `prepended do` (Rails 6+ Concern API):** absent from chunker
  `BLOCK_DEPTH_EXCEPTIONS` and from `activesupport.ts` concern-hooks — block
  content is not transparent. Count method defs + DSL macros inside
  `prepended do` blocks. If fat: add to both lists (2-line fix) + name-of
  audit.
- **D3 — `included do` bareCall misses:** bare calls inside `included do`
  blocks that fail to resolve (the open bead `vh0yh` — linked to the epic, not
  duplicated). Count feeds vh0yh prioritization.

taxdome is modern Rails; expectation is D1/D2 ≈ small.

### Bucket B/G1 overlap

`has_many` container refs from G1 already type `firm.employees.map(&:m)`
element receivers. The oracle reports bucket B **split**: sites typed by G1's
association container refs vs sites needing true VTA — so the VTA remainder is
honest, not inflated by G1's win.

## Gate (fixed)

- A + B(VTA-remainder) + C ≥ **5 000** in-project edges → VTA-IN: write G5
  design, keep `wbj3` as its bead.
- < 5 000 → VTA-OUT: close `wbj3` with the measured verdict and a pointer to
  the report.
- Bucket D micro-verdicts (per sub-count): D1 > 500 unresolved entries → file
  the legacy-Concern grammar as a small G3-adjacent task; D2 > 100 hidden
  defs/macros → file the `prepended do` transparency fix (2-line + tests);
  D3 feeds `vh0yh` prioritization (Wave 2 candidate if fat). Else record
  "modern idiom only, closed by 82o24 / negligible".

## Output

JSON + markdown table to `$CLAUDE_JOB_DIR/tmp` and the epic doc: per-bucket
sites, edges, top-10 member names, top-10 source files. Numbers land in this
design doc under "Findings" before the epic's Wave-2 decision point.

## Non-goals

- No resolver/production change of any kind.
- No new walker pass — extraction data the harness already holds.
- No reindex.

## Findings (2026-07-21)

Measured on taxdome (`/Users/artk0re/Dev/Job/taxdome`, 9 297 ruby files, 226 k
call sites) in-process via the oracle-extended harness
(`CODEGRAPH_ORACLE=1 npx tsx scripts/taxdome-codegraph-recall-forensics.ts`,
93 s, no qdrant/ollama/reindex). Full JSON:
`$CLAUDE_JOB_DIR/tmp/g0-oracle-report.json`.

### VTA gate — OUT

| Bucket | Shape | Sites | Oracle edges (upper bound) | Currently-miss subset |
| --- | --- | --- | --- | --- |
| A | `coll.each { \|x\| x.m }` block-param | 4 102 | **3 164** | 967 |
| B (total) | `coll.map(&:m)` symbol-to-proc | 1 391 | 990 | — |
| B — G1-typable | assoc / query-interface receiver | — | 421 | — |
| B — VTA-remainder | true VTA | — | **569** | 355 |
| C | `obj[k].m` index receiver | 317 | **317** | 317 (all) |

**Gate = A + B(remainder) + C:**

- Spec-literal upper bound: `3 164 + 569 + 317 = 4 050` < 5 000 → **VTA-OUT**.
- Honest new-recall bound: `967 + 355 + 317 = 1 639` (67 % below threshold).

Even the generous upper bound (monomorphic 1-edge-per-site, homonym-inflated —
the oracle-resolvable A/B sets are dominated by `id`, `to_s`, `name`, `present?`,
`sti_name`, i.e. core/attr homonyms that VTA would not usefully disambiguate) is
19 % below the gate. Both readings agree: **do NOT write G5. Close `wbj3` with
this report.**

C is dominated by core Enumerable/Hash/String members on the element
(`join` 47, `each` 41, `as_json` 29, `first`, `scan`, `presence`, `to_s`,
`to_h`) — the index element is usually a stdlib container, not a project model,
so VTA cannot type it anyway. B's G1-typable half (421) is genuinely covered by
G1 (top receiver tails: `select`, `where`, `documents`, `bills`, `clients`,
`users`, association + query-interface names), which is why crediting it to G1
and reporting the 569 remainder keeps the VTA number honest.

### Bucket D — Concern-coverage micro-verdicts

| Sub | Shape | Measured | Threshold | Verdict |
| --- | --- | --- | --- | --- |
| D1 | legacy `self.included(base); base.extend(ClassMethods)` | 2 hooks, 3 addressable members, **0** unresolved entries | > 500 | **negligible** — modern `ActiveSupport::Concern` only; no legacy-Concern grammar task |
| D2 | `prepended do` hidden defs/macros | **0** blocks, 0 defs, 0 macros | > 100 | **negligible** — taxdome uses NO `prepended do`; no transparency fix needed |
| D3 | `included do` bareCall misses | 38 blocks, **4** misses (`value`×2, `order`, `byte_size`) | feeds `vh0yh` | trivial; not a Wave-2 driver |

Confirms the epic's expectation ("taxdome is modern Rails; D1/D2 ≈ small") — it
is effectively zero. `82o24` (`class_methods do`) + include/prepend MRO channels
have already closed the Concern surface that matters; the legacy-extend and
`prepended do` idioms are absent from this corpus.

### How the oracle works

Additive, env-gated (`CODEGRAPH_ORACLE=1`) fold over the SAME materialized AST +
global symbol table the harness already builds in PASS-1 — no re-extraction, no
resolver change, no reindex; flag unset ⇒ byte-identical to before. One DFS per
file enumerates candidate sites (iterator block-param calls, `&:sym` args,
`has_many`/habtm accessor names, `included`/`prepended do` blocks, legacy
`self.included`+`base.extend` hooks). After the normal PASS-2 populates the miss
set, each candidate is folded against the oracle predicate
`symbolTable.lookupByShortName(member).length > 0` ("would resolve if the
element/receiver type were known perfectly"); bucket B is split by receiver-tail
into G1-typable vs true-VTA-remainder, and C reads directly off the existing
index-receiver recall holes.

### Deviations from spec

1. **B premise stale.** Spec says `&:sym` "never enters `callsAttempted`". Since
   2026-06-28 (`38319fb9`, pg5ya C2) `walker.emitBlockPassEdge` emits `&:m` as a
   receiver-null `bareCall` edge, so it IS attempted and resolves via ambiguous
   short-name lookup — B's oracle edges are mostly ALREADY edges (precision, not
   recall). Handled by reporting both the upper-bound and the new-recall bound;
   the verdict is OUT under both, so the staleness does not change the decision.
2. **C = 317, not 581.** 581 was the LIVE-index `receiverKind missWithDef`
   (`code_27622aef_v8`, 2026-07-10). 317 is the ruby-only in-process harness
   against the current worktree resolver (which carries other Wave-1 groups'
   uncommitted in-flight edits). C is not the deciding term at either value.
3. **"edges" = 1 per resolvable site** (monomorphic "known perfectly"
   assumption). The A/B oracle-resolvable sets are homonym-heavy, so the upper
   bound is deliberately generous — real addressable recall is below 4 050.
