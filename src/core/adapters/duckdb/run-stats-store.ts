/**
 * The resolve-stats reporting surface (bd tea-rags-mcp-j431): what extraction
 * attempted and how much of it resolved, plus the emitted edge-kind mix.
 *
 * Two tables back the breakdown, and `getRunStats` decides per language which
 * one answers (bd tea-rags-mcp-xpmwg):
 *
 * - `cg_file_resolve_stats` — one caller file's tally per receiver kind. A run
 *   replaces the rows of the files it resolved and nothing else, so the SUM
 *   describes the corpus however few files the last run touched.
 * - `cg_run_stats` — the legacy per-run table, replaced per language. It was
 *   the only table before migration 025, so it is what every language reads
 *   until a whole-corpus run has populated that language's per-file rows and
 *   recorded it in `cg_file_resolve_stats_coverage`.
 *
 * `getEdgeKindDistribution` reads the method-edge table rather than either, but
 * belongs here by role: it is the precision-confidence half of the same report,
 * telling exact edges apart from over-approximations.
 */

import type {
  EdgeKindCount,
  FileResolveStatsWrite,
  MethodEdgeKind,
  ResolveRunStatsRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

const FILE_RESOLVE_STATS_KEY_COLUMNS = ["rel_path", "receiver_kind"] as const;
const FILE_RESOLVE_STATS_VALUE_COLUMNS = [
  "language",
  "attempted",
  "resolved",
  "external_skipped",
  "unresolvable",
  "no_in_project_def",
  "core_ambiguous",
  "ambiguous_fanout",
  "unnarrowed_template",
] as const;

const COUNTER_COLUMNS = FILE_RESOLVE_STATS_VALUE_COLUMNS.slice(1);

export class DuckDbRunStatsStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    // Overwrite semantics: DELETE+INSERT inside one transaction so a prior
    // run's receiver kinds never leak into this run's breakdown.
    //
    // Scoped to the languages this run actually observed. A wholesale wipe was
    // correct only while every run saw the whole corpus; once a run can be
    // restricted (`--languages`, or simply a corpus where one language changed)
    // it erases the breakdown of languages it never looked at, and prime then
    // reports them as gone rather than unchanged.
    const languages = [...new Set(rows.map((r) => r.language))];
    if (languages.length === 0) return;

    return this.session.transaction(async () => {
      await this.session.run(
        `DELETE FROM cg_run_stats WHERE language IN (${languages.map(() => "?").join(", ")})`,
        languages,
      );
      for (const r of rows) {
        await this.session.run(
          "INSERT INTO cg_run_stats (language, receiver_kind, attempted, resolved, external_skipped, unresolvable, no_in_project_def, core_ambiguous, ambiguous_fanout, unnarrowed_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            r.unnarrowedTemplate ?? 0,
          ],
        );
      }
    });
  }

  /**
   * Replace the per-file tallies of every file `write` names and record its
   * covered languages, in one transaction.
   *
   * The replacement is a row DIFF (`applyScopedRowDiff`), not DELETE-then-INSERT:
   * a re-resolved file keeps most of its receiver kinds, and a transaction that
   * deletes and re-inserts the same primary key is the shape that turns a failed
   * commit into a native abort of the daemon (bd tea-rags-mcp-8l8d3). The outcome
   * is the same — a named file's rows become exactly its entry's rows, so a kind
   * it stopped tallying is deleted and an entry with no rows clears the file.
   *
   * Coverage is insert-only: once a whole-corpus run has populated a language,
   * every later run keeps its per-file rows current, so nothing ever needs to
   * un-cover it. A fresh `--force` starts from a new database file.
   */
  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    const relPaths = [...new Set(write.files.map((f) => f.relPath))];
    const languages = [...new Set(write.completeLanguages)];
    if (relPaths.length === 0 && languages.length === 0) return;

    const rows = write.files.flatMap((f) =>
      f.rows.map((r) => [
        f.relPath,
        r.receiverKind,
        f.language,
        r.attempted,
        r.resolved,
        r.externalSkipped,
        r.unresolvable,
        r.noInProjectDef ?? 0,
        r.coreAmbiguous ?? 0,
        r.ambiguousFanout ?? 0,
        r.unnarrowedTemplate ?? 0,
      ]),
    );

    return this.session.transaction(async () => {
      await this.session.applyScopedRowDiff(
        "cg_file_resolve_stats",
        "rel_path",
        relPaths,
        FILE_RESOLVE_STATS_KEY_COLUMNS,
        FILE_RESOLVE_STATS_VALUE_COLUMNS,
        rows,
      );
      await this.session.insertOrIgnoreBatched(
        "cg_file_resolve_stats_coverage",
        ["language"],
        languages.map((language) => [language]),
      );
    });
  }

  /**
   * The breakdown per (language, receiver kind): the per-file SUM for covered
   * languages, the legacy `cg_run_stats` rows for every other one. Never both
   * for one language — a covered language's legacy rows describe some earlier
   * run, and an uncovered language's per-file rows describe only the files
   * incremental runs happened to touch.
   */
  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    const counters = COUNTER_COLUMNS.join(", ");
    const sums = COUNTER_COLUMNS.map((c) => `CAST(SUM(${c}) AS BIGINT) AS ${c}`).join(", ");
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
      unnarrowed_template: number | bigint;
    }>(
      `SELECT language, receiver_kind, ${counters} FROM cg_run_stats
         WHERE language NOT IN (SELECT language FROM cg_file_resolve_stats_coverage)
       UNION ALL
       SELECT language, receiver_kind, ${sums} FROM cg_file_resolve_stats
         WHERE language IN (SELECT language FROM cg_file_resolve_stats_coverage)
         GROUP BY language, receiver_kind
       ORDER BY language, receiver_kind`,
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
      unnarrowedTemplate: Number(r.unnarrowed_template),
    }));
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    const rows = await this.session.queryAll<{ edge_kind: string; cnt: number | bigint }>(
      "SELECT edge_kind, COUNT(*) AS cnt FROM cg_symbols_edges_method GROUP BY edge_kind ORDER BY edge_kind",
    );
    return rows.map((r) => ({ edgeKind: r.edge_kind as MethodEdgeKind, count: Number(r.cnt) }));
  }
}
