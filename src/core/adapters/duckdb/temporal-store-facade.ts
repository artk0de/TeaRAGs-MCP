/**
 * `CodegraphTemporalStore` over the two DuckDB temporal stores (bd
 * tea-rags-mcp-0qaht.38). The stores keep their own table-scoped method names
 * (`replace`, `readGraph`, `replaceFiles`, …); this facade is the one place
 * that maps the contract's names onto them.
 */

import type {
  CodegraphTemporalStore,
  RelPath,
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitFileSnapshot,
} from "../../contracts/types/codegraph.js";
import type { DuckDbTemporalCochangeStore } from "./temporal-cochange-store.js";
import type { DuckDbTemporalSymbolCommitStore } from "./temporal-symbol-commit-store.js";

export class DuckDbTemporalStoreFacade implements CodegraphTemporalStore {
  constructor(
    private readonly cochange: DuckDbTemporalCochangeStore,
    private readonly symbolCommits: DuckDbTemporalSymbolCommitStore,
  ) {}

  // ── Temporal co-change sub-graph (bd tea-rags-mcp-x4rpp) ──

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    return this.cochange.replace(snapshot);
  }

  async readTemporalCochangeMeta(): Promise<TemporalCochangeBuildMeta | null> {
    return this.cochange.readMeta();
  }

  async readTemporalCochangeGraph(): Promise<TemporalCochangeGraph> {
    return this.cochange.readGraph();
  }

  async readTemporalBundleFiles(): Promise<ReadonlyMap<number, readonly RelPath[]>> {
    return this.cochange.readBundleFiles();
  }

  // ── Temporal symbol-commit store (bd tea-rags-mcp-3gz4f) ──

  async replaceTemporalSymbolCommits(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    return this.symbolCommits.replaceFiles(files);
  }

  async storedTemporalSymbolCommitFilePaths(): Promise<string[]> {
    return this.symbolCommits.storedFilePaths();
  }

  async deleteTemporalSymbolCommitFiles(relPaths: string[]): Promise<void> {
    return this.symbolCommits.deleteFiles(relPaths);
  }

  async readTemporalSymbolCommits(relPath: RelPath): Promise<TemporalSymbolCommitFileSnapshot> {
    return this.symbolCommits.readFile(relPath);
  }
}
