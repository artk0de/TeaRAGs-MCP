# Dimension Playbook — Phase 3 SCAN

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Exact call parameters + severity per dimension. Consumed by `../SKILL.md`
Phase 3. Parameter blocks byte-exact — never paraphrase into prose when
executing.

Input: Phase 2 working set `{file, changedSymbols[], chunkUUIDs[], overlay}` per
touched file. Output per dimension: findings
`{dimension, file, line, severity, evidence, suggestion, draft body}`.

`evidence` internal — signal value or code reference justifying finding.
`suggestion` = what reader should DO; none → observation, not comment.
`draft body` already plain language, no signal names/labels
(`delivery-contract.md` → "Speak human"). Each block ends with `fix:` — shape of
its suggestion.

Every call: `path=<checkout>` (SKILL Phase 0).

Codegraph gating: graph tools (`get_callers`, `find_cycles`, …) in tool list
(unsure → digest: `codegraph off` line = off, silent = on) → D1 + D7 + D8 run on
graph. Off → D7, D8 skipped ("not assessed" in summary, no substitute); D1
name-match mode (its block). D5 follows tests-as-context preflight.

## D1 blast-radius (codegraph-gated, with name-match fallback)

```text
per changed symbol (cap 10):
  get_callers symbolId=<id> limit=15
once for all of them:
  find_symbol symbols=[<id1>, <id2>, ...] rerank="blastRadius" metaOnly=true
              fields=["relativePath", "symbolId", "codegraph"]
  <id>: Class#method = instance method, Class.method = static — take it
        from the Phase 2 outline line, never retype it; rows keyed by
        `request`, misses in `missing[]`
edges: no codegraph floor + changedFiles > 0 → callers in changed files are
       the index's (`tea-rags://guide/freshness` "Addressing the Codebase")
overlay read: rankingOverlay.file.fanIn / transitiveImpact / isHub,
              rankingOverlay.chunk.fanIn (labels); raw values at
              payload.codegraph.symbols.{file,chunk}.* (pageRank there)
severity: chunk.fanIn frequent+ OR file.isHub → major "hub edit" (cite caller
          list + fanIn label); else observation
visibility: get_callers top-level `visibility` = changed symbol's declared
          level. private → ripple confined to declaring class (compiler-enforced
          in TS/Java/Swift/Rust/Go; Ruby/Python only a hint); public/absent →
          ripple = full caller list. Absent = unknown, never assume private
```

Codegraph OFF — degrade, do not skip:

```text
per changed symbol (cap 10):
  hybrid_search query=<bare symbol name> limit=15
                testFile=exclude metaOnly=true
  then ONE find_symbol symbols=[<promising hit ids>] to confirm real call sites
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
             limit=10 testFile=exclude
co-change evidence = twin file shares git.taskIds with a touched file
severity: similar + shared taskId + untouched in diff → major "usually changes
          together" (cite taskId + twin path); similarity alone → observation
```

Catches: siblings that historically change together, untouched in this MR. ONE
batched call — never per-chunk.

fix: name the twin file and what in it plausibly needs the matching edit.

## D3 fragile-zone (zero extra calls — Phase 2 overlay)

```text
overlay read: rankingOverlay.file.bugFixRate / churnVolatility /
              recencyWeightedFreq, rankingOverlay.chunk.bugFixRate on changed
              chunks (hotspots overlay from Phase 2)
severity: concerning+/erratic+/burst labels → major when paired with missing
          test update (D5 cross-ref), else minor "fragile zone — extra care"
```

Catches: edits landing in panic zones. Body states the history in words ("about
half the commits here are bug fixes"), never the metric name.

fix: ask for the test that pins the changed branch, or for splitting the edit —
"be careful" is not a suggestion.

## D4 silo-style

```text
trigger: rankingOverlay.file.blameDominantAuthorPct at silo/deep-silo label
         AND MR author (external) / git user (local) ≠ payload
         git.file.blameDominantAuthor
then:    semantic_search query=<changed symbol behavior>
           pathPattern=<same dir glob> rerank="proven" limit=5
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
2. coverage per changed symbol: ONE find_symbol symbols=[<mirrored test paths>]
   first (misses in `missing`);
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
find_cycles scope=file pathPattern=<touched-dirs glob>
severity: cycle through a touched file whose diff adds the closing import →
          major; pre-existing cycle merely touched → observation
```

Catches: MR introducing import/call cycle. Empty with codegraph ON = valid "no
cycles"; codegraph OFF = "not assessed", never "no cycles". Noise guard: >20
cycles → narrow pathPattern by subdomain.

fix: name the import to invert or the piece to extract so the closing edge goes
away.

## D8 naming (codegraph-gated)

```text
local:    review_changes changes={ base: <target branch, e.g. main> },
                             sections: ["naming"]
          (tool reads base at its merge-base with HEAD — no git merge-base)
          (on main, uncommitted only → changes={})
external: get_naming_lexicon names=[<declarations on the diff's added lines:
                             {name, kind, type?}; kind = param | local | field
                             | constant | return | type — `row = find_x(id)` →
                             row: local, find_x: return; a type: {name,
                             kind: "type", path, extends?}>]
                             pathPattern=<touched-dirs glob> language=<lang>
severity: MISFIT → minor; COLLISION → minor; NEW_TERM → minor only when
          topTerms or alternatives hold a term for the same concept;
          CONFORMS → nothing
```

Plan names, verbatim:
`D8 bodies: plain words, no MISFIT/COLLISION/NEW_TERM, no tool names`.

Comment bodies and the summary comment: plain language — no verdict codes, no
tool names, nothing about local vs external mode. MISFIT fix = the `suggestion`,
`holder` as precedent.

Local: ONE `review_changes(changes, sections: ["naming"])` call judges every
name added hunks declare (values, types, constants) — no hand-listed drafts.
Name it in the plan even when verdicts are already in context — they come from
that call. Changed files excluded from evidence → already-indexed names cannot
vouch for themselves. External: MR branch never checked out, working tree lacks
its code → `names[]` from diff. `notJudged` > 0 → state unjudged file count,
never "no naming issues".

Answer = `review` {base, checked, conforming, novel, findings, notJudged,
truncated?}; each finding flat `{relPath, line, name, kind, type?, verdict, …}`.
Findings grouped by verdict with `relPath:line`; conforming + novel counts = one
summary line. `novel` = NEW_TERM with nothing to compare against — never a
comment. `genericName` on a finding (even CONFORMS) = generic name → minor.
`notJudged` counts tests and non-codegraph files — not reviewed, not clean.
Reading a verdict: `../../data-driven-generation/SKILL.md` Step 5 "Naming
(lexicon)". Evidence = `suggestion` + `holder` (MISFIT), `existing` file
(COLLISION), `alternatives` (NEW_TERM — soft, never a rename demand). A type
MISFIT with `role.evidence: "directory"` is location-based: comment only when
the type IS one of `role.examples`' family; a non-member (a copier among
artifacts) = placement question → drop, or note the location, never a rename.

Method-naming audit over the whole diff (not just added declarations) →
`get_ontology_report sections=["verbs"]`: per noun tail, the project's verbs
with holders — descriptive, contested tails only, complements the per-name
`changes` review above. A tail's verbs are distinct operations, not synonyms:
never ask to rename one verb to another on this evidence.

fix: the suggested name citing the holder file (MISFIT); a distinct name, or a
reason the homonym is intended, citing the existing file (COLLISION); the
alternative term, when it denotes the same concept (NEW_TERM).

Phase 4 CLASSIFY rules (dedup, escalate, evidence/fix/visibility gates, cap,
humanize): `../SKILL.md` Phase 4.

## Call budget

≤20 tea-rags calls typical MR. Caps sum to ≤26: MAP 1 find_symbol (≤15 files)

- D1 ≤11 (get_callers per symbol, cap 10, + 1 find_symbol) + D2 1 find_similar +
  D4 ≤2 + D5 ≤3 + D6 ≤5 + D7 1 + D8 1 + diff-review 1. D1 in name-match mode
  costs the same: ≤10 hybrid_search + 1 confirmation find_symbol over ≤10 hits,
  dropping the least-promising hits rather than exceeding. Exceeded → narrow
  scope with user, never silently truncate coverage.
