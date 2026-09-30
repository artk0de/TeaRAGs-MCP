/**
 * The run-scoped symbol-commit buffer (bd tea-rags-mcp-3gz4f) — the contract
 * lives in `contracts/types/codegraph-temporal.ts`; this in-memory
 * implementation is what the composition root injects into the git provider
 * (absorbing walk results) and the temporal flush hook (draining).
 *
 * Union semantics on absorb are the whole point: one file's chunks arrive in
 * several batches, and only a union of per-batch symbol sets reconstructs the
 * full commit set of the file's current content.
 */

import type {
  RelPath,
  TemporalSymbolCommitBuffer,
  TemporalSymbolCommitFileSnapshot,
} from "../../../../../contracts/types/codegraph.js";

export class InMemoryTemporalSymbolCommitBuffer implements TemporalSymbolCommitBuffer {
  private readonly files = new Map<RelPath, Map<string, Set<string>>>();

  absorb(relPath: RelPath, symbols: ReadonlyMap<string, ReadonlySet<string>>): void {
    if (symbols.size === 0) return;
    let file = this.files.get(relPath);
    if (!file) {
      file = new Map();
      this.files.set(relPath, file);
    }
    for (const [symbolId, shas] of symbols) {
      const seen = file.get(symbolId);
      if (!seen) {
        file.set(symbolId, new Set(shas));
      } else {
        for (const sha of shas) seen.add(sha);
      }
    }
  }

  drainFiles(): TemporalSymbolCommitFileSnapshot[] {
    const snapshots = [...this.files.entries()].map(([relPath, symbols]) => ({
      relPath,
      symbols: [...symbols.entries()].map(([symbolId, shas]) => ({ symbolId, commitShas: [...shas] })),
    }));
    this.files.clear();
    return snapshots;
  }
}
