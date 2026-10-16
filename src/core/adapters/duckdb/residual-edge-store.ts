/**
 * Residual call sites and the model edges applied over them (bd
 * tea-rags-mcp-2m83f) — the graph-DB half of the residual pass.
 *
 * Model edges live in `cg_symbols_edges_method` beside the static ones
 * (migration 054: `origin = 'model'`, `model`, `p`, `site_key`; NULL origin =
 * static). They are replaced per model through `applyScopedRowDiff` scoped by
 * the `model` column, so a static row (model NULL) is never in scope. The
 * static re-walk (`DuckDbFileGraphStore#writeFileRowsGroup`) diffs by
 * `source_rel_path` and writes NULL provenance: a re-walked file drops its
 * model rows, a statically proven model key turns back into a static edge, and
 * an untouched file keeps its model rows.
 *
 * A model call between two files no import links also adds a file edge
 * (migration 056: `cg_symbols_edges_file.origin = 'model'`), so file-scope
 * lookups, file fan and the layout see the dependency. Those rows are rebuilt
 * from the model method edges on every apply; the re-walk drops them with the
 * file's other edges, and an import it finds replaces them.
 */
import type {
  CodegraphResidualEdgeStore,
  ModelEdgeApplyResult,
  ModelEdgeRow,
  ModelResolvedSiteCount,
  ResidualCallSiteRow,
  ResidualKind,
  ResidualReason,
} from "../../contracts/types/codegraph.js";
import { METHOD_EDGE_KEYS, METHOD_EDGE_VALUES } from "./file-graph-store.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { placeholders } from "./sql-binding.js";

/** Values per `IN (…)` list — the bound the session's batched writers use. */
const RESIDUAL_IN_LIST_CHUNK = 200;

interface ResidualSiteDbRow {
  site_key: string;
  source_rel_path: string;
  method_symbol_id: string;
  method_start_line: number | bigint;
  method_end_line: number | bigint;
  line: number | bigint;
  call_column: number | bigint;
  receiver_text: string;
  member: string;
  kind: string;
  candidates: string;
  menu_hash: string;
  menu_overflow: boolean;
  language: string | null;
  receiver_kind: string | null;
  reason: string | null;
}

interface ModelResolvedSiteCountDbRow {
  language: string | null;
  receiver_kind: string | null;
  kind: string;
  model: string;
  sites: number | bigint;
}

export class DuckDbResidualEdgeStore implements CodegraphResidualEdgeStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async readResidualCallSites(): Promise<ResidualCallSiteRow[]> {
    const rows = await this.session.queryAll<ResidualSiteDbRow>(
      `SELECT site_key, source_rel_path, method_symbol_id, method_start_line, method_end_line, line, call_column,
              receiver_text, member, kind, candidates, menu_hash, menu_overflow, language, receiver_kind, reason
         FROM cg_residual_call_sites ORDER BY source_rel_path, site_key`,
    );
    return rows.map((r) => ({
      siteKey: r.site_key,
      sourceRelPath: r.source_rel_path,
      methodSymbolId: r.method_symbol_id,
      methodStartLine: Number(r.method_start_line),
      methodEndLine: Number(r.method_end_line),
      line: Number(r.line),
      column: Number(r.call_column),
      receiverText: r.receiver_text,
      member: r.member,
      kind: r.kind as ResidualKind,
      candidates: JSON.parse(r.candidates) as string[],
      menuHash: r.menu_hash,
      menuOverflow: r.menu_overflow,
      ...(r.language === null ? {} : { language: r.language }),
      ...(r.receiver_kind === null ? {} : { receiverKind: r.receiver_kind }),
      ...(r.reason === null ? {} : { reason: r.reason as ResidualReason }),
    }));
  }

  /**
   * A site is resolved when a model edge holds its call: same method, file and
   * call text — the method-edge key, which one edge shares between sites making
   * the same call. Each site counts once, under the model of its most probable
   * edge.
   */
  async getModelResolvedSiteCounts(thresholds: Readonly<Record<string, number>>): Promise<ModelResolvedSiteCount[]> {
    const models = Object.entries(thresholds);
    const minP =
      models.length === 0
        ? "0"
        : `CASE e.model ${models.map(() => "WHEN ? THEN CAST(? AS DOUBLE)").join(" ")} ELSE 0 END`;
    const rows = await this.session.queryAll<ModelResolvedSiteCountDbRow>(
      `WITH resolved AS (
         SELECT r.language, r.receiver_kind, r.kind, arg_max(e.model, e.p) AS model
           FROM cg_residual_call_sites r
           JOIN cg_symbols_edges_method e
             ON e.origin = 'model'
            AND e.source_symbol_id = r.method_symbol_id
            AND e.source_rel_path = r.source_rel_path
            AND e.call_expression = CASE WHEN r.receiver_text = '' THEN r.member
                                         ELSE r.receiver_text || '.' || r.member END
            AND e.p >= ${minP}
          GROUP BY r.source_rel_path, r.site_key, r.language, r.receiver_kind, r.kind
       )
       SELECT language, receiver_kind, kind, model, COUNT(*) AS sites
         FROM resolved
        GROUP BY language, receiver_kind, kind, model
        ORDER BY language NULLS FIRST, receiver_kind NULLS FIRST, kind, model`,
      models.flatMap(([model, threshold]) => [model, threshold]),
    );
    return rows.map((r) => ({
      language: r.language,
      receiverKind: r.receiver_kind,
      kind: r.kind as ResidualKind,
      model: r.model,
      sites: Number(r.sites),
    }));
  }

  /**
   * Make the `model` rows of `cg_symbols_edges_method` equal `edges`. An edge
   * whose site is not a current residual row or whose target symbol is unknown
   * is skipped; one whose key a static edge already holds is ignored by the
   * diff's `INSERT OR IGNORE`. Reports what the model holds afterwards and
   * whether that differs from before, so the caller recomputes derived metrics
   * only when it does.
   */
  async applyModelEdges(model: string, edges: readonly ModelEdgeRow[]): Promise<ModelEdgeApplyResult> {
    return this.session.transaction(async () => {
      const before = await this.storedModelEdges(model);
      const callTexts = await this.callTextsBySite(edges.map((e) => e.siteKey));
      const targetPaths = await this.targetPathsBySymbol(edges.map((e) => e.targetSymbolId));
      const rows: unknown[][] = [];
      for (const e of edges) {
        const callExpression = callTexts.get(e.siteKey);
        const targetRelPath = targetPaths.get(e.targetSymbolId);
        if (callExpression === undefined || targetRelPath === undefined) continue;
        rows.push([
          e.sourceSymbolId,
          e.sourceRelPath,
          callExpression,
          targetRelPath,
          e.targetSymbolId,
          e.targetSymbolId,
          "exact",
          e.p,
          "model",
          model,
          e.p,
          e.siteKey,
        ]);
      }
      await this.session.applyScopedRowDiff(
        "cg_symbols_edges_method",
        "model",
        [model],
        METHOD_EDGE_KEYS,
        METHOD_EDGE_VALUES,
        rows,
      );
      await this.syncModelFileEdges();
      const after = await this.storedModelEdges(model);
      return { stored: after.length, changed: after.join("\n") !== before.join("\n") };
    });
  }

  /**
   * Make the model-derived rows of `cg_symbols_edges_file` equal the file pairs
   * the model method edges cross where no import edge does — over every model,
   * since a file edge belongs to no single one.
   */
  private async syncModelFileEdges(): Promise<void> {
    const modelPairs = `SELECT DISTINCT m.source_rel_path, m.target_rel_path
         FROM cg_symbols_edges_method m
        WHERE m.origin = 'model' AND m.target_symbol_id IS NOT NULL AND m.source_rel_path <> m.target_rel_path`;
    await this.session.run(
      `DELETE FROM cg_symbols_edges_file e
        WHERE e.origin = 'model'
          AND NOT EXISTS (SELECT 1 FROM (${modelPairs}) p
                           WHERE p.source_rel_path = e.source_rel_path AND p.target_rel_path = e.target_rel_path)`,
    );
    await this.session.run(
      `INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, origin)
       SELECT p.source_rel_path, p.target_rel_path, 'model' FROM (${modelPairs}) p
       ON CONFLICT DO NOTHING`,
    );
  }

  /** One sorted fingerprint (key and values) per stored edge of `model`. */
  private async storedModelEdges(model: string): Promise<string[]> {
    const columns = [...METHOD_EDGE_KEYS, ...METHOD_EDGE_VALUES];
    const rows = await this.session.queryAll<Record<string, unknown>>(
      `SELECT ${columns.join(", ")} FROM cg_symbols_edges_method WHERE model = ?`,
      [model],
    );
    return rows.map((r) => columns.map((c) => String(r[c])).join("\u0000")).sort();
  }

  /** `receiver.member` of each current residual site — `member` alone for an empty receiver. */
  private async callTextsBySite(siteKeys: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.queryInChunks<{ site_key: string; receiver_text: string; member: string }>(
      (list) => `SELECT site_key, receiver_text, member FROM cg_residual_call_sites WHERE site_key IN (${list})`,
      siteKeys,
    );
    return new Map(rows.map((r) => [r.site_key, r.receiver_text === "" ? r.member : `${r.receiver_text}.${r.member}`]));
  }

  /** The first file (by path) declaring each symbol id — a reopened class declares it in several. */
  private async targetPathsBySymbol(symbolIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.queryInChunks<{ symbol_id: string; rel_path: string }>(
      (list) =>
        `SELECT symbol_id, MIN(rel_path) AS rel_path FROM cg_symbols WHERE symbol_id IN (${list}) GROUP BY symbol_id`,
      symbolIds,
    );
    return new Map(rows.map((r) => [r.symbol_id, r.rel_path]));
  }

  private async queryInChunks<T>(sql: (list: string) => string, values: readonly string[]): Promise<T[]> {
    const unique = [...new Set(values)];
    const found: T[] = [];
    for (let i = 0; i < unique.length; i += RESIDUAL_IN_LIST_CHUNK) {
      const chunk = unique.slice(i, i + RESIDUAL_IN_LIST_CHUNK);
      found.push(...(await this.session.queryAll<T>(sql(placeholders(chunk)), chunk)));
    }
    return found;
  }
}
