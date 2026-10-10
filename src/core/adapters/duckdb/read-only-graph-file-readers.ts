/**
 * In-process READ_ONLY handles on graph files, counted per path (bd
 * tea-rags-mcp-xi2r9, WTO-7, D5). Split out of `GraphDbClientPool` (0qaht.38),
 * which serves `acquireRead`, `acquireFileReader` and `isFileReaderOpen` from it.
 */

import type { CollectionGraphHandle } from "../../contracts/types/codegraph-pool.js";
import { DuckDbGraphClient } from "./client.js";
import type { SymbolTableFactory } from "./collection-init-hook.js";
import { DuckDbOpenFailedError } from "./errors.js";

export class ReadOnlyGraphFileReaders {
  /** Open {@link acquire} handles per file path — see {@link isOpen}. */
  private readonly openFileReaders = new Map<string, number>();

  constructor(private readonly symbolTableFactory: SymbolTableFactory) {}

  /**
   * In-process READ_ONLY handle on a graph file this pool does not own — the
   * working tree's published graph (bd tea-rags-mcp-xi2r9, WTO-7), a
   * self-contained file no daemon holds, so even daemon mode attaches it
   * directly. NON-cached: the caller MUST close it.
   *
   * @throws DuckDbOpenFailedError when the file cannot be opened.
   */
  async acquire(dbPath: string): Promise<CollectionGraphHandle> {
    const graphDb = new TrackedFileReaderClient(dbPath, () => {
      this.releaseFileReader(dbPath);
    });
    try {
      await graphDb.init();
    } catch (err) {
      await graphDb.close().catch(() => undefined);
      throw new DuckDbOpenFailedError(dbPath, err instanceof Error ? err : undefined);
    }
    this.openFileReaders.set(dbPath, (this.openFileReaders.get(dbPath) ?? 0) + 1);
    graphDb.markCounted();
    return { graphDb, symbolTable: this.symbolTableFactory() };
  }

  /**
   * Whether a handle from {@link acquire} on `dbPath` is open in this
   * process — what the working-tree graph cache asks before it deletes a
   * superseded tree graph (bd tea-rags-mcp-xi2r9, D5). Process-local by nature:
   * a reader in another server is covered by the cache's grace, not by this.
   */
  isOpen(dbPath: string): boolean {
    return (this.openFileReaders.get(dbPath) ?? 0) > 0;
  }

  private releaseFileReader(dbPath: string): void {
    const count = (this.openFileReaders.get(dbPath) ?? 0) - 1;
    if (count > 0) this.openFileReaders.set(dbPath, count);
    else this.openFileReaders.delete(dbPath);
  }
}

/**
 * The READ_ONLY client {@link ReadOnlyGraphFileReaders#acquire} hands out:
 * its first `close()` after it was counted reports the release, so the
 * open-reader count drops exactly once per handle.
 */
class TrackedFileReaderClient extends DuckDbGraphClient {
  private counted = false;

  constructor(
    dbPath: string,
    private readonly onRelease: () => void,
  ) {
    super({ path: dbPath, accessMode: "READ_ONLY" });
  }

  /** Called once the open succeeded and the handle is counted. */
  markCounted(): void {
    this.counted = true;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      if (this.counted) {
        this.counted = false;
        this.onRelease();
      }
    }
  }
}
