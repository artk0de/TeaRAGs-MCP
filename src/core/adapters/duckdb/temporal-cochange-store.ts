/**
 * The temporal co-change store (bd tea-rags-mcp-x4rpp) — `cg_temporal_files`,
 * `cg_temporal_edges_cochange`, `cg_temporal_meta` (migration 031) and
 * `cg_temporal_bundle_files` (bd tea-rags-mcp-c3v6o, migration 042) and
 * `cg_temporal_bundle_commits` (bd tea-rags-mcp-89k7k.1.14, migration 043);
 * bundle files carry their commit's line counts (bd tea-rags-mcp-dm61n,
 * migration 046), bundle commits their commit time (bd tea-rags-mcp-zf9yz,
 * migration 047).
 *
 * Pure CRUD, like the analytics store: the extractor that computes the graph
 * and every judgement over it live in `domains/trajectory/codegraph/temporal/`.
 * The one join done here — whether the structural graph links a pair's
 * endpoints — is a read of the edge tables, not a judgement: the detector
 * decides what an unlinked pair means.
 */

import type {
  CochangeBurstWindowMethod,
  CochangeFileLineCounts,
  RelPath,
  TemporalCochangeBuildMeta,
  TemporalCochangeEdge,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

/** `cg_temporal_meta.meta_key` of the co-change build's provenance row. */
const COCHANGE_META_KEY = "cochange";

/**
 * Longest barrel chain `readGraph` follows. A cap, not a depth anyone expects:
 * it is what makes the recursion terminate on a re-export cycle.
 */
const REEXPORT_CHAIN_LIMIT = 8;

const EDGE_COLUMNS = [
  "rel_path_a",
  "rel_path_b",
  "support",
  "confidence_ab",
  "confidence_ba",
  "lift",
  "last_co_change_at",
  "sample_commits",
] as const;

interface MetaRow {
  head: string;
  fingerprint: string;
  built_at: number | bigint;
  window_since: number | bigint;
  commit_count: number;
  bundle_count: number;
  admitted_bundle_count: number;
  max_files_per_bundle: number;
  min_support: number;
  max_partners_per_file: number;
  admitted_burst_count: number | null;
  burst_window_minutes: number | null;
  burst_window_method: string | null;
}

interface EdgeRow {
  rel_path_a: string;
  rel_path_b: string;
  support: number;
  confidence_ab: number;
  confidence_ba: number;
  lift: number;
  last_co_change_at: number | bigint;
  sample_commits: string;
  structurally_linked: boolean;
}

interface BundleFileRow {
  bundle_id: number;
  rel_path: string;
}

export class DuckDbTemporalCochangeStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /**
   * Replace the whole co-change graph in one transaction. The tables are
   * recreated, not DELETEd — a keyed DuckDB table keeps every deleted
   * generation in the file (`DuckDbGraphSession#recreateEmptyTable`).
   */
  async replace(snapshot: TemporalCochangeSnapshot): Promise<void> {
    const {
      meta,
      files,
      edges,
      bundles,
      bundleCommits,
      bundleBursts,
      bundleTaskIds,
      bundleFileLines,
      bundleTimestamps,
    } = snapshot;
    await this.session.transaction(async () => {
      await this.session.recreateEmptyTable("cg_temporal_files");
      await this.session.recreateEmptyTable("cg_temporal_edges_cochange");
      await this.session.recreateEmptyTable("cg_temporal_meta");
      await this.session.recreateEmptyTable("cg_temporal_bundle_files");
      await this.session.recreateEmptyTable("cg_temporal_bundle_commits");
      await this.session.insertBatched(
        "cg_temporal_files",
        ["rel_path", "bundle_count", "partner_count", "last_changed_at"],
        files.map((f) => [f.relPath, f.bundleCount, f.partnerCount, f.lastChangedAt]),
      );
      await this.session.insertBatched("cg_temporal_edges_cochange", EDGE_COLUMNS, edges.map(edgeRow));
      await this.session.insertBatched(
        "cg_temporal_bundle_files",
        ["bundle_id", "rel_path", "lines_added", "lines_deleted"],
        bundles.flatMap((filesOfBundle, bundleId) =>
          filesOfBundle.map((relPath, fileIndex) => {
            const lines = bundleFileLines?.[bundleId]?.[fileIndex] ?? null;
            return [bundleId, relPath, lines?.added ?? null, lines?.deleted ?? null];
          }),
        ),
      );
      await this.session.insertBatched(
        "cg_temporal_bundle_commits",
        ["bundle_id", "commit_shas", "burst_id", "task_ids", "committed_at"],
        (bundleCommits ?? []).map((shas, bundleId) => {
          const taskIds = bundleTaskIds?.[bundleId];
          return [
            bundleId,
            JSON.stringify(shas),
            bundleBursts?.[bundleId] ?? null,
            taskIds === undefined ? null : JSON.stringify(taskIds),
            bundleTimestamps?.[bundleId] ?? null,
          ];
        }),
      );
      await this.session.insertBatched(
        "cg_temporal_meta",
        [
          "meta_key",
          "head",
          "fingerprint",
          "built_at",
          "window_since",
          "commit_count",
          "bundle_count",
          "admitted_bundle_count",
          "max_files_per_bundle",
          "min_support",
          "max_partners_per_file",
          "admitted_burst_count",
          "burst_window_minutes",
          "burst_window_method",
        ],
        [
          [
            COCHANGE_META_KEY,
            meta.head,
            meta.fingerprint,
            meta.builtAt,
            meta.windowSince,
            meta.commitCount,
            meta.bundleCount,
            meta.admittedBundleCount,
            meta.maxFilesPerBundle,
            meta.minSupport,
            meta.maxPartnersPerFile,
            meta.admittedBurstCount,
            meta.burstWindowMinutes,
            meta.burstWindowMethod,
          ],
        ],
      );
    });
  }

  /** The provenance row, or `null` before the first build. */
  async readMeta(): Promise<TemporalCochangeBuildMeta | null> {
    // Migration 044's burst columns: a file without them reads as not recorded.
    const burstColumns = ["admitted_burst_count", "burst_window_minutes", "burst_window_method"];
    const present = await this.columnsOf("cg_temporal_meta", burstColumns);
    const [row] = await this.session.queryAll<MetaRow>(
      `SELECT head, fingerprint, built_at, window_since, commit_count, bundle_count, admitted_bundle_count,
              max_files_per_bundle, min_support, max_partners_per_file,
              ${burstColumns.map((c) => (present.has(c) ? c : `NULL AS ${c}`)).join(", ")}
       FROM cg_temporal_meta WHERE meta_key = ?`,
      [COCHANGE_META_KEY],
    );
    if (!row) return null;
    return {
      head: row.head,
      fingerprint: row.fingerprint,
      builtAt: Number(row.built_at),
      windowSince: Number(row.window_since),
      commitCount: Number(row.commit_count),
      bundleCount: Number(row.bundle_count),
      admittedBundleCount: Number(row.admitted_bundle_count),
      maxFilesPerBundle: Number(row.max_files_per_bundle),
      minSupport: Number(row.min_support),
      maxPartnersPerFile: Number(row.max_partners_per_file),
      admittedBurstCount: row.admitted_burst_count === null ? null : Number(row.admitted_burst_count),
      burstWindowMinutes: row.burst_window_minutes === null ? null : Number(row.burst_window_minutes),
      burstWindowMethod: burstWindowMethodOf(row.burst_window_method),
    };
  }

  /**
   * Every stored pair, each flagged with whether a `cg_symbols_edges_file` row
   * or a RESOLVED `cg_symbols_edges_method` row joins its endpoints in either
   * direction. Method edges count on their own: 41% of this project's
   * cross-file call pairs have no file edge (see `readFileDependencyGraph`), and
   * a call is a structural link whatever the import graph says.
   *
   * An import of a barrel also links the importer to every file the barrel
   * RE-EXPORTS, through a chain of barrels (bd tea-rags-mcp-b4dcz): importing
   * `index.ts` that forwards `impl.ts` loads `impl.ts`, and on the self-index
   * 90 stored pairs are joined only that way. What a barrel merely imports for
   * itself is not forwarded. The closure is taken over re-export edges alone
   * (the barrel graph, small) and joined only for importers that have a
   * co-change row, so its cost does not grow with the whole import graph.
   *
   * A type-only import links too (bd tea-rags-mcp-r8hme.12, and since bd
   * tea-rags-mcp-89k7k.31 it is a regular `cg_symbols_edges_file` row reading
   * callWeight 0, so the first UNION arm already covers it). The dedicated
   * `cg_symbols_edges_file_type_only` arm stays for indexes walked before that
   * change and is a no-op subset under UNION once both tables carry the edge:
   * a declared type dependency is structure either way — the daemon server
   * consumes its wire protocol only through `import type`.
   */
  async readGraph(): Promise<TemporalCochangeGraph> {
    const meta = await this.readMeta();
    const rows = await this.session.queryAll<EdgeRow>(
      `WITH RECURSIVE reexport_reach(barrel, target, depth) AS (
         SELECT source_rel_path, target_rel_path, 1 FROM cg_symbols_edges_file
         WHERE reexported_export_names IS NOT NULL
         UNION
         SELECT r.barrel, e.target_rel_path, r.depth + 1
         FROM reexport_reach r
         JOIN cg_symbols_edges_file e ON e.source_rel_path = r.target AND e.reexported_export_names IS NOT NULL
         WHERE r.depth < ${REEXPORT_CHAIN_LIMIT}
       ),
       links AS (
         SELECT source_rel_path AS x, target_rel_path AS y FROM cg_symbols_edges_file
         UNION
         SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file_type_only
         UNION
         SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL
         UNION
         SELECT f.source_rel_path, r.target
         FROM cg_symbols_edges_file f
         JOIN reexport_reach r ON r.barrel = f.target_rel_path
         WHERE f.source_rel_path IN (SELECT rel_path FROM cg_temporal_files)
       ),
       undirected AS (
         SELECT DISTINCT LEAST(x, y) AS a, GREATEST(x, y) AS b FROM links WHERE x <> y
       )
       SELECT c.rel_path_a, c.rel_path_b, c.support, c.confidence_ab, c.confidence_ba, c.lift,
              c.last_co_change_at, c.sample_commits, (u.a IS NOT NULL) AS structurally_linked
       FROM cg_temporal_edges_cochange c
       LEFT JOIN undirected u ON u.a = c.rel_path_a AND u.b = c.rel_path_b
       ORDER BY c.rel_path_a, c.rel_path_b`,
    );
    return {
      meta,
      edges: rows.map(edgeFromRow),
      bundles: await this.readBundleFiles(),
      bundleCommits: await this.readBundleCommits(),
      bundleBursts: await this.readBundleBursts(),
      bundleTaskIds: await this.readBundleTaskIds(),
      bundleFileLines: await this.readBundleFileLines(),
      bundleTimestamps: await this.readBundleTimestamps(),
    };
  }

  /**
   * Each admitted bundle's per-file +/- line counts, keyed by bundle id then
   * path (bd tea-rags-mcp-dm61n); a file whose counts were not recorded is
   * absent. Empty on a build that predates migration 046 — a READ_ONLY attach
   * never migrates, so a file without the columns reads as not recorded.
   */
  async readBundleFileLines(): Promise<ReadonlyMap<number, ReadonlyMap<RelPath, CochangeFileLineCounts>>> {
    const columns = await this.columnsOf("cg_temporal_bundle_files", ["lines_added", "lines_deleted"]);
    if (!columns.has("lines_added") || !columns.has("lines_deleted")) return new Map();
    const rows = await this.session.queryAll<{
      bundle_id: number;
      rel_path: string;
      lines_added: number;
      lines_deleted: number;
    }>(
      `SELECT bundle_id, rel_path, lines_added, lines_deleted FROM cg_temporal_bundle_files
        WHERE lines_added IS NOT NULL AND lines_deleted IS NOT NULL ORDER BY bundle_id, rel_path`,
    );
    const lines = new Map<number, Map<RelPath, CochangeFileLineCounts>>();
    for (const row of rows) {
      const bundleId = Number(row.bundle_id);
      let files = lines.get(bundleId);
      if (!files) {
        files = new Map();
        lines.set(bundleId, files);
      }
      files.set(row.rel_path, { added: Number(row.lines_added), deleted: Number(row.lines_deleted) });
    }
    return lines;
  }

  /**
   * The admitted bundles' file memberships, keyed by bundle id (bd
   * tea-rags-mcp-c3v6o) — ordered by bundle then path, so a bundle's list is
   * stable whatever the write batched. An empty map is a build that admitted
   * no bundle (or no build at all): the report's split/merge block reads that
   * as not built, never as clean verdicts.
   */
  async readBundleFiles(): Promise<ReadonlyMap<number, readonly RelPath[]>> {
    const rows = await this.session.queryAll<BundleFileRow>(
      "SELECT bundle_id, rel_path FROM cg_temporal_bundle_files ORDER BY bundle_id, rel_path",
    );
    const bundles = new Map<number, RelPath[]>();
    for (const row of rows) {
      const files = bundles.get(row.bundle_id);
      if (files) files.push(row.rel_path);
      else bundles.set(row.bundle_id, [row.rel_path]);
    }
    return bundles;
  }

  /**
   * Each admitted bundle's commit SHAs, keyed by bundle id (bd
   * tea-rags-mcp-89k7k.1.14) — how a review drops its own commits from the
   * history. Empty on a build that predates migration 043.
   */
  async readBundleCommits(): Promise<ReadonlyMap<number, readonly string[]>> {
    const rows = await this.session.queryAll<{ bundle_id: number; commit_shas: string }>(
      "SELECT bundle_id, commit_shas FROM cg_temporal_bundle_commits ORDER BY bundle_id",
    );
    return new Map(rows.map((row) => [Number(row.bundle_id), JSON.parse(row.commit_shas) as string[]]));
  }

  /**
   * Each admitted bundle's author burst, keyed by bundle id (bd
   * tea-rags-mcp-3vg0x) — what the significance gate counts per. Empty on a
   * build that predates migration 044: a READ_ONLY attach never migrates, so a
   * newer build reads a file an older build's daemon owns exactly as that
   * build left it, and a file without the column reads as not recorded (bd
   * tea-rags-mcp-vyxjt).
   */
  async readBundleBursts(): Promise<ReadonlyMap<number, number>> {
    if (!(await this.columnsOf("cg_temporal_bundle_commits", ["burst_id"])).has("burst_id")) return new Map();
    const rows = await this.session.queryAll<{ bundle_id: number; burst_id: number }>(
      "SELECT bundle_id, burst_id FROM cg_temporal_bundle_commits WHERE burst_id IS NOT NULL ORDER BY bundle_id",
    );
    return new Map(rows.map((row) => [Number(row.bundle_id), Number(row.burst_id)]));
  }

  /**
   * Each admitted bundle's commit-message task ids, keyed by bundle id (bd
   * tea-rags-mcp-09c4m) — what joins a burst's commits into one logical
   * change. `[]` = the message named none; empty map = a build that predates
   * migration 045. A file without the column reads as not recorded: a
   * READ_ONLY attach never migrates, so a newer build reads a file an older
   * build's daemon owns exactly as that build left it.
   */
  async readBundleTaskIds(): Promise<ReadonlyMap<number, readonly string[]>> {
    if (!(await this.columnsOf("cg_temporal_bundle_commits", ["task_ids"])).has("task_ids")) return new Map();
    const rows = await this.session.queryAll<{ bundle_id: number; task_ids: string }>(
      "SELECT bundle_id, task_ids FROM cg_temporal_bundle_commits WHERE task_ids IS NOT NULL ORDER BY bundle_id",
    );
    return new Map(rows.map((row) => [Number(row.bundle_id), JSON.parse(row.task_ids) as string[]]));
  }

  /**
   * Each admitted bundle's commit time in unix seconds, keyed by bundle id (bd
   * tea-rags-mcp-zf9yz) — the chronology the shotgun lifecycle test orients
   * by; bundle ids are a storage order. Empty on a build that predates
   * migration 047: a file without the column reads as not recorded, as for
   * {@link readBundleTaskIds}.
   */
  async readBundleTimestamps(): Promise<ReadonlyMap<number, number>> {
    if (!(await this.columnsOf("cg_temporal_bundle_commits", ["committed_at"])).has("committed_at")) return new Map();
    const rows = await this.session.queryAll<{ bundle_id: number; committed_at: number | bigint }>(
      "SELECT bundle_id, committed_at FROM cg_temporal_bundle_commits WHERE committed_at IS NOT NULL ORDER BY bundle_id",
    );
    return new Map(rows.map((row) => [Number(row.bundle_id), Number(row.committed_at)]));
  }

  /** Which of `columns` the table holds - the guard for columns a later migration added. */
  private async columnsOf(table: string, columns: readonly string[]): Promise<ReadonlySet<string>> {
    const rows = await this.session.queryAll<{ column_name: string }>(
      `SELECT column_name FROM duckdb_columns()
        WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ?`,
      [table],
    );
    return new Set(rows.map((r) => r.column_name).filter((name) => columns.includes(name)));
  }
}

/** A stored method, `null` for a row predating it (or a value this build does not know). */
function burstWindowMethodOf(stored: string | null): CochangeBurstWindowMethod | null {
  return stored === "estimated" || stored === "fallback" ? stored : null;
}

function edgeRow(e: TemporalCochangeEdge): unknown[] {
  return [
    e.relPathA,
    e.relPathB,
    e.support,
    e.confidenceAB,
    e.confidenceBA,
    e.lift,
    e.lastCoChangeAt,
    JSON.stringify(e.sampleCommits),
  ];
}

function edgeFromRow(r: EdgeRow): TemporalCochangeEdgeWithLinkage {
  return {
    relPathA: r.rel_path_a,
    relPathB: r.rel_path_b,
    support: Number(r.support),
    confidenceAB: Number(r.confidence_ab),
    confidenceBA: Number(r.confidence_ba),
    lift: Number(r.lift),
    lastCoChangeAt: Number(r.last_co_change_at),
    sampleCommits: JSON.parse(r.sample_commits) as string[],
    structurallyLinked: Boolean(r.structurally_linked),
  };
}
