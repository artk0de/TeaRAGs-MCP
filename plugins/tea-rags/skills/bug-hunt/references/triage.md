# Bug Hunt — signal triage detail and anti-patterns

On-demand detail for Non-negotiable 4. SKILL.md owns the class ladder and the
printed lines; this file owns the label semantics behind them.

## Signal triage

Overlay labels (search `rankingOverlay`, trace step `dangerOverlay`) sort each
chunk into a class. Keep chunk when it fits ANY class.

**Historical class — fix history:**

- `bugFixRate` `critical` → **prime suspect**
- `bugFixRate` `concerning` + `relativeChurn` `high` → **secondary suspect**

**Fresh class — changed recently, no fix history yet:**

- `recencyWeightedFreq` `burst` → **fresh suspect** (being edited right now)
- `ageDays` `recent` + `relativeChurn` `high` → **fresh suspect** (young,
  rewritten heavily for its size)
- `ageDays` `recent` + on the failing call path (trace step, stack-trace frame)
  → **fresh suspect** — path membership replaces churn corroboration
- fresh-probe hit matching symptom → **fresh suspect**

**Uncommitted class:** uncommitted-probe hit matching symptom → **uncommitted
suspect**, whatever its labels.

**SKIP** only: `bugFixRate` `healthy` + no fresh-class label + not a probe hit.
SKIP = no drill (`find_symbol`, Read), also when user asks before seeing the
verdict; verdict known + user insists → SKILL.md Rule 7 override.

`healthy` on low-`commitCount` code = too little history to judge, NOT clean:
confidence clamp caps `bugFixRate` label at `healthy` when `commitCount` below
collection p10 (`concerning` below p25). Young code cannot reach `critical`.
Pattern reading (e.g. "new method, bursty"): `signal-interpretation.md`.

**High bugFixRate + high `imports`/`fanIn` (fan-in):** suspect may be a coupling
point propagating bugs from upstream, not the origin. Check callers before
fixing here — when codegraph on, `get_callers` (see `call-path.md`) names the
exact upstream origins. See `signal-interpretation.md` (bug attractor vs
coupling; codegraph `fanIn` supersedes the `imports` proxy).

## Anti-patterns

- **Extra parallel searches in discovery.** Probes a/b (+ c) ARE the discovery
  (Non-negotiable 3). User-asked targeted search over named files ≠ extra
  search: run it (one brace-pathPattern call).
- **SKIP on `healthy` alone.** Young code label-capped at `healthy` (Signal
  triage) — fresh class decides.
- **Curiosity search.** "How does the other path work?" →
  `find_symbol(relativePath=<known file>)` outline, then
  `find_symbol(symbol=<id>)` body — never `hybrid_search` / `semantic_search`
  with that file as pathPattern. You already know WHERE the code is.
- **Confirmatory search / navigation.** Checkpoint has a candidate — present it.
  No search, `find_symbol`, or `trace_path` for "proof" or certainty.
- **Full file reads.** Chunk coordinates exist. Use them.
