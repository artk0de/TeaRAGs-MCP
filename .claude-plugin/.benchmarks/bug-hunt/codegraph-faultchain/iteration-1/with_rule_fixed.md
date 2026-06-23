# bug-hunt codegraph fault-chain navigation — iteration 1 (with rule, fixed)

Skill under test:
`.claude-plugin/tea-rags/skills/bug-hunt/SKILL.md`

Two environments:
- ENV-A: prime `## Enrichment` = `git: file healthy, chunk healthy` (no
  `codegraph.symbols`). Tools: semantic_search, rank_chunks, find_symbol,
  hybrid_search, find_similar, ripgrep, Read. (codegraph OFF — get_callers /
  get_callees / find_cycles / trace_path NOT registered)
- ENV-B: ENV-A + `codegraph.symbols: file healthy, chunk healthy`. Tools: ENV-A
  + get_callers, get_callees, find_cycles, trace_path. (codegraph ON)

---

CASE 1 (upstream-origin) [ENV-B]:
- after the flat bugHunt suspect list, next: `find_symbol` to resolve the exact
  id of `OrderTotal#compute`, then `get_callers symbolId=OrderTotal#compute` to
  name who feeds it the bad value — the bug looks like it originates one hop up.
- codegraph available? yes — prime shows `codegraph.symbols: file healthy, chunk
  healthy`; get_callers IS registered.
- TELL THE USER: the failing method is a victim, not the origin — bad input
  arrives from a caller. I trace the **upstream origin via get_callers**:
  resolve `OrderTotal#compute` with find_symbol, then `get_callers` names the
  exact upstream callers; the origin is most likely one of them, not compute
  itself.

CASE 2 (entry-then-trace) [ENV-B]:
- after the flat bugHunt suspect list, next: `semantic_search rerank="entryPoint"
  pathPattern=<scope>` to surface the flow entry (high fan-out / low fan-in
  driver) that reaches `PaymentService#charge`, then `trace_path(from=<entry>,
  to=PaymentService#charge, rerank="bugHunt")` for the danger-ranked call path.
- codegraph available? yes — prime shows `codegraph.symbols` healthy; entryPoint
  preset + trace_path are usable.
- TELL THE USER: I have the suspect but no request-flow `from` — I use
  **entryPoint to find the from** (the entry that reaches the suspect), then
  trace_path from that entry to `PaymentService#charge` and read the
  per-step dangerOverlay top-down (dangerRanking[0] = inspect-first hop).

CASE 3 (state-loop) [ENV-B]:
- after the flat bugHunt suspect list, next: `find_cycles scope=method
  pathPattern=<SyncWorker scope>` to surface the circular call path — a cycle
  through `SyncWorker` is the structural form of the infinite-loop hypothesis.
- codegraph available? yes — prime shows `codegraph.symbols` healthy; find_cycles
  IS registered.
- TELL THE USER: the symptom is runaway recursion / infinite re-entry, so I use
  **find_cycles for the loop** — it surfaces the circular call path around
  `SyncWorker`; the cycle through the suspect is the structural cause of the
  hang.

CASE 4 (off-fallback) [ENV-A]:
- after the flat bugHunt suspect list, next: NO codegraph tool — get_callers /
  trace_path are not registered. Fall back to the flat suspect list plus manual
  reasoning (partial Read at chunk coordinates from the search results; ripgrep
  only for literal markers).
- codegraph available? no — prime `## Enrichment` has NO `codegraph.symbols`
  block; the upstream-origin tools do not exist in this env.
- TELL THE USER: **codegraph off — flat list + manual only.** The call-chain /
  upstream-origin ranking is unavailable without codegraph; I report the
  bugHunt-ranked flat suspect list (file:line + bugFixRate/relativeChurn labels)
  and reason about the caller manually from chunk coordinates, never reading an
  absent get_callers as a fact.
