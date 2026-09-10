-- Codegraph schema — the unnarrowed-self-dispatch-entry invariant (bd znxg8).
-- Every other counter on cg_run_stats describes a MISS, which is why none of
-- them saw znxg8: the degraded edges all RESOLVED. A concrete
-- `SomeService.call(...)` landing on the shared `KindOfService.call` it inherits
-- is a wrong target, not a missing one, so inProjectEdgeRecall read 1.0 while
-- 200/200 sampled caller edges of that node were entry calls. This column counts
-- them directly and feeds no rate — near zero when entry narrowing works.
-- Nullable (DuckDB rejects NOT NULL on ALTER ADD COLUMN); DEFAULT 0 backfills.
-- Mirrors 022-cg-run-stats-unnarrowed-template.ts — keep in sync.
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS unnarrowed_template BIGINT DEFAULT 0;
