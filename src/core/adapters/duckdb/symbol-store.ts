/**
 * Persistence for `cg_symbols` — the disk-backed copy of the in-memory
 * `GlobalSymbolTable` that lets a cold start or a partial reindex hydrate
 * without re-walking every file.
 *
 * Writes make a file's symbols EQUAL the walk's output, expressed as a row diff
 * inside one transaction (so a partial failure leaves either the full new set or
 * the previous one), and `chunk_id` is the one column written separately: it is
 * not part of a definition, it is backfilled once chunking has produced ids. The
 * row codec itself lives in `cg-symbols-row.ts`, shared with the hydration
 * SELECT.
 */

import type {
  BulkSymbolUpsertEntry,
  PersistedSymbolLineRanges,
  RelPath,
  SymbolChunkIdJoinEntry,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import {
  CG_SYMBOLS_DEF_COLUMNS,
  CG_SYMBOLS_KEY_COLUMNS,
  CG_SYMBOLS_VALUE_COLUMNS,
  fromCgSymbolsRow,
  toCgSymbolsRow,
  type CgSymbolsRow,
} from "./cg-symbols-row.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { escapeLikeLiteral } from "./sql-binding.js";
import { lastNameSegment } from "./symbol-id-text.js";

/**
 * Paths per `IN (…)` list of {@link DuckDbSymbolStore.getSymbolLineRangesBulk}.
 * The same bound the session's batched writers use: DuckDB plans a long literal
 * list as one wide filter, and the caller's own batch (2 000 on the heal path)
 * would otherwise become a single 2 000-parameter statement.
 */
const SYMBOL_LINE_RANGE_READ_CHUNK = 200;

export class DuckDbSymbolStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    // One file is the degenerate batch. Routing it through the bulk path keeps a
    // single write SHAPE for cg_symbols: two shapes on one table means the
    // chunk_id contract (below) holds on one of them and silently not the other.
    return this.upsertSymbolsBulk([{ relPath, definitions }]);
  }

  /**
   * Make `cg_symbols` equal the walk's output for every file the batch names,
   * in one transaction. Equivalent to calling
   * `upsertSymbols(relPath, definitions)` once per entry, in order — so a later
   * entry for the same relPath fully REPLACES an earlier one (last-wins per
   * relPath). Empty `entries` is a no-op; an entry with empty `definitions`
   * clears its file.
   */
  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // A batch may legitimately carry TWO entries for the SAME relPath. The
    // contract is "== calling upsertSymbols(relPath, defs) once per entry, in
    // order", and a per-file upsert REPLACES that file's rows — so a later entry
    // for a file supersedes an earlier one rather than unioning with it.
    // Collapse by relPath keeping LAST-wins BEFORE touching the DB, so the diff
    // reconciles each distinct relPath against its final entry's definitions
    // only. Distinct relPaths never share a PK, so cross-file rows never
    // interfere.
    const lastByRelPath = new Map<RelPath, SymbolDefinition[]>();
    for (const { relPath, definitions } of entries) {
      lastByRelPath.set(relPath, definitions);
    }
    const rows: unknown[][] = [];
    for (const definitions of lastByRelPath.values()) {
      for (const def of definitions) rows.push(toCgSymbolsRow(def));
    }
    return this.session.transaction(async () =>
      // A DIFF, not a DELETE+re-INSERT of the same keys (bd tea-rags-mcp-tslvq).
      // Two reasons, and the first is a crash:
      //
      //  - DuckDB's commit path is not exception-safe for a transaction whose
      //    delete set and insert set share a key; a failed commit re-appends the
      //    deleted rows onto keys the same transaction inserted and abort()s the
      //    process from native code. `applyScopedRowDiff`'s docblock carries the
      //    mechanism and the nine daemon deaths it caused on 2026-08-17.
      //  - A recompute re-walks files whose symbols did not move, and the INSERT
      //    floor is ~16k rows/s, so it re-wrote rows it already had. The diff
      //    leaves them physically untouched. Warm drain of
      //    `scripts/spikes/node-drain-profile.ts`, 4 000 files / 100k rows, at
      //    the live cadence of 256: 21 612ms set-based DELETE against 3 345ms.
      //
      // Duplicate symbolIds within one file stay FIRST-wins — the walker can
      // legitimately emit one twice (TS get/set accessor pairs, overload
      // signatures), and the PK is identity, not occurrence count.
      //
      // `chunk_id` is outside both the key and the value columns, so an
      // unchanged row keeps the join the deferred chunk pass wrote. Retiring a
      // stale join is that pass's own job — see `updateSymbolChunkIdsBulk`.
      this.session.applyScopedRowDiff(
        "cg_symbols",
        "rel_path",
        [...lastByRelPath.keys()],
        CG_SYMBOLS_KEY_COLUMNS,
        CG_SYMBOLS_VALUE_COLUMNS,
        rows,
      ),
    );
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    // Single DELETE is atomic by itself, but still routed through the
    // write queue so it can't interleave with an in-flight BEGIN/COMMIT
    // on the shared connection.
    return this.session.serialize(async () => this.session.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]));
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    const rows = await this.session.queryAll<CgSymbolsRow>(
      `SELECT ${CG_SYMBOLS_DEF_COLUMNS.join(", ")} FROM cg_symbols`,
    );
    return rows.map(fromCgSymbolsRow);
  }

  /**
   * REPLACE one file's symbol → covering-chunk join. Naming the file is what
   * retires the joins of its symbols the fresh map no longer covers — see
   * {@link updateSymbolChunkIdsBulk}, whose contract this is the one-file case
   * of.
   */
  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    return this.updateSymbolChunkIdsBulk([{ relPath, chunkIds }]);
  }

  /**
   * Whole-pass form of {@link updateSymbolChunkIds}. The deferred chunk pass
   * resolves the join for every file at once, so it writes it at once: one
   * transaction of chunked set-based statements instead of one transaction —
   * and, behind the daemon, one socket round-trip — per file
   * (bd tea-rags-mcp-6aytq).
   *
   * REPLACE, not merge, per file the call NAMES (bd tea-rags-mcp-tslvq): every
   * named file's chunk_id is cleared first, then the collected mapping applied.
   * That guarantee used to come from the writer above — `upsertSymbols` deleted
   * and re-inserted a file's rows, so a re-walked symbol always arrived with
   * chunk_id NULL and this pass only ever filled values in. `upsertSymbolsBulk`
   * is a row diff now and leaves an unchanged row alone, chunk_id included, so
   * the guarantee moves here, to the pass that owns the column and is the only
   * one that knows the fresh mapping. A symbol whose covering chunk moved out
   * from under it between runs still ends NULL rather than pointing at a chunk
   * that no longer contains it.
   *
   * Both halves are set-based and share the transaction, so no reader observes
   * the intermediate all-NULL state. Naming a file with an EMPTY map is
   * therefore meaningful: it says "re-derived, nothing covers it".
   *
   * A file the entries never name is untouched — an incremental pass re-derives
   * only the chunks it re-chunked, and every other file's join is still valid.
   *
   * Duplicate (relPath, symbolId) pairs are collapsed LAST-WINS here, in a map
   * keyed per file, rather than left to the statement: DuckDB does not define
   * which of two colliding VALUES rows an `UPDATE … FROM` applies. Collapsing
   * reproduces what sequential per-file calls did.
   */
  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lastByFile = new Map<RelPath, Map<SymbolId, string>>();
    for (const { relPath, chunkIds } of entries) {
      let perFile = lastByFile.get(relPath);
      if (perFile === undefined) {
        perFile = new Map<SymbolId, string>();
        lastByFile.set(relPath, perFile);
      }
      for (const [symbolId, chunkId] of chunkIds) perFile.set(symbolId, chunkId);
    }
    const rows: [string, string, string][] = [];
    for (const [relPath, perFile] of lastByFile) {
      for (const [symbolId, chunkId] of perFile) rows.push([relPath, symbolId, chunkId]);
    }
    return this.session.transaction(async () => {
      // Clear EVERY named file before applying ANY row: the clear is scoped by
      // rel_path and the apply is keyed by (rel_path, symbol_id), so the two
      // must not interleave per chunk — a mapping row in an early chunk would
      // otherwise be wiped by a clear in a later one.
      await this.session.clearColumnByScopeValuesBatched("cg_symbols", "chunk_id", "rel_path", [...lastByFile.keys()]);
      await this.session.updateFromRows("cg_symbols", ["rel_path", "symbol_id"], ["chunk_id"], rows);
    });
  }

  /**
   * Each requested file's symbol ranges as `cg_symbols` holds them (bd
   * tea-rags-mcp-9i2ow): every RANGED row, plus the count of rows whose range is
   * NULL — written before migration 024. Those rows are counted, not dropped:
   * "rows the chunk-owner rule cannot place" and "no rows" settle differently
   * (bd tea-rags-mcp-39xca.2). A path with no row at all is absent.
   */
  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    const out = new Map<RelPath, PersistedSymbolLineRanges>();
    for (let i = 0; i < relPaths.length; i += SYMBOL_LINE_RANGE_READ_CHUNK) {
      const chunk = relPaths.slice(i, i + SYMBOL_LINE_RANGE_READ_CHUNK);
      const rows = await this.session.queryAll<{
        rel_path: string;
        symbol_id: string;
        start_line: number | null;
        end_line: number | null;
      }>(
        `SELECT rel_path, symbol_id, start_line, end_line FROM cg_symbols
           WHERE rel_path IN (${chunk.map(() => "?").join(", ")})`,
        [...chunk],
      );
      for (const row of rows) {
        let file = out.get(row.rel_path);
        if (file === undefined) {
          file = { ranges: [], rowsWithoutRanges: 0 };
          out.set(row.rel_path, file);
        }
        if (row.start_line === null || row.end_line === null) {
          file.rowsWithoutRanges++;
          continue;
        }
        file.ranges.push({ symbolId: row.symbol_id, startLine: Number(row.start_line), endLine: Number(row.end_line) });
      }
    }
    return out;
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    // Tier 1 — exact symbol_id match (the canonical fast path, indexed).
    const exact = await this.session.queryAll<{ rel_path: string; chunk_id: string | null }>(
      "SELECT rel_path, chunk_id FROM cg_symbols WHERE symbol_id = ? AND chunk_id IS NOT NULL LIMIT 1",
      [symbolId],
    );
    if (exact.length > 0) return { relPath: exact[0].rel_path, chunkId: exact[0].chunk_id as string };

    // Tier 2 — last-name-segment fallback. Rails DSL-defined symbols
    // (`scope`/`has_many`/`delegate`) are minted in cg_symbols under their
    // concern/module FQN (e.g. `Account::Suspensions.suspended`), but the
    // covering body chunk's payload symbolId is the parent module — so the
    // Qdrant scroll AND the exact tier above both miss a bare ("suspended") or
    // host-class ("Account.suspended") query. Resolve by the query's trailing
    // name segment so the symbol's already-joined chunk (and its edges) surface
    // via the symbol-API. Mirrors the bare-name last-segment match the Qdrant
    // SymbolSearchStrategy applies for `def` methods. See bd tea-rags-mcp-mtlhd.
    const tail = lastNameSegment(symbolId);
    if (tail.length === 0) return null;
    const likeTail = escapeLikeLiteral(tail);
    const bySegment = await this.session.queryAll<{ rel_path: string; chunk_id: string | null }>(
      `SELECT rel_path, chunk_id FROM cg_symbols
         WHERE chunk_id IS NOT NULL
           AND ( symbol_id = ?
              OR symbol_id LIKE ? ESCAPE '\\'
              OR symbol_id LIKE ? ESCAPE '\\'
              OR symbol_id LIKE ? ESCAPE '\\' )
         ORDER BY symbol_id
         LIMIT 1`,
      [tail, `%.${likeTail}`, `%#${likeTail}`, `%::${likeTail}`],
    );
    if (bySegment.length === 0) return null;
    return { relPath: bySegment[0].rel_path, chunkId: bySegment[0].chunk_id as string };
  }
}
