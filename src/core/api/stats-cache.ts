import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CollectionSignalStats, SignalStats } from "../contracts/types/trajectory.js";

interface StatsFileContent {
  version: 1;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
}

const CURRENT_VERSION = 1;

export class StatsCache {
  constructor(private readonly snapshotsDir: string) {}

  /** Load cached stats from JSON file. Returns null if missing/corrupt. */
  load(collectionName: string): CollectionSignalStats | null {
    const filePath = this.filePath(collectionName);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as StatsFileContent;
      if (data.version !== CURRENT_VERSION) return null;
      return {
        perSignal: new Map(Object.entries(data.perSignal)),
        computedAt: data.computedAt,
      };
    } catch {
      return null;
    }
  }

  /** Save stats to JSON file. */
  save(collectionName: string, stats: CollectionSignalStats): void {
    mkdirSync(this.snapshotsDir, { recursive: true });
    const content: StatsFileContent = {
      version: CURRENT_VERSION,
      collectionName,
      computedAt: stats.computedAt,
      perSignal: Object.fromEntries(stats.perSignal),
    };
    writeFileSync(this.filePath(collectionName), JSON.stringify(content, null, 2), "utf-8");
  }

  /** Invalidate (delete) cache file. */
  invalidate(collectionName: string): void {
    const filePath = this.filePath(collectionName);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
  }

  private filePath(collectionName: string): string {
    return join(this.snapshotsDir, `${collectionName}.stats.json`);
  }
}
