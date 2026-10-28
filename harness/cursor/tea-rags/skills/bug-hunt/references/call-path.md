# Bug Hunt — call path between entry and failure

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

On-demand detail for Non-negotiable 7. SKILL.md owns the printed plan lines;
open this file when reading a `trace_path` / `get_callers` response (empty
paths, namesakes, `dangerRanking`, model edges, regression bisect, cycles).

## Call path — fresh steps between entry and failure

Signal triage gives a **flat** list — WHAT is suspect. Call path gives the
**causal chain** — WHICH step on the executed route from entry to failure is
riskiest. Step with `ageDays` `recent` on that route = fresh suspect even at
`bugFixRate` `healthy` (`triage.md`): new code on the failing path, never fixed
yet.

Edges: no `codegraph` floor while `changedFiles` > 0 → edges touching changed
files are the index's (`tea-rags://guide/freshness` "Addressing the Codebase").

**Requires codegraph** (graph tools registered; `## Codegraph resolve` = its
resolve rate). Codegraph off → graph tools not registered — use Codegraph off
below; never read an absent tool as a fact.

**Endpoints:**

- **entry** = outermost in-project frame named in stack trace / symptom — test
  function, handler, public API. None named →
  `semantic_search rerank="entryPoint" pathPattern=<scope>` surfaces flow
  entries (high fan-out / low fan-in drivers); pick one reaching the failure.
- **failure site** = innermost in-project frame, or suspect from triage.
- Resolve both to exact symbolIds in ONE
  `find_symbol(symbols: [<entry>, <failure site>])` first (`Class#method` vs
  `Class.method`); search chunk already carries `symbolId` + `relativePath`.
  Entry `find_symbol` cannot resolve (anonymous test block) → first named frame
  it calls.

**Escalate cheap → full** (`tea-rags://guide/navigation` Graph navigation
precedence):

1. **One endpoint known → one hop.**
   - `get_callers symbolId=<failure site>` — who feeds it. Suspect looks like a
     victim (bad input/state arrives from elsewhere) → bug may originate one hop
     up.
   - `get_callees symbolId=<entry or suspect>` — what it drives; where corrupted
     state propagates next, to pick the next checkpoint.
   - Hops carry no git overlay → triage the hops in ONE
     `find_symbol(symbols: [<hop ids>], rerank: "bugHunt")` (attaches
     `rankingOverlay`).
2. **Both endpoints known + whole route matters → trace.**

   ```text
   trace_path(from=<entry>, to=<failure site>, rerank="bugHunt")
   ```

   Pass `rerank` explicitly — without it trace is lean, no overlay. Per-step
   `dangerOverlay` = same `bugHunt` overlay as search → apply the two-class
   triage to EVERY step, both classes.

   A step with `origin: "model"` (+ `model`, `p`) is a model verdict with
   probability `p`, not a static fact; path `minP` is its weakest link — a low
   `minP` means the route may not exist at runtime.

**Read trace response:**

- `dangerRanking[0]` → **inspect-first step** — riskiest hop on the route.
- Fresh-class step anywhere on the path → suspect, even when `dangerRanking`
  puts an old hotspot first.
- `aggregateDanger` → ranks competing paths when `maxPaths > 1`; walk the
  highest-danger route first. Bound with `maxDepth` / `maxPaths`; `truncated`
  true → more paths exist, pin endpoints before raising limits.
- Namesake endpoints (component codebases: `BaseTable` in several files) → pin
  `fromPath` / `toPath` with the chunk's `relativePath`; semantics in
  `tea-rags://guide/navigation` Graph navigation.
- **Empty `paths`: check `namesakes` FIRST.** Present → `fromPath`/`toPath`
  matched no candidate — fix the path (real candidates listed), not the suspect.
  Absent → no static call path — wrong entry, dynamic dispatch, or wrong
  suspect. Re-pick before reading code.
- **Regression bisect:** route worked before, broke now → `rerank="recent"`
  orders steps by recency. Its overlay lacks `bugFixRate` — cannot separate
  fresh-never-fixed from fresh-fix; `bugHunt` stays default. Other presets:
  `rerank` enum in tool schema.

**State-loop / re-entrancy smell (`find_cycles`).** Symptom is infinite loop,
runaway recursion, repeated re-entry →
`find_cycles scope=method pathPattern=<scope>` surfaces circular call paths — a
cycle through the suspect is the structural form of that hypothesis. A cycle
with `hasModelEdge` may be closed only by a model verdict — verify the model hop
before trusting the loop.

### Codegraph off

Route per `tea-rags://guide/navigation` "When codegraph is off" table. Bug-hunt
specifics:

- Stack trace frames = executed path. Fresh probe with `pathPattern` =
  brace-joined relativePaths of in-project frames (project root stripped) →
  fresh chunks along the route, no graph needed.
- No stack trace → semantic/hybrid + manual reading; say plainly "no static path
  tool". Never claim "no path" / "unreachable" / "no cycles".
