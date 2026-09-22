/**
 * stats-v7 — recompute a stats file sampled under a procedure this build no
 * longer uses.
 *
 * The case that prompted it: every `*.file.*` value is stamped onto every chunk
 * of its file, so a sample taken without `stats.dedupeByFile` let a many-chunk
 * file vote once per chunk and tilted every file-scope percentile toward large
 * files. Measured on the tea-rags index before the flag was swept across the
 * enrichment trajectories, `git.file.ageDays` p50 read 7 days per chunk against
 * 31 per file, and `git.file.bugFixRate` p50 read 25 against 0.
 *
 * Those percentiles are not display-only — filter presets compare against them
 * and the reranker's adaptive bounds are floored with them, so the skew reached
 * ranking. Existing indexes cannot be left to drift until someone happens to
 * force an enrichment recompute for an unrelated reason.
 *
 * Everything needed is already on disk: the payload carries the values, the
 * descriptors carry the (now correct) sampling declarations. So this recomputes
 * rather than asking for a reindex — see `.claude/rules/migrations.md`, which
 * makes that distinction the test for whether a migration is owed at all. It is
 * scoped to the CONTRACT rather than to the dedupe flag alone because the same
 * argument covers every other property of the sample, and a second migration
 * doing the same rebuild for the next such change would be pure ceremony.
 */

import type { Migration, StatsStore, StepResult } from "../types.js";

export class StatsV7SamplingContract implements Migration {
  readonly name = "stats-v7-sampling-contract";
  readonly version = 7;

  constructor(
    private readonly collection: string,
    private readonly store: StatsStore,
  ) {}

  async apply(): Promise<StepResult> {
    const rebuilt = await this.store.rebuildStatsFromPayload(this.collection);
    return {
      applied: rebuilt
        ? [`signal percentiles recomputed under the current sampling contract for ${this.collection}`]
        : [`signal percentile recompute — skipped (no stats file for ${this.collection})`],
    };
  }
}
