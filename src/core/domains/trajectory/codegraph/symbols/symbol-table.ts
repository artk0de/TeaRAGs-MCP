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

import type {
  GlobalSymbolTable,
  RelPath,
  SymbolDefinition,
  SymbolLookupOptions,
} from "../../../../contracts/types/codegraph.js";

export class InMemoryGlobalSymbolTable implements GlobalSymbolTable {
  /** fqName -> definitions across files (multiple = monkey-patched module). */
  private readonly byFq = new Map<string, SymbolDefinition[]>();
  /** shortName -> definitions across files. */
  private readonly byShort = new Map<string, SymbolDefinition[]>();
  /** relPath -> definitions, for cheap removal on re-upsert. */
  private readonly byFile = new Map<RelPath, SymbolDefinition[]>();
  /**
   * shortName -> SCHEMA-SYNTHESIZED column accessors (bd tea-rags-mcp-8l5fo).
   *
   * A separate index, not a flag inside `byShort`, because the exclusion has to
   * be structural: `lookup`, `size`, `shortNameDefCounts` and the DEFAULT
   * `lookupByShortName` are then byte-identical to a run with no schema, so no
   * global short-name fan-out and no ambiguity aggregate can ever see a column
   * that 300 models "define". Only a caller passing
   * `{ includeSchemaColumns: true }` — the typed-receiver / MRO paths, already
   * narrowed to one class — reaches it.
   *
   * Run-scoped: rebuilt wholesale by `setSchemaColumns` at each pass-1→pass-2
   * barrier, so per-file `upsertFile` / `removeFile` deliberately leave it alone.
   */
  private schemaColumnsByShort = new Map<string, SymbolDefinition[]>();
  /**
   * Ancestor directory -> number of files under it that hold definitions.
   *
   * Refcounted rather than a Set because `removeFile` is a per-file operation
   * on a directory many files share — a Set would delete `netbox/dcim` the
   * first time any file under it went away. Every ancestor prefix of a file
   * gets one count, so a corpus of 1,300 files at depth 5 holds a few thousand
   * entries: bounded by (files x depth), and no filesystem access at any point.
   */
  private readonly dirRefCounts = new Map<string, number>();

  upsertFile(relPath: RelPath, definitions: SymbolDefinition[]): void {
    this.removeFile(relPath);
    if (definitions.length === 0) return;
    this.byFile.set(relPath, definitions.slice());
    for (const dir of ancestorDirs(relPath)) {
      this.dirRefCounts.set(dir, (this.dirRefCounts.get(dir) ?? 0) + 1);
    }
    for (const def of definitions) {
      pushTo(this.byFq, def.fqName, def);
      pushTo(this.byShort, def.shortName, def);
    }
  }

  removeFile(relPath: RelPath): void {
    const existing = this.byFile.get(relPath);
    if (!existing) return;
    this.byFile.delete(relPath);
    for (const dir of ancestorDirs(relPath)) {
      const next = (this.dirRefCounts.get(dir) ?? 0) - 1;
      if (next <= 0) this.dirRefCounts.delete(dir);
      else this.dirRefCounts.set(dir, next);
    }
    for (const def of existing) {
      removeFrom(this.byFq, def.fqName, def);
      removeFrom(this.byShort, def.shortName, def);
    }
  }

  hasFile(relPath: RelPath): boolean {
    return this.byFile.has(relPath);
  }

  hasFilesUnder(dirRelPath: string): boolean {
    const normalized = dirRelPath.endsWith("/") ? dirRelPath.slice(0, -1) : dirRelPath;
    if (normalized === "") return this.byFile.size > 0;
    return this.dirRefCounts.has(normalized);
  }

  lookup(fqName: string): SymbolDefinition[] {
    return (this.byFq.get(fqName) ?? []).slice();
  }

  lookupByShortName(name: string, options?: SymbolLookupOptions): SymbolDefinition[] {
    const declared = (this.byShort.get(name) ?? []).slice();
    if (options?.includeSchemaColumns !== true) return declared;
    // Declared definitions stay FIRST: a real `def name` shadows the AR-generated
    // attribute method in Ruby, and callers that pick a single candidate rely on
    // the declared-before-synthesized order.
    const columns = this.schemaColumnsByShort.get(name);
    return columns === undefined ? declared : [...declared, ...columns];
  }

  setSchemaColumns(definitions: SymbolDefinition[]): void {
    const next = new Map<string, SymbolDefinition[]>();
    for (const def of definitions) pushTo(next, def.shortName, def);
    this.schemaColumnsByShort = next;
  }

  size(): number {
    let n = 0;
    for (const defs of this.byFile.values()) n += defs.length;
    return n;
  }

  shortNameDefCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const [name, defs] of this.byShort) counts.set(name, defs.length);
    return counts;
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

/** Every ancestor directory of a repo-relative path, shallowest first. */
function ancestorDirs(relPath: RelPath): string[] {
  const segments = relPath.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < segments.length; i++) dirs.push(segments.slice(0, i).join("/"));
  return dirs;
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
