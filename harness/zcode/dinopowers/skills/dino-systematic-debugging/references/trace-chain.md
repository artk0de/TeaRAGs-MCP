# systematic-debugging — Step 3.5 trace detail

On-demand detail for SKILL.md Step 3.5. SKILL.md owns the call and the appended
block; open this file when reading the `trace_path` response (empty result,
`namesakes`, `dangerRanking`) or picking a non-default preset.

## Step 3.5 detail

Bug-hunt = **flat** list; the trace adds the static call CHAIN + temporal risk
per step.

Read result:

- **`dangerRanking[0]`** — inspect FIRST: riskiest hop between entry and suspect
  (not necessarily either). Start hypothesis there.
- **`dangerOverlay`** per step — `bugFixRate` / churn per hop; quiet
  intermediate with critical history surfaces.
- **Empty result** — check `namesakes` first (wrong `fromPath`/`toPath` pin →
  fix pin), then floor rule (no `codegraph` floor + `changedFiles` > 0 → edges
  in changed files = index's, re-check). Only then: NO static path `from` →
  `to`; "entry reaches suspect" **structurally false**. Either repro point
  wrong, dynamic/async edge invisible to static graph, or suspect unrelated.
  Drop it, trace next suspect.

Preset for trace:

| Situation                                       | `rerank`      |
| ----------------------------------------------- | ------------- |
| General symptom, history-ranked chain (default) | `bugHunt`     |
| **Fresh regression** — "worked last release"    | `recent`      |
| Suspect is a hot, frequently-touched path       | `hotspots`    |
| Failure smells like a wide blast-radius change  | `blastRadius` |

Fresh regression → `recent` ranks most recently-changed hop first (likely
breaking change). Old always-flaky symptom → keep `bugHunt`. Deep/branchy graph
→ bound `maxDepth` / `maxPaths`.
