/**
 * The per-review file-edge store (bd tea-rags-mcp-89k7k.1.2, F1 slice B) —
 * one THROWAWAY `cg_review_file_edges_<reviewId>` table per diff-scoped
 * review, holding the working-tree edges slice A's reader extracts.
 *
 * Why a table per review and not rows keyed by review id in one shared table:
 * the review id embeds its epoch (`<epochSeconds>-<pid>-<6 random chars>`),
 * so the age sweep reads the age off the table NAME — zero extra queries and
 * no scan of a shared table — and the disposal is a single `DROP TABLE`,
 * which frees the dead generations outright, where a DELETE on a keyed table
 * would keep them until a compaction (every indexed `cg_*` table pays that
 * tax; a throwaway need not).
 *
 * The table is deliberately NOT in any migration file: temp tables must never
 * enter the migration catalog — the DDL is issued here, at runtime, and the
 * table carries no PRIMARY KEY. A review writes once and drops whole; nothing
 * diffs it, so a key on a table this short-lived is wasted generations.
 *
 * Cleanup contract — guaranteed, not best-effort. Three layers:
 *
 * 1. The review flow's finally-drop: the orchestration (arriving with F2)
 *    drops the table when the review ends, success or failure.
 * 2. Sweep-on-create: the review ops call {@link sweepExpiredReviewTables}
 *    (now, maxAge) BEFORE their first put, so a crashed process's tables die
 *    on the next review anywhere.
 * 3. Daemon-start sweep is slice C — the parent decides where it hooks; the
 *    primitive this store ships is the same
 *    {@link sweepExpiredReviewTables} call.
 *
 * Write shape: put folds create-if-absent + append into ONE transaction —
 * an empty edge list still creates the table, so "review with no edges" is
 * distinguishable from "review never written". A second put to the same id
 * APPENDS: reviews write once, so append only ever fires on a retry, where
 * keeping the first attempt's rows is the honest answer.
 */

import type { ReviewFileEdge } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

/** The per-review table-name prefix; the review id follows it verbatim. */
export const REVIEW_EDGE_TABLE_PREFIX = "cg_review_file_edges_";

/**
 * How long a review's table may outlive its own id's epoch before any sweep
 * drops it — one hour of review is generous; the finally-drop normally wins.
 */
export const REVIEW_EDGE_MAX_AGE_SECONDS = 3600;

/**
 * Exactly the id the review flow mints: a 10-digit epoch, the minting process's
 * pid, six lowercase random chars. This string becomes part of a SQL
 * identifier that cannot travel as a bind parameter, so the pattern is the
 * injection guard — anything outside it fails loudly instead of landing in
 * DDL.
 */
const REVIEW_ID_PATTERN = /^\d{10}-\d{1,7}-[a-z0-9]{6}$/;

const COLUMNS = ["source_rel_path", "target_rel_path"] as const;

/** The table this review id names. Throws on anything that is not a minted id. */
function reviewTableName(reviewId: string): string {
  if (!REVIEW_ID_PATTERN.test(reviewId)) {
    throw new Error(`review-edge-store: not a minted review id: ${reviewId}`);
  }
  return `${REVIEW_EDGE_TABLE_PREFIX}${reviewId}`;
}

/** Double-quote a table name for interpolation into DDL. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface EdgeRow {
  source_rel_path: string;
  target_rel_path: string;
}

export class DuckDbReviewEdgeStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /** Create the review's table when absent. Runtime DDL — never a migration. */
  async createReviewTable(reviewId: string): Promise<void> {
    await this.session.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(reviewTableName(reviewId))} ` +
        "(source_rel_path VARCHAR NOT NULL, target_rel_path VARCHAR NOT NULL)",
    );
  }

  /** Create-if-absent + append, one transaction — see the module docblock. */
  async putReviewFileEdges(reviewId: string, edges: readonly ReviewFileEdge[]): Promise<void> {
    await this.session.transaction(async () => {
      await this.createReviewTable(reviewId);
      await this.session.insertBatched(
        quoteIdentifier(reviewTableName(reviewId)),
        [...COLUMNS],
        edges.map((e) => [e.sourceRelPath, e.targetRelPath]),
      );
    });
  }

  /** Drop the review's table. `IF EXISTS`: the finally-drop is idempotent. */
  async dropReviewTable(reviewId: string): Promise<void> {
    await this.session.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(reviewTableName(reviewId))}`);
  }

  /**
   * Drop every `cg_review_file_edges_*` table older than `maxAgeSeconds` at
   * `nowEpochSeconds`, and every malformed-named one — garbage never lingers.
   * Names are taken from the catalog and re-quoted with doubling, so even a
   * hostile name in our own database cannot leave the identifier. Returns the
   * dropped names.
   */
  async sweepExpiredReviewTables(nowEpochSeconds: number, maxAgeSeconds: number): Promise<string[]> {
    const rows = await this.session.queryAll<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    const dropped: string[] = [];
    for (const { table_name: name } of rows) {
      if (!name.startsWith(REVIEW_EDGE_TABLE_PREFIX)) continue;
      const epoch = /^\d+/.exec(name.slice(REVIEW_EDGE_TABLE_PREFIX.length))?.[0];
      const expired = epoch === undefined || nowEpochSeconds - Number(epoch) >= maxAgeSeconds;
      if (!expired) continue;
      await this.session.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
      dropped.push(name);
    }
    return dropped;
  }

  /** The review's edges ordered by (source, target); a missing table reads as none. */
  async readReviewFileEdges(reviewId: string): Promise<ReviewFileEdge[]> {
    const name = reviewTableName(reviewId);
    const found = await this.session.queryAll<{ n: number }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?",
      [name],
    );
    // The driver hands BIGINT back as a STRING in JSON mode — "0" === 0 is
    // false, and a dropped table would then fall through to a SELECT on a
    // missing name instead of reading as no edges.
    if (Number(found[0]?.n ?? 0) === 0) return [];
    const rows = await this.session.queryAll<EdgeRow>(
      `SELECT source_rel_path, target_rel_path FROM ${quoteIdentifier(name)} ORDER BY source_rel_path, target_rel_path`,
    );
    return rows.map((r) => ({ sourceRelPath: r.source_rel_path, targetRelPath: r.target_rel_path }));
  }
}
