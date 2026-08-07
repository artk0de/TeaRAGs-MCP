# Dimension Playbook — Phase 3 SCAN

Exact call parameters + severity mapping per dimension. Consumed by
`../SKILL.md` Phase 3. Parameter blocks byte-exact — never paraphrase into prose
when executing.

Input: Phase 2 working set `{file, changedSymbols[], chunkUUIDs[], overlay}` per
touched file. Output per dimension: findings
`{dimension, file, line, severity, evidence, draft body}`.

Codegraph gating: D1 + D7 run ONLY when prime `## Enrichment` lists
`codegraph.symbols`. Absent → skip, summary says "not assessed". D5 follows
tests-as-context preflight.

## D1 blast-radius (codegraph-gated)

```text
per changed symbol (cap 10):
  get_callers symbolId=<Class.method> project=<alias> limit=15
overlay read: codegraph.file.fanIn / transitiveImpact / isHub,
              codegraph.chunk.fanIn / pageRank (labels from prime)
severity: chunk.fanIn frequent+ OR file.isHub → major "hub edit" (cite caller
          list + fanIn label); else observation
```

Catches: hidden coupling, hub edits with wide ripple.

## D2 shotgun-twins

```text
find_similar positiveIds=[<all changed chunk UUIDs, one batch>]
             project=<alias> limit=10 testFile=exclude
co-change evidence = twin file shares git.taskIds with a touched file
severity: similar + shared taskId + untouched in diff → major "usually changes
          together" (cite taskId + twin path); similarity alone → observation
```

Catches: siblings that historically change together, untouched in this MR. ONE
batched call — never per-chunk.

## D3 fragile-zone (zero extra calls — Phase 2 overlay)

```text
overlay read: git.file.bugFixRate / churnVolatility / recencyWeightedFreq,
              git.chunk.bugFixRate on changed chunks
severity: concerning+/erratic+/burst labels → major when paired with missing
          test update (D5 cross-ref), else minor "fragile zone — extra care"
```

Catches: edits landing in panic zones. Labels from prime thresholds — cite raw
value + label.

## D4 silo-style

```text
trigger: git.file.blameDominantAuthorPct at silo/deep-silo label AND MR author
         (external) / git user (local) ≠ blameDominantAuthor
then:    semantic_search query=<changed symbol behavior>
           pathPattern=<same dir glob> rerank="proven" limit=5 project=<alias>
severity: minor — style/naming deviation from proven neighbors, cite the
          neighbor file:line pattern
```

Catches: non-owner editing silo-owned code. Proven neighbors = style reference;
deviation without neighbor citation → drop (evidence filter).

## D5 tests

```text
1. tests-as-context tests-at-risk recipe (skill preflight decides DSL vs
   fallback)
2. coverage per changed symbol: find_symbol on mirrored test path first;
   else hybrid_search query=<symbols of ONE domain cluster> testFile="only"
   metaOnly=true limit=15 — one call per cluster, NEVER one batched call
   (BM25 crowding → fabricated "untested")
severity: no coverage + (D1 hub OR D3 fragile) → major "untested change in
          hub/fragile zone"; no coverage alone → minor; verdict only from the
          symbol's own cluster call
```

Catches: scenarios at risk, changed branches without coverage. Three-state
verdict: test path found / none (own-cluster miss) / unverified — never print
"none" from another cluster's call.

## D6 invariants

```text
concepts = changed symbol names + MR description nouns (cap 5 queries)
semantic_search query=<concept> documentation="only" limit=5 metaOnly=false
severity: diff contradicts documented behavior → major, cite doc path:line +
          the contradicted statement
```

Catches: diff vs documented behavior/specs. Runs for ALL touched files including
`overlay: none` (new files still contradict docs).

## D7 cycles (codegraph-gated)

```text
find_cycles scope=file pathPattern=<touched-dirs glob> project=<alias>
severity: cycle through a touched file whose diff adds the closing import →
          major; pre-existing cycle merely touched → observation
```

Catches: MR introducing import/call cycle. Empty with codegraph ON = valid "no
cycles". Noise guard: >20 cycles → narrow pathPattern by subdomain.

## Phase 4 CLASSIFY rules (applied over all dimension findings)

1. Dedup by file:line — keep highest severity.
2. Cross-dimension overlap on same file/symbol → escalate one level (fragile +
   blast-radius → major; D5 pairing per its block).
3. Evidence filter: finding without citable signal label or code reference →
   DROP. Observations survive only into chat summary — never into posting
   contract.
4. Output findings in delivery-contract shape — see `delivery-contract.md`.

## Call budget

≤30 tea-rags calls typical MR (≤15 files): MAP ≤15 find_symbol + D1 ≤10
get_callers + D2 1 find_similar + D4 ≤2 + D5 ≤3 + D6 ≤5 + D7 1. Exceeded →
narrow scope with user, never silently truncate coverage.
