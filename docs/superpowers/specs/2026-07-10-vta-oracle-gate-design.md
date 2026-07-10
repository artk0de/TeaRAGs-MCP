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
