/**
 * The temporal symbol-commit store (bd tea-rags-mcp-3gz4f) —
 * `cg_temporal_symbol_commits`, the temporal sub-graph's symbol-level half.
 *
 * Unlike the file-level tables, rows are replaced PER FILE, never wholesale:
 * a file's rows are a function of its own last walk, so an incremental run
 * replaces exactly the files it re-walked and leaves the rest standing.
 */

import type { TemporalSymbolCommitFileSnapshot } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

interface Row {
  rel_path: string;
  symbol_id: string;
  commit_shas: string;
}

export class DuckDbTemporalSymbolCommitStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /**
   * Replace each file's rows with the snapshot's symbols, in one transaction.
   * Files not named in the batch are untouched — a flush names only the files
   * the run actually re-walked.
   */
  async replaceFiles(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    if (files.length === 0) return;
    await this.session.transaction(async () => {
      for (const { relPath, symbols } of files) {
        await this.session.run("DELETE FROM cg_temporal_symbol_commits WHERE rel_path = ?", [relPath]);
        if (symbols.length === 0) continue;
        await this.session.insertBatched(
          "cg_temporal_symbol_commits",
          ["rel_path", "symbol_id", "commit_shas"],
          symbols.map((s) => [relPath, s.symbolId, JSON.stringify(s.commitShas)]),
        );
      }
    });
  }

  /** Every file that has rows — the universe the hook prunes gone files against. */
  async storedFilePaths(): Promise<string[]> {
    const rows = await this.session.queryAll<{ rel_path: string }>(
      "SELECT DISTINCT rel_path FROM cg_temporal_symbol_commits ORDER BY rel_path",
    );
    return rows.map((r) => r.rel_path);
  }

  /** Drop every row of the named files (deleted from the live set). */
  async deleteFiles(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return;
    await this.session.transaction(async () => {
      for (const relPath of relPaths) {
        await this.session.run("DELETE FROM cg_temporal_symbol_commits WHERE rel_path = ?", [relPath]);
      }
    });
  }

  /** One file's rows, `commit_shas` parsed — the read side's per-file slice. */
  async readFile(relPath: string): Promise<TemporalSymbolCommitFileSnapshot> {
    const rows = await this.session.queryAll<Row>(
      "SELECT rel_path, symbol_id, commit_shas FROM cg_temporal_symbol_commits WHERE rel_path = ? ORDER BY symbol_id",
      [relPath],
    );
    return {
      relPath,
      symbols: rows.map((r) => ({ symbolId: r.symbol_id, commitShas: JSON.parse(r.commit_shas) as string[] })),
    };
  }
}
