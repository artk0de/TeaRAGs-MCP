/**
 * In-memory implementation of the `GlobalSymbolTable` contract.
 *
 * Used by `TSCallResolver` (slice 1 T6) to look up call targets across
 * files, and populated by `CodegraphEnrichmentProvider` (T7) from
 * `FileExtraction.chunks[].symbolId`.
 *
 * Indexing strategy: three coupled maps so both lookups (`lookup` by
 * fully-qualified name, `lookupByShortName`) are O(1), and removal
 * (`removeFile`) is cheap (delete one per-file entry, then remove its
 * definitions from the two reverse indexes).
 *
 * No synchronisation primitives: the codegraph provider buffers
 * extractions in a single async chain (`asExtractionSink().write` ->
 * `finish`), so callers run sequentially on one event-loop turn at a
 * time. Slice 2 may add fine-grained locking if a chunked-flush variant
 * lands.
 */

import type { GlobalSymbolTable, RelPath, SymbolDefinition } from "../../../../contracts/types/codegraph.js";

export class InMemoryGlobalSymbolTable implements GlobalSymbolTable {
  /** fqName -> definitions across files (multiple = monkey-patched module). */
  private readonly byFq = new Map<string, SymbolDefinition[]>();
  /** shortName -> definitions across files. */
  private readonly byShort = new Map<string, SymbolDefinition[]>();
  /** relPath -> definitions, for cheap removal on re-upsert. */
  private readonly byFile = new Map<RelPath, SymbolDefinition[]>();

  upsertFile(relPath: RelPath, definitions: SymbolDefinition[]): void {
    this.removeFile(relPath);
    if (definitions.length === 0) return;
    this.byFile.set(relPath, definitions.slice());
    for (const def of definitions) {
      pushTo(this.byFq, def.fqName, def);
      pushTo(this.byShort, def.shortName, def);
    }
  }

  removeFile(relPath: RelPath): void {
    const existing = this.byFile.get(relPath);
    if (!existing) return;
    this.byFile.delete(relPath);
    for (const def of existing) {
      removeFrom(this.byFq, def.fqName, def);
      removeFrom(this.byShort, def.shortName, def);
    }
  }

  lookup(fqName: string): SymbolDefinition[] {
    return (this.byFq.get(fqName) ?? []).slice();
  }

  lookupByShortName(name: string): SymbolDefinition[] {
    return (this.byShort.get(name) ?? []).slice();
  }

  size(): number {
    let n = 0;
    for (const defs of this.byFile.values()) n += defs.length;
    return n;
  }

  /**
   * Bulk-load definitions, typically from `GraphDbClient.listAllSymbols`
   * on cold start. Groups by `relPath` and calls `upsertFile` once per
   * file so the existing identity-chain invariants in `byFq`/`byShort`
   * are preserved. Definitions for a file already in memory get
   * overwritten (this is the same semantics as `upsertFile` which
   * removes existing entries first).
   */
  hydrate(definitions: SymbolDefinition[]): void {
    if (definitions.length === 0) return;
    const grouped = new Map<RelPath, SymbolDefinition[]>();
    for (const def of definitions) {
      const arr = grouped.get(def.relPath);
      if (arr) arr.push(def);
      else grouped.set(def.relPath, [def]);
    }
    for (const [relPath, defs] of grouped) {
      this.upsertFile(relPath, defs);
    }
  }
}

function pushTo(map: Map<string, SymbolDefinition[]>, key: string, def: SymbolDefinition): void {
  const arr = map.get(key);
  if (arr) arr.push(def);
  else map.set(key, [def]);
}

function removeFrom(map: Map<string, SymbolDefinition[]>, key: string, def: SymbolDefinition): void {
  const arr = map.get(key);
  if (!arr) return;
  // Identity-first match (same object) falls back to a structural match on
  // (relPath, symbolId) — sufficient because upsertFile carries the source
  // file's definitions over to both reverse indexes by reference, and
  // removeFile walks that same identity chain.
  const filtered = arr.filter((d) => d !== def && !(d.relPath === def.relPath && d.symbolId === def.symbolId));
  if (filtered.length === 0) map.delete(key);
  else map.set(key, filtered);
}
