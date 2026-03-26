import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CollectionSignalStats, Distributions, SignalStats } from "../contracts/types/trajectory.js";

interface StatsFileContent {
  version: 4;
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  perLanguage: Record<string, Record<string, SignalStats>>;
  distributions: Distributions;
  payloadFieldKeys?: string[];
}

const CURRENT_VERSION = 4;

export interface SchemaDrift {
  added: string[];
  removed: string[];
}

export class StatsCache {
  constructor(private readonly snapshotsDir: string) {}

  /** Load cached stats from JSON file. Returns null if missing/corrupt. */
  load(collectionName: string): (CollectionSignalStats & { payloadFieldKeys?: string[] }) | null {
    const filePath = this.filePath(collectionName);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as StatsFileContent;
      if (data.version !== CURRENT_VERSION) return null;
      return {
        perSignal: new Map(Object.entries(data.perSignal)),
        perLanguage: new Map(
          Object.entries(data.perLanguage ?? {}).map(([lang, signals]) => [lang, new Map(Object.entries(signals))]),
        ),
        distributions: data.distributions,
        computedAt: data.computedAt,
        payloadFieldKeys: data.payloadFieldKeys,
      };
    } catch {
      return null;
    }
  }

  /** Save stats to JSON file. */
  save(collectionName: string, stats: CollectionSignalStats, payloadFieldKeys?: string[]): void {
    mkdirSync(this.snapshotsDir, { recursive: true });
    const perLanguageObj: Record<string, Record<string, SignalStats>> = {};
    for (const [lang, signals] of stats.perLanguage) {
      perLanguageObj[lang] = Object.fromEntries(signals);
    }
    const content: StatsFileContent = {
      version: CURRENT_VERSION,
      collectionName,
      computedAt: stats.computedAt,
      perSignal: Object.fromEntries(stats.perSignal),
      perLanguage: perLanguageObj,
      distributions: stats.distributions,
      payloadFieldKeys,
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

  /** Compare cached payload keys vs current. Returns null if no drift or no cached keys. */
  static checkSchemaDrift(cachedKeys: string[] | undefined, currentKeys: string[]): SchemaDrift | null {
    if (!cachedKeys) return null;
    const cachedSet = new Set(cachedKeys);
    const currentSet = new Set(currentKeys);
    const added = currentKeys.filter((k) => !cachedSet.has(k));
    const removed = cachedKeys.filter((k) => !currentSet.has(k));
    if (added.length === 0 && removed.length === 0) return null;
    return { added, removed };
  }

  /** Format a human-readable warning for schema drift. */
  static formatSchemaDriftWarning(drift: SchemaDrift): string {
    const lines: string[] = ["Payload schema changed since last indexing."];
    if (drift.added.length > 0) {
      lines.push(`New fields: ${drift.added.join(", ")} (require reindex to populate)`);
    }
    if (drift.removed.length > 0) {
      lines.push(`Removed fields: ${drift.removed.join(", ")} (no longer used)`);
    }
    lines.push("Run index_codebase with forceReindex=true to update.");
    return lines.join("\n");
  }
}
