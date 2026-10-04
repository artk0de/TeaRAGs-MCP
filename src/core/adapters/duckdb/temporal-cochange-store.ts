/**
 * The temporal co-change store (bd tea-rags-mcp-x4rpp) — `cg_temporal_files`,
 * `cg_temporal_edges_cochange`, `cg_temporal_meta` (migration 031) and
 * `cg_temporal_bundle_files` (bd tea-rags-mcp-c3v6o, migration 042).
 *
 * Pure CRUD, like the analytics store: the extractor that computes the graph
 * and every judgement over it live in `domains/trajectory/codegraph/temporal/`.
 * The one join done here — whether the structural graph links a pair's
 * endpoints — is a read of the edge tables, not a judgement: the detector
 * decides what an unlinked pair means.
 */

import type {
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
  session_gap_minutes: number | null;
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
    const { meta, files, edges, bundles } = snapshot;
    await this.session.transaction(async () => {
      await this.session.recreateEmptyTable("cg_temporal_files");
      await this.session.recreateEmptyTable("cg_temporal_edges_cochange");
      await this.session.recreateEmptyTable("cg_temporal_meta");
      await this.session.recreateEmptyTable("cg_temporal_bundle_files");
      await this.session.insertBatched(
        "cg_temporal_files",
        ["rel_path", "bundle_count", "partner_count", "last_changed_at"],
        files.map((f) => [f.relPath, f.bundleCount, f.partnerCount, f.lastChangedAt]),
      );
      await this.session.insertBatched("cg_temporal_edges_cochange", EDGE_COLUMNS, edges.map(edgeRow));
      await this.session.insertBatched(
        "cg_temporal_bundle_files",
        ["bundle_id", "rel_path"],
        bundles.flatMap((filesOfBundle, bundleId) => filesOfBundle.map((relPath) => [bundleId, relPath])),
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
          "session_gap_minutes",
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
            meta.sessionGapMinutes,
          ],
        ],
      );
    });
  }

  /** The provenance row, or `null` before the first build. */
  async readMeta(): Promise<TemporalCochangeBuildMeta | null> {
    const [row] = await this.session.queryAll<MetaRow>(
      `SELECT head, fingerprint, built_at, window_since, commit_count, bundle_count, admitted_bundle_count,
              max_files_per_bundle, min_support, max_partners_per_file, session_gap_minutes
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
      sessionGapMinutes: row.session_gap_minutes === null ? null : Number(row.session_gap_minutes),
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
   * A type-only import links too (bd tea-rags-mcp-r8hme.12). It is no runtime
   * dependency, so it is kept out of `cg_symbols_edges_file`, but a declared
   * type dependency is structure: the daemon server consumes its wire protocol
   * only through `import type`, and without `cg_symbols_edges_file_type_only`
   * that pair ranked among the strongest silent couplings.
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
    return { meta, edges: rows.map(edgeFromRow), bundles: await this.readBundleFiles() };
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
