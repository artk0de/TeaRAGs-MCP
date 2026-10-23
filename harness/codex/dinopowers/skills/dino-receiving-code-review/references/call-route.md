# Step 3.5 — Trace call route the change rides

Read when review comment names **relationship between two symbols** ("change how
`X` calls `Y`", "this method should not reach `Z`", "route this through `W`
instead"). Change rides a **call route**, not one symbol → promote Step 2's
single fanIn to actual PATH: `trace_path` between named endpoints → route +
highest-impact chokepoint.

**Requires codegraph** — `trace_path` in tool list (unsure → read
`tea-rags://project/<alias>/metrics?section=registry`, `codegraph on|off`). Off
→ stay with Step 2 fanIn, note route view unavailable.

```
trace_path(
  from="<caller symbol the comment names>",   # e.g. the X in "how X calls Y"
  to="<callee symbol the comment names>",     # e.g. the Y, or the Z it "should not reach"
  rerank="blastRadius"                          # rank each hop by fanIn / import impact
)
```

Reading:

- **`dangerRanking[0]`** — highest-impact step ON route, not necessarily an
  endpoint. Chokepoint change ripples through → concrete hop with measured
  fanIn, not one number on named symbol.
- **`dangerOverlay`** per step — `imports` / churn per hop; quiet intermediate
  everything routes through surfaces instead of hiding between endpoints.
- **Empty result** — first check `namesakes` (wrong `fromPath`/`toPath` pin →
  fix pin) + floor rule (no `codegraph` floor + `changedFiles` > 0 → edges in
  changed files = index's → re-check). Only then: NO static path `from` → `to`;
  reviewer's premise ("X reaches Y") may be **structurally false** → pushback
  input. Confirm before agreeing.

| Situation                                                     | `rerank`      |
| ------------------------------------------------------------- | ------------- |
| "What does this change ripple through" — impact-ranked route  | `blastRadius` |
| "Who else owns the steps I'd touch" — who to loop into the PR | `ownership`   |

`rerank="ownership"` → owners of each hop; change crosses hops owned by others
than named symbols' owners → loop them in. Deep/branchy graph → bound with
`maxDepth` / `maxPaths`.

Append under Step 3 impact block:

```
**Call route the change rides (<from> → <to>), danger-ranked:**
- chokepoint: <dangerRanking[0] symbol> @ <file>:<line>
  overlay: imports <N>, churn <Y>
- also on route: <next step> @ <file>:<line>
  owner (ownership preset): <blameDominantAuthor> — loop into review
```

Empty → append
`**Call route:** no static path <from> → <to> — the reviewer's "X reaches Y" premise may not hold; confirm before agreeing`.
