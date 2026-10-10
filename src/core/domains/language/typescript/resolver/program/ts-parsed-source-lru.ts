/**
 * Least-recently-used index over the TypeScript resolver's shared parses,
 * bounded in source-text BYTES (bd tea-rags-mcp-vtuu4).
 *
 * Bytes, not files, because retained heap follows text: the batch spike
 * measured AST + binder state at ≈ 28–31 MB of heap per MB of source, while a
 * file count says nothing about whether the files are 200-byte barrels or
 * 400 KB generated clients. Least recently used, because consecutive closure
 * batches share 80–95% of their files — a batch that is about to be built
 * touches exactly the parses the previous one used, so those are the ones to
 * keep.
 *
 * PINNED names are exempt: the prelude every batch Program is rooted at. It is
 * read by every batch, so evicting it would re-parse it per batch — the cost
 * the prelude exists to pay once. The default lib is exempt one level up (the
 * cache never hands it here), for the same reason.
 *
 * Holds names and sizes only; the parses themselves live in the cache's map,
 * which drops whatever {@link overflow} returns.
 */
export class TSParsedSourceLru {
  /** Unpinned parses in recency order — the first key is the least recently used. */
  private readonly order = new Map<string, number>();
  private readonly pinned = new Set<string>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number) {}

  /** Text the unpinned parses hold — the quantity the budget bounds. */
  get textBytes(): number {
    return this.bytes;
  }

  /** Exempt `fileNames` from eviction for as long as the pins last. */
  pin(fileNames: Iterable<string>): void {
    for (const fileName of fileNames) {
      this.pinned.add(fileName);
      const held = this.order.get(fileName);
      if (held === undefined) continue;
      this.order.delete(fileName);
      this.bytes -= held;
    }
  }

  isPinned(fileName: string): boolean {
    return this.pinned.has(fileName);
  }

  /** Record a fresh parse of `fileName` as the most recently used. */
  remember(fileName: string, textBytes: number): void {
    if (this.pinned.has(fileName)) return;
    this.forget(fileName);
    this.order.set(fileName, textBytes);
    this.bytes += textBytes;
  }

  /** A cache hit: move `fileName` to the most recently used end. */
  touch(fileName: string): void {
    const held = this.order.get(fileName);
    if (held === undefined) return;
    this.order.delete(fileName);
    this.order.set(fileName, held);
  }

  /** Drop `fileName` from the index — the parse left the cache for another reason. */
  forget(fileName: string): void {
    const held = this.order.get(fileName);
    if (held === undefined) return;
    this.order.delete(fileName);
    this.bytes -= held;
  }

  /** Evict least-recently-used parses until the text fits; the evicted names, oldest first. */
  overflow(): string[] {
    const evicted: string[] = [];
    for (const [fileName, held] of this.order) {
      if (this.bytes <= this.budgetBytes) break;
      this.order.delete(fileName);
      this.bytes -= held;
      evicted.push(fileName);
    }
    return evicted;
  }

  /** Evict every unpinned parse; the evicted names, oldest first. */
  evictAll(): string[] {
    const evicted = [...this.order.keys()];
    this.order.clear();
    this.bytes = 0;
    return evicted;
  }

  /** Forget everything, pins included — the run boundary. */
  clear(): void {
    this.order.clear();
    this.pinned.clear();
    this.bytes = 0;
  }
}
