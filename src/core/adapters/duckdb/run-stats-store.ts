/**
 * The resolve-run reporting surface (bd tea-rags-mcp-j431): what the last
 * extraction pass attempted and how much of it resolved, plus the emitted
 * edge-kind mix.
 *
 * `cg_run_stats` is overwrite-only — a run records every receiver kind it
 * observed, so a stale row from a previous run must never survive into this
 * run's breakdown. `getEdgeKindDistribution` reads the method-edge table rather
 * than `cg_run_stats`, but belongs here by role: it is the precision-confidence
 * half of the same report, telling exact edges apart from over-approximations.
 */

import type { EdgeKindCount, MethodEdgeKind, ResolveRunStatsRow } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

export class DuckDbRunStatsStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    // Overwrite semantics: DELETE+INSERT inside one transaction so a prior
    // run's receiver kinds never leak into this run's breakdown.
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_run_stats");
      for (const r of rows) {
        await this.session.run(
          "INSERT INTO cg_run_stats (language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            r.language,
            r.receiverKind,
            r.attempted,
            r.resolved,
            r.externalSkipped,
            r.unresolvable,
            r.noInProjectDef ?? 0,
            r.coreAmbiguous ?? 0,
            r.ambiguousFanout ?? 0,
          ],
        );
      }
    });
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    const rows = await this.session.queryAll<{
      language: string;
      receiver_kind: string;
      attempted: number | bigint;
      resolved: number | bigint;
      external_skipped: number | bigint;
      unresolvable: number | bigint;
      no_in_project_def: number | bigint;
      core_ambiguous: number | bigint;
      ambiguous_fanout: number | bigint;
    }>(
      "SELECT language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout FROM cg_run_stats ORDER BY language, receiver_kind",
    );
    return rows.map((r) => ({
      language: r.language,
      receiverKind: r.receiver_kind,
      attempted: Number(r.attempted),
      resolved: Number(r.resolved),
      externalSkipped: Number(r.external_skipped),
      unresolvable: Number(r.unresolvable),
      noInProjectDef: Number(r.no_in_project_def),
      coreAmbiguous: Number(r.core_ambiguous),
      ambiguousFanout: Number(r.ambiguous_fanout),
    }));
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    const rows = await this.session.queryAll<{ edge_kind: string; cnt: number | bigint }>(
      "SELECT edge_kind, COUNT(*) AS cnt FROM cg_symbols_edges_method GROUP BY edge_kind ORDER BY edge_kind",
    );
    return rows.map((r) => ({ edgeKind: r.edge_kind as MethodEdgeKind, count: Number(r.cnt) }));
  }
}
