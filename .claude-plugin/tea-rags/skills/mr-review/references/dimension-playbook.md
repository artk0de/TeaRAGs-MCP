# Dimension Playbook — Phase 3 SCAN

Exact call parameters + severity mapping per dimension. Consumed by
`../SKILL.md` Phase 3. Parameter blocks byte-exact — never paraphrase into prose
when executing.

Input: Phase 2 working set `{file, changedSymbols[], chunkUUIDs[], overlay}` per
touched file. Output per dimension: findings
`{dimension, file, line, severity, evidence, suggestion, draft body}`.

`evidence` is internal — the signal value or code reference that justified the
finding. `suggestion` is what the reader should DO; a finding without one is an
observation, not a comment. `draft body` is already plain language: signal names
and labels never survive into it (`delivery-contract.md` → "Speak human").

Every dimension block below ends with `fix:` — the shape its suggestion takes.

Codegraph gating: prime `## Enrichment` lists `codegraph.symbols` → D1 + D7 run
on the graph. Absent → D7 skipped ("not assessed" in summary, cycles have no
substitute); D1 runs in name-match mode (see its block). D5 follows
tests-as-context preflight.

## D1 blast-radius (codegraph-gated, with name-match fallback)

```text
per changed symbol (cap 10):
  get_callers symbolId=<Class.method> project=<alias> limit=15
overlay read: codegraph.file.fanIn / transitiveImpact / isHub,
              codegraph.chunk.fanIn / pageRank (labels from prime)
severity: chunk.fanIn frequent+ OR file.isHub → major "hub edit" (cite caller
          list + fanIn label); else observation
```

Codegraph OFF — degrade, do not skip:

```text
per changed symbol (cap 10):
  hybrid_search query=<bare symbol name> project=<alias> limit=15
                testFile=exclude metaOnly=true
  then find_symbol on the promising hits to confirm a real call site
severity: confirmed call sites in ≥3 other files → major; else observation
```

Name-matched callers are a LOWER BOUND — same-named methods on other classes
inflate it, dynamic dispatch deflates it. Every body built this way says the
callers were found by name, not by call graph, and never claims completeness.

Catches: hidden coupling, hub edits with wide ripple.

fix: name the call sites that need the same change, or the guard that keeps them
safe.

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

fix: name the twin file and what in it plausibly needs the matching edit.

## D3 fragile-zone (zero extra calls — Phase 2 overlay)

```text
overlay read: git.file.bugFixRate / churnVolatility / recencyWeightedFreq,
              git.chunk.bugFixRate on changed chunks
severity: concerning+/erratic+/burst labels → major when paired with missing
          test update (D5 cross-ref), else minor "fragile zone — extra care"
```

Catches: edits landing in panic zones. Body states the history in words ("about
half the commits here are bug fixes"), never the metric name.

fix: ask for the test that pins the changed branch, or for splitting the edit —
"be careful" is not a suggestion.

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
deviation without neighbor citation → drop (evidence filter). Never name the
dominant author as an authority — cite the pattern, not the person.

fix: point at the neighbor's pattern and the concrete edit that matches it.

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

fix: name the test file and the existing example the new case should sit beside.

## D6 invariants

```text
concepts = changed symbol names + MR description nouns (cap 5 queries)
semantic_search query=<concept> documentation="only" limit=5 metaOnly=false
severity: diff contradicts documented behavior → major, cite doc path:line +
          the contradicted statement
```

Catches: diff vs documented behavior/specs. Runs for ALL touched files including
`overlay: none` (new files still contradict docs).

Doc must be tracked in the MR's repo (Phase 4 source-visibility gate). A doc
chunk from agent-side config is not an invariant of the reviewed project.

fix: say which side is wrong — update the doc, or restore documented behavior —
and name the file to change.

## D7 cycles (codegraph-gated)

```text
find_cycles scope=file pathPattern=<touched-dirs glob> project=<alias>
severity: cycle through a touched file whose diff adds the closing import →
          major; pre-existing cycle merely touched → observation
```

Catches: MR introducing import/call cycle. Empty with codegraph ON = valid "no
cycles"; codegraph OFF = "not assessed", never "no cycles". Noise guard: >20
cycles → narrow pathPattern by subdomain.

fix: name the import to invert or the piece to extract so the closing edge goes
away.

## Phase 4 CLASSIFY rules (applied over all dimension findings)

1. Dedup by file:line — keep highest severity; two findings on one symbol merge.
2. Cross-dimension overlap on same file/symbol → escalate one level (fragile +
   blast-radius → major; D5 pairing per its block).
3. Evidence filter: finding without citable signal label or code reference →
   DROP. Observations survive only into chat summary — never into posting
   contract.
4. Fix gate: no concrete suggestion → demote to observation.
5. Source-visibility gate: cited path not tracked in the MR's repo → restate
   from code or drop.
6. Volume cap: ≤8 posted comments, ≤5 major; overflow → summary lines.
7. Humanize: observation → consequence → suggestion, ≤3 sentences, ≤1 number, no
   signal jargon.
8. Output findings in delivery-contract shape — see `delivery-contract.md`.

## Call budget

≤30 tea-rags calls typical MR (≤15 files): MAP ≤15 find_symbol + D1 ≤10
get_callers + D2 1 find_similar + D4 ≤2 + D5 ≤3 + D6 ≤5 + D7 1. D1 in name-match
mode costs the same ≤10 (hybrid_search) plus confirmation find_symbol calls —
cap those at 10 too, dropping the least-promising hits rather than exceeding.
Exceeded → narrow scope with user, never silently truncate coverage.
