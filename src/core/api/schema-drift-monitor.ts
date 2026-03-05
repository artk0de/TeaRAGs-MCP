/**
 * SchemaDriftMonitor — detects payload schema changes between server version and indexed data.
 *
 * Emits a warning ONCE per session (per instance). Shared across all MCP tools.
 * Lazy: drift check triggers on first tool call that provides a collection path.
 */

import { resolveCollectionName, validatePath } from "../contracts/collection.js";
import { StatsCache, type SchemaDrift } from "./stats-cache.js";

export class SchemaDriftMonitor {
  private _warned = false;
  private readonly _checkedCollections = new Set<string>();

  constructor(
    private readonly statsCache: StatsCache,
    private readonly currentPayloadKeys: string[],
  ) {}

  /**
   * Check drift for a path and return warning (once per session).
   * Returns null if already warned, no drift, or no cached keys.
   */
  async checkAndConsume(path: string): Promise<string | null> {
    if (this._warned) return null;
    try {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      if (this._checkedCollections.has(collectionName)) return null;
      this._checkedCollections.add(collectionName);

      const loaded = this.statsCache.load(collectionName);
      if (!loaded) return null;

      const drift = StatsCache.checkSchemaDrift(loaded.payloadFieldKeys, this.currentPayloadKeys);
      if (!drift) return null;

      this._warned = true;
      return StatsCache.formatSchemaDriftWarning(drift);
    } catch {
      return null;
    }
  }

  /** Check drift synchronously when collection name is already known. */
  checkByCollectionName(collectionName: string): string | null {
    if (this._warned) return null;
    if (this._checkedCollections.has(collectionName)) return null;
    this._checkedCollections.add(collectionName);

    const loaded = this.statsCache.load(collectionName);
    if (!loaded) return null;

    const drift = StatsCache.checkSchemaDrift(loaded.payloadFieldKeys, this.currentPayloadKeys);
    if (!drift) return null;

    this._warned = true;
    return StatsCache.formatSchemaDriftWarning(drift);
  }

  /** Expose drift detection for testing. */
  static detectDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
    return StatsCache.checkSchemaDrift(cachedKeys, currentKeys);
  }
}
