/**
 * The intra-file mass-commit fence (bd tea-rags-mcp-3gz4f design point 1).
 *
 * The chunk walk carries NO mass-change cut: a formatter run, a rename sweep
 * or a mechanical refactor touches every method of a file, and every symbol
 * pair in it co-changes — A3 would read one giant cluster per file. The
 * read side draws the cut itself, inverting the stored symbol → commit sets:
 * a commit is as heavy as the number of the file's symbols it touched, and
 * the heavy tail of that distribution is cut with the temporal family's one
 * Tukey fence over log2 (`tukeyCutOverLog2`, the same math as the file-level
 * mass-change cut). Commits touching a single symbol never enter the sample —
 * they carry no pair and would pull the quartiles down, exactly like
 * single-file bundles at the file level.
 *
 * Pure function over one file's stored rows — the rows stay raw, the fence is
 * a read-side judgement and its parameters move without a re-flush.
 */

import type { TemporalSymbolCommitFileSnapshot } from "../../../../../contracts/types/codegraph.js";
import { tukeyCutOverLog2 } from "../cochange/index.js";

export interface FencedSymbolCommits {
  /** Symbol → surviving commits; symbols left with none are dropped whole. */
  readonly symbols: ReadonlyMap<string, ReadonlySet<string>>;
  /** Distinct commits the fence removed — reported as evidence, not silence. */
  readonly droppedCommits: number;
}

export function fenceMassCommits(rows: TemporalSymbolCommitFileSnapshot): FencedSymbolCommits {
  // Invert: commit → how many of the file's symbols it touched.
  const symbolsPerCommit = new Map<string, number>();
  for (const symbol of rows.symbols) {
    for (const sha of symbol.commitShas) symbolsPerCommit.set(sha, (symbolsPerCommit.get(sha) ?? 0) + 1);
  }

  const cut = tukeyCutOverLog2([...symbolsPerCommit.values()], {
    min: 2,
    max: Math.max(2, rows.symbols.length),
  });

  const symbols = new Map<string, Set<string>>();
  let droppedCommits = 0;
  for (const count of symbolsPerCommit.values()) {
    if (count > cut) droppedCommits += 1;
  }
  for (const symbol of rows.symbols) {
    const surviving = symbol.commitShas.filter((sha) => (symbolsPerCommit.get(sha) ?? 0) <= cut);
    if (surviving.length === 0) continue;
    symbols.set(symbol.symbolId, new Set(surviving));
  }
  return { symbols, droppedCommits };
}
