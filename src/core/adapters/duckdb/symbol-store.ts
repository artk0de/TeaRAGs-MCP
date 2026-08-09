/**
 * Persistence for `cg_symbols` — the disk-backed copy of the in-memory
 * `GlobalSymbolTable` that lets a cold start or a partial reindex hydrate
 * without re-walking every file.
 *
 * Writes replace a file's symbols wholesale (DELETE+INSERT in one transaction,
 * so a partial failure leaves either the full new set or the previous one), and
 * `chunk_id` is the one column written separately: it is not part of a
 * definition, it is backfilled once chunking has produced ids. The row codec
 * itself lives in `cg-symbols-row.ts`, shared with the hydration SELECT.
 */

import type {
  BulkSymbolUpsertEntry,
  RelPath,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import {
  CG_SYMBOLS_DEF_COLUMNS,
  CG_SYMBOLS_DEF_INSERT_SQL,
  fromCgSymbolsRow,
  toCgSymbolsRow,
  type CgSymbolsRow,
} from "./cg-symbols-row.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import { escapeLikeLiteral } from "./sql-binding.js";
import { lastNameSegment } from "./symbol-id-text.js";

export class DuckDbSymbolStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    // DELETE+INSERT inside a transaction so a partial failure leaves
    // either the full new set or the previous set — never a mix. Empty
    // definitions list clears the file (idempotent with handleDeletedPaths).
    //
    // INSERT OR IGNORE because the walker can legitimately emit the same
    // symbolId twice for one file: TypeScript get/set accessor pairs,
    // function overload signatures sharing a name, and other language
    // patterns where multiple AST nodes contribute to the same logical
    // identifier. The PK (rel_path, symbol_id) is identity, not
    // occurrence count — first row wins.
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      for (const def of definitions) {
        await this.session.run(CG_SYMBOLS_DEF_INSERT_SQL, toCgSymbolsRow(def));
      }
    });
  }

  /**
   * Batched form of {@link upsertSymbols}: one transaction for many files
   * instead of one BEGIN/COMMIT per file. Equivalent to calling
   * `upsertSymbols(relPath, definitions)` once per entry, in order — so a
   * later entry for the same relPath fully REPLACES an earlier one (last-wins
   * per relPath, matching sequential DELETE+INSERT). Empty `entries` is a
   * no-op.
   */
  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // Same DELETE+INSERT-inside-a-transaction contract as upsertSymbols,
    // just spanning every file in the batch instead of one.
    //
    // A batch may legitimately carry TWO entries for the SAME relPath. The
    // contract is "== calling upsertSymbols(relPath, defs) once per entry, in
    // order" — and sequential per-file upsert is DELETE+INSERT, so a later
    // entry for a file fully REPLACES an earlier one (the second call's DELETE
    // wipes the first's rows). Collapse by relPath keeping LAST-wins BEFORE
    // touching the DB so this holds: each distinct relPath is deleted once and
    // only its final entry's definitions are inserted — never a union of both
    // (a union would leak the superseded entry's rows through INSERT OR IGNORE).
    // Distinct relPaths never share a PK, so cross-file rows never interfere.
    //
    // Within a single surviving entry, INSERT OR IGNORE still preserves
    // first-wins on a duplicate symbolId: row build order iterates definitions
    // in declaration order, so the first occurrence of a (rel_path, symbol_id)
    // pair lands first in the batched VALUES list (see insertOrIgnoreBatched's
    // doc comment for why duplicate-PK rows within one statement are
    // first-row-wins).
    const lastByRelPath = new Map<RelPath, SymbolDefinition[]>();
    for (const { relPath, definitions } of entries) {
      lastByRelPath.set(relPath, definitions);
    }
    return this.session.transaction(async () => {
      for (const relPath of lastByRelPath.keys()) {
        await this.session.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      }
      const rows: unknown[][] = [];
      for (const definitions of lastByRelPath.values()) {
        for (const def of definitions) rows.push(toCgSymbolsRow(def));
      }
      await this.session.insertOrIgnoreBatched("cg_symbols", CG_SYMBOLS_DEF_COLUMNS, rows);
    });
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

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    if (chunkIds.size === 0) return;
    return this.session.transaction(async () => {
      for (const [symbolId, chunkId] of chunkIds) {
        await this.session.run("UPDATE cg_symbols SET chunk_id = ? WHERE rel_path = ? AND symbol_id = ?", [
          chunkId,
          relPath,
          symbolId,
        ]);
      }
    });
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
